// 本地 HTTP 服务：托管静态页面 + 提供 JSON API + 代理 OpenAI 流式回复。
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, DATA_DIR, getConfig, saveConfig, listCharacters, getCharacter, saveCharacter, deleteCharacter, listSessions, getSession, createSession, saveSession, deleteSession, exportBundle, mergeBundle, ensureDataReady, getKnowledge, saveKnowledge, KNOWLEDGE_MAX, normalizeKnowledgeChars, normalizePhraseLevel, normalizeDirectPhrases, getSharedKnowledge, saveSharedKnowledge, sharedKnowledgeEnabled, KNOWLEDGE_DIR_PATH, normalizeSearchSite, normalizeSearchCount, normalizeSearchChars, normalizeCastSpeakChance } from './store.js';
import { pickChunks, knowledgeBlock, pickChunksSmart, applyColloquialMap, setEmbedCacheDir } from './knowledge.js';
import { synthesize, speechText, ttsCacheKey, ttsMime } from './tts.js';
import { ttsCacheFile, fileExists } from './store.js';
import { defaultRulesText, buildMessages, previewContext, regenerateNudge, antiStallNudge, personNudge, clicheNudge, continueNudge, openingPrefill, CONTEXT_BUDGET, dynamicHistoryBudget, directMessages, directPhrasesBlock, parsePhrases, dimsBlock, hintBlock, memoBlock, synonymsBlock, noKnowledgeBlock, webSearchBlock, NO_THINK, stuffedPhrases, isPhraseOffTopic, stuffedNudge, normalizeCastSpeaker, castOf, asNudge, applyAsIdentity, dropAsSpeaker, dropMultiOpener, splitInlineSpeakers, detailNudge, castNudge, timeNudge, parseKeywordActions, matchKeywordActions } from './prompt.js';
import { saveLabel, listLabels, labelStats, normalizeW, describeW } from './rl.js';
import { sanitizeReply, stripRoleLeak, stripLeadingReasoning, fixThirdPersonForUser, fixFormalYou, fixAnatomyTerms, describeCleaned, replyQuality, describeQuality, stripClicheActions, countClicheActions, describeCliche, stripUserActions } from './sanitize.js';
import { streamChat, listModels, OpenAIError, resolveModelId, cloudModelAliases } from './openai.js';
// 候选回答生成：「🎲 挑一个 / 预选回复 / 该我说什么」共用；走 config 的 baseUrl/model，
// 不再写死 Ollama 11434（llama-server 换成 gemma 后旧实现会「全部生成失败」）。
import { generateCandidates } from './candidates.js';
import { workState, SCHEDULE_TEXT, isLocalEndpoint } from './workguard.js';
import { status as ollamaStatus, start as ollamaStart, setKeepAlive as ollamaSetKeepAlive, freeNow as ollamaFreeNow, localOllamaBase, preload as ollamaPreload, listLocalModels, thinkControl } from './ollama.js';
import { describeImage, parseImagePayload, normalizeVisionModel, VISION_IMAGE_MAX } from './vision.js';
import { detectTailLoop, cutLoop, describeLoop, detectDuplicateSentence, cutDuplicate } from './loopguard.js';
import { normalizeMarkup, normalizePerson, describeMarkup, thirdPersonSubjects } from './markup.js';
import { trimToLimit, describeTrim } from './limit.js';
import { VERSION } from './version.js';
import { listTrainRuns, trainRunDetail, gpuSnapshot, liveProcesses } from './trainlog.js';
import { isAuthorized, isLoopback, grantCookie, clearCookie, checkPassword, loginPage } from './access.js';
import { exportTrainingSamples, toJsonl } from './export.js';
import { sessionToMarkdown, sessionToJson, chatLogFileName } from './chatlog.js';
import { enqueueTraining, enqueueGoldTraining, enqueueScriptTraining, queueState, cancelQueued, removeQueued, trainState, stopTraining, deployTraining, resumeQueue } from './trainer.js';
import { unloadOllama, ollamaLoaded, llamaServerUp, ensureVramForOllama, stopLlamaServicesExcept, arbitrateForChat, restoreGpuAfterChat, gpuArbiterStatus, comfyUp, comfyUnloadModels } from './gpu.js';
import { searchBing, cleanQuery, describeSearchFail } from './search.js';
import { extractUrls, resolveShare, getProfile, fetchOne, listCards, getRecord, deleteRecord, avatarFile, stats as xingyeStats, registerCharacters, search as xingyeSearch } from './xingye.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  // 防止 ../ 穿越到项目外。
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// 工作时段锁用的"当前时间"。正常就是 now；
// 调试/测试可用 WORKBENCH_WORKGUARD_NOW=<ISO 时刻> 假装现在是别的时间。
function currentTime() {
  const fake = (process.env.WORKBENCH_WORKGUARD_NOW || process.env.XINGYE_WORKGUARD_NOW);
  return fake ? new Date(fake) : new Date();
}

// SSE 事件流：把模型逐字输出实时推给浏览器。
/**
 * v0.61.0：统一的"取资料块"参数。
 * 语义检索实测把资料检索正确率从 14/20 提到 19/20（热查询 ~23ms），
 * 所以默认走语义；embedding 不可用时 pickChunksSmart 会自动降级回词法检索。
 */
function knowledgeOpts(config) {
  return {
    maxChars: normalizeKnowledgeChars(config?.knowledgeChars),
    topK: 3,
    semantic: config?.knowledgeSemantic !== false,
    threshold: Number(config?.knowledgeThreshold ?? 0.5),
    embedModel: config?.knowledgeEmbedModel || 'qwen3-embedding:0.6b',
    // embedding 端点与主 baseUrl 分开：主 baseUrl 可能指向云端，embedding 必须在本机
    embedBaseUrl: 'http://127.0.0.1:11434',
  };
}

/** 口语→术语映射：命中的行把右侧术语**追加**到查询上（不替换原句，原句的规范词更有价值）。 */
function mappedQuery(q, config) {
  return applyColloquialMap(q, config?.knowledgeMap);
}

// 降级只提醒一次，不要每轮刷屏（embedding 没装 / Ollama 没起时会走到这里）
let _knowWarned = false;
function knowledgePickWarnOnce(err) {
  if (_knowWarned) return;
  _knowWarned = true;
  console.warn(`[资料库] 语义检索不可用，已降级为词法检索：${err}`);
}

/* ---------- 联网搜索（v0.62.0，必应网页抓取） ---------- */

/**
 * 这一轮联网搜索怎么跑。**关着时这里返回 enabled:false，后面一步网络都不走。**
 * 代理直接复用设置里那个 `proxy`（同一个字段，不另开一处要用户填两遍）。
 * `WORKBENCH_BING_BASE` 是**测试钩子**（和 WORKBENCH_WORKGUARD_NOW 一个路子）：
 * 冒烟测试把它指到本地假必应，整条链路就能离线跑完。
 */
function searchPlan(config) {
  return {
    enabled: config?.webSearch === true,
    site: normalizeSearchSite(config?.webSearchSite),
    count: normalizeSearchCount(config?.webSearchCount),
    chars: normalizeSearchChars(config?.webSearchChars),
    proxy: config?.proxy || '',
    base: (process.env.WORKBENCH_BING_BASE || process.env.XINGYE_BING_BASE) || '',
  };
}

// 同一个会话 + 同一条查询 + 同一个站点，90 秒内只搜一次。
// 为什么必须缓存：「重新生成」「点停止再点一次」「查看上下文」这三个动作都会再问一遍同一个问题，
// 不缓存就是白打三次必应（慢、还可能被判成机器人）。
const searchCache = new Map();
const SEARCH_CACHE_MS = 90 * 1000;
const SEARCH_CACHE_MAX = 16;

function searchCacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_MS) { searchCache.delete(key); return null; }
  return hit.payload;
}

function searchCacheSet(key, payload) {
  searchCache.delete(key);
  searchCache.set(key, { at: Date.now(), payload });
  while (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
}

// 搜索失败只提醒一次：没网/代理没开时不该每轮都刷一行
let _searchWarned = false;
function searchWarnOnce(msg) {
  if (_searchWarned) return;
  _searchWarned = true;
  console.warn(`[联网搜索] ${msg}`);
}

/**
 * 这一轮要不要搜、搜什么、结果是什么。
 *
 * ★ 失败**绝不影响聊天**：任何异常都收敛成 results:[]，调用方照常走资料库/提示词那套。
 *   （联网只是"锦上添花"，不能因为必应不通就让人聊不了天。）
 *
 * @param {object} session 当前会话（只用来当缓存 key）
 * @param {object} plan searchPlan(config) 的结果
 * @param {string} lastUserText 这一轮在聊什么
 * @returns {{results:Array, notice:string, error:string, query:string, site:string, via:string, cached:boolean}}
 */
async function pickSearchFor(session, plan, lastUserText, opts = {}) {
  const none = { results: [], notice: '', error: '', query: '', site: plan.site, via: '', cached: false };
  if (!plan.enabled) return none;
  const query = cleanQuery(lastUserText);
  // 剥掉 *动作* 和（环境）之后没剩下什么（"嗯""继续"）→ 不搜，省一次请求
  if (!query) return none;

  const key = `${session?.id || '-'}::${plan.site}::${plan.count}::${query}`;
  if (!opts.fresh) {
    const hit = searchCacheGet(key);
    if (hit) return { ...hit, cached: true };
  }
  try {
    const r = await searchBing(query, {
      site: plan.site,
      count: plan.count,
      proxy: plan.proxy,
      base: plan.base,
    });
    const payload = {
      results: r.results,
      notice: r.notice || '',
      error: '',
      query,
      site: plan.site,
      via: r.via,
      cached: false,
    };
    searchCacheSet(key, payload);
    return payload;
  } catch (err) {
    const msg = describeSearchFail(err);
    searchWarnOnce(msg);
    return { ...none, query, error: msg };
  }
}

/** 存进会话文件里的来源：只留标题/链接/域名（摘要不留，会话文件要跟着 Syncthing 同步，越瘦越好）。 */
function toSources(results) {
  return (Array.isArray(results) ? results : [])
    .filter((r) => r && /^https?:\/\//i.test(String(r.url || '')))
    .slice(0, 10)
    .map((r) => ({
      title: String(r.title || r.url).slice(0, 160),
      url: String(r.url),
      host: String(r.host || '').slice(0, 60),
    }));
}

/** 给前端/日志用的一条摘要（不含结果正文）。 */
function searchSummary(sRes) {
  return {
    query: sRes.query,
    count: sRes.results.length,
    site: sRes.site,
    via: sRes.via,
    notice: sRes.notice,
    error: sRes.error,
    cached: sRes.cached,
  };
}

// 资料库：读**共享资料 + 这个角色自己的资料**，按"这一轮在聊什么"挑几块。
// query 用"最新一条用户消息 + 上一条角色回复"——只看用户那句，遇到"嗯""继续"这种就挑不中；
// 带上角色上一轮的回复，相关度判断稳得多。
async function pickKnowledgeFor(character, session, config, lastUserText) {
  const none = { chunks: [], emptyReason: null, err: null };
  try {
    const budgetChars = normalizeKnowledgeChars(config?.knowledgeChars);
    if (!character?.id || budgetChars <= 0) return none;
    // 共享的那份放前面，角色专属的放后面（两份拼起来一起挑块）
    const [shared, own] = await Promise.all([getSharedKnowledge(), getKnowledge(character.id)]);
    const text = [shared, own].filter((t) => t && t.trim()).join('\n\n');
    if (!text.trim()) return none;
    const lastAssistant = [...(session.messages || [])].reverse().find((m) => m.role === 'assistant')?.content || '';
    const query = mappedQuery(`${String(lastUserText || '')}\n${String(lastAssistant).slice(-200)}`, config);
    const r = await pickChunksSmart(text, query, knowledgeOpts(config));
    if (r.err) knowledgePickWarnOnce(r.err);
    // 只有"资料非空、但这轮没挑中"才注入"没有资料"提示；
    // 'empty'/'no-query'（压根没资料 / 没问句）**不注入**，直连模式必须保持零 system。
    return {
      chunks: r.chunks,
      emptyReason: r.emptyReason === 'below-threshold' ? 'below-threshold' : null,
      err: r.err,
    };
  } catch {
    return none; // 资料读不出来也不能影响聊天
  }
}

/**
 * 直连模式：读**共享资料库**（`knowledge/_shared.md`）—— 和角色模式读的是同一份。
 * 挑块规则和角色模式完全一致（走同一个 pickChunksSmart），两种模式行为可预期。
 */
async function pickKnowledgeForDirect(session, config, lastUserText) {
  const none = { chunks: [], emptyReason: null, err: null };
  try {
    const budgetChars = normalizeKnowledgeChars(config?.knowledgeChars);
    if (budgetChars <= 0) return none;
    // 共享资料库**存在**才算"开着"（内容可以是空的）。
    // 只看内容是否为空没法区分"没开"和"开着但为空"，
    // 而这两者在"要不要注入'没有资料'提示"上行为不同 —— 见 sharedKnowledgeEnabled 的注释。
    if (!(await sharedKnowledgeEnabled())) return none;
    const text = await getSharedKnowledge();
    // 内容为空（还没填 / 已清空）→ 不注入任何东西。
    // 语义上"空资料库"就等于"没有资料可用"，此时再塞一句【本轮没有可用资料】
    // 纯属自造噪声 —— 直连模式的立身之本是"没东西要注入时就是零 system"。
    if (!text.trim()) return none;
    const lastAssistant = [...(session?.messages || [])].reverse().find((m) => m.role === 'assistant')?.content || '';
    const query = mappedQuery(`${String(lastUserText || '')}\n${String(lastAssistant).slice(-200)}`, config);
    const r = await pickChunksSmart(text, query, knowledgeOpts(config));
    if (r.err) knowledgePickWarnOnce(r.err);
    return {
      chunks: r.chunks,
      emptyReason: r.emptyReason === 'below-threshold' ? 'below-threshold' : null,
      err: r.err,
    };
  } catch {
    return none; // 资料读不出来也不能影响聊天
  }
}

// 📷 附图：「重新生成」要能带上同一张图，所以把每个会话最后一张图记在**内存**里。
// 不落盘、不进同步目录（base64 写进会话文件会被 Syncthing 同步到手机，几 MB 一张）。
// 进程重启就没了 —— 重抽会退化成纯文本，可以接受。
// 上限 8 个会话，超了丢最老的：一张几 MB，不能无限攒。
// ---- 显存自动调度的"聊天空闲后恢复" ----
// 聊天前可能临时停了 ComfyUI 之类的服务；不能每条消息都重启再停（会来回抖），
// 所以攒着，等 2 分钟没新消息了再一次性拉回来。
let gpuRestoreTimer = null;
let gpuRestoreQueue = [];
function cancelGpuRestore() {
  if (gpuRestoreTimer) { clearTimeout(gpuRestoreTimer); gpuRestoreTimer = null; }
}
function scheduleGpuRestore(stopped = []) {
  if (!Array.isArray(stopped) || !stopped.length) return;
  gpuRestoreQueue.push(...stopped);
  cancelGpuRestore();
  gpuRestoreTimer = setTimeout(async () => {
    const queue = gpuRestoreQueue;
    gpuRestoreQueue = [];
    gpuRestoreTimer = null;
    try {
      const restored = await restoreGpuAfterChat(queue);
      const ok = restored.filter((x) => x.ok).map((x) => x.unit);
      if (ok.length) console.log(`[gpu] 聊天空闲，已恢复：${ok.join('、')}`);
    } catch { /* 恢复失败下次还有机会 */ }
  }, 120000);
  gpuRestoreTimer.unref?.();
}

// ---- token 用量（v1.5.3，DSH 样式）：云端接口拿真实 usage，本地模型拿不到就按字数估算 ----
function normUsage(u) {
  if (!u) return null;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const total = Number(u.total_tokens) || input + output;
  const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? 0) || 0;
  const reasoning = Number(u.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
  if (!input && !output && !total) return null;
  return { input, output, reasoning, cached, total };
}
function addUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cached: a.cached + b.cached,
    total: a.total + b.total,
  };
}
/** 本地模型没有 usage 时的估算：中文按 1.7 字/token */
const estTokens = (chars) => Math.ceil((Number(chars) || 0) / 1.7);

const lastImage = new Map();
const LAST_IMAGE_MAX = 8;
function rememberImage(sessionId, rec) {
  if (!sessionId || !rec?.pic) return;
  lastImage.delete(sessionId);       // 重新 set 一下，让它排到最新
  lastImage.set(sessionId, rec);
  while (lastImage.size > LAST_IMAGE_MAX) lastImage.delete(lastImage.keys().next().value);
}

async function handleChat(req, res) {
  // 📷 附图时请求体里带 base64 图片，默认 1MB 的上限根本不够 —— 单独放宽。
  let body;
  try {
    body = await readBody(req, VISION_IMAGE_MAX + 512 * 1024);
  } catch (err) {
    return sendJson(res, 413, { error: `请求体太大或不是合法 JSON：${err.message}` });
  }
  const { sessionId, content, regenerate, rejectedReason, hint, next, image, pinnedReply } = body;
  // 「只在这次用」的微调提示：请求里带了就用它，不带就用设置里存的
  const hintOverride = typeof hint === 'string' ? hint.trim().slice(0, 500) : '';
  // cheats=1：不当作你说的话，直接让角色接着演下一句
  const continueNext = next === true;
  const session = await getSession(sessionId);
  if (!session) return sendJson(res, 404, { error: '会话不存在' });

  const characters = await listCharacters();
  const character = characters.find((c) => c.id === session.characterId);
  if (!character) return sendJson(res, 404, { error: '角色不存在' });

  // 多人模式：结构化 cast 或 persona 里的「【人物】」节，≥2 个才启用（见 lib/prompt.js 的 castOf）
  const { parseReplyLines } = await import('./prompt.js');
  const cast = castOf(character);
  const isMulti = cast.length >= 2;
  const castNames = cast.map((c) => c.name);

  // 「/ 以谁的身份发这条消息」（v1.2.2）：只认**本会话人物表**里的人名。
  // 用户选「陈梦」= 这条消息由用户扮演陈梦说出，模型只演其他人物。
  // 重抽 / 接着演时请求里没有 as，从最后一条用户消息的 as 还原。
  const asName = body.as && typeof body.as === 'object' ? String(body.as.name || '').trim() : '';
  let asForTurn = isMulti && asName && cast.some((c) => c.name === asName) ? asName : '';
  if (!asForTurn && isMulti && (regenerate || next === true)) {
    const lastAs = [...session.messages].reverse().find((m) => m.role === 'user')?.as;
    if (lastAs && cast.some((c) => c.name === lastAs)) asForTurn = lastAs;
  }
  const asOthers = cast.map((c) => c.name).filter((n) => n !== asForTurn);

  const config = await getConfig();
  // 本机聊天前自动调度显存（v1.4.0）：Ollama 掉线自动重启、停常驻 llama-server、
  // 让 ComfyUI /free 卸模型（实在不行临时停服务）、卸掉 Ollama 里的其它模型。
  // 用户要求："做自动卸载和重启 ollama/comfyui/llama"。
  let gpuState = null;
  if (localOllamaBase(config) && config.gpuArbiter !== false) {
    cancelGpuRestore();   // 又开聊了，先别恢复
    try {
      gpuState = await arbitrateForChat({
        needGB: 1.2,
        targetModel: config.model,
        embedModel: config.knowledgeEmbedModel,
      });
      if (gpuState.actions?.length) console.log(`[gpu] 聊天前自动调度：${gpuState.actions.join('；')}（空闲 ${gpuState.freeGB}G）`);
    } catch { /* 调度失败不阻塞聊天 */ }
  }
  // 走 llama-server（gemma）后端但服务没起：按需拉起（v1.3.1 起该服务已禁用自启，
  // 不兜底的话切过去第一条就「连接失败」）。起之前先卸 Ollama，腾出显存。
  if (/:18080\b/.test(String(config.baseUrl || '')) && !(await llamaServerUp(18080))) {
    try {
      await unloadOllama();
      await stopLlamaServicesExcept(['gemma-server']);
      if (await comfyUp()) { await comfyUnloadModels().catch(() => {}); }
      const { execFile } = await import('node:child_process');
      await new Promise((resolve) => execFile('systemctl', ['--user', 'start', 'gemma-server', '--no-ask-password'], { timeout: 20000 }, () => resolve(null)));
      for (let i = 0; i < 30; i += 1) {
        if (await llamaServerUp(18080)) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch { /* 起不来就让后面的请求正常报错 */ }
  }
  // 本地模型（Ollama / llama-server）：提示词用「精简」版，长度/说话人重抽门控不生效
  //（rp4/rp7 是用短对话训的，套云端那套"必须写满 150 字"会被逼出胡话，实测踩过）
  const localBackend = Boolean(localOllamaBase(config)) || /:18080\b/.test(String(config.baseUrl || ''));
  // R1 这类模型「思考即输出」：think:false 关不掉思考，只能生成后把思考段切掉
  const r1NoThink = /(deepseek[-_.]?r1|r1[-_.]?distill|qwq)/i.test(String(config.model || ''));
  // v1.8.4：本地模型**完全不管字数**（提示词不写、生成后不裁）。
  // 实测 8B 模型对字数要求很敏感：逼它凑字数反而容易吐空/说胡话。
  const maxCharsForTurn = localBackend
    ? 0
    : (isMulti && config.maxChars > 0
      ? Math.min(2000, Math.round(config.maxChars * 1.4))
      : config.maxChars);

  // 资料库检索用的"这一轮在聊什么"：最新一条用户消息（重新生成/接着演时退回会话里最后一条用户消息）
  const lastUserText = String(content || '').trim()
    || [...session.messages].reverse().find((m) => m.role === 'user')?.content
    || '';

  // 多人卡：这一轮谁开口 —— 每个人物按几率决定（v1.7.2）。
  // 以前是提示词硬性要求"2 个人物都开口" + 服务器重抽兜底，导致每轮全员说话；
  // 现在随机：用户点名的必开口，其余按 castSpeakChance（默认 65%）决定，
  // 至少保一个人开口，谁先说也打乱。
  let castPlan = [];
  if (isMulti) {
    const pool = asForTurn ? castNames.filter((n) => n !== asForTurn) : castNames;
    const chance = normalizeCastSpeakChance(config.castSpeakChance) / 100;
    const mentioned = pool.filter((n) => lastUserText.includes(n));
    castPlan = pool.filter((n) => mentioned.includes(n) || Math.random() < chance);
    if (!castPlan.length && pool.length) {
      castPlan = [mentioned[0] || pool[Math.floor(Math.random() * pool.length)]];
    }
    for (let i = castPlan.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [castPlan[i], castPlan[j]] = [castPlan[j], castPlan[i]];
    }
  }

  // 关键词 → 动作（v1.7.8）：角色卡自己的表优先，没填就用全局；只匹配「这一轮用户说的话」
  const kwMap = parseKeywordActions(
    String(character.keywordActions || '').trim() || config.keywordActions || '',
  );
  const kwHits = matchKeywordActions(lastUserText, kwMap);

  // ---- 📷 附图：图片作为消息内容直接发给角色 ----
  // 图片**只在这一次请求里**带上，历史里存的仍是纯文本。
  let pic = null;
  if (image) {
    try {
      pic = parseImagePayload(image);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });   // SSE 还没开始，可以正常报错
    }
    rememberImage(sessionId, { text: lastUserText, pic });
  }
  // 「重新生成」把上次那张图接回来 —— 否则重抽变成"对着一张看不见的图回话"。
  // 只在还是同一条用户消息时接（文字对得上），免得把旧图错接到后面的消息上。
  const memo = lastImage.get(sessionId);
  const visionPic = pic || (regenerate && memo && memo.text === lastUserText ? memo.pic : null);

  // 工作时段锁：先把门关上再谈别的 —— 必须在写入任何消息之前拦下来，
  // 否则会留下"消息存进去了、模型却没回"的半截状态。
  // 只对**云端**模型生效：本地/内网接口（Ollama 等）不受工作时段限制。
  const gate = isLocalEndpoint(config.baseUrl)
    ? { enabled: config.workGuard !== false, blocked: false, until: null, label: null, reason: 'local' }
    : workState(currentTime(), config.workGuard);
  if (gate.blocked) {
    const unlockAt = new Date(gate.until).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return sendJson(res, 403, {
      error: `现在是工作时间（${gate.label} 北京时间），对话已锁定，${unlockAt} 自动解锁`,
      blocked: true,
      until: gate.until,
      label: gate.label,
    });
  }

  // v1.8.3：这次请求新加进历史的用户消息，生成失败时要撤回
  let addedUserMsg = '';
  let previousReply = '';
  // 重新生成时被摘下来的那几条（消息对象，不是纯文本）：收尾要用它兜底，见下面的 catch。
  const droppedMsgs = [];
  // cheats=1（生成下一句）：不追加用户消息、也不丢掉已有回复 ——
  // 只是带着"接着往下演"的系统指令再生成一条角色回复。
  const keepGoing = continueNext && !regenerate;
  if (regenerate) {
    if (!session.messages.some((m) => m.role === 'user')) {
      return sendJson(res, 400, { error: '还没有用户消息，无法重新生成' });
    }
    // 末尾若还是角色回复，先丢掉，免得它"接着自己上一句往下写"；
    // 顺手把丢掉的内容记下来，用来要求这一次换个走向。
    // 摘下来的**消息对象**也留着：万一这一轮一个字都没留下（用户点停止 / 请求报错），
    // 得把它原样放回去 —— 否则"点一下重新生成再点停止"就会把上一版吃掉。
    while (session.messages.length && session.messages.at(-1).role === 'assistant') {
      droppedMsgs.unshift(session.messages.pop());
    }
    previousReply = droppedMsgs.map((m) => m.content).join('\n');
  } else if (keepGoing) {
    if (!session.messages.length) {
      return sendJson(res, 400, { error: '这个会话还没有内容，没法接着演' });
    }
  } else {
    const text = (content || '').trim();
    if (!text) return sendJson(res, 400, { error: '消息不能为空' });
    session.messages.push({
      role: 'user',
      content: text,
      at: Date.now(),
      // 这一条是以某个人物的身份说的：记下来，重抽 / 事后看记录都知道当时演的是谁
      ...(asForTurn ? { as: asForTurn } : {}),
    });
    // v1.8.3：记下来，生成失败时撤回 —— 否则报错后这句话照样留在历史里，
    // 用户重发一次就变成两条一模一样的消息（实测连发三次「300」，模型开始凭空编"刚才聊过"）。
    addedUserMsg = text;
    // 第一条用户消息拿来当会话标题，方便在列表里认出来。
    if (session.title === '新的对话') {
      session.title = text.slice(0, 18);
    }
  }

  // 🎲 预选模式：前端已经挑好了这一版的回复，直接落盘，不再调模型。
  // 省掉「生成完再替换」那一轮白跑的推理（实测每次能省 5~15 秒）。
  const pinned = String(pinnedReply || '').trim();
  if (pinned && !regenerate && !keepGoing && content) {
    session.messages.push({
      role: 'assistant',
      content: pinned,
      at: Date.now(),
      // 标一个来源，方便事后分辨「这是预选来的，不是当场生成的」
      source: 'presend',
    });
    await saveSession(session);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: delta\ndata: ${JSON.stringify({ text: pinned })}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ title: session.title || '' })}\n\n`);
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const controller = new AbortController();
  // 客户端断开要能**真的察觉到**，否则用户点了「停止」界面不更新了、
  // 服务端却还在后面吭哧吭哧生成（实测：req 的 close 在这个场景不触发，
  // 必须挂 res 的 close —— 它在"连接被提前终止"时才会响）。
  const onClientGone = () => controller.abort();
  req.on('close', onClientGone);
  res.on('close', onClientGone);
  // 「用户点了停止」的判定 = 这个 controller 被 abort 了（角色模式里它只由客户端断开触发）。
  // 不能只看 `err.name === 'AbortError'`：**上游已经吐过字之后再断开**，拿到的是流上的
  // 通用错误（ECONNRESET），name 根本不是 AbortError —— 那条路会被误判成"上游报错"，
  // 用户明明点了停止，却走错误分支（直连模式里实测过这个洞，两边一起修）。
  const clientGone = () => controller.signal.aborted;

  // 收尾兜底：重新生成时摘下来的那几条，只有在**没有任何东西替代它们**时才放回去。
  // 「一个都没留下」的典型场景：点了重新生成、模型还没吐出第一个字就点了停止。
  // 判断条件是"末尾不是角色回复"：正常生成成功后末尾就是新回复（不还原），
  // 保存本身失败时内存里也已经有了那条（也不还原），所以不会出现两条连续回复。
  const restoreDropped = () => {
    if (droppedMsgs.length && session.messages.at(-1)?.role !== 'assistant') {
      session.messages.push(...droppedMsgs);
    }
  };

  try {
    // 资料库：拿"这一轮在聊什么"（最新一条用户消息 + 上一条角色回复）去挑最相关的几块。
    // 挑不中就不注入（不浪费本来就紧张的历史预算）。
    const kRes = asForTurn
      // 「/ 以身份发」时不注入资料：实测资料块会把模型拽回"第三人称叙述/别人说"的状态，
      // 这一轮只要它演其他人物，参考资料反而添乱。
      ? { chunks: [], emptyReason: '' }
      : await pickKnowledgeFor(character, session, config, lastUserText);
    const knowledge = kRes.chunks;
    // 联网搜索（v0.62.0）：关着时这里立刻返回空、一个网络请求都不发。
    // 结果只进 system 当参考（和资料库同一层），**不**改用户消息、也不进历史。
    const sPlan = searchPlan(config);
    if (kwHits.length) send('kw', { matches: kwHits });
    if (sPlan.enabled) send('web', { phase: 'start', site: sPlan.site });
    const sRes = await pickSearchFor(session, sPlan, lastUserText);
    if (sPlan.enabled) send('web', { phase: 'done', ...searchSummary(sRes) });
    // 「关掉思考」按模型分派（Qwen3 → system 里的 /no_think；R1 → 请求体的 think:false）
    const tp = thinkPlan(config);
    // 「常用词 / 口头禅」的词表 + 重抽用的"整段不注入"开关（v0.57.0）
    const phraseWords = parsePhrases(character?.phrases);
    let skipPhrases = false;
    // 场景推进（v1.7.4）：已经出过 3 条角色回复（3/6/9…）时，往这一轮 system 里塞一句推进要求。
    // 单角色和多人卡都算；重抽时这一轮保持一致（固定在 buildOpts 里，不会变来变去）。
    const aiTurns = (session.messages || []).filter((m) => m.role === 'assistant').length;
    const timePush = aiTurns > 0 && aiTurns % 3 === 0 ? timeNudge() : '';
    const buildOpts = {
      cleanHistory: config.cleanHistory !== false,
      // 本地小模型用精简提示词（v1.7.7）：完整版太长，8B/12B 抓不住重点会答非所问
      localBackend,
      // 这一轮要不要硬推时间（空串 = 不推）
      timeNudge: timePush,
      // 多人人物表 + 用户正在演的那个角色（「/ 以身份发」时模型名单里要把 TA 拿掉）
      cast,
      asName: asForTurn,
      // 这一轮点名谁开口（按几率随机；见上面的 castPlan）
      castPlan,
      // 本轮命中的「关键词→动作」（prompt.js 会拼成【本轮暗号】放到系统提示词最后）
      keywordActions: kwHits,
      // 维度和「特点提示词」：这个角色自己设过就用它的，没设就回退到设置里的全局值
      dims: character?.dims?.length ? character.dims : config.dims,
      hint: hintOverride || String(character?.hint || '').trim() || config.hint,
      // 等义词是全角色通用的一份（用户自己的用词习惯），所有角色都注入
      synonyms: config.synonyms,
      // 「回答时也用我这些说法」（v0.56.0）：勾上 = 整张等义词表都进输出侧；
      // 不勾时只有行尾标了 `#输出` 的条目会（见 lib/prompt.js 的 synonymsBlock）
      synonymsOutput: config.synonymsOutput === true,
      memo: config.memo,
      maxChars: maxCharsForTurn,
      knowledge,
      // v0.61.0：资料库非空但这一轮没挑中 → 让提示词里出现"没有资料"的约束
      noKnowledge: kRes.emptyReason === 'below-threshold',
      // v0.62.0 联网搜索：结果块 + 注入上限（和资料库一起从历史预算里扣）
      search: sRes.results,
      searchChars: sPlan.chars,
      // 「关掉思考」：Qwen3 这代用 system 里的 /no_think；R1 这代改成请求体的 think:false（thinkPlan）
      thinkOff: tp.systemInject,
      // 可编辑的扮演规则（v1.6.0）：设置里改的整段提示词，替换或追加到默认规则上
      customRules: config.customRules,
      customRulesMode: config.customRulesMode,
    };
    // 多人卡：历史里如果还有「（陈梦）台词」这种老写法（老卡的开场白就是），
    // 先归位成「陈梦：台词」再喂模型 —— 不然模型照着历史学，整轮都写括号，
    // parseReplyLines 一个说话人都认不出来（实测 gemma3-12b-rp2 跟着开场白学坏了）。
    let historyForModel = applyAsIdentity(isMulti
      ? session.messages.map((m) => (m.role === 'assistant'
        ? { ...m, content: normalizeCastSpeaker(m.content, cast) }
        : m))
      : session.messages);
    // 以身份发送时，历史里模型替用户角色写的话要摘掉（否则它跟着开场白继续演用户）
    if (asForTurn) historyForModel = dropAsSpeaker(historyForModel, asForTurn, castNames);
    // 多人卡：开场白（单人一句话）不进模型历史，否则模型会锚成"只有一个人说话"
    if (isMulti) historyForModel = dropMultiOpener(historyForModel, character, cast);
    // v1.8.2：单人卡也把「历史开头的开场白」摘掉。
    // 实测 Qwen3 的模板在**第一条就是 assistant**（只有开场白、用户还没说话）时，
    // 会把思考标记搞乱，模型只吐一个 "</think>" 就停（内容为空 → 连续重抽 → 报错）。
    // 开场白只是"角色先开口"，对模型来说等于没有上下文，删掉不影响语义。
    if (!isMulti && historyForModel.length && historyForModel[0].role === 'assistant') {
      const g = String(character?.greeting || '').trim();
      const c0 = String(historyForModel[0].content || '').trim();
      if (!g || c0 === g || (g && (c0.startsWith(g.slice(0, 16)) || g.startsWith(c0.slice(0, 16))))) {
        historyForModel = historyForModel.slice(1);
      }
    }
    // v1.8.3：上下文太薄时的兜底（见下），拼进 system 最末尾
    let thinContextNote = '';
    {
      const bodies = historyForModel.filter((m) => m.role !== 'system');
      const totalChars = bodies.reduce((n, m) => n + String(m.content || '').replace(/\s/g, '').length, 0);
      const userMsgs = bodies.filter((m) => m.role === 'user');
      const distinct = new Set(userMsgs.map((m) => String(m.content || '').trim()));
      // 历史里有效信息极少（或只有反复重复的同一句）→ 模型会为了"显得有回应"自己编一段不存在的过往
      // （实测：只有三条「300」，模型回「怎么又来？别又像刚才那样说几句就走」——全是幻觉）。
      if (totalChars < 40 || (userMsgs.length >= 2 && distinct.size === 1 && totalChars < 80)) {
        thinContextNote = '【当前上下文很少】对方刚开口（或只说了很短的几句），你只回应这一句本身。'
          + '不要编造"刚才/上次/之前"发生过的任何事，不要提对方没说过的话和没做过的动作；'
          + '可以把话题往下带（问一句、给个反应），但不要假装你们已经聊了很久。';
      }
    }
    // v1.9.2 常驻知识：设置里填的一段文本，每轮都进 system（不参与检索、不吃 knowledgeChars 预算）。
    // 放在角色提示词之后、其它提示之前 —— 位置比"知识库检索结果"靠前一点，
    // 但比后面那些"本轮补充/太短重抽"之类的即时提示靠前（那些必须最后说）。
    // v2.2.0：按窗口动态算历史预算 —— 常驻知识一涨就会把窗口挤爆（Ollama 400 超长）
    const rolePromptChars = String(character?.persona || '').length
      + String(character?.scenario || '').length
      + String(character?.tagline || '').length + 2600;   // 2600 = 固定的规则文本
    const historyBudgetForTurn = dynamicHistoryBudget(config.contextWindow, {
      residentChars: String(config.residentKnowledge || '').length,
      rolePromptChars,
      knowledgeChars: Number(config.knowledgeChars) || 0,
      outputTokens: 400,
    });
    if (historyBudgetForTurn < CONTEXT_BUDGET) {
      console.log(`[budget] 窗口 ${config.contextWindow || '默认'} → 历史预算缩到 ${historyBudgetForTurn} 字（原 ${CONTEXT_BUDGET}）`);
    }
    const residentText = String(config.residentKnowledge || '').trim();
    const residentBlock = residentText
      ? `【常识参考（写动作和生理反应时可以照着用，不要原文复述、不要念资料）】\n${residentText}`
      : '';
    const buildSystem = (extra = {}) => {
      const msgs = buildMessages(
        character, historyForModel, historyBudgetForTurn, config.narrative, { ...buildOpts, ...extra },
      );
      const tail = [residentBlock, thinContextNote].filter(Boolean).join('\n\n');
      if (tail && msgs[0]?.role === 'system') {
        msgs[0] = { role: 'system', content: `${msgs[0].content}\n\n${tail}` };
      }
      return msgs;
    };
    let messages = buildSystem();
    // 重新生成时把上一版喂回去，明确要求换个走向；温度也略微上调一点增加变化。
    const nudge = regenerateNudge(previousReply);
    // 提示一律拼进 system，**不要**当成用户消息塞进去：
    // 模型会把用户消息当"场景里对方说的话"照演/复述（实测它把"不要再拖延"直接写成了台词）。
    // 记下拼过的提示：重抽时如果要"整段摘掉常用语"，得把 messages 重建再把它们拼回去。
    const nudgeHistory = [];
    const withNudge = (extra) => {
      if (!extra) return;
      nudgeHistory.push(extra);
      const first = messages[0];
      messages[0] = { role: 'system', content: `${first.content}\n\n${extra}` };
    };
    const rebuild = (extra = {}) => {
      messages = buildSystem(extra);
      for (const n of nudgeHistory) withNudge(n);
    };
    // 这一轮"是不是在聊常用词那个话题"（v0.57.0）：判断依据只看用户这条消息 + 最近几条历史，
    // 三条都成立才算"不相关"（用户在提问、且消息与最近几轮都没出现词表里的词）。
    const phraseOffTopic = isPhraseOffTopic(
      lastUserText,
      session.messages.slice(-7, -1).map((m) => m.content),
      phraseWords,
    );
    withNudge(nudge);
    // cheats=1：把"接着往下演"的要求也拼进 system（不是用户消息，免得被当台词）
    if (keepGoing) withNudge(continueNudge());
    // 「/ 以谁的身份发」：告诉模型这条是谁说的、它该演谁（同样拼进 system，别当用户消息）
    if (asForTurn) withNudge(asNudge(asForTurn, asOthers));
    const runConfig = {
      ...(nudge ? { ...config, temperature: Math.min(1.2, (config.temperature ?? 0.85) + 0.1) } : config),
      // v1.9.2 上下文窗口要传到请求体（lib/openai.js 会拼成 options.num_ctx）
      contextWindow: config.contextWindow,
      // 多人模式温度略高一点：实测同一个温度下模型更容易复读上一轮的句子
      ...(isMulti ? { temperature: Math.min(1.05, Number(config.temperature ?? 0.7) + 0.08) } : {}),
      // R1 这类：关思考走请求体（think:false），system 里不加 /no_think
      ...(tp.payloadThink ? { think: false } : {}),
      // 附图这一轮临时换**视觉**模型：聊天用的模型多半是纯文本的，发图过去只会报错。
      // 只影响这一轮，下一轮照旧用聊天模型。
      ...(visionPic ? { model: normalizeVisionModel(config.visionModel) } : {}),
    };

    // 「凭空动静」判定只看**对话历史**，绝不带系统提示词：
    // 提示词里为了禁止这类事会提到相关词，一旦算进上下文，
    // 每个事件词都会被当成"上文提过"而全部放行，自动清理就形同虚设了。
    const contextText = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');

    // 附图这一轮：把最后一条用户消息换成 OpenAI 的「文字 + 图片」多段内容。
    // 只动这一轮，历史里其它消息保持纯文本 —— 上面的 contextText 也因此还是纯文本
    //（「凭空动静」判定靠它，喂进去个 [object Object] 会把自动清理搞乱）。
    if (visionPic) {
      const last = messages.at(-1);
      if (last?.role === 'user') {
        last.content = [
          { type: 'text', text: String(last.content || '') },
          { type: 'image_url', image_url: { url: `data:${visionPic.mime};base64,${visionPic.base64}` } },
        ];
      }
    }
    // 上一版角色回复（取历史里最后一条 assistant），用来判断"复读"
    const prevAssistant = previousReply
      || [...session.messages].reverse().find((m) => m.role === 'assistant')?.content
      || '';
    // v1.8.1：最多生成 2 次（用户要求"重抽就 2 次"）。以前是 MAX_ATTEMPTS+1 = 3 次，
    // 再叠加"太短/只一个人"各一次的额外重抽，最坏能跑到 5 次，本地模型会连续空转 30 秒。
    const MAX_TRIES = Number(config.maxTries) > 0 ? Math.min(3, Number(config.maxTries)) : 2;
    // 「写详细但不冗长」：太短就重抽一次（提示词管不住，实测要靠硬门）
    const multiTwoSpeakers = isMulti && castPlan.length >= 2;
    const minReplyChars = isMulti
      ? (multiTwoSpeakers
        ? Math.max(140, Math.round(maxCharsForTurn * 0.56))
        : Math.max(90, Math.round(maxCharsForTurn * 0.45)))
      : Math.max(100, Math.round((maxCharsForTurn || 160) * 0.55));
    // 软下限 = 下限的 80%：低于软下限才值得再抽一次；140 字和 130 字的差距不值 5 秒延迟。
    // 本地小模型（v1.7.9）：不再完全跳过长度门控 —— 实测 qwen3-8b 只写 20~50 字，
    // 所以给它一个更低的软下限（60 字），太短就带提示重抽一次。它是本地推理（1~2 秒），
    // 多抽一次的代价比云端小得多。
    // v1.8.1：本地模型**不再限字数**（用户要求）—— 太短也不重抽、提示词里也不写字数要求。
    // 之前 60 字软下限让 8B 反复重抽，遇到"300"这种极短输入会连续 5 次吐空。
    const softMinChars = localBackend
      ? 0
      : (multiTwoSpeakers ? minReplyChars : Math.round(minReplyChars * 0.9));
    let shortRetry = false;
    const QUALITY_GATE = 4; // 分够了就再来一版（0 分 = 很干净）
    // 「动作开头」要往末尾追加一条 assistant 消息；如果历史**本身就以角色回复结尾**
    // （cheats=1 接着演、或任何原因），再追加一条就变成"末尾两条 assistant"，
    // OpenAI 兼容接口会直接 400（实测：`Cannot have 2 or more assistant messages at the end`）。
    const endsWithAssistant = session.messages.at(-1)?.role === 'assistant';
    // 附图这一轮**强制**用「动作开头」前缀：实测思考型 VL 模型不带前缀会把 2200 tokens
    // 全花在思考上、content 直接是空的（21.5 秒什么都没出）；带上前缀 1.4 秒给出 461 字，
    // 质量还更好。所以这里不看 forceAction 开关。
    const usePrefill = (config.forceAction !== false || Boolean(visionPic)) && !endsWithAssistant;

    let lastText = '';
    let lastAttemptReasoning = '';   // 最近一版生成的思考过程（DeepSeek V4 的 reasoning_content）
    let replyReasoning = '';         // 最终写进会话那一版的思考过程
    let turnUsage = null;            // 本轮总用量（含重抽的每一版）
    let usageEstimated = false;      // 用量是否为本地估算（没有 usage 字段时）
    let best = null;
    let cleanedInfo = null;
    let retryInfo = null;
    const rejectedExtra = []; // 截断/清理前的原文，统一并进「已否决」

    // 卡住保护：多久收不到任何新内容就认定"模型卡住了"，掐掉并报错，
    // 免得界面一直转圈什么都不说（实测遇到过 llama-server 内部出错、几十秒才返回）。
    // WORKBENCH_IDLE_MS 只是给测试用的临时覆盖。
    const IDLE_MS = Number((process.env.WORKBENCH_IDLE_MS || process.env.XINGYE_IDLE_MS)) > 0 ? Number((process.env.WORKBENCH_IDLE_MS || process.env.XINGYE_IDLE_MS)) : 90000;

    // 生成一版。带 prefill 时末尾会多送一条 assistant 前缀，模型必须从动作开头续写；
    // 若服务端不接受这种末尾 assistant 消息（返回 4xx），自动去掉前缀重来一次。
    // 每次尝试都有自己的 AbortController：用户点停止、卡住超时、复读截断三者互不干扰。
    const runAttempt = async (prefill) => {
      const ctl = new AbortController();
      const onUserAbort = () => ctl.abort();
      controller.signal.addEventListener('abort', onUserAbort, { once: true });

      let idle = null;
      let idleHit = false;
      let loopHit = null;
      let dupHit = null;
      let acc = '';
      let attemptReasoning = '';
      const onUsage = (u) => {
        const n = normUsage(u);
        if (n) turnUsage = addUsage(turnUsage, n);
      };
      // 思考过程（v1.5.1）：云端 DeepSeek V4 的 reasoning_content 边收边推给前端，
      // 生成完再随消息落盘，界面上「💭 思考」按钮能回看。
      const onReasoning = (t) => {
        if (!t) return;
        armIdle();
        attemptReasoning += t;
        send('reasoning', { text: t });
      };
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { idleHit = true; ctl.abort(); }, IDLE_MS);
      };
      const onDelta = (delta) => {
        armIdle();
        acc += delta;
        send('delta', { text: delta });
        if (loopHit || dupHit) return;
        // 边收边查两种退化：① 紧挨着的复读 ② 把前面写过的一整句又写一遍
        const hit = detectTailLoop(acc);
        if (hit) { loopHit = hit; ctl.abort(); return; }
        const dup = detectDuplicateSentence(acc);
        if (dup) { dupHit = dup; ctl.abort(); }
      };

      armIdle();
      try {
        if (!prefill) return { text: await streamChat({ config: runConfig, messages, signal: ctl.signal, onDelta, onReasoning, onUsage }) };
        try {
          return { text: await streamChat({ config: runConfig, messages, prefill, signal: ctl.signal, onDelta, onReasoning, onUsage }) };
        } catch (err) {
          if (err instanceof OpenAIError && err.status >= 400 && err.status < 500) {
            return { text: await streamChat({ config: runConfig, messages, signal: ctl.signal, onDelta, onReasoning, onUsage }) };
          }
          throw err;
        }
      } catch (err) {
        // 复读 → 用截断后的文本当这一版的结果，同时把复读全文留档给「已否决」
        if (loopHit) {
          const cut = cutLoop(acc, loopHit);
          send('replace', { text: cut, note: describeLoop(loopHit) });
          return { text: cut, loopRaw: acc, loopNote: describeLoop(loopHit) };
        }
        // 整句重复 → 在重复处截断，只留第一遍
        if (dupHit) {
          const cut = cutDuplicate(acc, dupHit);
          const note = '检测到整句重复，已在重复处截断';
          send('replace', { text: cut, note });
          return { text: cut, loopRaw: acc, loopNote: note };
        }
        if (idleHit) {
          throw new OpenAIError(
            `模型 ${Math.round(IDLE_MS / 1000)} 秒没有输出任何内容，已中断。多半是模型卡住或正在加载，重发一次通常就好。`,
            504,
          );
        }
        // 已经收到完整内容、只是连接在流末被上游硬关掉（llama-server 不发 [DONE]）：
        // 当成这一版的正常结果，别让用户看到「回复显示出来了 + 一条网络错误」。
        // 主动中止（含同一会话发来新消息时中止旧的）不该报成网络错误
        if (controller?.signal?.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          e.partial = String(acc || '');
          throw e;
        }
        console.error('[gen-err]', JSON.stringify({
          name: err?.name, code: err?.code, status: err?.status,
          msg: String(err?.message || '').slice(0, 120),
          aborted: Boolean(controller?.signal?.aborted), accLen: String(acc || '').length,
        }));
        if (String(acc || '').trim() && /ECONNRESET|EPIPE|terminated|socket hang up|other side closed/i.test(String(err?.code || '') + String(err?.message || ''))) {
          return { text: acc };
        }
        throw err;
      } finally {
        lastAttemptReasoning = attemptReasoning;
        clearTimeout(idle);
        controller.signal.removeEventListener('abort', onUserAbort);
      }
    };

    // 最多生成 MAX_TRIES 次：第一条如果质量偏低（凭空造事 / 拖延 / 雷同 / 以问句收尾…），
    // 就带着对应的提示重来，最后取分数最低的那一版。写进历史前仍会清掉凭空动静。
    // 每一版都留着（attempts），落选的进「已否决」，方便你事后翻出来看或改用。
    const attempts = [];
    const MAX_ATTEMPTS = Math.max(MAX_TRIES, 2); // 基础次数；额外只给"太短/只一个人"各一次
    const ATTEMPT_LIMIT = localBackend ? 2 : MAX_ATTEMPTS + 1;  // 本地模型最多 2 次，别空转
    let stuffedRetry = null;   // 上一版"硬凑常用词"时，记下塞进来的词（重抽时用来提示 + 摘掉常用语段）
    let lengthRetries = 0;     // 因"太短"重抽了几次
    let emptyRetries = 0;      // 因"空回复"重抽了几次
    let castRetries = 0;       // 多人卡因"只一个人说话"重抽了几次
    let castRetry = false;
    let longest = null;        // 如果所有版本都不够长，最后退而求其次选最长的一版
    for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
      if (attempt > 0) {
        send('reset', { reason: 'quality' }); // 让界面把上一版擦掉，重新打一遍
        // 按上一版被淘汰的原因挑提示：人称问题就用【人称错了】，
        // 否则模型只会收到"不要拖延"，而它这次犯的其实不是拖延（实测提示不对症时重抽也白搭）。
        // 注意这里匹配的是 replyQuality 的 reasons 原文（'用他/她写自己'），
        // 别写成"人称"就以为能中 —— 那条 reason 里根本没有"人称"两个字（踩过）。
        const why = (retryInfo?.reasons || []).join(' ');
        // 多人卡这一轮只有一个人说话（v1.6.0）
        if (castRetry) {
          castRetry = false;
          castRetries += 1;
          withNudge(castNudge(castPlan.length ? castPlan : (asForTurn ? castNames.filter((n) => n !== asForTurn) : castNames)));
        } else if (shortRetry) {
          shortRetry = false;
          withNudge(detailNudge(localBackend ? softMinChars + 20 : minReplyChars, lastText.replace(/\s/g, '').length));
        } else if (stuffedRetry) {
          skipPhrases = true;
          rebuild({ skipPhrases: true });
          withNudge(stuffedNudge(stuffedRetry));
          stuffedRetry = null;
        } else {
          withNudge(/写自己|第三人称/.test(why) ? personNudge()
            : /空动作/.test(why) ? clicheNudge()
              : antiStallNudge());
        }
      }

      const prefill = usePrefill ? openingPrefill(character, attempt) : '';
      let res;
      try {
        res = await runAttempt(prefill);
      } catch (err) {
        // 云端偶发空回复（只出了思考、正文空）或网络抖动（连接失败/超时）：
        // 别直接报错给用户，等 2 秒重抽一次（用户要求断网时循环重连）。
        const msg = String(err?.message || '');
        const empty = err instanceof OpenAIError && /没有返回任何内容|没有产出内容/.test(msg);
        const networkish = err instanceof OpenAIError
          && (err.status === 502 || err.status === 504 || /连接|ECONNRESET|ETIMEDOUT|timeout|socket|network|fetch failed/i.test(msg));
        if ((empty || networkish) && attempt < ATTEMPT_LIMIT - 1) {
          send('reset', { reason: empty ? 'empty' : 'network' });
          retryInfo = { score: 0, reasons: [empty ? '空回复' : '网络抖动'] };
          if (!empty) await new Promise((r) => setTimeout(r, 2000 + attempt * 1500));
          withNudge(antiStallNudge());
          continue;
        }
        throw err;
      }
      let text = res.text;
      // 模型刚写完前缀就停（这一版等于没内容）：去掉前缀再抽一次，不要白等。
      // 但**附图那一轮不能这么退**：思考型 VL 模型没有前缀就是 20 秒空转，
      // 不如直接进下一轮重抽（openingPrefill 每次给的前缀不一样）。
      if (prefill && !text.trim() && !visionPic) { res = await runAttempt(''); text = res.text; }
      lastText = text;
      if (!text.trim()) continue;

      const rawText = text; // 清理之前的原文，留档
      // 先规整星号/括号（模型常把 * 写成 ) 收尾、半角全角混着用），
      // 再把动作段里的人称掰回第一人称（"*<角色名>的声音…*" → "*我的声音…*"），
      // 最后清凭空动静 —— 顺序很重要：规整后括号才是统一的（），后面的判定才准。
      const notes = [];
      // v1.9.6：空回复（模型一个字都没吐，或只吐了个 </think>）→ **自动重抽**，
      // 以前这种版本会一路走到最后的"只写了 0 个字"报错，白等一轮。
      if (!String(text || '').replace(/[\s<>\/think]/gi, '').length && attempt < ATTEMPT_LIMIT - 1) {
        emptyRetries += 1;
        retryInfo = { score: 0, reasons: ['空回复'] };
        send('reset', { reason: 'empty' });
        continue;
      }
      const afterMarkup = normalizeMarkup(text, { keep: [character?.name] });
      const afterPerson = normalizePerson(afterMarkup, character?.name);
      if (afterMarkup !== text) notes.push(describeMarkup());
      if (afterPerson !== afterMarkup) notes.push('已把动作里的人称改回第一人称');
      text = afterPerson;
      // v1.8.4：R1 这类「思考即输出」的模型会把思考段直接写在正文前面，中间用空行隔开。
      // v2.3.5：**不再只给 R1 用**。实测 Qwen3 微调版（v7k / emerv）也会在正文前吐
      //   空的 </>、<>、↑、- 这类碎片，老代码因为 r1NoThink=false 整个跳过，
      //   结果 "<>\n\n我还没问呢" 原样写进历史（用户看到开头两个尖括号）。
      //   stripLeadingReasoning 内部只剥"明显的标记/符号垃圾"，正常回复（以（）或汉字开头）
      //   一个字符都不会动，所以对普通模型是安全的。
      {
        const sr = stripLeadingReasoning(text);
        if (sr.cut) {
          text = sr.text;
          notes.push(r1NoThink ? '已剥掉模型写在正文前的思考段' : '已剥掉回复开头的标记残留');
        }
      }
      // v1.8.2：Qwen3 偶尔只吐 "</think>"（思考标记残留），整段没有任何台词 —— 当作空回复处理，
      // 交给上面的重抽逻辑，而不是把 "</think>" 当回复写进历史。
      if (/^\s*(<\/?think>|\/think>|思考[:：])?\s*$/i.test(text) || /^\s*<\/think>/.test(text)) {
        const rest = text.replace(/^\s*<\/think>\s*/i, '').trim();
        if (!rest) { text = ''; }
        else { text = rest; }
      }
      // 模型自己往下写 "user\n…" 接着扮演你 → 在标记处截断（stop 词兜不住时这里补）
      const rl = stripRoleLeak(text);
      if (rl.cut) {
        if (!rl.text) { text = ''; }
        else { text = rl.text; notes.push('已截掉漏进来的角色标记'); }
      }
      // 删掉"万能小动作"（*我低头一笑，手指蘸了蘸…* → *手指蘸了蘸…*）。
      // 提示词管不住这类空动作（给任何具体样例都会被照抄），所以这里直接删。
      const clicheCount = countClicheActions(text);
      if (clicheCount) {
        const stripped = stripClicheActions(text);
        if (stripped.trim().length >= 8) {
          text = stripped;
          notes.push(describeCliche(clicheCount));
        }
      }

      let cleanedNote = '';
      if (config.autoClean !== false) {
        const fixed = sanitizeReply(text, contextText);
        if (fixed.cleaned.length) {
          cleanedInfo = fixed.cleaned;
          cleanedNote = describeCleaned(fixed.cleaned);
          text = fixed.text;
          notes.push(cleanedNote);
        }
      }
      // v2.1.4：解剖术语 → 口语（"小阴唇底下"这种提示词管不住，这里兜底）
      {
        const at = fixAnatomyTerms(text, { characterName: character?.name, persona: character?.persona });
        if (at.changed) { text = at.text; notes.push(`已把术语改成口语（${[...new Set(at.hits)].slice(0, 3).join('、')}）`); }
      }
      // v2.0.1：「您」→「你」（太生分，除非角色设定就是要敬称）
      {
        const fy = fixFormalYou(text);
        if (fy.changed) { text = fy.text; notes.push('已把「您」改成「你」'); }
      }
      // v1.9.5：单人卡里把指代对方的「他/她」改成「你」（模型偶尔退回第三人称）
      if (!isMulti) {
        const tp = fixThirdPersonForUser(text, { characterName: character?.name });
        if (tp.changed) {
          text = tp.text;
          notes.push('已把指代你的"他/她"改成"你"');
        }
      }
      // v1.2.2：模型爱"替用户演"（"你按下了按钮"）。这里把旁白里属于用户的动作/心理删掉。
      // 不受「自动清洗」开关影响 —— 用户明确要求不要替他写动作。
      const userAct = stripUserActions(text);
      if (userAct.changed) {
        text = userAct.text;
        notes.push(userAct.note);
      }
      if (notes.length) {
        send('replace', { text, cleaned: cleanedInfo ? cleanedInfo.length : 0, note: notes.join('；') });
      }

      // 最后落实字数上限：提示词里说了不算，这里按句号裁（不切断半句），
      // 裁掉的部分留档给「已否决」，想换回来随时能换。
      const limited = localBackend ? { text, trimmed: false } : trimToLimit(text, maxCharsForTurn);
      if (limited.trimmed) {
        text = limited.text;
        rejectedExtra.push({
          text: rawText,
          reason: describeTrim(text.length, rawText.length),
          source: 'trim',
          at: Date.now(),
        });
        send('replace', { text, note: describeTrim(text.length, rawText.length) });
      }

      // 多人卡：这一轮**一个人都没开口**（模型把「名字：」格式丢了）才重抽。
      // v1.7.2：是否全员说话改由几率决定（castSpeakChance），不再逼"必须有 2 个人说话"。
      const castGateNames = asForTurn ? castNames.filter((n) => n !== asForTurn) : castNames;
      if (!localBackend && isMulti && castGateNames.length >= 1 && castRetries < 1 && attempt < MAX_ATTEMPTS - 1) {
        const spk = new Set((parseReplyLines(text, castNames) || []).map((x) => x.speaker).filter(Boolean));
        const castSpk = [...spk].filter((n) => castGateNames.includes(n));
        if (!castSpk.length) {
          castRetry = true;
          retryInfo = { score: 0, reasons: ['没有一个角色说话'] };
          send('reset', { reason: 'cast' });
          continue;
        }
      }
      // 太短 → 重抽（最多 2 次；最后一版不再折腾，避免死循环）
      const gotLen = String(text || '').replace(/\s/g, '').length;
      if (softMinChars > 0 && gotLen < softMinChars && lengthRetries < 1 && attempt < ATTEMPT_LIMIT - 1) {
        shortRetry = true;
        lengthRetries += 1;
        retryInfo = { score: 0, reasons: ['太短'] };
        send('reset', { reason: 'short' });
        continue;
      }

      const q = replyQuality(text, { previousReply: prevAssistant, contextText, characterName: character?.name, originalText: rawText });
      // 「/ 以谁的身份发」：模型如果只演了用户正在演的那个角色（陈梦），这一版等于没演别人。
      // 加高分让它重抽；最后一版仍然如此就在下面报错（别把"用户自己"的台词当成回复存下来）。
      if (asForTurn) {
        const asSegs = parseReplyLines(text, castNames);
        if (asSegs.length && !asSegs.some((x) => x.speaker && x.speaker !== asForTurn)) {
          q.score += 6;
          q.reasons.push(`这一轮只演了「${asForTurn}」（用户在演这个角色）`);
        }
      }
      // 硬凑常用词（v0.57.0）：这一轮明明不是在聊这个话题（用户在提问/说明，且最近几轮都没出现这些词），
      // 回复里却塞进了词表里的词 —— 那就是为了凑频率硬塞的。
      // 处置：**这一版直接算落选**（进「已否决」，不参与 best 比较）+ 摘掉常用语整段 + 明确告诉它为什么退，重抽一次。
      // ⚠ 不能只是"重抽后比较分数"：塞词那版往往分数并不差（实测 score 0），
      //   按分数取最好会把硬塞的那版又捞回来（这一版第一遍实现就栽在这儿，被冒烟测试抓出来了）。
      const stuffed = phraseOffTopic ? stuffedPhrases(text, phraseWords) : [];
      if (stuffed.length && attempt < MAX_TRIES - 1 && config.autoClean !== false) {
        rejectedExtra.push({
          text: rawText,
          reason: `硬凑常用词（${stuffed.join('、')}）：这一轮话题不相关`,
          source: 'stuffed',
          at: Date.now(),
        });
        retryInfo = { score: q.score, reasons: [`硬凑常用词（${stuffed.join('、')}）`] };
        stuffedRetry = stuffed;
        continue;
      }
      attempts.push({ text, raw: rawText, cleanedNote, q, loopRaw: res.loopRaw, loopNote: res.loopNote, reasoning: lastAttemptReasoning });
      // 同分时**挑内容更全的**，别让 `*我*` 这种半截版赢过长回复。
      // （旧逻辑只有 q.score 一个维度：两版都是 0 分时，先来的赢 ——
      //  重抽碰巧先吐出个空壳，整轮就只剩 "*我*"，看着就是"回了一点点就没了"。）
      const lenNow = String(text || '').replace(/\s/g, '').length;
      if (lenNow >= softMinChars) {
        const fuller = best && q.score === best.q.score && text.length > best.text.length * 1.3;
        if (!best || q.score < best.q.score || fuller) best = { text, q, reasoning: lastAttemptReasoning };
      } else if (!longest || lenNow > longest.len) {
        longest = { text, q, reasoning: lastAttemptReasoning, len: lenNow };
      }
      if (stuffed.length) {
        notes.push(`话题不相关却出现常用词（${stuffed.join('、')}）—— 已是最后一版，保留原样`);
      }
      if (attempt < MAX_TRIES - 1 && config.autoClean !== false && q.score >= QUALITY_GATE) {
        retryInfo = q;
        continue; // 质量不够 → 再生成一版
      }
      break;
    }

    if (!best && longest) {
      console.log(`[gen] 所有版本都不足 ${minReplyChars} 字：取最长 ${longest.len} 字`);
      best = longest; // 所有版本都没到字数下限：选最长的那版
    }
    if (!best) {
      throw new OpenAIError(`模型这次没有产出内容（试了 ${ATTEMPT_LIMIT} 次）。可以再点一次发送，或换一个模型试试。`, 502);
    }
    // 硬下限：只有 `*我轻哼一声*` 这种空壳时，宁可报错让你重抽，
    // 也不把它当答案写进历史 —— 写进去下一轮又会因为"与上一轮雷同"被判低分，
    // 越滚越短（实测就这样退化成只剩 `*我*` + 一句环境）。
    // v1.9.6：0 个字时说得更准 —— 这不是"写得太短"，是模型一个字都没吐出来
    //（常见原因：输出被特殊 token 吃掉、或提示词太长把输出预算挤没）。别让用户以为是重抽能好的事。
    const bareLen = best.text.replace(/\s/g, '').length;
    if (bareLen === 0) {
      throw new OpenAIError(
        '模型这次一个字都没输出（不是写得太短，是空回复）。'
        + '常见原因：①提示词太长（常驻知识 + 历史把输出预算挤没了）②模型刚加载还没热起来。'
        + '可以再点一次发送，或把「设置 → 常驻知识」暂时关掉试试。',
        502,
      );
    }
    // v2.3.3：硬下限按角色可调。原来写死 14 字，可"冷淡话少"这类人设
    // 本来就该一两句话就完事（实测阿梅那张卡："（看表）三百。" 7 个字），
    // 被这道门槛直接判死、重抽还是短、最后报错 —— 用户看到的就是"这角色老是回不出东西"。
    // 角色卡里把 `allowShort` 设成 true 就只拦"空壳"（<4 字），不再要 14 字。
    const minBare = character?.allowShort === true ? 4 : 14;
    if (bareLen < minBare) {
      throw new OpenAIError(
        `模型这次只写了 ${bareLen} 个字（${best.text.slice(0, 20)}），内容不完整，已放弃这一版。再点一次重抽通常就好。`
        + '（如果这个角色本来就该说话很短，可以在角色卡里打开「允许短回复」。）',
        502,
      );
    }
    let reply = best.text;
    replyReasoning = best.reasoning || lastAttemptReasoning || '';
    // 以身份发送却只得到"用户自己"的台词：宁可让用户重抽，也不把角色演错
    if (asForTurn) {
      const segs = parseReplyLines(reply, castNames);
      if (segs.length && !segs.some((x) => x.speaker && x.speaker !== asForTurn)) {
        throw new OpenAIError(
          `模型这一轮只演了「${asForTurn}」（那是你正在演的角色），没让其他人物接话。再点一次重抽通常就好。`,
          502,
        );
      }
    }
    // 最后一手（v0.39）：模型连着几版都用第三人称写自己，而这条回复又没标台词
    // （光秃秃的文字可能是旁白、也可能是台词，normalizePerson 前面不敢动）。
    // 到这一步就按旁白**强制**掰回来 —— 宁可冒"改坏某句台词"的风险，
    // 也不让"她/他"当自称留在屏幕上（这是最出戏的一类，用户明确要求彻底解决）。
    // 掰之前的原文进「已否决」，想换回来随时能换。
    let personNote = '';
    if (thirdPersonSubjects(reply).length) {
      const forced = normalizePerson(reply, character?.name, { aggressive: true });
      if (forced !== reply) {
        rejectedExtra.push({
          text: reply,
          reason: '人称：强制掰回第一人称前的原文',
          source: 'person',
          at: Date.now(),
        });
        reply = forced;
        personNote = '已把第三人称强制掰回第一人称';
      }
    }
    // 多人卡：模型偶尔还是会写「（陈梦）台词」，落盘 / 分段前统一成「陈梦：台词」。
    // 这样 segments 的说话人才认得出来，也免得历史里又攒一堆括号写法继续传染。
    if (isMulti) {
      const fixed = normalizeCastSpeaker(reply, cast);
      if (fixed !== reply) {
        rejectedExtra.push({ text: reply, reason: '多人格式：括号说话人改成「名字：」前的原文', source: 'format', at: Date.now() });
        reply = fixed;
      }
      // 云端/大模型常把两人写在同一行（罗启：… 陈梦：…），拆成多行才能分气泡
      reply = splitInlineSpeakers(reply, castNames);
      // 「/ 以谁的身份发」：用户演的那个人，模型不该替他/她说话。
      // 模型偶尔还是会把用户角色的台词写出来 → 只保留其他人物的段落（原文进「已否决」）。
      if (asForTurn) {
        const segs = parseReplyLines(reply, castNames);
        const others = segs.filter((x) => x.speaker && x.speaker !== asForTurn);
        if (others.length && others.length < segs.filter((x) => x.speaker).length) {
          rejectedExtra.push({
            text: reply,
            reason: `身份发送：去掉模型替「${asForTurn}」写的话`,
            source: 'speaker',
            at: Date.now(),
          });
          reply = others.map((x) => `${x.speaker}：${x.text}`).join('\n');
        }
      }
    }
    if (retryInfo) {
      send('replace', { text: reply, note: [describeQuality(retryInfo.reasons), personNote].filter(Boolean).join('；') });
    } else if (personNote) {
      send('replace', { text: reply, note: personNote });
    }

    // 收集「已否决」的版本（最近的在前面），上限 5 条，别让会话文件无限膨胀。
    const rejected = [...rejectedExtra];
    if (previousReply) {
      rejected.push({
        text: previousReply,
        reason: String(rejectedReason || '').trim().slice(0, 40) || '重新生成前的一版',
        source: 'regen',
        at: Date.now(),
      });
    }
    for (const a of attempts) {
      // 复读被截断的那一版：把**截断前的全文**留档，方便你确认它到底重复成什么样
      if (a.loopRaw) {
        rejected.push({ text: a.loopRaw, reason: a.loopNote || '复读被截断前的全文', source: 'loop', at: Date.now() });
      }
      if (a.text === reply) continue;
      if (a.cleanedNote) {
        rejected.push({ text: a.raw, reason: `清理前：${a.cleanedNote}`, source: 'cleaned', at: Date.now() });
      }
      rejected.push({
        text: a.text,
        reason: a.q.reasons.length ? describeQuality(a.q.reasons) : '质量更低的一版',
        source: 'quality',
        at: Date.now(),
      });
    }
    if (best.cleanedNote) {
      const b = attempts.find((a) => a.text === reply && a.cleanedNote);
      if (b) rejected.push({ text: b.raw, reason: `清理前：${b.cleanedNote}`, source: 'cleaned', at: Date.now() });
    }

    // 本地模型/不支持 usage 的接口：按字数估算（前端会标「≈」）
    if (!turnUsage) {
      const inChars = (() => { try { return JSON.stringify(messages).length; } catch { return 0; } })();
      const outChars = reply.length + (replyReasoning ? replyReasoning.length : 0);
      turnUsage = {
        input: estTokens(inChars), output: estTokens(outChars),
        reasoning: replyReasoning ? estTokens(replyReasoning.length) : 0,
        cached: 0,
        total: estTokens(inChars) + estTokens(outChars),
      };
      usageEstimated = true;
    }
    // 先把本轮用量推给前端（聊天下方的状态条立刻更新）
    send('usage', { usage: turnUsage, estimated: usageEstimated });

    // cheats=1（接着演）时**合并进上一条角色回复**，而不是新开一条：
    // 两条连续的 assistant 消息是非法的（会让这个会话之后每次都 400），
    // 而且语义上本来就是"同一条回复被往下写了一段"。
    const tail = session.messages[session.messages.length - 1];
    const sources = toSources(sRes.results);
    if (keepGoing && tail && tail.role === 'assistant') {
      tail.content = `${tail.content}\n\n${reply}`;
      tail.at = Date.now();
      if (isMulti) tail.segments = parseReplyLines(tail.content, castNames);
      if (replyReasoning) tail.reasoning = [tail.reasoning, replyReasoning].filter(Boolean).join('\n\n');
      if (turnUsage) {
        tail.usage = addUsage(tail.usage, turnUsage);
        if (usageEstimated) tail.usageEstimated = true;
      }
      if (rejected.length) tail.rejected = [...(tail.rejected || []), ...rejected].slice(0, 5);
      // 接着演的那一轮如果搜了，来源也并进这条（前端在气泡下显示「🌐 来源 N」）
      if (sources.length) tail.sources = sources;
    } else {
      session.messages.push({
        role: 'assistant',
        content: reply,
        at: Date.now(),
        // 多人卡：把回复拆成 [{speaker, text}]，前端按人物分气泡显示。
        // 单角色不存这个字段，渲染逻辑完全不变。
        ...(isMulti ? { segments: parseReplyLines(reply, castNames) } : {}),
        // v1.9.0 日常强化：把这一轮**实际喂给模型的消息**存到这条回复上，
        // 打 w 分时直接用它当"当时的上文"落盘（会话后面还会变，事后还原不出来）。
        // 只在开着强化开关时才存，别平时也把 prompt 复制一份进会话文件。
        ...(config.rlEnabled === true ? { rlPrompt: promptSnapshot(messages) } : {}),
        // v2.3.4：默认不存思考过程（config.showReasoning 才存）。
        // 不存的好处：① 聊天页不会突然展开一大段"金额是交易的基础…"的哲学废话
        //            ② 会话文件小一截 ③ 后面导训练数据时也不会把思考混进正文
        ...(replyReasoning && config.showReasoning === true ? { reasoning: replyReasoning } : {}),
        ...(turnUsage ? { usage: turnUsage, ...(usageEstimated ? { usageEstimated: true } : {}) } : {}),
        ...(sources.length ? { sources } : {}),
        ...(rejected.length ? { rejected: rejected.slice(0, 5) } : {}),
      });
    }
    await saveSession(session);
    // 本地 Ollama：**每轮生成完都要重新按一遍 keep-alive**。
    // 为什么不能只靠请求体里那个 keep_alive：Ollama 的 OpenAI 兼容端点
    // (/v1/chat/completions) 会**直接忽略**这个字段（实测：发了 '5m'，expires_at 纹丝不动），
    // 于是它退回服务端默认值（我们设的 OLLAMA_KEEP_ALIVE=2m）→ 你以为点了「不关闭」，
    // 模型照样两分钟卸载。只有原生 /api/generate 认这个值（实测 -1 → 永久生效）。
    if (config.keepAlive !== null && config.keepAlive !== undefined && localOllamaBase(config)) {
      ollamaSetKeepAlive(config, config.keepAlive).catch(() => { /* 按不上就算了，不影响回复 */ });
    }
    send('done', {
      title: session.title,
      cleaned: cleanedInfo ? cleanedInfo.length : 0,
      rejected: rejected.length,
    });
  } catch (err) {
    if (err.name === 'AbortError' || clientGone()) {
      // 用户中途停止：把已经生成的部分存下来，不要丢。
      restoreDropped();
      await saveSession(session);
      send('done', { title: session.title, aborted: true });
    } else {
      // 上游报错同理：重新生成时摘下来的那一版至少要放回去，别被一次报错吃掉。
      restoreDropped();
      // v1.8.3：生成失败 → 把这次新加的那条用户消息撤回。
      // 用户看到报错会再发一次，如果不撤回，历史里就会堆上一堆重复的同句话。
      if (addedUserMsg) {
        for (let i = session.messages.length - 1; i >= 0; i -= 1) {
          const m = session.messages[i];
          if (m.role === 'user' && m.content === addedUserMsg) { session.messages.splice(i, 1); break; }
        }
        if (session.title === addedUserMsg.slice(0, 18) && !session.messages.some((m) => m.role === 'user')) {
          session.title = '新的对话';
        }
      }
      await saveSession(session);
      send('error', { error: err instanceof OpenAIError ? err.message : String(err.message || err) });
    }
  } finally {
    // 聊天结束：把这次临时停掉的 ComfyUI 之类服务排队恢复（2 分钟没新消息才动）
    if (gpuState?.stoppedServices?.length) scheduleGpuRestore(gpuState.stoppedServices);
    else cancelGpuRestore();
    res.end();
  }
}

/**
 * 直连模式最终发出去的 messages。
 *
 * 默认**只有这个会话本身**（一条 system 都没有）。设置里给直连模式填了东西才注入：
 *   - 常用语 / 口头禅（原有）
 *   - 维度（directDims）、微调提示（directHint）、场景备忘（directMemo）—— 都是直连自己那一份，
 *     跟角色模式的 dims/hint/memo **互不干扰**（这是刻意的：改直连不该动到角色卡）
 *
 * 顺序：备忘在最后（它是"既成事实"，离当前对话最近），前面依次是常用语、维度、提示。
 *
 * 注意：「重新生成」那一轮额外加的"换一个走向"提示**不在这里** —— 它按次请求生成，
 * 由 handleDirectChat 自己拼（见那里的 regenerateNudge），所以这个预览接口看到的
 * 始终是"普通一轮会发出去的东西"。
 */
function directPayload(history, config, opts = {}) {
  // 直连模式的资料库（v0.60.0）：直连会话没有角色，所以单独一份 _direct.md。
  // 默认**还是零注入** —— 没放资料、或 knowledgeChars 预算为 0 时，这里什么都不加。
  // 和角色模式用同一个 knowledgeBlock 包装（"只作参考，不是台词"），行为一致好理解。
  const knowBlock = Array.isArray(opts.knowledge) && opts.knowledge.length
    ? knowledgeBlock(opts.knowledge)
    : '';
  // 资料库非空、但这一轮没挑中相关块时，明确告诉模型"没有资料"，
  // 免得它拿自己的记忆硬答（实测会编具体数字/人名）。
  const noKnowBlock = (!knowBlock && opts.knowledgeEmptyReason) ? noKnowledgeBlock() : '';
  // 联网搜索（v0.62.0）：开着才有这一段，关着时是空串 —— 直连模式"零注入"的默认不变。
  const searchBlock = webSearchBlock(opts.search, { maxChars: opts.searchChars });
  const parts = [
    // 资料库放在最前：先给"事实底座"，后面才是语用偏好（常用语/提示/备忘）
    knowBlock,
    noKnowBlock,
    // 网页结果紧跟资料库：同属"参考资料"层，排在常用语/提示/备忘这些语用偏好之前
    searchBlock,
    // opts.skipPhrases：这一版不注入常用语（模型硬塞常用词时重抽用，见 handleDirectChat）
    opts.skipPhrases ? '' : directPhrasesBlock(config?.directPhrases, config?.directPhraseLevel),
    // ⚠ v0.54.0：**直连不再注入维度**（用户要求）。
    // 维度是角色扮演的「笔墨比重」（动作 5/10、神态 5/10…），塞进直连的无提示词对话里
    // 会把模型往演戏方向带 —— 用户实测"直连里问东西感觉变差"就是这个原因。
    // 字段还留着只是为了能把历史值干净地清掉，见 lib/store.js 的注释。
    hintBlock(config?.directHint),
    // 等义词：默认只教"听懂"；行尾标了 `#输出`（或全局开关 synonymsOutput）的条目
    // 还会要求模型**回答时也用这些说法**（v0.56.0）
    synonymsBlock(config?.directSynonyms, { output: config?.synonymsOutput === true }),
    memoBlock(config?.directMemo),
  ].filter(Boolean);
  // 「关掉思考」：直连模式平时零注入，但 Qwen3 这代不关思考会先把 2000+ 字思考写完
  //（还挤掉正文），所以开了这个开关就必须给一段 system（只有 /no_think）。
  // 「关掉思考」：直连模式平时零注入，但思维模型不关会先把一大段思考写完
  //（还挤掉正文）；实现按模型分派（Qwen3 → /no_think，R1 → 请求体 think:false）。
  if (config?.thinkOff && thinkPlan(config).systemInject) parts.push(NO_THINK);
  const messages = directMessages(history);
  return parts.length ? [{ role: 'system', content: parts.join('\n\n') }, ...messages] : messages;
}

/**
 * 「直连模式」：一条系统提示词都不加，把这个会话原样发给模型。
 *
 * 跟 handleChat 的区别就是这条模式存在的理由：
 *   - 没有角色卡 / system 提示词（叙事推进、维度、微调提示、场景备忘、资料库全不参与）
 *   - 不做角色模式那套后处理：不清洗、不检测出戏、不按质量重抽 —— 模型回什么就存什么
 *   - 只有「工作时段锁」和「停止生成」跟角色模式保持一致
 * 长度兜底仍然共用 lib/openai.js 的 max_tokens 上限。
 *
 * 直连模式**故意**保留的两处"像角色模式"的行为，都是用户明确要的、且都需要你主动触发：
 *   ① 设了 directMaxChars 就按句号截断（截掉的部分留档进「已否决」）
 *   ② 点「重新生成」时把上一版喂回去要求换个走向（上一版同样进「已否决」）
 * 不设、不点，就仍然是零注入的一条 system 都没有。
 */
async function handleDirectChat(req, res) {
  let body;
  try {
    body = await readBody(req, VISION_IMAGE_MAX + 512 * 1024);
  } catch (err) {
    return sendJson(res, 413, { error: `请求体太大或不是合法 JSON：${err.message}` });
  }
  const { sessionId, content, regenerate, rejectedReason, image } = body;
  const session = await getSession(sessionId);
  if (!session) return sendJson(res, 404, { error: '会话不存在' });
  if (session.kind !== 'direct') return sendJson(res, 400, { error: '这不是直连会话（直连模式不经过角色卡）' });

  const config = await getConfig();
  let gpuStateDirect = null;
  if (localOllamaBase(config) && config.gpuArbiter !== false) {
    cancelGpuRestore();
    try {
      gpuStateDirect = await arbitrateForChat({ needGB: 1.2, targetModel: config.model, embedModel: config.knowledgeEmbedModel });
      if (gpuStateDirect.actions?.length) console.log(`[gpu] 直连聊天前自动调度：${gpuStateDirect.actions.join('；')}`);
    } catch { /* 忽略 */ }
  }

  // 🖼 附图：先把图片本身校验掉（400），别等消息写进会话了再报错。
  let pic = null;
  if (image) {
    try {
      pic = parseImagePayload(image);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    if (!localOllamaBase(config)) {
      return sendJson(res, 400, { error: '附图只在本机 Ollama 上可用（设置 → Base URL 填 http://127.0.0.1:11434/v1）' });
    }
  }

  // 工作时段锁：和角色模式同一套规则 —— 云端接口受限，本地/内网不受限。
  // 同样在写入任何消息之前拦下，避免留下"消息存了、模型没回"的半截状态。
  const gate = isLocalEndpoint(config.baseUrl)
    ? { enabled: config.workGuard !== false, blocked: false, until: null, label: null, reason: 'local' }
    : workState(currentTime(), config.workGuard);
  if (gate.blocked) {
    const unlockAt = new Date(gate.until).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return sendJson(res, 403, {
      error: `现在是工作时间（${gate.label} 北京时间），对话已锁定，${unlockAt} 自动解锁`,
      blocked: true,
      until: gate.until,
      label: gate.label,
    });
  }

  // 「已否决」列表（最多 5 条）：重新生成前的那一版、字数截断掉的部分都留在这里。
  // 声明得这么早，是为了让"正常出结果 / 用户中途停止 / 上游报错"三条收尾路径都能带上它 ——
  // 只在成功路径里记的话，用户刚点「重新生成」就停止时，那一版会凭空消失。
  const rejected = [];
  let previousReply = '';
  // 重新生成的两种用法：① 拿它当「换一个走向」的提示喂回去（否则模型只会照着上一版重说一遍）
  // ② 存进「已否决」，想换回来随时能换。
  // 摘下来的**消息对象**也留着：万一这一轮一个字都没生成（用户点停止 / 请求报错），
  // 得把它原样放回去 —— 不然用户的回复会因为"点了一次重新生成"凭空消失。
  const droppedMsgs = [];
  if (regenerate) {
    if (!session.messages.some((m) => m.role === 'user')) {
      return sendJson(res, 400, { error: '还没有你说的话，无法重新生成' });
    }
    // 末尾若是模型上一轮的回复，先丢掉，让它基于同一段历史重答。
    while (session.messages.length && session.messages.at(-1).role === 'assistant') {
      droppedMsgs.unshift(session.messages.pop());
    }
    previousReply = droppedMsgs.map((m) => m.content).join('\n');
    // 一摘下来就记进「已否决」：后面不管是正常出结果、被停止还是上游报错，这一版都留得住。
    // 理由优先用请求里给的（比如"调维度之前的那一版"），没给就用默认话术。
    if (previousReply) {
      rejected.push({
        text: previousReply,
        reason: String(rejectedReason || '').trim().slice(0, 40) || '重新生成前的一版',
        source: 'regen',
        at: Date.now(),
      });
    }
  } else {
    const text = (content || '').trim();
    if (!text) return sendJson(res, 400, { error: '消息不能为空' });
    session.messages.push({ role: 'user', content: text, at: Date.now() });
    // 第一条用户消息拿来当会话标题，方便在列表里认出来（和角色模式一致）。
    if (session.title === '新的对话') session.title = text.slice(0, 18);
  }

  // 🖼 附图：这一轮的消息要带图（图片只在这次请求里用，历史里仍是纯文本）。
  // 「重新生成」把上次那张图接回来，同样要求还是同一条用户消息。
  const directLastUser = (content || '').trim()
    || [...session.messages].reverse().find((m) => m.role === 'user')?.content
    || '';
  if (pic) rememberImage(sessionId, { text: directLastUser, pic });
  const directMemo = lastImage.get(sessionId);
  const visionPic = pic
    || (regenerate && directMemo && directMemo.text === directLastUser ? directMemo.pic : null);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const controller = new AbortController();
  const onClientGone = () => controller.abort();
  req.on('close', onClientGone);
  res.on('close', onClientGone);

  // 「用户点了停止 / 浏览器把连接关掉」的统一判定 = controller 被 abort 了。
  // ⚠ 光看 `err.name === 'AbortError'` 是不够的：**上游已经吐过字之后再断开**，
  // 拿到的是流上的通用错误（`aborted` / ECONNRESET），name 根本不是 AbortError ——
  // 那条路会被误判成"上游报错"，于是 ① 屏幕上已经打出来的半截被丢掉、
  // ② 重新生成时摘下来的那一版也没人放回去（实测：会话只剩你那条消息，回复凭空消失）。
  // 直连模式里 abort 只有一个来源（客户端断开），所以这个判定是准的。
  const clientGone = () => controller.signal.aborted;

  let text = '';
  let dReasoning = '';   // 思考过程（v1.5.1）：云端模型 reasoning_content
  let dUsage = null;     // 本轮用量（v1.5.3）
  let dUsageEstimated = false;
  // ⚠ 联网搜索的来源必须声明在 try **外面**：catch 里（用户点停止、上游报错）也要挂到
  // 存下来的那条回复上，而 `const dSearch` 在 try 的作用域里、catch 根本看不见 ——
  // 在里面引用它会在"点停止"这条路上抛 ReferenceError，半截回复直接丢（被专项测试逮到过）。
  let dSources = [];
  try {
    // 「重新生成」：把上一版喂回去，明确要求换一个走向 —— 和角色模式用的是**同一个**
    // regenerateNudge()，措辞只有一份，不会两边说不一样。
    // 直连模式平时是零注入；这一段**只在你主动点「重新生成」时**才出现，不点永远不会有。
    // 和角色模式一样拼进 system，绝不当作 user 消息：否则模型会把"请换个走向"当成
    // "你说的这句话"接着演出来（这个坑角色模式里踩过）。
    const nudge = regenerateNudge(previousReply);
    // 所有提示统一从这儿拼进 system（重抽时要在"摘掉常用语段"的新 messages 上再拼一遍）
    const applyNudges = (msgs, extras = []) => {
      for (const p of [nudge, ...extras].filter(Boolean)) {
        const first = msgs[0];
        if (first?.role === 'system') msgs[0] = { role: 'system', content: `${first.content}\n\n${p}` };
        else msgs.unshift({ role: 'system', content: p });
      }
      return msgs;
    };
    // 直连模式的资料库（v0.60.0）：挑块规则与角色模式一致，没资料/预算 0 时返回空数组，
    // 这一轮就还是零注入 —— 不改变"直连默认没有系统提示词"这个前提。
    const directK = await pickKnowledgeForDirect(session, config, content);
    const directKnowledge = directK.chunks;
    // 联网搜索（v0.62.0）：直连模式同样只在开着时走网络，关着时这一轮仍是"零 system"。
    const dSearchPlan = searchPlan(config);
    if (dSearchPlan.enabled) send('web', { phase: 'start', site: dSearchPlan.site });
    const dSearch = await pickSearchFor(session, dSearchPlan, content);
    dSources = toSources(dSearch.results);
    if (dSearchPlan.enabled) send('web', { phase: 'done', ...searchSummary(dSearch) });
    const messages = applyNudges(directPayload(session.messages, config, { knowledge: directKnowledge, knowledgeEmptyReason: directK.emptyReason, search: dSearch.results, searchChars: dSearchPlan.chars }));
    // 「关掉思考」按模型分派（v0.59.0）：Qwen3 → system 里的 /no_think（已在 directPayload 里加）；
    // R1 → 请求体的 think:false（放在下面的 runConfig 里）
    const directThink = thinkPlan(config);
    // 🖼 附图那一轮：临时换成**视觉**模型（直连模式也照换，用户明确接受这一点），
    // 把图片挂到最后一条用户消息上。
    //
    // ★ 关键：末尾补一个**一个空格**的 assistant 前缀，用来压住「思考」。
    //   视觉模型常常是思考型，而在这一版 Ollama 上：
    //     · think:false、reasoning_effort:none、chat_template_kwargs.enable_thinking=false —— 全都不认
    //     · /no_think 软开关 —— 不可靠（system 在位时照样思考 2000+ 字）
    //     · **空前** assistant（"") —— 没用（实测思考 3335 字、content 0 字）
    //     · 但任何**非空**前缀都能把思考压到 0 字：一个空格 1.1 秒出 134 字（实测三连稳定）
    //   取一个空格是因为它最小、最不打扰：不回显任何文字、形状上也不算"注入内容"，
    //   存库前会把开头空白去掉，所以历史里看到的仍然是模型的原文。
    if (visionPic) {
      const last = messages.at(-1);
      if (last?.role === 'user') {
        last.content = [
          { type: 'text', text: String(last.content || '') },
          { type: 'image_url', image_url: { url: `data:${visionPic.mime};base64,${visionPic.base64}` } },
        ];
      }
    }
    const runConfig = {
      // 重抽时温度略微上调（和角色模式同一套）：只换 seed 只会换措辞，
      // 走向还是会撞车 —— 抬一点温度配合上面那段提示才真的能换个拍子。
      ...(nudge ? { ...config, temperature: Math.min(1.2, (config.temperature ?? 0.85) + 0.1) } : config),
      // R1 这类：关思考走请求体（think:false），system 里不加 /no_think（v0.59.0）
      ...(directThink.payloadThink ? { think: false } : {}),
      ...(visionPic ? { model: normalizeVisionModel(config.visionModel) } : {}),
    };
    const onDelta = (delta) => {
      // 逐字推给浏览器；同时自己留一份，用户中途点「停止」时把已生成的部分存下来。
      text += delta;
      send('text', { text: delta });
    };
    const onReasoning = (t) => {
      if (!t) return;
      dReasoning += t;
      send('reasoning', { text: t });
    };
    const onUsage = (u) => {
      const n = normUsage(u);
      if (n) dUsage = addUsage(dUsage, n);
    };
    let reply;
    // 空回复 / 网络抖动都重试（最多 3 次，逐次加长等待）—— 断网时循环重连
    let directTry = 0;
    for (;;) {
      try {
        reply = await streamChat({ config: runConfig, messages, prefill: visionPic ? ' ' : '', onDelta, onReasoning, onUsage, signal: controller.signal });
        break;
      } catch (err) {
        const msg = String(err?.message || '');
        const empty = err instanceof OpenAIError && /没有返回任何内容/.test(msg);
        const networkish = err instanceof OpenAIError
          && (err.status === 502 || err.status === 504 || /连接|ECONNRESET|ETIMEDOUT|timeout|socket|network|fetch failed/i.test(msg));
        if ((empty || networkish) && directTry < 3) {
          directTry += 1;
          text = '';
          reasoning = '';
          send('reset', { reason: empty ? 'empty' : 'network' });
          if (!empty) await new Promise((r) => setTimeout(r, 2000 * directTry));
          continue;
        }
        throw err;
      }
    }
    // 去掉前缀那个空格（回显与否都统一处理），历史里存的就是模型原文。
    reply = reply.replace(/^[ \t\n]+/, '');
    // 硬凑常用词（v0.57.0）：直连模式本来是"模型回什么就存什么"，这里新增一处**极窄**的例外 ——
    // 三条**同时**成立才触发：① 你填了常用语（否则根本没有"凑频率"的动机）
    // ② 这一轮明显不是在聊那个话题（在提问/说明，且最近几轮都没出现这些词）
    // ③ 回复里真的塞进了词表里的词。
    // 处置：摘掉常用语整段重抽一次，落选的那一版进「已否决」（跟字数截断、重新生成一个待遇）。
    const dWords = parsePhrases(config?.directPhrases);
    if (dWords.length && config.autoClean !== false
      && stuffedPhrases(reply, dWords).length
      && isPhraseOffTopic(directLastUser, session.messages.slice(-7, -1).map((m) => m.content), dWords)) {
      const firstReply = reply;
      const hit = stuffedPhrases(firstReply, dWords);
      send('reset', { reason: 'stuffed' });
      text = '';
      const retryMsgs = applyNudges(
        directPayload(session.messages, config, { skipPhrases: true, knowledge: directKnowledge, knowledgeEmptyReason: directK.emptyReason, search: dSearch.results, searchChars: dSearchPlan.chars }),
        [stuffedNudge(hit)],
      );
      reply = await streamChat({ config: runConfig, messages: retryMsgs, prefill: visionPic ? ' ' : '', onDelta, signal: controller.signal });
      reply = reply.replace(/^[ \t\n]+/, '');
      rejected.push({
        text: firstReply,
        // 和角色模式用同一句理由（避免两处措辞不一致，冒烟测试也是按这句认的）
        reason: `硬凑常用词（${hit.join('、')}）：这一轮话题不相关`.slice(0, 40),
        source: 'stuffed',
        at: Date.now(),
      });
    }
    // 直连模式也要规整标记：以前这里只做字数裁剪，**完全没走 normalizeMarkup** ——
    // 于是模型写的 `**阴道**`（Markdown 加粗）原样漏到界面上，和 `*动作*` 撞在一起。
    // 角色模式一直有这一步，直连漏了（踩过）。
    if (reply) {
      const before = reply;
      const afterMarkup = normalizeMarkup(reply, { keep: [] });
      if (afterMarkup !== before) {
        reply = afterMarkup;
        send('replace', { text: reply, note: describeMarkup() });
      }
    }

    // 直连的「字数上限」（directMaxChars）：跟角色模式同一套（按句号裁、不切断半句），
    // 裁掉的部分进「已否决」。用的是**直连自己**那份额度，跟角色模式的 maxChars 互不干扰。
    if (config.directMaxChars) {
      const rawReply = reply;
      const limited = trimToLimit(rawReply, config.directMaxChars);
      if (limited.trimmed) {
        reply = limited.text;
        rejected.push({
          text: rawReply,
          reason: describeTrim(reply.length, rawReply.length),
          source: 'trim',
          at: Date.now(),
        });
        send('replace', { text: reply, note: describeTrim(reply.length, rawReply.length) });
      }
    }
    // 重新生成被丢掉的那一版已经在摘下它的时候就记进「已否决」了（见上面的 rejected），
    // 所以这里不用再补一次 —— 补了就会重复，而且中止/报错的路径也照样漏。
    text = reply;
    if (!dUsage) {
      const inChars = (() => { try { return JSON.stringify(messages).length; } catch { return 0; } })();
      const outChars = reply.length + (dReasoning ? dReasoning.length : 0);
      dUsage = {
        input: estTokens(inChars), output: estTokens(outChars),
        reasoning: dReasoning ? estTokens(dReasoning.length) : 0,
        cached: 0, total: estTokens(inChars) + estTokens(outChars),
      };
      dUsageEstimated = true;
    }
    send('usage', { usage: dUsage, estimated: dUsageEstimated });
    session.messages.push({
      role: 'assistant',
      content: reply,
      at: Date.now(),
      ...(dReasoning ? { reasoning: dReasoning } : {}),
      ...(dUsage ? { usage: dUsage, ...(dUsageEstimated ? { usageEstimated: true } : {}) } : {}),
      // 联网搜索的来源（v0.62.0）：前端在气泡下显示「🌐 来源 N」
      ...(dSources.length ? { sources: dSources } : {}),
      ...(rejected.length ? { rejected: rejected.slice(0, 5) } : {}),
    });
    await saveSession(session);
    // 本地 Ollama：跟角色模式一样，每轮生成完重新按一次 keep-alive（本地模型才不会两分钟被卸载）。
    if (config.keepAlive !== null && config.keepAlive !== undefined && localOllamaBase(config)) {
      ollamaSetKeepAlive(config, config.keepAlive).catch(() => { /* 按不上就算了，不影响回复 */ });
    }
    // 带上否决条数：前端会提示"有 N 版被否决，点气泡下的「已否决」可以看"
    //（直连模式同样渲染那个入口，和角色模式共用一套消息条）。
    send('done', { title: session.title, rejected: rejected.length });
  } catch (err) {
    if (err.name === 'AbortError' || clientGone()) {
      // 用户中途停止：已经吐出来的部分照样存下来，别白等那几秒。
      if (text.trim()) {
        // 重抽时被摘掉的那一版同样进「已否决」—— 停止不代表要把它丢掉。
        session.messages.push({
          role: 'assistant',
          content: text,
          at: Date.now(),
          ...(dReasoning ? { reasoning: dReasoning } : {}),
          ...(dUsage ? { usage: dUsage } : {}),
          ...(dSources.length ? { sources: dSources } : {}),
          ...(rejected.length ? { rejected: rejected.slice(0, 5) } : {}),
        });
      } else if (droppedMsgs.length) {
        // 一个字都没生成就停了：把重新生成时摘下来的那条原样放回去，
        // 否则它既不在会话里、也不在「已否决」里，等于凭空消失。
        session.messages.push(...droppedMsgs);
      }
      await saveSession(session);
      send('done', { title: session.title, aborted: true });
    } else {
      // 报错同理：这一轮一个字都没留下来时，把摘下来的那条放回去
      //（已经存了半截的情况走上面的分支，不会出现两条连续的 assistant）。
      if (!text.trim() && droppedMsgs.length) session.messages.push(...droppedMsgs);
      await saveSession(session);
      send('error', { error: err instanceof OpenAIError ? err.message : String(err.message || err) });
    }
  } finally {
    if (gpuStateDirect?.stoppedServices?.length) scheduleGpuRestore(gpuStateDirect.stoppedServices);
    else cancelGpuRestore();
    res.end();
  }
}

// 发给前端的配置：**永不带出完整 Key**，只回显"有没有"和尾 4 位。
/* ---------- 聊天记录存哪儿（v1.6.1） ----------
 *
 * 用户要能在设置里看到数据目录位置，并且一键在文件管理器里打开。
 * 注意：打开目录 = 在**服务器这台机器**上执行 xdg-open / explorer.exe，
 * 所以只对"本机请求"放开（远程/手机访问时只显示路径，不给按钮）。
 * 这也是安全考虑：不能让局域网里的任何人触发本机进程。
 */
async function dataDirInfo() {
  const info = {
    path: DATA_DIR,
    root: ROOT,
    // data-dir.txt 里写了才说明用户把数据挪到了同步目录
    redirected: false,
    exists: false,
    // 各类数据条数，让用户一眼知道是不是这里
    counts: { characters: 0, sessions: 0 },
    // 本机才能"在文件管理器里打开"
    canOpen: true,
  };
  try {
    await fs.access(DATA_DIR);
    info.exists = true;
  } catch { /* 不存在就是还没初始化 */ }
  try {
    const txt = await fs.readFile(path.join(ROOT, 'data-dir.txt'), 'utf8');
    info.redirected = txt.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'));
  } catch { /* 没有 data-dir.txt = 用默认 ./data */ }
  try { info.counts.characters = (await fs.readdir(path.join(DATA_DIR, 'characters'))).filter((f) => f.endsWith('.json')).length; } catch { /* 目录还没建 */ }
  try { info.counts.sessions = (await fs.readdir(path.join(DATA_DIR, 'sessions'))).filter((f) => f.endsWith('.json')).length; } catch { /* 目录还没建 */ }
  return info;
}

/** 在本机文件管理器里打开目录。只允许本机调用。 */
function openDataDir(req) {
  const platform = process.platform;
  // 为什么不能只用 xdg-open（2026-11 实测踩坑）：
  //   Ubuntu + snap 版 Firefox 时，xdg-open 打开目录会被转到浏览器关联上，
  //   snap 的 Firefox 在沙箱里没有文件系统权限 —— 结果不是"打开文件夹"，
  //   而是把浏览器连带关掉（用户看到的是"点了自动关浏览器"）。
  // 正解：**直接点名文件管理器**，不经过 mime 关联。
  //   Linux:  gio open（GNOME 官方、按 inode/directory 关联到 Nautilus）→ nautilus → dolphin → xdg-open
  //   macOS:  open
  //   Windows: explorer
  const candidates = platform === 'win32'
    ? [['explorer.exe', DATA_DIR]]
    : platform === 'darwin'
      ? [['open', DATA_DIR]]
      : [
          ['gio', 'open', DATA_DIR],
          ['nautilus', DATA_DIR],
          ['dolphin', DATA_DIR],
          ['thunar', DATA_DIR],
          ['xdg-open', DATA_DIR],   // 兜底（可能被浏览器关联截胡）
        ];

  return new Promise((resolve, reject) => {
    const tried = [];
    const tryNext = (i) => {
      if (i >= candidates.length) {
        return reject(new Error(`找不到可用的文件管理器（试过：${tried.join(', ')}）`));
      }
      const [cmd, ...args] = candidates[i];
      let child;
      try {
        child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      } catch (err) {
        tried.push(`${cmd}(不可用)`);
        return tryNext(i + 1);
      }
      let settled = false;
      const ok = () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve(cmd);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        tried.push(`${cmd}(失败)`);
        tryNext(i + 1);
      };
      // ENOENT = 这个命令没装，换下一个
      child.on('error', (err) => {
        if (err && err.code === 'ENOENT') return fail();
        // 别的错误（比如没权限）也换下一个，但记下来
        fail();
      });
      // 命令跑起来了就算成功；exit code 不为 0 说明这个方式不行，继续试
      child.on('exit', (code) => {
        if (code === 0) ok();
        else fail();
      });
      // 有些程序（如 gio）会很快退出且不报错，给个短窗口当作成功
      setTimeout(ok, 800);
    };
    tryNext(0);
  });
}

function redactConfig(config) {
  const tts = config.tts || {};
  return {
    ...config,
    version: VERSION,
    apiKey: '',
    hasApiKey: Boolean(config.apiKey),
    apiKeyHint: config.apiKey ? `••••${config.apiKey.slice(-4)}` : '',
    savedCloud: config.savedCloud
      ? { baseUrl: config.savedCloud.baseUrl, model: config.savedCloud.model, hasApiKey: Boolean(config.savedCloud.apiKey) }
      : null,
    tts: { ...tts, apiKey: '', hasApiKey: Boolean(tts.apiKey), apiKeyHint: tts.apiKey ? `••••${tts.apiKey.slice(-4)}` : '' },
  };
}

// 「关掉思考」到底怎么关，得看模型（v0.59.0）：
//   · Qwen3 这代 → 往 system 里加 /no_think
//   · R1 这代   → 请求体里加 think:false（system 里的 /no_think 对它完全无效，实测过）
// 返回 systemInject（要不要注入 /no_think）、payloadThink（要不要发 think:false）、how（给预览/提示看的名字）
/**
 * v1.9.0：把这一轮实际发给模型的消息截成可落盘的快照（给"日常强化"评分用）。
 * 限制总长，避免把超长上下文整个塞进会话文件 —— 评分数据够用就行，
 * 训练端真要完整的，可以按 sessionId + 时间回会话里取。
 */
const RL_PROMPT_MAX_CHARS = 6000;
function promptSnapshot(msgs) {
  const out = [];
  let budget = RL_PROMPT_MAX_CHARS;
  // 从后往前留（越靠后越重要：最近几轮 + 最后一轮 system 已经合并过了）
  const list = Array.isArray(msgs) ? msgs : [];
  for (let i = list.length - 1; i >= 0 && budget > 0; i -= 1) {
    const m = list[i];
    if (!m || m.content === undefined) continue;
    const role = String(m.role || 'user');
    let content = String(m.content);
    if (content.length > budget) content = content.slice(0, budget);
    out.unshift({ role, content });
    budget -= content.length;
  }
  return out;
}

function thinkPlan(config) {
  if (!config || config.thinkOff !== true) return { systemInject: false, payloadThink: false, how: '' };
  // 本地推理服务（llama-server 8080 / LM Studio 1234 / vLLM 8000）的思考开关是模板参数，
  // 不是 /no_think 也不是 think:false。保持 system 干净，别把 "/no_think" 写进角色设定。
  if (localOllamaBase(config) && /:(8080|1234|8000)$/.test(localOllamaBase(config))) {
    return { systemInject: false, payloadThink: false, how: '模型模板参数（本地推理服务）' };
  }
  const control = thinkControl(config.model);
  return control === 'think_false'
    ? { systemInject: false, payloadThink: true, how: 'think:false（请求体）' }
    : { systemInject: true, payloadThink: false, how: '/no_think（system）' };
}

/* ---------- 星野抓取任务（内存 Map；单并发；30 分钟过期；log ≤ 300 行） ---------- */
// 抓取是长任务：POST /api/xingye/job 立刻返回 jobId，前端每 700ms 轮询进度。
// 任务对象只在内存里，进程重启就没了（对「抓几个角色」这种短任务足够）。
const XY_JOB_TTL = 30 * 60 * 1000;
const XY_JOB_LOG_MAX = 300;
const xingyeJobs = new Map();
let xingyeJobSeq = 0;

const xySleep = (ms) => new Promise((r) => setTimeout(r, ms));

function xyJobPrune() {
  const now = Date.now();
  for (const [id, job] of xingyeJobs) {
    if (job.status === 'running') continue;
    const end = job.finishedAt || job.startedAt || now;
    if (now - end > XY_JOB_TTL) xingyeJobs.delete(id);
  }
}

function xyJobLog(job, level, msg) {
  job.log.push({ at: Date.now(), level, msg: String(msg) });
  while (job.log.length > XY_JOB_LOG_MAX) job.log.shift();
}

function xyJobBusy() {
  for (const job of xingyeJobs.values()) if (job.status === 'running') return true;
  return false;
}

function xyJobView(job) {
  return {
    ok: true,
    jobId: job.jobId,
    status: job.status,
    mode: job.mode,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    log: job.log,
    items: job.items,
    error: job.error,
  };
}

const XY_SKIP_TEXT = {
  'already-registered': '已经注册过了',
  'name-exists': '本地已有同名角色',
  'not-fetched': '还没有抓取记录',
};

/** 后台跑一个抓取任务。异常都在里面收口，不会把进程带崩。 */
async function xyRunJob(job, { mode, links, ids, autoRegister, downloadAvatar }) {
  const targets = [];
  try {
    if (mode === 'links') {
      const urls = extractUrls(links);
      if (!urls.length) throw new Error('没有从输入里找到任何 http 链接（把整段分享文案粘进来也可以）');
      job.progress.total = urls.length;
      xyJobLog(job, 'info', `从输入里抠出 ${urls.length} 条链接`);
      for (const url of urls) {
        try {
          const { npcId } = await resolveShare(url);
          targets.push({ npcId, source: 'share', link: url });
          xyJobLog(job, 'info', `${url} → npc_id=${npcId}`);
        } catch (err) {
          job.progress.done += 1;
          job.progress.fail += 1;
          xyJobLog(job, 'err', `链接解析失败：${url}（${err.message}）`);
        }
      }
    } else {
      const raw = Array.isArray(ids) ? ids : [];
      const parsed = [...new Set(raw.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
      if (!parsed.length) throw new Error('ids 里没有合法的 npc_id');
      job.progress.total = parsed.length;
      for (const npcId of parsed) targets.push({ npcId, source: 'id', link: '' });
      xyJobLog(job, 'info', `待抓 npc_id：${parsed.join(', ')}`);
    }

    // 去重（多条链接可能指向同一个 npc）
    const seen = new Set();
    const uniq = [];
    for (const t of targets) {
      if (seen.has(t.npcId)) {
        job.progress.total -= 1;
        xyJobLog(job, 'warn', `npc_id=${t.npcId} 重复，跳过`);
        continue;
      }
      seen.add(t.npcId);
      uniq.push(t);
    }

    for (const t of uniq) {
      try {
        const { item } = await fetchOne(t.npcId, { source: t.source, downloadAvatar: downloadAvatar !== false });
        job.progress.ok += 1;
        xyJobLog(job, 'ok', `${t.npcId}「${item.name}」设定 ${item.personaChars} 字 / 开场白 ${item.greetingChars} 字`);
        let reason = null;
        if (autoRegister) {
          const r = await registerCharacters([t.npcId]);
          if (r.created.length) {
            job.progress.registered += 1;
            xyJobLog(job, 'ok', `已注册角色「${item.name}」（${r.created[0].characterId}）`);
          } else if (r.skipped.length) {
            reason = r.skipped[0].reason;
            xyJobLog(job, 'warn', `跳过注册「${item.name}」：${XY_SKIP_TEXT[reason] || reason}`);
          }
        }
        const rec = await getRecord(t.npcId);
        job.items.push({ ...(rec?.item || item), reason });
      } catch (err) {
        job.progress.fail += 1;
        xyJobLog(job, 'err', `npc_id=${t.npcId} 抓取失败：${err.message}`);
      }
      job.progress.done += 1;
      // SPEC §3.3：每个 NPC 间隔 300~500ms，单失败不中断。
      await xySleep(300 + Math.floor(Math.random() * 200));
    }

    if (job.progress.ok === 0 && job.progress.fail > 0) throw new Error('全部失败：没有抓到任何角色');
    job.status = 'done';
    job.finishedAt = Date.now();
    xyJobLog(job, 'ok', `完成：成功 ${job.progress.ok}，失败 ${job.progress.fail}` +
      (autoRegister ? `，新注册 ${job.progress.registered}` : ''));
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.finishedAt = Date.now();
    xyJobLog(job, 'err', `任务失败：${err.message}`);
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const method = req.method;

  // --- 远程访问口令 ---
  // 本机（127.0.0.1）免密；从别的设备来的一律先过这道门。
  // 口令在环境变量里，没设就等于不启用（本机开发时行为完全不变）。
  if (pathname === '/__login' && method === 'POST') {
    // 登录走的是普通 <form> 提交（application/x-www-form-urlencoded），
    // 不是 JSON —— 不能用 readBody，它只认 JSON（这里踩过一次）。
    const raw = await (async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8');
    })().catch(() => '');
    const form = new URLSearchParams(raw);
    if (checkPassword(form.get('password'))) {
      grantCookie(res);
      res.writeHead(302, { Location: '/' }).end();
    } else {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }).end(loginPage('口令不对'));
    }
    return;
  }
  if (pathname === '/__logout') {
    clearCookie(res);
    res.writeHead(302, { Location: '/' }).end();
    return;
  }
  if (!isAuthorized(req)) {
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 401, { error: '需要口令（浏览器打开首页登录一次即可）' });
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }).end(loginPage());
    return;
  }

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  // --- 设置 ---
  // 版本号：方便确认"手机上跑的是不是新包"
  if (pathname === '/api/version' && method === 'GET') {
    return sendJson(res, 200, { version: VERSION });
  }

  if (pathname === '/api/config') {
    if (method === 'GET') {
      const cfg = await getConfig();
      const out = redactConfig(cfg);
      // 前端要据此显示「这次关思考走哪种方式」（Qwen3 → /no_think，Gemma → think:false）。
      // 不给这个字段的话，聊天页那个 🧠 按钮没法告诉用户它到底干了什么。
      out.thinkControl = thinkPlan(cfg).how;
      // v1.6.0：设置页「系统提示词」编辑框的「填入默认」按钮要用
      out.defaultRulesText = defaultRulesText();
      // v1.6.1：聊天记录存哪儿 —— 设置页要显示 + 能一键在文件管理器里打开
      out.dataDir = DATA_DIR;
      out.dataDirInfo = await dataDirInfo();
      return sendJson(res, 200, out);
    }
    if (method === 'PUT') {
      const patch = await readBody(req);
      // 只改了「模型 = gemma3-12b-heretic」、地址还指着 Ollama 的话，自动改成 llama-server。
      // 否则保存后必然 model not found（用户多半只会改模型名这一格）。
      if (/^gemma/i.test(String(patch.model || ''))) {
        const cur = await getConfig();
        const url = String(patch.baseUrl || cur.baseUrl || '');
        if (!/:18080\b/.test(url)) {
          patch.baseUrl = 'http://127.0.0.1:18080/v1';
          patch.apiKey = 'llama';
          console.log('[config] 模型是 gemma → 地址自动切到 llama-server');
        }
      }
      // 前端留空表示“不修改已保存的 Key”。
      if (!patch.apiKey) delete patch.apiKey;
      // TTS 的 Key 同理：留空 = 不改（不然一改音色就把 Key 抹了）
      if (patch.tts && typeof patch.tts === 'object' && !patch.tts.apiKey) delete patch.tts.apiKey;
      // Base URL 校验：写坏了（比如漏掉端口 "/v1"）会让人一头雾水 ——
      // 报错是 "ECONNREFUSED"，根本看不出是地址写错了。这里直接把话说清楚。
      if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
        const raw = patch.baseUrl.trim();
        let u = null;
        try { u = new URL(raw); } catch { /* 下面统一报错 */ }
        if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) {
          return sendJson(res, 400, { error: `接口地址不像个网址：${raw}（要写成 http://主机:端口/v1 这种）` });
        }
        const host = u.hostname.toLowerCase();
        const isLocal = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
        if (isLocal && !u.port) {
          return sendJson(res, 400, {
            error: `本地地址要带端口：${raw} 少了端口号。Ollama 默认是 11434，完整写法 http://127.0.0.1:11434/v1`,
          });
        }
        patch.baseUrl = raw;
      }
      const config = await saveConfig(patch);
      return sendJson(res, 200, { ok: true, hasApiKey: Boolean(config.apiKey) });
    }
  }

  // 查看「这次会发给模型的上下文」——和聊天请求走同一套 buildMessages，
  // 所以界面上看到的就是真的发出去的那份。
  if (pathname === '/api/context' && method === 'GET') {
    const session = await getSession(url.searchParams.get('sessionId') || '');
    if (!session) return sendJson(res, 404, { error: '会话不存在' });
    const characters = await listCharacters();
    const character = characters.find((c) => c.id === session.characterId);
    if (!character) return sendJson(res, 404, { error: '角色不存在' });
    // 「/ 以谁的身份发」（v1.2.2）：最后一条用户消息记了 as，且是本会话人物表里的人，
    // 预览就要和真发出去的一致：历史里那条显示成「陈梦：…」+ 结尾带上 asNudge。
    // 否则又变成"预览撒谎"（v0.53.0 踩过一次）。
    const ctxCast = castOf(character);
    const ctxCastNames = ctxCast.map((c) => c.name);
    const ctxAsRaw = [...session.messages].reverse().find((m) => m.role === 'user')?.as;
    const ctxAs = ctxCast.length >= 2 && ctxAsRaw && ctxCastNames.includes(ctxAsRaw) ? ctxAsRaw : '';
    // 和 handleChat 一样的转换：多人卡括号说话人归位 + 用户 as 消息写成「名字：内容」
    let ctxHistory = applyAsIdentity(ctxCast.length >= 2
      ? session.messages.map((m) => (m.role === 'assistant'
        ? { ...m, content: normalizeCastSpeaker(m.content, ctxCast) }
        : m))
      : session.messages);
    if (ctxAs) ctxHistory = dropAsSpeaker(ctxHistory, ctxAs, ctxCastNames);
    if (ctxCast.length >= 2) ctxHistory = dropMultiOpener(ctxHistory, character, ctxCast);
    const config = await getConfig();
    // 「查看上下文」看到的就是真发出去的 —— 资料块也要按同样规则挑出来算进去
    const ctxLastUser = [...session.messages].reverse().find((m) => m.role === 'user')?.content || '';
    const ctxKnowledge = ctxAs
      ? []
      : (await pickKnowledgeFor(character, session, config, ctxLastUser)).chunks;
    // 联网搜索也要按同样规则算进来 —— 否则开了联网，预览里却看不到那段【网页搜索结果】，
    // 又变成"预览撒谎"（v0.53.0 踩过一次，冒烟测试现在盯着）。走缓存：刚聊过的那条
    // 查询直接复用同一批结果，不会再打一次必应。
    const ctxSearchPlan = searchPlan(config);
    const ctxSearch = await pickSearchFor(session, ctxSearchPlan, ctxLastUser);
    const preview = previewContext(character, ctxHistory, CONTEXT_BUDGET, config.narrative, {
      cleanHistory: config.cleanHistory !== false,
      cast: ctxCast,
      asName: ctxAs,
      dims: character?.dims?.length ? character.dims : config.dims,
      hint: String(character?.hint || '').trim() || config.hint,
      synonyms: config.synonyms,   // 等义词：全角色通用
      synonymsOutput: config.synonymsOutput === true,
      memo: config.memo,
      maxChars: ctxCast.length >= 2 && config.maxChars > 0
        ? Math.min(2000, Math.round(config.maxChars * 1.6))
        : config.maxChars,
      knowledge: ctxKnowledge,
      search: ctxSearch.results,
      searchChars: ctxSearchPlan.chars,
      // ⚠ 这个必须和 handleChat 里那份一模一样，否则「查看上下文」显示的就不是真发出去的东西
      //   （v0.53.0 漏了这一行：开关开着，预览里却不显示 /no_think —— 冒烟测试现在盯着它）
      // v0.59.0：按模型分派 —— R1 那类关思考走请求体的 think:false，system 里**不该**有 /no_think
      thinkOff: thinkPlan(config).systemInject,
    });
    return sendJson(res, 200, {
      sessionId: session.id,
      title: session.title,
      characterName: character.name,
      model: config.model,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      extraBody: config.extraBody || '',
      // 「关掉思考」这一轮到底怎么关的（空 = 没开）：前端照着显示，别让预览撒谎
      thinkControl: thinkPlan(config).how,
      narrative: config.narrative || '',
      workGuard: config.workGuard !== false,
      knowledgeChars: normalizeKnowledgeChars(config.knowledgeChars),
      knowledge: preview.knowledge || [],
      // 联网搜索这一轮到底搜没搜、搜到什么（空 = 没开或不适用）：预览不许撒谎
      webSearch: {
        enabled: ctxSearchPlan.enabled,
        site: ctxSearchPlan.site,
        chars: ctxSearchPlan.chars,
        ...searchSummary(ctxSearch),
      },
      system: ctxAs
        ? `${preview.messages[0].content}\n\n${asNudge(ctxAs, ctxCastNames.filter((n) => n !== ctxAs))}`
        : preview.messages[0].content,
      // 这一轮是以谁的身份发的（空 = 以用户本人身份）；前端可以据此高亮
      as: ctxAs || '',
      history: preview.messages.slice(1),
      stats: preview.stats,
    });
  }

  if (pathname === '/api/models' && method === 'GET') {
    const config = await getConfig();
    const models = await listModels(config);
    // 云端模型的习惯叫法也塞进列表（如 deepseek-v4-flash → 实际 id deepseek-flash）
    for (const alias of cloudModelAliases(config.baseUrl)) {
      if (!models.includes(alias)) models.push(alias);
    }
    // 设置页「模型」输入框的 datalist 用这个列表。它只列**当前后端**的模型，
    // 切回 Ollama 后 gemma 就从下拉里消失了（用户反馈「gemma 又没了」）。
    // 把本机 llama-server 的模型也并进去，保证任何后端下都能选到 gemma。
    try {
      const hr = await fetch('http://127.0.0.1:18080/health', { signal: AbortSignal.timeout(1200) });
      if (hr.ok && !models.includes('gemma3-12b-heretic')) models.push('gemma3-12b-heretic');
    } catch { /* llama-server 没起就不加 */ }
    return sendJson(res, 200, { models });
  }

  // ---- 应用内「切模型」（v0.55.0）：不用再敲 tools\switch-model.mjs ----
  // ① 列出本机 Ollama 里装了什么（带规模/量化/支不支持思考）
  if (pathname === '/api/local-models' && method === 'GET') {
    const config = await getConfig();
    // ⚠ 列表**固定查本机 Ollama**，不跟着当前 baseUrl 走。
    // 原来直接 listLocalModels(config)：一旦切到 gemma（baseUrl=:18080），
    // 列表就变成「只显示 gemma」—— 用户就再也点不回 Ollama 的模型了（实测）。
    const OLLAMA_LOCAL = 'http://127.0.0.1:11434/v1';
    let out = await listLocalModels({ ...config, baseUrl: OLLAMA_LOCAL });
    if (!out.ok || !(out.models || []).length) {
      // Ollama 没起：退回用当前配置（至少别把列表弄空）
      out = await listLocalModels(config);
    }
    // 并入 llama-server 的模型（gemma 走这个后端，不在 Ollama 里）。
    // 不并进来的话设置页只有 Ollama 的模型，gemma 就「点不到」了。
    const GEMMA_URL = 'http://127.0.0.1:18080';
    try {
      const hr = await fetch(`${GEMMA_URL}/health`, { signal: AbortSignal.timeout(1200) });
      if (hr.ok) {
        const jr = await fetch(`${GEMMA_URL}/v1/models`, { signal: AbortSignal.timeout(1200) });
        const jd = await jr.json();
        for (const m of (jd.models || [])) {
          out.models.push({
            name: 'gemma3-12b-heretic',
            rawName: m.name || '',
            sizeBytes: 0, quant: 'Q5_K_M', params: '12B', family: 'gemma3',
            contextLength: 8192, thinking: false, vision: false,
            backend: 'llama', label: 'gemma3-12b-heretic（本地 llama.cpp）',
          });
        }
      }
    } catch { /* llama-server 没起就跳过 */ }

    // 并入「云端模型」：让设置页那个"点一下就能切"的列表里也出现 V4 Flash / Pro。
    // 用户要求"把 V4FLASH 也加到模型列表里" —— 这个列表是每天真正用的入口。
    const cloudProviders = [];
    if (!isLocalEndpoint(config.baseUrl) && config.baseUrl) {
      cloudProviders.push({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey });
    }
    if (config.savedCloud?.baseUrl) {
      if (!cloudProviders.some((p) => p.baseUrl === config.savedCloud.baseUrl)) {
        cloudProviders.push({ baseUrl: config.savedCloud.baseUrl, model: config.savedCloud.model, apiKey: config.savedCloud.apiKey });
      }
    }
    const seenCloud = new Set((out.models || []).map((m) => m.name));
    for (const prov of cloudProviders) {
      const isDeepSeek = /deepseek/i.test(prov.baseUrl);
      const names = isDeepSeek ? ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-flash'] : [prov.model].filter(Boolean);
      for (const name of names) {
        if (!name || seenCloud.has(name)) continue;
        seenCloud.add(name);
        out.models.push({
          name,
          backend: 'cloud',
          cloud: true,
          baseUrl: prov.baseUrl,
          sizeBytes: 0, quant: '', params: isDeepSeek ? 'V4' : '', family: isDeepSeek ? 'deepseek' : '',
          contextLength: isDeepSeek ? 1048576 : 0, thinking: false, vision: false,
          label: isDeepSeek ? `${name === 'deepseek-v4-pro' ? 'DeepSeek V4 Pro' : 'DeepSeek V4 Flash'}（云端）` : `${name}（云端）`,
        });
      }
    }

    const same = (a, b) => a === b || String(a).split(':')[0] === String(b).split(':')[0];
    return sendJson(res, 200, {
      ...out,
      current: config.model,
      backend: /:18080\b/.test(String(config.baseUrl || '')) ? 'llama' : (localOllamaBase(config) ? 'ollama' : 'cloud'),
      isLocalNow: (out.models || []).some((m) => same(m.name, config.model)) && Boolean(isLocalEndpoint(config.baseUrl)),
      savedCloud: config.savedCloud ? { baseUrl: config.savedCloud.baseUrl, model: config.savedCloud.model } : null,
    });
  }

  // ② 一键切到某个本机模型（或一键切回云端）：baseUrl / apiKey / 模型名 / 关思考 一次配好。
  //    这个逻辑原来只在命令行脚本里 —— 搬进来之后手机端也能切。
  if (pathname === '/api/switch-model' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    console.log('[switch-model]', JSON.stringify({ model: body.model, backend: body.backend, cloud: body.cloud }));
    const config = await getConfig();

    // 切回云端：还原当初从云端切走时自动存下来的那一份
    if (body.cloud === true) {
      const saved = config.savedCloud;
      if (!saved?.baseUrl) {
        return sendJson(res, 400, { error: '没存过云端配置 —— 先在设置里手动填一次 Base URL / 模型 / Key，之后再切到本地就能一键切回来了' });
      }
      await saveConfig({
        baseUrl: saved.baseUrl, model: saved.model, apiKey: saved.apiKey,
        extraBody: saved.extraBody || '', thinkOff: false,   // 云端模型不认 /no_think，别留着
      });
      return sendJson(res, 200, { ok: true, mode: 'cloud', model: saved.model, config: redactConfig(await getConfig()) });
    }

    const want = String(body.model || '').trim();
    if (!want) return sendJson(res, 400, { error: '要切哪个模型？' });

    // 顺手核对一下这个模型在不在本机（不在也允许，只是提示一句），并拿"支不支持思考"。
    // 同样固定查本机 Ollama：否则从 gemma 切回 Ollama 模型时，会拿 gemma 后端的列表去核对，
    // 结果是 known:false + 一条「本机 Ollama 里没有这个模型」的假警告（实测）。
    const list = await listLocalModels({ ...config, baseUrl: 'http://127.0.0.1:11434/v1' });
    const hit = (list.models || []).find((m) => m.name === want || m.name.split(':')[0] === want.split(':')[0]);

    // 切到云端（列表里点「DeepSeek V4 Flash（云端）」就走这里）
    if (String(body.backend || '') === 'cloud') {
      const baseUrl = String(body.baseUrl || config.savedCloud?.baseUrl || '').trim();
      if (!baseUrl) return sendJson(res, 400, { error: '没有云端地址：先在设置里填一次 Base URL / Key' });
      const savedKey = (config.savedCloud && config.savedCloud.baseUrl === baseUrl) ? config.savedCloud.apiKey : '';
      const curKey = (!/^(ollama|llama)?$/i.test(String(config.apiKey || '')) && !isLocalEndpoint(baseUrl)) ? config.apiKey : '';
      const apiKey = savedKey || curKey;
      if (!apiKey) {
        return sendJson(res, 400, { error: '切云端需要 API Key：先在设置里填一次（之后会自动记住）' });
      }
      const afterC = await saveConfig({
        baseUrl, model: want, apiKey, extraBody: '', thinkOff: false,
        // 从云端切云端不用存 savedCloud；从本地切过去，把本地地址留在 config 里即可（切回本地走别的入口）
      });
      return sendJson(res, 200, {
        ok: true, mode: 'cloud', model: want, backend: 'cloud',
        config: redactConfig(afterC),
      });
    }

    // 切到 llama-server 后端（gemma）：地址和 Key 都不一样，别走 Ollama 那套
    if (String(body.backend || hit?.backend || '') === 'llama') {
      const patchL = {
        baseUrl: 'http://127.0.0.1:18080/v1',
        apiKey: 'llama',
        model: want,
        extraBody: '',
        savedCloud: (!isLocalEndpoint(config.baseUrl) && config.baseUrl)
          ? { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, extraBody: config.extraBody || '' }
          : config.savedCloud,
      };
      const afterL = await saveConfig(patchL);
      // 切到本地 llama-server 前把 Ollama 模型卸掉（16G 放不下两个 12B）
      await unloadOllama().catch(() => {});
      return sendJson(res, 200, {
        ok: true, mode: 'llama', model: want, backend: 'llama',
        config: redactConfig(afterL),
      });
    }

    const patch = {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama',
      model: want,
      // 原来那份额外参数（通常是 {"seed":-1}）留着；空的就给个默认，别让本地模型拿不到 seed
      extraBody: String(config.extraBody || '').trim() || '{"seed":-1}',
      // 「关掉思考」不在这里动：切模型只换地址 / Key / 模型名，
      // 思考开关保持用户手动设置的状态（要开要关自己去设置里勾）。
    };
    // 从云端切到本地之前，先把云端那套存下来（这样「切回云端」才有得还原）
    if (!isLocalEndpoint(config.baseUrl) && config.baseUrl) {
      patch.savedCloud = { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, extraBody: config.extraBody || '' };
    }
    const after = await saveConfig(patch);
    return sendJson(res, 200, {
      ok: true, mode: 'local', model: want, thinkOff: after.thinkOff === true,
      known: Boolean(hit),
      ...(hit ? {} : { warning: `本机 Ollama 里没有 ${want}（${list.ok ? '现有：' + list.models.map((m) => m.name).join('、') : list.error}）` }),
      config: redactConfig(after),
    });
  }

  // 工作时段锁的当前状态（前端轮询它来决定要不要锁输入框）。
  if (pathname === '/api/workguard' && method === 'GET') {
    const config = await getConfig();
    const isLocal = isLocalEndpoint(config.baseUrl);
    const state = isLocal
      ? { enabled: config.workGuard !== false, blocked: false, until: null, label: null, reason: 'local' }
      : workState(currentTime(), config.workGuard);
    return sendJson(res, 200, { ...state, local: isLocal, schedule: SCHEDULE_TEXT, now: Date.now() });
  }

  // --- 训练队列：点「🧠」→ 导出+清洗 → 进入待开始队列 → 串行训练（SFT → DPO） ---
  // ---- 手写训练素材（提示 + 回复，作者亲手写）----
  if (pathname.startsWith('/api/script/') || pathname === '/api/script') {
    const { listScripts, getScript, createScript, saveScript, deleteScript } = await import('./store.js');
    const body = method === 'POST' ? await readBody(req).catch(() => ({})) : {};
    try {
      if (pathname === '/api/script/list' || pathname === '/api/script') {
        return sendJson(res, 200, { scripts: await listScripts() });
      }
      if (pathname === '/api/script/get') {
        const s = await getScript(new URL(req.url, 'http://x').searchParams.get('id'));
        return s ? sendJson(res, 200, s) : sendJson(res, 404, { error: '素材不存在' });
      }
      // 手写素材：让模型给「下一条」起草，并回传 token 用量。
      //
      // 两条通道：
      //   ollama —— 走 Ollama 原生 /api/chat（只有原生接口给准的 prompt_eval_count/eval_count）
      //   llama  —— 走 llama-server 的 OpenAI 兼容口（专门给 gemma 用：Ollama 那边磁盘不够，
      //              而且 llama.cpp 会按 GGUF 自带的 chat template 套格式，不会「走空」）
      //
      // 空输出保护：模型偶尔返回空（模板不匹配 / 被截断），这里重试一次再报错，
      // 绝不让界面拿到空字符串。
      if (pathname === '/api/script/generate' && method === 'POST') {
        // ⚠ 不要再 readBody：外层已经读过一次，请求流已消费，再读只会拿到 {}。
        const script = await getScript(body.id);
        if (!script) return sendJson(res, 404, { error: '素材不存在' });
        const config = await getConfig();
        const provider = String(body.provider || 'ollama');
        const model = String(body.model || (provider === 'llama' ? 'gemma3-12b-heretic' : config.model) || '').trim();
        if (!model) return sendJson(res, 400, { error: '没有可用模型' });

        // 组装这一轮要喂的对话：system + 历史 + （可选）刚写的那句
        const turns = (script.turns || []).filter((t) => t && String(t.content || '').trim())
          .map((t) => ({ role: t.role, content: String(t.content) }));
        const draft = String(body.input || '').trim();
        if (draft) turns.push({ role: 'user', content: draft });
        if (!turns.length) return sendJson(res, 400, { error: '先写一句你的话，再让它起草' });
        if (turns[turns.length - 1].role !== 'user') {
          return sendJson(res, 400, { error: '下一条应该是「角色」：先在输入框写一句用户的话，或撤销到用户那条' });
        }
        const messages = [];
        if (String(script.system || '').trim()) messages.push({ role: 'system', content: script.system });
        messages.push(...turns);

        const temperature = Number(body.temperature ?? 0.85);
        const maxTokens = Number(body.maxTokens || 400);

        const callOllama = async () => {
          const base = String(config.baseUrl || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
          const r = await fetch(`${base}/api/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages, stream: false, think: false,
              options: { temperature, num_predict: maxTokens } }),
          });
          if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
          const j = await r.json();
          return {
            text: (j.message || {}).content || '',
            usage: {
              prompt: j.prompt_eval_count || 0,
              completion: j.eval_count || 0,
              total: (j.prompt_eval_count || 0) + (j.eval_count || 0),
              promptMs: j.prompt_eval_duration ? Math.round(j.prompt_eval_duration / 1e6) : 0,
              genMs: j.eval_duration ? Math.round(j.eval_duration / 1e6) : 0,
              tokPerSec: j.eval_duration ? +(j.eval_count / (j.eval_duration / 1e9)).toFixed(1) : 0,
            },
          };
        };
        // gemma 走 llama-server 的**原始补全** /completion，而不是 /v1/chat/completions。
        // 原因：新版 llama-server 会从 jinja 模板自动生成「解析器」，Gemma 的模板里
        // 有它不支持的表达式，直接 400：
        //   Unable to generate parser for this template. Automatic parser generation failed…
        // 自己按 Gemma 格式拼 prompt 就绕开了整个模板/解析器链路，也不会「走空」。
        // provider=api：调用 config 里配的云端接口（现在指 DeepSeek）。
        // 手写页起草用得上强模型：本地 gemma 12B 的笔力明显不如它。
        const callApi = async () => {
          const base = String(config.baseUrl || '').replace(/\/+$/, '');
          if (!/^https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(base)) {
            throw new Error('当前 baseUrl 不是云端接口，先把设置里的地址改成 API 地址');
          }
          const r = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey || ''}` },
            body: JSON.stringify({
              model, messages, temperature, max_tokens: maxTokens, stream: false,
            }),
          });
          if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
          const j = await r.json();
          const u = j.usage || {};
          return {
            text: ((j.choices || [{}])[0].message || {}).content || '',
            usage: {
              prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0,
              total: u.total_tokens || 0, promptMs: 0, genMs: 0, tokPerSec: 0,
            },
          };
        };

        const callLlama = async () => {
          const root = String(body.llamaUrl || 'http://127.0.0.1:18080');
          const sys = messages.find((m) => m.role === 'system');
          const turns = messages.filter((m) => m.role !== 'system');
          // Gemma 没有独立的 system 角色：system 一律放在**最前面的一条 user 段**里。
          // ⚠ 不能只在「第一条是 user」时才拼 —— 素材常常以角色开场白开头（第一条是
          // assistant），那样 system 会被整个丢掉，模型就完全不知道自己在演谁
          //（实测：输出「我是 Gemma，一个由 Google DeepMind 训练的…」）。
          let prompt = '';
          if (sys && String(sys.content || '').trim()) {
            prompt += `<start_of_turn>user\n${sys.content}<end_of_turn>\n`;
          }
          turns.forEach((m) => {
            const content = String(m.content || '');
            prompt += `<start_of_turn>${m.role === 'assistant' ? 'model' : 'user'}\n${content}<end_of_turn>\n`;
          });
          prompt += '<start_of_turn>model\n';
          // 和聊天共用一把锁：llama-server 并发会互踢（ECONNRESET）
          const { withBackendLock } = await import('./openai.js');
          const r = await withBackendLock(root, () => fetch(`${root}/completion`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt, n_predict: maxTokens, temperature, stream: false,
              stop: ['<end_of_turn>', '<eos>'],
              // prompt 里已经带了完整的对话，别再让服务端加一个 user 前缀
              cache_prompt: false,
            }),
          }));
          if (!r.ok) throw new Error(`llama-server ${r.status}: ${(await r.text()).slice(0, 200)}`);
          const j = await r.json();
          const t = j.timings || {};
          const promptN = j.tokens_evaluated || t.prompt_n || 0;
          const compN = j.tokens_predicted || t.predicted_n || 0;
          return {
            text: String(j.content || ''),
            debug: { promptChars: prompt.length, turns: turns.length, hasSys: Boolean(sys), promptHead: prompt.slice(0, 80) },
            usage: {
              prompt: promptN,
              completion: compN,
              total: promptN + compN,
              promptMs: t.prompt_ms ? Math.round(t.prompt_ms) : 0,
              genMs: t.predicted_ms ? Math.round(t.predicted_ms) : 0,
              tokPerSec: t.predicted_per_second ? +t.predicted_per_second.toFixed(1) : 0,
            },
          };
        };

        const t0 = Date.now();
        try {
          // gemma 那个 llama-server 是 systemd 用户服务（gemma-server）。
          // 训练会把它临时停掉腾显存，所以这里发现它没起就自己拉一下。
          if (provider === 'llama') {
            const root = String(body.llamaUrl || 'http://127.0.0.1:18080');
            const up = async () => {
              try { const r = await fetch(`${root}/health`); return r.ok; } catch { return false; }
            };
            if (!(await up())) {
              // 显存只有 16G：先把 Ollama 的模型和另一个 llama-server（:8080）停掉，再起 gemma-server，
              // 否则 12B + 12B 直接爆（之前 gemma-server 起不来就是栽在这）。
              await unloadOllama().catch(() => {});
              await stopLlamaServicesExcept(['gemma-server']).catch(() => {});
              // ComfyUI 也占显存的话先让它卸模型（服务不杀，下次出图自动重载）
              if (await comfyUp()) { await comfyUnloadModels().catch(() => {}); }
              const { execFile } = await import('node:child_process');
              await new Promise((resolve) => {
                execFile('systemctl', ['--user', 'start', 'gemma-server', '--no-ask-password'],
                  { timeout: 20000 }, () => resolve(null));
              });
              // 12B 加载到 GPU 大约 10-40 秒（显存够的话）
              for (let i = 0; i < 40; i++) {
                if (await up()) break;
                await new Promise((r) => setTimeout(r, 2000));
              }
              if (!(await up())) {
                return sendJson(res, 503, {
                  error: 'gemma 服务没起来：`systemctl --user start gemma-server` 失败或超时。'
                    + '可以手动跑一下看日志：`journalctl --user -u gemma-server -n 50`',
                });
              }
            }
          }
          let out;
          for (let attempt = 0; attempt < 2; attempt++) {
            out = provider === 'api' ? await callApi()
              : provider === 'llama' ? await callLlama()
              : await callOllama();
            if (String(out.text || '').trim()) break;
            if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
          }
          if (!String(out.text || '').trim()) {
            return sendJson(res, 502, {
              error: provider === 'llama'
                ? 'gemma 返回了空内容：确认 llama-server 在 18080 上跑着、且模型自带的 chat template 被正确加载'
                : '模型返回了空内容（可能是模板不匹配或输出被截断）',
              usage: out.usage,
            });
          }
          return sendJson(res, 200, {
            ok: true, text: out.text, debug: out.debug || null, usage: { ...out.usage, wallMs: Date.now() - t0 },
            model, provider,
          });
        } catch (e) {
          return sendJson(res, 500, { error: `生成失败：${e.message}` });
        }
      }

      // 把某个已有角色的「角色设定」取出来，供手写素材的 system 复用。
      // 和真实聊天用的是**同一套** buildMessages，所以写出来的素材和线上分布一致。
      if (pathname === '/api/script/character-system') {
        const cid = new URL(req.url, 'http://x').searchParams.get('id');
        const characters = await listCharacters();
        const character = characters.find((c) => c.id === cid);
        if (!character) return sendJson(res, 404, { error: '角色不存在' });
        const presetGet = String(new URL(req.url, 'http://x').searchParams.get('preset') || '');
        // preset=lean：约 300-500 字的精简 system（只给手写素材起草用）
        if (presetGet === 'lean') {
          // 单独 import：下面那行 const { leanSystemPrompt } = await import(...) 还没执行到，
          // 直接用会踩 TDZ（Cannot access 'leanSystemPrompt' before initialization）
          const { leanSystemPrompt: buildLean } = await import('./prompt.js');
          const sysLean = buildLean(character, { maxChars: 180 });
          const g0 = String(character.greeting || '').trim();
          return sendJson(res, 200, {
            name: character.name, system: sysLean, chars: sysLean.length, preset: 'lean',
            greeting: g0, greetingChars: g0.length,
          });
        }
        const config = await getConfig();
        const { buildMessages, CONTEXT_BUDGET } = await import('./prompt.js');
        // preset=script：手写素材专用的描写配比。
        // 全局设置现在是「环境 0 / 字数 120 / 动作 2」，那是为'短聊天'调的，
        // 用在写素材上会直接废掉环境与身体反应（而手写素材恰恰靠这些细节出味道，
        // 用户自己的素材里就有「（闻到一股烟味）」「（烟灰落了一截）」）。
        const preset = String(new URL(req.url, 'http://x').searchParams.get('preset') || '');
        const SCRIPT_DIMS = [
          { name: '动作', level: 4 }, { name: '神态', level: 5 },
          { name: '语言', level: 8 }, { name: '反应', level: 6 },
          { name: '环境', level: 3 }, { name: '主动性', level: 6 },
        ];
        const usePreset = preset === 'script';
        // v1.6：生成训练素材时要能指定字数上限 / 维度预设（多人 252、单人 180；dims=script 带环境细节）
        const qMax = Number(new URL(req.url, 'http://x').searchParams.get('maxChars'));
        const qDims = String(new URL(req.url, 'http://x').searchParams.get('dims') || '');
        // v1.7.7：local=1 → 返回本地小模型用的精简提示词（数据生成也要用它，保持训练/推理一致）
        const qLocal = String(new URL(req.url, 'http://x').searchParams.get('local') || '') === '1';
        const msgs = buildMessages(character, [], CONTEXT_BUDGET, config.narrative || '', {
          cleanHistory: false,
          dims: (usePreset || qDims === 'script') ? SCRIPT_DIMS : (character?.dims?.length ? character.dims : config.dims),
          hint: String(character?.hint || '').trim() || config.hint,
          synonyms: config.synonyms, synonymsOutput: config.synonymsOutput === true,
          memo: config.memo,
          maxChars: (Number.isFinite(qMax) && qMax > 0) ? qMax : (usePreset ? 180 : config.maxChars),
          knowledge: [], search: [], thinkOff: false,
          localBackend: qLocal,
        });
        const sys = (msgs.find((m) => m.role === 'system') || {}).content || '';
        // 开场白单独返回：它不属于 system（system 里塞开场白会让模型每轮都想复述它），
        // 但手写素材需要一条「角色先开口」的起始，所以交给前端插成第一条 assistant。
        const greeting = String(character.greeting || '').trim();
        return sendJson(res, 200, {
          name: character.name, system: sys, chars: sys.length, preset: usePreset ? 'script' : 'global',
          greeting, greetingChars: greeting.length,
        });
      }

      // 手动挑选用：返回全部素材（含完整 turns，工作台的 list 只给条数）
      if (pathname === '/api/script/all') {
        const { listScripts } = await import('./store.js');
        const all = [];
        for (const it of await listScripts()) {
          const s = await getScript(it.id);
          if (s) all.push(s);
        }
        return sendJson(res, 200, { scripts: all });
      }
      // 挑素材：标记「参与训练 / 剔除」
      if (pathname === '/api/script/reject' && method === 'POST') {
        const sc = await getScript(body.id);
        if (!sc) return sendJson(res, 404, { error: '素材不存在' });
        if (body.rejected) {
          sc.rejected = true;
          sc.rejectReason = '手动剔除';
        } else {
          delete sc.rejected;
          delete sc.rejectReason;
        }
        const saved = await saveScript(sc);
        return sendJson(res, 200, { ok: true, script: saved });
      }

      if (pathname === '/api/script/create' && method === 'POST') {
        return sendJson(res, 200, { ok: true, script: await createScript({ title: body.title }) });
      }
      if (pathname === '/api/script/save' && method === 'POST') {
        return sendJson(res, 200, { ok: true, script: await saveScript(body.script) });
      }
      if (pathname === '/api/script/delete' && method === 'POST') {
        return sendJson(res, 200, await deleteScript(body.id));
      }
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    return sendJson(res, 404, { error: '未知的素材接口' });
  }

  // 用手写素材起一次 SFT（权重走 handwritten 档）
  if (pathname === '/api/train/script' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    try {
      const r = await enqueueScriptTraining({
        epochs: body.epochs, lr: body.lr, maxSeqLen: body.maxSeqLen,
        weights: body.weights, base: body.base,
        autoDeploy: body.autoDeploy,
        mixRatio: body.mixRatio, mixClaude: body.mixClaude,
        gradAccum: body.gradAccum,
      });
      return sendJson(res, r.ok ? 200 : 409, r);
    } catch (e) {
      return sendJson(res, 500, { error: `加入队列失败：${e.message}` });
    }
  }

  if (pathname === '/api/train/session' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const session = await getSession(String(body.sessionId || ''));
    if (!session) return sendJson(res, 404, { error: '会话不存在' });
    const characters = await listCharacters();
    const character = characters.find((c) => c.id === session.characterId);
    try {
      const r = await enqueueTraining({
        sessionId: session.id,
        title: character?.name || session.title || 'session',
        epochs: body.epochs, lr: body.lr,
        maxTokens: body.maxTokens, maxSeqLen: body.maxSeqLen,
        batchSize: body.batchSize, gradAccum: body.gradAccum,
        clean: body.clean, minChars: body.minChars, dpo: body.dpo,
        weights: body.weights, base: body.base,
        mixClaude: body.mixClaude, mixRatio: body.mixRatio,
        deleteOllama: body.deleteOllama, deleteLlama: body.deleteLlama,
      });
      return sendJson(res, r.ok ? 200 : 409, r);
    } catch (e) {
      return sendJson(res, 500, { error: `加入队列失败：${e.message}` });
    }
  }

  // 大模式：用「标准回答库」训练
  if (pathname === '/api/train/gold' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    try {
      const r = await enqueueGoldTraining({
        minScore: body.minScore, epochs: body.epochs, lr: body.lr,
        maxSeqLen: body.maxSeqLen, system: body.system,
        weights: body.weights, base: body.base,
        deleteOllama: body.deleteOllama, deleteLlama: body.deleteLlama,
      });
      return sendJson(res, r.ok ? 200 : 409, r);
    } catch (e) {
      return sendJson(res, 500, { error: `大模式入队失败：${e.message}` });
    }
  }

  // 标准回答库统计
  if (pathname === '/api/gold/stats' && method === 'GET') {
    const { execFile } = await import('node:child_process');
    const dir = process.env.LLM_CHAT_DIR || '/home/don0ox1/deepseek/llm-chat';
    const st = await new Promise((resolve) => {
      execFile(path.join(dir, '.venv-train/bin/python'), [path.join(dir, 'gold_corpus.py'), 'stats'], {
        cwd: dir, env: { ...process.env },
      }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
    });
    let dpoCount = 0, candCount = 0;
    try { dpoCount = (await fs.readFile(path.join(dir, 'gold', 'dpo_pairs.jsonl'), 'utf8')).split('\n').filter(Boolean).length; } catch { /* 无 */ }
    try { candCount = (await fs.readFile(path.join(dir, 'gold', 'candidates.jsonl'), 'utf8')).split('\n').filter(Boolean).length; } catch { /* 无 */ }
    return sendJson(res, 200, { ok: st.ok, stats: st.out, dpoPairs: dpoCount, candidates: candCount });
  }

  // 队列状态
  if (pathname === '/api/train/queue' && method === 'GET') {
    return sendJson(res, 200, await queueState());
  }

  // 取消某一项（待开始或正在训练）
  if (pathname === '/api/train/cancel' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return sendJson(res, 200, await cancelQueued(String(body.id || '')));
  }

  // 从队列移除
  if (pathname === '/api/train/remove' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return sendJson(res, 200, await removeQueued(String(body.id || '')));
  }

  // --- 训练监控页：直接读 logs/*.log，不依赖进程状态 ---
  if (pathname === '/api/train/runs' && method === 'GET') {
    return sendJson(res, 200, {
      runs: await listTrainRuns(),
      gpu: await gpuSnapshot(),
      // 实时进程（不依赖日志）：日志被缓冲住时，这个仍然是真的
      live: await liveProcesses(),
    });
  }
  if (pathname === '/api/train/run' && method === 'GET') {
    const name = url.searchParams.get('name') || '';
    const detail = await trainRunDetail(name);
    if (!detail) return sendJson(res, 404, { error: '找不到这个日志' });
    return sendJson(res, 200, detail);
  }

  if (pathname === '/api/train/status' && method === 'GET') {
    const q = await queueState();
    const cur = q.items.find((i) => i.id === q.currentId);
    return sendJson(res, 200, {
      running: q.running,
      status: cur ? cur.status : 'idle',
      step: cur ? cur.step : '',
      log: cur ? cur.log : '',
      outPath: cur ? cur.outPath : '',
      archivePath: cur ? cur.archivePath : '',
      queue: q,
    });
  }

  // 手动打开「训练控制台」窗口（训练监控页/命令行都能用）
  if (pathname === '/api/train/console' && method === 'POST') {
    try {
      const { openTrainConsole } = await import('./trainer.js');
      const q = await queueState();
      const cur = q.items.find((i) => i.id === q.currentId);
      return sendJson(res, 200, openTrainConsole({ log: cur?.logPath || '', data: cur?.dataPath || '' }));
    } catch (err) {
      return sendJson(res, 500, { error: `打开控制台失败：${err.message}` });
    }
  }

  if (pathname === '/api/train/stop' && method === 'POST') {
    return sendJson(res, 200, stopTraining());
  }

  if (pathname === '/api/gpu' && method === 'GET') {
    const config = await getConfig();
    const st = await gpuArbiterStatus().catch(() => ({}));
    const loaded = await ollamaLoaded();
    return sendJson(res, 200, {
      ...st,
      ollamaUp: loaded !== null,
      ollamaLoaded: loaded || [],
      llamaServerUp: await llamaServerUp(18080),
      arbiter: config.gpuArbiter !== false,
      restorePending: gpuRestoreQueue.length,
    });
  }

  // 手动触发一次自动调度（调试/救急用：聊天卡住时点一下就把显存腾出来）
  if (pathname === '/api/gpu/arbitrate' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const config = await getConfig();
    try {
      cancelGpuRestore();
      const r = await arbitrateForChat({
        needGB: Number(body.needGB) > 0 ? Number(body.needGB) : 1.2,
        targetModel: config.model,
        embedModel: config.knowledgeEmbedModel,
      });
      if (r.stoppedServices?.length) scheduleGpuRestore(r.stoppedServices);
      return sendJson(res, 200, { ok: r.ok, ...r });
    } catch (err) {
      return sendJson(res, 500, { error: `调度失败：${err.message}` });
    }
  }

  // 立刻恢复被调度临时停掉的服务（不等那 2 分钟）
  if (pathname === '/api/gpu/restore' && method === 'POST') {
    cancelGpuRestore();
    const queue = gpuRestoreQueue;
    gpuRestoreQueue = [];
    try {
      const restored = await restoreGpuAfterChat(queue);
      return sendJson(res, 200, { ok: true, restored });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/gpu/unload' && method === 'POST') {
    return sendJson(res, 200, await unloadOllama());
  }

  // --- 训练数据导出（QLoRA）---
  if (pathname === '/api/export-training') {
    const q = url.searchParams;
    try {
      const out = await exportTrainingSamples({
        sessionId: q.get('sessionId') || undefined,
        characterId: q.get('characterId') || undefined,
        maxTokens: Number(q.get('maxTokens')) || 3072,
        histTokens: Number(q.get('histTokens')) || 0,
        minChars: q.get('minChars') != null ? Number(q.get('minChars')) : 12,
        withRejected: q.get('withRejected') !== '0',
      });
      if (q.get('download') === '1') {
        res.writeHead(200, {
          'Content-Type': 'application/x-jsonlines; charset=utf-8',
          'Content-Disposition': `attachment; filename="xingye-training.jsonl"`,
        });
        return res.end(toJsonl(out.samples));
      }
      return sendJson(res, 200, {
        ok: true, stat: out.stat,
        sampleCount: out.samples.length, negativeCount: out.negatives.length,
      });
    } catch (e) {
      return sendJson(res, 500, { error: `导出失败：${e.message}` });
    }
  }

  // 部署：训练出的 LoRA → 合并 → 转 GGUF → 量化，变成能聊天的模型（带版本号）
  if (pathname === '/api/train/deploy' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    try {
      const r = await deployTraining({ adapter: body.adapter, version: body.version });
      return sendJson(res, r.ok ? 200 : 409, r);
    } catch (e) {
      return sendJson(res, 500, { error: `部署失败：${e.message}` });
    }
  }

  if (pathname === '/api/models/versions' && method === 'GET') {
    const reg = path.join(process.env.LLM_CHAT_DIR || '/home/don0ox1/deepseek/llm-chat', 'models', 'registry');
    let versions = [];
    try {
      const dirs = (await fs.readdir(reg)).filter((d) => d !== 'current');
      let current = '';
      try { current = (await fs.readlink(path.join(reg, 'current'))).split('/').pop(); } catch { /* 无 */ }
      versions = await Promise.all(dirs.map(async (d) => {
        let m = null;
        try { m = JSON.parse(await fs.readFile(path.join(reg, d, 'manifest.json'), 'utf8')); } catch { /* 无 */ }
        return { version: d, current: d === current, manifest: m };
      }));
    } catch { /* registry 还没建 */ }
    return sendJson(res, 200, { versions });
  }

  // 候选生成：一次生成 N 个回答供挑选（选中的成为标准回答，其余变负样本）
  // 🙋 「该我说什么」：让模型**反过来扮演你**，根据角色刚说的话生成 4 个
  // 你可以回应的候选。和 /api/chat/presend 正好相反 ——
  //   那个是「我已经想好说什么了，先看看它怎么回」
  //   这个是「我不知道说什么了，帮我起个头」
  // 用主模型（不是小模型）：实测 1.7B 只会复读、说"好吧""哦..."，
  // 写不出有内容的角色扮演台词。慢几秒换质量，值得。
  if (pathname === '/api/chat/suggest' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const sessionId = String(body.sessionId || '');
    const n = Math.min(4, Math.max(2, Number(body.n) || 4));
    const session = await getSession(sessionId);
    if (!session) return sendJson(res, 404, { error: '会话不存在' });
    const characters = await listCharacters();
    const character = characters.find((c) => c.id === session.characterId);
    const config = await getConfig();
    try {
      // 取最近几轮做素材（太长的历史反而让小模型抓不住重点）
      const dialog = (session.messages || [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
        .slice(-8);
      if (!dialog.length) return sendJson(res, 400, { error: '这个会话还没有对话' });

      const name = character?.name || '对方';
      const style = String(character?.hint || '').trim().slice(0, 200);
      const sysPrompt = `你现在代替【玩家】发言。对面是「${name}」${style ? `（${style}）` : ''}。

这段对话的格式：**「${name}」说的话在上一条 user 里，玩家说的话由你写在 assistant 里**。
你要写的是**玩家**刚刚开口的下一句。

严格规则：
1. **只写玩家**的台词和动作 —— 不要替「${name}」说一个字，
   不要写${name}的反应、心理、动作，不要写旁白
2. 动作写在（）括号里，例：（走过去，坐在床边）
3. 不要用 *星号*，只用（）括号
4. 长度 8~35 字，像随口说出来的话，别写成小说
5. 不要重复玩家之前说过的话
6. **直接输出这一句**，不要解释、不要前缀、不要引号包裹，也不要以「${name}：」开头`;

      // v2.0.2：**改用标准 chat 格式**，把「玩家这一侧」标成 assistant，让模型续写 assistant 段。
      // 以前用的是「玩家: / 角色名:」纯文本 + 末尾一个「玩家:」——8B 模型会把它当成
      // 对话正文往下写，于是输出成角色的下一句（实测：让写玩家的话，回的是角色的台词）。
      // assistant 消息 = 玩家说过的；user 消息 = 角色说过的。
      const chatMsgs = [{ role: 'system', content: sysPrompt }];
      for (const m of dialog) {
        if (!String(m.content || '').trim()) continue;
        chatMsgs.push(m.role === 'user'
          ? { role: 'assistant', content: m.content }
          : { role: 'user', content: m.content });
      }
      // 最后一条必须是 user（= 角色刚说的那句），模型才会接着写 assistant（= 玩家）
      if (chatMsgs.length < 2 || chatMsgs[chatMsgs.length - 1].role !== 'user') {
        chatMsgs.push({ role: 'user', content: '（继续说）' });
      }

      const candidates = await generateCandidates({
        config,
        messages: chatMsgs,
        n, baseTemp: 0.95, maxTokens: 90,
      });
      // 清掉模型偶尔带出来的前缀（"玩家:" / "用户:"）
      const cleaned = candidates.map((c) => ({
        ...c,
        text: String(c.text || '').replace(/^\s*(玩家|用户|我)\s*[:：]\s*/, '').trim(),
      })).filter((c) => c.text.length >= 4);
      return sendJson(res, 200, { ok: true, candidates: cleaned, model: config.model });
    } catch (e) {
      return sendJson(res, 500, { error: `生成失败：${e.message}` });
    }
  }

  // 发送前预选：**你还没发出去的这句话** + 历史 → 生成 N 个角色的回应，
  // 挑一个当正文直接显示（不消耗你的发送次数，也不需要真的先把消息发出去）。
  // 和 /api/gold/generate 的区别：那个是替换**已有**的回复，这个是预览**将要**得到的回复。
  if (pathname === '/api/chat/presend' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const sessionId = String(body.sessionId || '');
    const content = String(body.content || '').trim();
    const n = Math.min(4, Math.max(2, Number(body.n) || 4));
    if (!content) return sendJson(res, 400, { error: '还没输入内容' });
    const session = await getSession(sessionId);
    if (!session) return sendJson(res, 404, { error: '会话不存在' });
    const characters = await listCharacters();
    const character = characters.find((c) => c.id === session.characterId);
    const config = await getConfig();
    try {
      const { buildMessages, CONTEXT_BUDGET } = await import('./prompt.js');
      // 历史 + 这句还没发的话（当作最后一条 user）
      const history = (session.messages || [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
        .map(({ role, content: c }) => ({ role, content: c }));
      history.push({ role: 'user', content });
      const msgs = buildMessages(character, history, CONTEXT_BUDGET, config.narrative || '', {
        cleanHistory: config.cleanHistory !== false,
        dims: character?.dims?.length ? character.dims : config.dims,
        hint: String(character?.hint || '').trim() || config.hint,
        synonyms: config.synonyms, synonymsOutput: config.synonymsOutput === true,
        memo: config.memo, maxChars: config.maxChars,
        knowledge: [], search: [], thinkOff: false,
      });
      const candidates = await generateCandidates({
        config,
        messages: msgs.map((m) => ({ role: m.role, content: m.content })),
        n, baseTemp: 0.95, maxTokens: 720,
      });
      return sendJson(res, 200, { ok: true, candidates, model: config.model });
    } catch (e) {
      return sendJson(res, 500, { error: `生成失败：${e.message}` });
    }
  }

  if (pathname === '/api/gold/generate' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const sessionId = String(body.sessionId || '');
    const n = Math.min(8, Math.max(2, Number(body.n) || 4));
    const session = await getSession(sessionId);
    if (!session) return sendJson(res, 404, { error: '会话不存在' });
    const characters = await listCharacters();
    const character = characters.find((c) => c.id === session.characterId);
    const config = await getConfig();
    try {
      // 用和真实聊天完全一致的上下文构建方式
      const { buildMessages, CONTEXT_BUDGET } = await import('./prompt.js');
      const end = body.endIndex != null ? Number(body.endIndex) : session.messages.length;
      const history = (session.messages || []).slice(0, end)
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
        .map(({ role, content }) => ({ role, content }));
      const msgs = buildMessages(character, history, CONTEXT_BUDGET, config.narrative || '', {
        cleanHistory: config.cleanHistory !== false,
        dims: character?.dims?.length ? character.dims : config.dims,
        hint: String(character?.hint || '').trim() || config.hint,
        synonyms: config.synonyms, synonymsOutput: config.synonymsOutput === true,
        memo: config.memo, maxChars: config.maxChars,
        knowledge: [], search: [], thinkOff: false,
      });
      // 走应用自己的 OpenAI 兼容通道（baseUrl/model 与聊天一致），
      // 不再写死 Ollama 11434（llama-server / 云端都能用）
      const candidates = await generateCandidates({
        config,
        messages: msgs.map((m) => ({ role: m.role, content: m.content })),
        n, baseTemp: 0.95, maxTokens: 720,
      });
      // 保存候选组，供后续 choose
      const dir = process.env.LLM_CHAT_DIR || '/home/don0ox1/deepseek/llm-chat';
      const groupId = `cand-${Date.now().toString(36)}`;
      const groupFile = path.join(dir, 'data', `cand-${groupId}.json`);
      await fs.mkdir(path.dirname(groupFile), { recursive: true });
      const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content || '';
      const payload = {
        groupId, sessionId, character: character?.name || '',
        context: history.slice(0, -1), user: lastUser,
        candidates, model: config.model,
      };
      await fs.writeFile(groupFile, JSON.stringify(payload), 'utf8');
      return sendJson(res, 200, { ok: true, ...payload });
    } catch (e) {
      return sendJson(res, 500, { error: `生成失败：${e.message}` });
    }
  }

  // 全部否决：关闭面板 = 4 个候选你都不要，全部记进负样本（不进标准库）
  if (pathname === '/api/gold/reject-all' && method === 'POST') {
    const { execFile } = await import('node:child_process');
    const body = await readBody(req).catch(() => ({}));
    const dir = process.env.LLM_CHAT_DIR || '/home/don0ox1/deepseek/llm-chat';
    const groupFile = path.join(dir, 'data', `cand-${String(body.groupId || '')}.json`);
    try {
      await fs.access(groupFile);
    } catch {
      return sendJson(res, 404, { error: '候选组不存在或已过期' });
    }
    try {
      const r = await new Promise((resolve) => {
        execFile(path.join(dir, '.venv-train/bin/python'),
          [path.join(dir, 'gold_corpus.py'), 'reject', '--candidates', groupFile],
          { cwd: dir, env: { ...process.env } },
          (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
      });
      if (r.ok) await fs.unlink(groupFile).catch(() => {});
      return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, out: r.out });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 采纳某个候选：选中的进标准库，其余记为负样本（DPO）
  if (pathname === '/api/gold/choose' && method === 'POST') {
    const { execFile } = await import('node:child_process');
    const body = await readBody(req).catch(() => ({}));
    const dir = process.env.LLM_CHAT_DIR || '/home/don0ox1/deepseek/llm-chat';
    const groupFile = path.join(dir, 'data', `cand-${String(body.groupId || '')}.json`);
    try {
      await fs.access(groupFile);
    } catch {
      return sendJson(res, 404, { error: '候选组不存在或已过期' });
    }
    try {
      const r = await new Promise((resolve) => {
        execFile(path.join(dir, '.venv-train/bin/python'),
          [path.join(dir, 'gold_corpus.py'), 'choose', '--candidates', groupFile,
           '--index', String(Number(body.index) || 0),
           ...(body.character ? ['--character', String(body.character)] : [])],
          { cwd: dir, env: { ...process.env } },
          (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
      });
      // 采纳后删掉候选组文件
      if (r.ok) await fs.unlink(groupFile).catch(() => {});
      return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, out: r.out });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // --- 同步：整包导出 / 合并导入 ---
  // 在本机文件管理器里打开数据目录（v1.6.1）。只允许本机调用。
  if (pathname === '/api/data-dir/open' && method === 'POST') {
    if (!isLoopback(req)) {
      return sendJson(res, 403, { error: '只有本机可以打开文件夹' });
    }
    try {
      const opened = await openDataDir(req);
      return sendJson(res, 200, { ok: true, opened, path: DATA_DIR });
    } catch (err) {
      return sendJson(res, 500, { error: `打开失败：${err.message}` });
    }
  }

  if (pathname === '/api/export' && method === 'GET') {
    const bundle = await exportBundle();
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="workbench-backup-${stamp}.json"`,
    });
    return res.end(JSON.stringify(bundle, null, 2));
  }

  if (pathname === '/api/import' && method === 'POST') {
    // 备份文件可能不小，放宽到 50MB。
    const bundle = await readBody(req, 50 * 1024 * 1024);
    try {
      const stats = await mergeBundle(bundle);
      return sendJson(res, 200, { ok: true, ...stats });
    } catch (err) {
      // 用户选错文件属于客户端问题，回 400 而不是 500。
      return sendJson(res, 400, { error: err.message });
    }
  }

  // --- 日常强化评分（v1.9.0）---
  // POST /api/rl/label  {sessionId, messageAt, w}
  // 只落盘，不改模型、不触发训练。
  if (pathname === '/api/rl/label' && method === 'POST') {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || '');
    const w = normalizeW(body.w);
    if (w === null) return sendJson(res, 400, { error: 'w 必须是 0~3 的数字' });
    const session = await getSession(sessionId);
    if (!session) return sendJson(res, 404, { error: '会话不存在' });
    // 找到那条被评分的回复：优先用 messageAt 精确定位，否则取最后一条角色回复
    const at = Number(body.messageAt) || 0;
    let idx = -1;
    if (at) idx = session.messages.findLastIndex((m) => m.role === 'assistant' && m.at === at);
    if (idx < 0) idx = session.messages.findLastIndex((m) => m.role === 'assistant');
    if (idx < 0) return sendJson(res, 400, { error: '这个会话里还没有角色回复' });
    const target = session.messages[idx];
    const config = await getConfig();
    const rec = await saveLabel({
      sessionId,
      characterId: session.characterId || '',
      model: config.model || '',
      w,
      prompt: Array.isArray(target.rlPrompt) ? target.rlPrompt : promptSnapshot([]),
      reply: target.content,
      // v2.1.1：手改过的回复带上标记 —— 训练端可以据此知道"这条分数评的是改写稿"
      note: target.editedAt ? `改写稿（原生成于 ${new Date(target.at || 0).toLocaleString('zh-CN')}）` : '',
    });
    // 记在这条回复上，重新打开会话也能看到打过几分
    target.rl = { w, at: rec.at };
    await saveSession(session);
    return sendJson(res, 200, { ok: true, label: { id: rec.id, w: rec.w, wLabel: rec.wLabel }, stats: await labelStats() });
  }
  if (pathname === '/api/rl/labels' && method === 'GET') {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit')) || 20));
    return sendJson(res, 200, await listLabels(limit));
  }

  // --- 角色卡 ---
  if (pathname === '/api/characters') {
    if (method === 'GET') {
      // ?all=1 连隐藏的也一起返回（设置里"显示隐藏角色"用）
      const all = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('all') === '1';
      return sendJson(res, 200, { characters: await listCharacters({ includeHidden: all }) });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      // 隐藏/取消隐藏：只带 {id, hidden} 也行（saveCharacter 里面没传的字段保持原样）
      return sendJson(res, 200, { character: await saveCharacter(body) });
    }
  }
  // 资料库：每角色一份纯文本。GET 取回；PUT 保存（空文本 = 删掉）。
  // 还能带一个 query 做"预演"：只返回这一轮会挑中哪几块，方便你先看效果。
  if (pathname === '/api/knowledge') {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (method === 'GET') {
      const characterId = u.searchParams.get('characterId') || '';
      const [text, sharedText] = await Promise.all([getKnowledge(characterId), getSharedKnowledge()]);
      const q = u.searchParams.get('query') || '';
      // 预演必须和真正生成时**走同一条检索路径**（否则预览会撒谎，v0.53.1 踩过这个坑）：
      // 角色模式实际注入的是「共享 + 这个角色」，这里也拼起来挑。
      const config = await getConfig();
      const combined = [sharedText, text].filter((t) => t && t.trim()).join('\n\n');
      const r = q ? await pickChunksSmart(combined, mappedQuery(q, config), knowledgeOpts(config)) : { chunks: [], mode: null };
      if (r.err) knowledgePickWarnOnce(r.err);
      return sendJson(res, 200, {
        characterId, text, sharedText, max: KNOWLEDGE_MAX, picked: r.chunks, mode: r.mode, degradeErr: r.err || null,
      });
    }
    if (method === 'PUT' || method === 'POST') {
      const { characterId, text } = await readBody(req);
      // v0.60.0：超上限**明确报错**，不再静默截断（截断会把资料悄悄吃掉一大半）
      if (String(text || '').length > KNOWLEDGE_MAX) {
        return sendJson(res, 400, { error: `资料太长（${String(text).length} 字，上限 ${KNOWLEDGE_MAX} 字）` });
      }
      const saved = await saveKnowledge(characterId, text);
      return sendJson(res, 200, { ok: true, characterId, chars: saved.length, max: KNOWLEDGE_MAX });
    }
  }

  // 共享资料库：**直连模式和所有角色都读这一份**（`knowledge/_shared.md`）。
  // `/api/direct/knowledge` 是它的旧名字，保留为别名，老书签 / 老前端还能用。
  if (pathname === '/api/knowledge/shared' || pathname === '/api/direct/knowledge') {
    const legacy = pathname === '/api/direct/knowledge';
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (method === 'GET') {
      const text = await getSharedKnowledge();
      const q = u.searchParams.get('query') || '';
      const config = await getConfig();
      const r = q ? await pickChunksSmart(text, mappedQuery(q, config), knowledgeOpts(config)) : { chunks: [], mode: null };
      if (r.err) knowledgePickWarnOnce(r.err);
      return sendJson(res, 200, {
        scope: legacy ? 'direct' : 'shared', text, max: KNOWLEDGE_MAX, picked: r.chunks, mode: r.mode, degradeErr: r.err || null,
      });
    }
    if (method === 'PUT' || method === 'POST') {
      const { text } = await readBody(req);
      if (String(text || '').length > KNOWLEDGE_MAX) {
        return sendJson(res, 400, { error: `资料太长（${String(text).length} 字，上限 ${KNOWLEDGE_MAX} 字）` });
      }
      const saved = await saveSharedKnowledge(text);
      return sendJson(res, 200, { ok: true, scope: legacy ? 'direct' : 'shared', chars: saved.length, max: KNOWLEDGE_MAX });
    }
  }
  const charMatch = pathname.match(/^\/api\/characters\/([\w-]+)$/);
  if (charMatch && method === 'DELETE') {
    const ok = await deleteCharacter(charMatch[1]);
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  // --- 星野抓取（SPEC §5：分享链接 → 角色卡 → 注册） ---
  if (pathname === '/api/xingye/status' && method === 'GET') {
    xyJobPrune();
    return sendJson(res, 200, { ok: true, stats: await xingyeStats() });
  }

  if (pathname === '/api/xingye/cards' && method === 'GET') {
    const r = await listCards({
      query: url.searchParams.get('query') || '',
      limit: url.searchParams.get('limit') || 200,
      offset: url.searchParams.get('offset') || 0,
    });
    return sendJson(res, 200, { ok: true, total: r.total, items: r.items });
  }

  if (pathname === '/api/xingye/job' && method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: '请求体不是合法 JSON' });
    const mode = body.mode === 'links' || body.mode === 'ids' ? body.mode : '';
    if (!mode) return sendJson(res, 400, { error: 'mode 只能是 "links" 或 "ids"' });
    xyJobPrune();
    if (xyJobBusy()) return sendJson(res, 409, { error: '已有任务在跑，等它结束' });
    const jobId = `j_${Date.now().toString(36)}${(xingyeJobSeq += 1).toString(36)}`;
    const job = {
      jobId, status: 'running', mode,
      startedAt: Date.now(), finishedAt: null,
      progress: { done: 0, total: 0, ok: 0, fail: 0, registered: 0 },
      log: [], items: [], error: null,
    };
    xingyeJobs.set(jobId, job);
    // 不 await：任务在后台跑，前端轮询 §5.4 取进度。
    xyRunJob(job, {
      mode,
      links: String(body.links || ''),
      ids: body.ids,
      autoRegister: body.autoRegister !== false,
      downloadAvatar: body.downloadAvatar !== false,
    }).catch((err) => {
      job.status = 'error';
      job.error = err.message || String(err);
      job.finishedAt = Date.now();
    });
    return sendJson(res, 200, { ok: true, jobId });
  }

  const xyJobMatch = pathname.match(/^\/api\/xingye\/job\/([\w-]+)$/);
  if (xyJobMatch && method === 'GET') {
    xyJobPrune();
    const job = xingyeJobs.get(xyJobMatch[1]);
    if (!job) return sendJson(res, 404, { error: '任务不存在或已过期' });
    return sendJson(res, 200, xyJobView(job));
  }

  if (pathname === '/api/xingye/register' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const npcIds = Array.isArray(body.npcIds) ? body.npcIds : [];
    if (!npcIds.length) return sendJson(res, 400, { error: 'npcIds 不能为空' });
    const r = await registerCharacters(npcIds);
    return sendJson(res, 200, { ok: true, created: r.created, skipped: r.skipped });
  }

  const xyCardMatch = pathname.match(/^\/api\/xingye\/cards\/(\d+)$/);
  if (xyCardMatch) {
    const npcId = Number(xyCardMatch[1]);
    if (method === 'GET') {
      const rec = await getRecord(npcId);
      if (!rec) return sendJson(res, 404, { error: '没有这个抓取记录' });
      return sendJson(res, 200, { ok: true, item: rec.item, card: rec.card });
    }
    if (method === 'DELETE') {
      // 只删「已抓记录」，已注册的本地角色保留（SPEC §4）。
      const ok = await deleteRecord(npcId);
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '没有这个抓取记录' });
    }
  }

  const xyAvatarMatch = pathname.match(/^\/api\/xingye\/avatar\/(\d+)$/);
  if (xyAvatarMatch && method === 'GET') {
    const av = await avatarFile(Number(xyAvatarMatch[1]));
    if (!av) return sendJson(res, 404, { error: '没有头像' });
    try {
      const buf = await fs.readFile(av.file);
      res.writeHead(200, {
        'Content-Type': av.mime,
        'Cache-Control': 'public, max-age=86400',
      });
      return res.end(buf);
    } catch {
      return sendJson(res, 404, { error: '没有头像' });
    }
  }

  if (pathname === '/api/xingye/search' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const query = String(body.query || '').trim();
    if (!query) return sendJson(res, 400, { error: '搜索关键词不能为空' });
    const items = await xingyeSearch(query);
    return sendJson(res, 200, { ok: true, items });
  }

  // --- 会话 ---
  if (pathname === '/api/sessions') {
    if (method === 'GET') return sendJson(res, 200, { sessions: await listSessions() });
    if (method === 'POST') {
      const { characterId, greeting } = await readBody(req);
      const session = await createSession(characterId);
      // 开场白作为第一条 assistant 消息，让角色先开口。
      // 优先用请求里带的；**没带就自己去角色卡上取** —— 这样不管哪个客户端建会话
      // （老版本手机端、脚本、以后新加的入口）都不会丢掉开场白，不用每个前端都记得传。
      let text = String(greeting || '').trim();
      let card = null;
      if (!text && characterId) {
        card = await getCharacter(characterId);
        text = String(card?.greeting || '').trim();
      }
      // 多人卡：开场白里的「（陈梦）台词」先归位成「陈梦：台词」——
      // 这句会作为历史第一条喂给模型，留着括号写法模型会照着学（实测会整轮跟）。
      if (text && characterId) {
        card = card || await getCharacter(characterId);
        const cast = card ? castOf(card) : [];
        if (cast.length >= 2) text = normalizeCastSpeaker(text, cast);
      }
      if (text) {
        session.messages.push({ role: 'assistant', content: text, at: Date.now() });
        await saveSession(session);
      }
      return sendJson(res, 200, { session });
    }
  }
  // 会话 → 导出聊天记录（会话列表每项的 ⬇）：默认 Markdown，?format=json 是整包存档。
  // 两种会话共用 /api/sessions/:id，所以角色会话和直连会话都走这一个入口。
  const sessExportMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/export$/);
  if (sessExportMatch && method === 'GET') {
    const session = await getSession(sessExportMatch[1]);
    if (!session) return sendJson(res, 404, { error: '会话不存在' });
    const character = session.characterId ? await getCharacter(session.characterId) : null;
    const format = String(url.searchParams.get('format') || 'md').toLowerCase();
    if (format === 'json') {
      const body = sessionToJson(session, character);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="chat-${session.id}.json"; filename*=UTF-8''${encodeURIComponent(chatLogFileName(session, character).replace(/\.md$/, '.json'))}`,
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }
    const body = await sessionToMarkdown(session, character);
    const filename = chatLogFileName(session, character);
    // 中文文件名走 RFC 5987；filename= 只留一段 ASCII 兜底，老浏览器也不会乱码。
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="chat-${session.id}.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  const sessMatch = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
  if (sessMatch) {
    if (method === 'GET') {
      const session = await getSession(sessMatch[1]);
      return session ? sendJson(res, 200, { session }) : sendJson(res, 404, { error: '会话不存在' });
    }
    if (method === 'DELETE') {
      // 一并回报被删掉的消息条数，前端能明确告诉用户「删掉了多少条」。
      const doomed = await getSession(sessMatch[1]);
      const removed = doomed?.messages?.length || 0;
      return sendJson(res, 200, { ok: await deleteSession(sessMatch[1]), removed });
    }
    if (method === 'PATCH') {
      const session = await getSession(sessMatch[1]);
      if (!session) return sendJson(res, 404, { error: '会话不存在' });
      const { title, action, index, content, rejectedIndex, reason, tag, on } = await readBody(req);
      if (title) session.title = title.slice(0, 40);

      // 撤回：删掉第 index 条及其之后的全部消息（下标按 messages 数组算）。
      // 之所以连后面一起删，是因为删掉中间一条会让对话上下文接不上。
      if (action === 'recall') {
        const i = Number(index);
        if (!Number.isInteger(i) || i < 0 || i >= session.messages.length) {
          return sendJson(res, 400, { error: '消息下标不合法' });
        }
        const removed = session.messages.splice(i).length;
        await saveSession(session);
        return sendJson(res, 200, { session, removed });
      }

      // 采用「已否决」里的某一版：正文与那一版互换。
      // 被换下来的那一版会进入否决列表，所以这一步可以反复来回切，不会丢东西。
      if (action === 'adopt') {
        const i = Number(index);
        const r = Number(rejectedIndex);
        const msg = session.messages[i];
        if (!msg || !Array.isArray(msg.rejected)) {
          return sendJson(res, 400, { error: '这条消息没有已否决的版本' });
        }
        const pick = msg.rejected[r];
        if (!Number.isInteger(r) || !pick) return sendJson(res, 400, { error: '版本下标不合法' });
        const current = msg.content;
        msg.rejected = [
          { text: current, reason: '被换下的这一版', source: 'swap', at: Date.now() },
          ...msg.rejected.filter((_, k) => k !== r),
        ].slice(0, 5);
        msg.content = pick.text;
        msg.adoptedAt = Date.now();
        // 从候选里挑中的 = 明确的正面信号（训练加权用）
        msg.origin = 'adopted';
        await saveSession(session);
        return sendJson(res, 200, { session });
      }

      // 给「已否决」里的某一版打标记：「知识错误」/「设定不符」，可以同时打多个。
      // 用途：这一版语气可能没问题，但写错了客观事实或角色设定 —— 它仍然是有价值的
      // 负样本，标上之后进 DPO 时能带上理由，训练侧也统计得到。
      //
      // 请求两种形态都收：
      //   { tag:'知识错误', on:true }           开关单个标记
      //   { reason:'知识错误' }                  老形态（整串覆盖），清空即取消全部
      if (action === 'vetoReason') {
        const i = Number(index);
        const r = Number(rejectedIndex);
        const msg = session.messages[i];
        if (!msg || !Array.isArray(msg.rejected) || !msg.rejected[r]) {
          return sendJson(res, 400, { error: '没有这一版' });
        }
        const cur = msg.rejected[r];
        // 兼容老数据：老版本只存一个 tag 字符串
        let tags = Array.isArray(cur.tags) ? cur.tags.slice() : (cur.tag ? [cur.tag] : []);
        delete cur.tag;
        if (reason !== undefined && tag === undefined) {
          const one = String(reason || '').trim().slice(0, 60);
          tags = one ? [one] : [];
        } else {
          const key = String(tag || '').trim().slice(0, 60);
          if (!key) return sendJson(res, 400, { error: '缺少 tag' });
          if (on) { if (!tags.includes(key)) tags.push(key); }
          else tags = tags.filter((x) => x !== key);
        }
        if (tags.length) {
          cur.tags = tags;
          cur.taggedAt = Date.now();
        } else {
          delete cur.tags;
          delete cur.taggedAt;
        }
        await saveSession(session);
        return sendJson(res, 200, { session });
      }

      // 人工改写：只改那一条的内容，并留一个"已改写"的标记。
      if (action === 'edit') {
        const i = Number(index);
        if (!Number.isInteger(i) || i < 0 || i >= session.messages.length) {
          return sendJson(res, 400, { error: '消息下标不合法' });
        }
        const text = (content || '').trim();
        if (!text) return sendJson(res, 400, { error: '内容不能为空' });
        session.messages[i].content = text;
        session.messages[i].editedAt = Date.now();
        // 手改是明确的正面信号：训练加权时这条按「手改」算（见 lib/weights.js）
        session.messages[i].origin = 'edited';
        // 多人卡：手改之后分段要重算，否则气泡还按旧内容显示
        {
          const ch = (await listCharacters()).find((c) => c.id === session.characterId);
          const { castOf, parseReplyLines } = await import('./prompt.js');
          if (ch && castOf(ch).length >= 2) {
            session.messages[i].segments = parseReplyLines(text, castOf(ch).map((x) => x.name));
          }
        }
        await saveSession(session);
        return sendJson(res, 200, { session });
      }

      // 重新生成 = 丢掉最后一条 assistant 回复，前端再重新请求一次。
      if (action === 'truncateLast') {
        while (session.messages.length && session.messages.at(-1).role === 'assistant') {
          session.messages.pop();
        }
      }
      await saveSession(session);
      return sendJson(res, 200, { session });
    }
  }

  // 「朗读」：把一条回复读出来。前端只跟这里说话，由服务端去调本地 TTS
  // （OpenAI 兼容的 /v1/audio/speech），这样浏览器不用管 CORS，也方便做磁盘缓存。
  if (pathname === '/api/tts' && method === 'POST') {
    const { text, voice } = await readBody(req);
    const config = await getConfig();
    const tts = config.tts || {};
    if (!tts.baseUrl) {
      return sendJson(res, 400, { error: '还没配朗读服务：设置 → 朗读 → 填一个本地 TTS 地址（见 README「朗读」一节）' });
    }
    const speech = speechText(text);
    if (!speech) return sendJson(res, 400, { error: '这条没有可以读出来的台词' });
    // 每个角色可以有自己的音色（角色卡上的 voice），没设就用全局默认
    const characterVoice = String(voice || '').trim();
    const params = {
      baseUrl: tts.baseUrl,
      apiKey: tts.apiKey || '',
      model: tts.model || 'tts-1',
      voice: characterVoice || tts.voice || 'alloy',
      speed: tts.speed || 1,
      format: tts.format || 'mp3',
    };
    const key = ttsCacheKey({ ...params, text: speech });
    const file = ttsCacheFile(key, params.format);
    try {
      let buffer;
      let contentType = ttsMime(params.format);
      if (await fileExists(file)) {
        buffer = await fs.readFile(file);
      } else {
        const out = await synthesize({ ...params, text: speech });
        buffer = out.buffer;
        contentType = out.contentType;
        // 落盘缓存：同一句话再点就不用重新合成了。
        // 存在**程序目录**而不是数据目录 —— 数据目录是要同步到手机的，音频别跟着同步。
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, buffer);
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
        'X-TTS-Cache': 'disk',
      });
      return res.end(buffer);
    } catch (err) {
      return sendJson(res, 502, { error: `朗读失败：${err.message}` });
    }
  }

  // 「识图」：把一张图交给本地视觉模型，换回一段自然语言描述。
  // 图片是在**服务端**交给 Ollama 的（前端只发 base64），所以手机浏览器连着
  // 局域网也能用，页面里也不用知道 Ollama 的地址。
  if (pathname === '/api/vision' && method === 'POST') {
    let body;
    try {
      // 图片是 base64，默认 1MB 的请求体上限根本不够 —— 单独放宽到图片上限 + 一层外壳开销
      body = await readBody(req, VISION_IMAGE_MAX + 1024 * 1024);
    } catch (err) {
      return sendJson(res, 413, { error: `图片太大，发不过来：${err.message}` });
    }
    // 先把图片本身校验掉（400），再去谈模型的事（502）—— 两种错误分开报才好排查
    let pic;
    try {
      pic = parseImagePayload(body.image, body.mime);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    try {
      const config = await getConfig();
      const r = await describeImage({ config, image: pic.base64, mime: pic.mime, prompt: body.prompt });
      return sendJson(res, 200, r);
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  // 联网搜索（v0.62.0）：手动搜一次。
  // 用途：① 设置页的「试搜一次」——不保存也能试当前填的站点/代理/条数；
  //       ② tools/test-websearch.mjs 打真必应。
  // 不落库、不注入任何会话，纯探测。失败返回 502 + 人话错误（前端直接 toast）。
  if (pathname === '/api/search' && method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      body = {};
    }
    const config = await getConfig();
    const plan = searchPlan(config);
    const query = String(body?.query || '').trim().slice(0, 200);
    if (!query) return sendJson(res, 400, { error: '查询不能为空' });
    const site = body?.site === 'cn' || body?.site === 'intl' ? body.site : plan.site;
    const count = normalizeSearchCount(body?.count ?? plan.count);
    // 代理：只用这次请求里显式给的（设置页还没保存也能试）；不给就用设置里那份
    const proxy = typeof body?.proxy === 'string' && body.proxy.trim() ? body.proxy.trim() : plan.proxy;
    try {
      const r = await searchBing(query, { site, count, proxy, base: plan.base });
      return sendJson(res, 200, {
        query: r.query,
        site,
        via: r.via,
        finalHost: r.finalHost,
        notice: r.notice,
        status: r.status,
        bytes: r.bytes,
        results: r.results,
      });
    } catch (err) {
      return sendJson(res, 502, { error: describeSearchFail(err) });
    }
  }

  if (pathname === '/api/chat' && method === 'POST') return handleChat(req, res);

  // --- 直连模式（不注入任何提示词的无提示词对话）---
  // 会话和角色模式共用存储与 /api/sessions/:id 的读改删接口，只是多一个 kind='direct'
  // 标记、没有 characterId。列表单独给一份，前端好把两种会话分开显示。
  if (pathname === '/api/direct/sessions') {
    if (method === 'GET') {
      const sessions = (await listSessions()).filter((s) => s.kind === 'direct');
      return sendJson(res, 200, { sessions });
    }
    if (method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const session = await createSession(null, body.title, 'direct');
      return sendJson(res, 200, { session });
    }
  }

  // 「查看这次发出去什么」：直连模式下默认只有你打的字；设了常用语就只有那一段 system。
  if (pathname === '/api/direct/context' && method === 'GET') {
    const session = await getSession(url.searchParams.get('sessionId') || '');
    if (!session) return sendJson(res, 404, { error: '会话不存在' });
    if (session.kind !== 'direct') return sendJson(res, 400, { error: '这不是直连会话' });
    const config = await getConfig();
    // 资料库也要一起算进来 —— 否则预览会"撒谎"（v0.53.1 踩过预览漏传 thinkOff 的坑）。
    // 这里还没有"这一轮的新消息"，所以用会话里最后一条 user 消息当线索。
    const lastUser = [...(session.messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
    const previewKnowledge = (await pickKnowledgeForDirect(session, config, lastUser)).chunks;
    const dCtxPlan = searchPlan(config);
    const dCtxSearch = await pickSearchFor(session, dCtxPlan, lastUser);
    const messages = directPayload(session.messages, config, { knowledge: previewKnowledge, search: dCtxSearch.results, searchChars: dCtxPlan.chars });
    const hasSystem = messages[0]?.role === 'system';
    const system = hasSystem ? messages[0].content : '';
    const history = hasSystem ? messages.slice(1) : messages;
    const words = parsePhrases(config.directPhrases);
    return sendJson(res, 200, {
      sessionId: session.id,
      title: session.title,
      model: config.model,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      extraBody: config.extraBody || '',
      system,
      history,
      webSearch: {
        enabled: dCtxPlan.enabled,
        site: dCtxPlan.site,
        chars: dCtxPlan.chars,
        ...searchSummary(dCtxSearch),
      },
      stats: {
        totalMessages: messages.length,
        totalChars: messages.reduce((n, m) => n + m.content.length, 0),
        systemChars: system.length,
        phrasesCount: words.length,
        phrasesLevel: words.length ? normalizePhraseLevel(config.directPhraseLevel) : null,
        // 直连这一轮注入的网页结果（0 = 没搜/没注入）
        searchChars: webSearchBlock(dCtxSearch.results, { maxChars: dCtxPlan.chars }).length,
        searchCount: dCtxSearch.results.length,
      },
    });
  }

  // 常用语的实时预览：把词表和频率档位渲染成真正会发出去的那段，前端不重复实现措辞。
  if (pathname === '/api/direct/phrases' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const level = normalizePhraseLevel(body.level);
    const text = normalizeDirectPhrases(body.text);
    const block = directPhrasesBlock(text, level);
    return sendJson(res, 200, {
      count: parsePhrases(text).length,
      level,
      block,
      // phrasesLine 的构造是"词表 + 频率说明"，最后一行就是频率说明，单独给前端做即时提示
      how: block ? block.split('\n').at(-1) : '',
    });
  }

  if (pathname === '/api/direct/chat' && method === 'POST') return handleDirectChat(req, res);

  // 「quit」：在输入框里敲 quit（或 exit / 退出 / 关闭）就立刻收摊。
  // 设计目的是**人不在电脑旁边时也能关**（比如手机浏览器连着局域网/虚拟局域网），
  // 所以它不限制来源地址。副作用要知道：谁连得上这个程序，谁就能关它
  //（程序本来就没有口令；单人使用没问题，介意的话就别把它绑到 0.0.0.0）。
  if (pathname === '/api/quit' && method === 'POST') return handleQuit(req, res);
  // 主页那三个按钮：查状态 / 启动 / 常驻不卸载 / 立刻释放显存
  if (pathname === '/api/ollama') return handleOllama(req, res, method);

  sendJson(res, 404, { error: '未知接口' });
}

// quit 用：把本地 Ollama 里常驻显存的模型卸掉（远端接口不是 Ollama，跳过即可）。
// 只认回环地址，避免把这个请求打到别人的服务上。
async function unloadLocalModels() {
  try {
    const config = await getConfig();
    const base = String(config.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(base)) return 0;
    const ps = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) });
    const models = (await ps.json()).models || [];
    let n = 0;
    for (const m of models) {
      try {
        await fetch(`${base}/api/generate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: m.name, keep_alive: 0, prompt: '' }),
          signal: AbortSignal.timeout(8000),
        });
        n += 1;
      } catch { /* 卸不掉就算了，不影响关闭 */ }
    }
    return n;
  } catch { return 0; }
}

// 主页那三个按钮的后端。
//   GET  /api/ollama            → 当前状态（在不在跑 / 显存里有什么 / 常驻还是自动卸载）
//   POST /api/ollama {action}   → on=启动｜keep=常驻不卸载｜auto=改回 2 分钟｜free=立刻释放显存
async function handleOllama(req, res, method) {
  const config = await getConfig();
  try {
    if (method === 'GET') return sendJson(res, 200, await ollamaStatus(config));
    if (method !== 'POST') return sendJson(res, 405, { error: '只支持 GET / POST' });
    const body = await readBody(req).catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'on') {
      const r = await ollamaStart(config);
      return sendJson(res, 200, { ...r, ...(await ollamaStatus(await getConfig())) });
    }
    if (action === 'keep' || action === 'auto') {
      const value = action === 'keep' ? -1 : '2m';
      await saveConfig({ keepAlive: value });
      const fresh = await getConfig();
      const r = await ollamaSetKeepAlive(fresh, value);
      return sendJson(res, 200, {
        ...r,
        message: `${action === 'keep' ? '已设为常驻不卸载' : '已改回 2 分钟自动卸载'}${r.touched ? `（${r.touched} 个模型已生效）` : ''}`,
        ...(await ollamaStatus(fresh)),
      });
    }
    if (action === 'preload') {
      const r = await ollamaPreload(config);
      return sendJson(res, r.ok ? 200 : 502, { ...r, ...(await ollamaStatus(config)) });
    }
    if (action === 'free') {
      const r = await ollamaFreeNow(config);
      return sendJson(res, 200, { ...r, ...(await ollamaStatus(config)) });
    }
    return sendJson(res, 400, { error: `未知动作：${action}（只有 on / keep / auto / free）` });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

async function handleQuit(req, res) {
  const unloaded = await unloadLocalModels();
  sendJson(res, 200, { ok: true, unloaded, message: '本地AI对话工作台已关闭' });
  console.log(`\n  收到 quit${unloaded ? `：已卸载 ${unloaded} 个模型（显存已释放）` : ''}，正在关闭…`);
  // 先让响应飞出去，再优雅关掉监听、退出进程
  setTimeout(() => {
    try { activeServer?.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 300);
  }, 250);
}

let activeServer = null;

export async function startServer(port = 5178, host = '127.0.0.1') {
  // 启动前先把数据目录整理好：迁移旧格式角色卡、维护 .stignore。
  await ensureDataReady();
  // v0.61.0：块向量缓存落到资料目录旁边（不进同步，见 saveConfig 里的 .stignore），
  // 重启后不用重算整库（实测冷启动 22.7s → 读盘 92ms）。
  try {
    setEmbedCacheDir(KNOWLEDGE_DIR_PATH);
  } catch { /* 拿不到路径就退化成纯内存缓存 */ }
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      sendJson(res, 500, { error: err.message || String(err) });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      activeServer = server;
      // 服务起来了就把上次没跑完的训练队列接着跑。
      // 不接这一步的话，重启后磁盘里明明是 queued 的任务，
      // 界面上会一直「待开始」，没有任何东西推动它（踩过）。
      resumeQueue().then((resumed) => {
        if (resumed) console.log('  ↻ 已恢复训练队列，继续跑未完成的任务');
      }).catch(() => { /* 队列坏了不影响服务启动 */ });
      resolve(server);
    });
  });
}
