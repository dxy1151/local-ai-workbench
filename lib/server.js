// 本地 HTTP 服务：托管静态页面 + 提供 JSON API + 代理 OpenAI 流式回复。
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, getConfig, saveConfig, listCharacters, getCharacter, saveCharacter, deleteCharacter, listSessions, getSession, createSession, saveSession, deleteSession, exportBundle, mergeBundle, ensureDataReady, getKnowledge, saveKnowledge, KNOWLEDGE_MAX, normalizeKnowledgeChars, normalizePhraseLevel, normalizeDirectPhrases, DIRECT_KNOWLEDGE_ID, getDirectKnowledge, saveDirectKnowledge, directKnowledgeEnabled, KNOWLEDGE_DIR_PATH, normalizeSearchSite, normalizeSearchCount, normalizeSearchChars } from './store.js';
import { pickChunks, knowledgeBlock, pickChunksSmart, applyColloquialMap, setEmbedCacheDir } from './knowledge.js';
import { synthesize, speechText, ttsCacheKey, ttsMime } from './tts.js';
import { ttsCacheFile, fileExists } from './store.js';
import { buildMessages, previewContext, regenerateNudge, antiStallNudge, personNudge, clicheNudge, continueNudge, openingPrefill, CONTEXT_BUDGET, directMessages, directPhrasesBlock, parsePhrases, dimsBlock, hintBlock, memoBlock, synonymsBlock, noKnowledgeBlock, webSearchBlock, NO_THINK, stuffedPhrases, isPhraseOffTopic, stuffedNudge } from './prompt.js';
import { sanitizeReply, describeCleaned, replyQuality, describeQuality, stripClicheActions, countClicheActions, describeCliche } from './sanitize.js';
import { streamChat, listModels, OpenAIError } from './openai.js';
import { workState, SCHEDULE_TEXT, isLocalEndpoint } from './workguard.js';
import { status as ollamaStatus, start as ollamaStart, setKeepAlive as ollamaSetKeepAlive, freeNow as ollamaFreeNow, localOllamaBase, preload as ollamaPreload, listLocalModels, thinkControl } from './ollama.js';
import { describeImage, parseImagePayload, normalizeVisionModel, VISION_IMAGE_MAX } from './vision.js';
import { detectTailLoop, cutLoop, describeLoop, detectDuplicateSentence, cutDuplicate } from './loopguard.js';
import { normalizeMarkup, normalizePerson, describeMarkup, thirdPersonSubjects } from './markup.js';
import { trimToLimit, describeTrim } from './limit.js';
import { VERSION } from './version.js';
import { searchBing, cleanQuery, describeSearchFail } from './search.js';

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

// 资料库：读这个角色的资料，按"这一轮在聊什么"挑几块。
// query 用"最新一条用户消息 + 上一条角色回复"——只看用户那句，遇到"嗯""继续"这种就挑不中；
// 带上角色上一轮的回复，相关度判断稳得多。
async function pickKnowledgeFor(character, session, config, lastUserText) {
  const none = { chunks: [], emptyReason: null, err: null };
  try {
    const budgetChars = normalizeKnowledgeChars(config?.knowledgeChars);
    if (!character?.id || budgetChars <= 0) return none;
    const text = await getKnowledge(character.id);
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
 * 直连模式的资料库（v0.60.0）：直连会话没有 characterId，所以读单独一份 `_direct.md`。
 * 挑块规则和角色模式完全一致（走同一个 pickChunksSmart），两种模式行为可预期。
 */
async function pickKnowledgeForDirect(session, config, lastUserText) {
  const none = { chunks: [], emptyReason: null, err: null };
  try {
    const budgetChars = normalizeKnowledgeChars(config?.knowledgeChars);
    if (budgetChars <= 0) return none;
    // `_direct.md` **存在**才算"直连资料库开着"（内容可以是空的）。
    // 只看 getDirectKnowledge() 是否为空没法区分"没开"和"开着但为空"，
    // 而这两者在"要不要注入'没有资料'提示"上行为不同 —— 见 directKnowledgeEnabled 的注释。
    if (!(await directKnowledgeEnabled())) return none;
    const text = await getDirectKnowledge();
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
  const { sessionId, content, regenerate, rejectedReason, hint, next, image } = body;
  // 「只在这次用」的微调提示：请求里带了就用它，不带就用设置里存的
  const hintOverride = typeof hint === 'string' ? hint.trim().slice(0, 500) : '';
  // cheats=1：不当作你说的话，直接让角色接着演下一句
  const continueNext = next === true;
  const session = await getSession(sessionId);
  if (!session) return sendJson(res, 404, { error: '会话不存在' });

  const characters = await listCharacters();
  const character = characters.find((c) => c.id === session.characterId);
  if (!character) return sendJson(res, 404, { error: '角色不存在' });

  const config = await getConfig();

  // 资料库检索用的"这一轮在聊什么"：最新一条用户消息（重新生成/接着演时退回会话里最后一条用户消息）
  const lastUserText = String(content || '').trim()
    || [...session.messages].reverse().find((m) => m.role === 'user')?.content
    || '';

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
    session.messages.push({ role: 'user', content: text, at: Date.now() });
    // 第一条用户消息拿来当会话标题，方便在列表里认出来。
    if (session.title === '新的对话') {
      session.title = text.slice(0, 18);
    }
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
    const kRes = await pickKnowledgeFor(character, session, config, lastUserText);
    const knowledge = kRes.chunks;
    // 联网搜索（v0.62.0）：关着时这里立刻返回空、一个网络请求都不发。
    // 结果只进 system 当参考（和资料库同一层），**不**改用户消息、也不进历史。
    const sPlan = searchPlan(config);
    if (sPlan.enabled) send('web', { phase: 'start', site: sPlan.site });
    const sRes = await pickSearchFor(session, sPlan, lastUserText);
    if (sPlan.enabled) send('web', { phase: 'done', ...searchSummary(sRes) });
    // 「关掉思考」按模型分派（Qwen3 → system 里的 /no_think；R1 → 请求体的 think:false）
    const tp = thinkPlan(config);
    // 「常用词 / 口头禅」的词表 + 重抽用的"整段不注入"开关（v0.57.0）
    const phraseWords = parsePhrases(character?.phrases);
    let skipPhrases = false;
    const buildOpts = {
      cleanHistory: config.cleanHistory !== false,
      // 维度和「特点提示词」：这个角色自己设过就用它的，没设就回退到设置里的全局值
      dims: character?.dims?.length ? character.dims : config.dims,
      hint: hintOverride || String(character?.hint || '').trim() || config.hint,
      // 等义词是全角色通用的一份（用户自己的用词习惯），所有角色都注入
      synonyms: config.synonyms,
      // 「回答时也用我这些说法」（v0.56.0）：勾上 = 整张等义词表都进输出侧；
      // 不勾时只有行尾标了 `#输出` 的条目会（见 lib/prompt.js 的 synonymsBlock）
      synonymsOutput: config.synonymsOutput === true,
      memo: config.memo,
      maxChars: config.maxChars,
      knowledge,
      // v0.61.0：资料库非空但这一轮没挑中 → 让提示词里出现"没有资料"的约束
      noKnowledge: kRes.emptyReason === 'below-threshold',
      // v0.62.0 联网搜索：结果块 + 注入上限（和资料库一起从历史预算里扣）
      search: sRes.results,
      searchChars: sPlan.chars,
      // 「关掉思考」：Qwen3 这代用 system 里的 /no_think；R1 这代改成请求体的 think:false（thinkPlan）
      thinkOff: tp.systemInject,
    };
    const buildSystem = (extra = {}) => buildMessages(
      character, session.messages, CONTEXT_BUDGET, config.narrative, { ...buildOpts, ...extra },
    );
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
    const runConfig = {
      ...(nudge ? { ...config, temperature: Math.min(1.2, (config.temperature ?? 0.85) + 0.1) } : config),
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
    const MAX_TRIES = Number(config.maxTries) > 0 ? Math.min(3, Number(config.maxTries)) : 2;
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
        if (!prefill) return { text: await streamChat({ config: runConfig, messages, signal: ctl.signal, onDelta }) };
        try {
          return { text: await streamChat({ config: runConfig, messages, prefill, signal: ctl.signal, onDelta }) };
        } catch (err) {
          if (err instanceof OpenAIError && err.status >= 400 && err.status < 500) {
            return { text: await streamChat({ config: runConfig, messages, signal: ctl.signal, onDelta }) };
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
        throw err;
      } finally {
        clearTimeout(idle);
        controller.signal.removeEventListener('abort', onUserAbort);
      }
    };

    // 最多生成 MAX_TRIES 次：第一条如果质量偏低（凭空造事 / 拖延 / 雷同 / 以问句收尾…），
    // 就带着对应的提示重来，最后取分数最低的那一版。写进历史前仍会清掉凭空动静。
    // 每一版都留着（attempts），落选的进「已否决」，方便你事后翻出来看或改用。
    const attempts = [];
    let stuffedRetry = null;   // 上一版"硬凑常用词"时，记下塞进来的词（重抽时用来提示 + 摘掉常用语段）
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      if (attempt > 0) {
        send('reset', { reason: 'quality' }); // 让界面把上一版擦掉，重新打一遍
        // 按上一版被淘汰的原因挑提示：人称问题就用【人称错了】，
        // 否则模型只会收到"不要拖延"，而它这次犯的其实不是拖延（实测提示不对症时重抽也白搭）。
        // 注意这里匹配的是 replyQuality 的 reasons 原文（'用他/她写自己'），
        // 别写成"人称"就以为能中 —— 那条 reason 里根本没有"人称"两个字（踩过）。
        const why = (retryInfo?.reasons || []).join(' ');
        // 硬凑常用词：整段**不注入**常用语 + 明确告诉它这版为什么退（v0.57.0）
        if (stuffedRetry) {
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
      let res = await runAttempt(prefill);
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
      const afterMarkup = normalizeMarkup(text, { keep: [character?.name] });
      const afterPerson = normalizePerson(afterMarkup, character?.name);
      if (afterMarkup !== text) notes.push(describeMarkup());
      if (afterPerson !== afterMarkup) notes.push('已把动作里的人称改回第一人称');
      text = afterPerson;
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
      if (notes.length) {
        send('replace', { text, cleaned: cleanedInfo ? cleanedInfo.length : 0, note: notes.join('；') });
      }

      // 最后落实字数上限：提示词里说了不算，这里按句号裁（不切断半句），
      // 裁掉的部分留档给「已否决」，想换回来随时能换。
      const limited = trimToLimit(text, config.maxChars);
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

      const q = replyQuality(text, { previousReply: prevAssistant, contextText, characterName: character?.name, originalText: rawText });
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
      attempts.push({ text, raw: rawText, cleanedNote, q, loopRaw: res.loopRaw, loopNote: res.loopNote });
      if (!best || q.score < best.q.score) best = { text, q };
      if (stuffed.length) {
        notes.push(`话题不相关却出现常用词（${stuffed.join('、')}）—— 已是最后一版，保留原样`);
      }
      if (attempt < MAX_TRIES - 1 && config.autoClean !== false && q.score >= QUALITY_GATE) {
        retryInfo = q;
        continue; // 质量不够 → 再生成一版
      }
      break;
    }

    if (!best) {
      throw new OpenAIError('模型这次没有产出内容。可以在设置里关掉「动作开头」再试。', 502);
    }
    let reply = best.text;
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

    // cheats=1（接着演）时**合并进上一条角色回复**，而不是新开一条：
    // 两条连续的 assistant 消息是非法的（会让这个会话之后每次都 400），
    // 而且语义上本来就是"同一条回复被往下写了一段"。
    const tail = session.messages[session.messages.length - 1];
    const sources = toSources(sRes.results);
    if (keepGoing && tail && tail.role === 'assistant') {
      tail.content = `${tail.content}\n\n${reply}`;
      tail.at = Date.now();
      if (rejected.length) tail.rejected = [...(tail.rejected || []), ...rejected].slice(0, 5);
      // 接着演的那一轮如果搜了，来源也并进这条（前端在气泡下显示「🌐 来源 N」）
      if (sources.length) tail.sources = sources;
    } else {
      session.messages.push({
        role: 'assistant',
        content: reply,
        at: Date.now(),
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
      await saveSession(session);
      send('error', { error: err instanceof OpenAIError ? err.message : String(err.message || err) });
    }
  } finally {
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
    let reply;
    try {
      reply = await streamChat({ config: runConfig, messages, prefill: visionPic ? ' ' : '', onDelta, signal: controller.signal });
    } catch (err) {
      // 空回复：思考型模型偶发把输出预算全烧在思考上，一个字都没吐出来。
      // 这时界面还是空的，原样再试一次是完全安全的。
      if (err instanceof OpenAIError && /没有返回任何内容/.test(err.message)) {
        text = '';
        send('reset', { reason: 'empty' });
        reply = await streamChat({ config: runConfig, messages, prefill: visionPic ? ' ' : '', onDelta, signal: controller.signal });
      } else {
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
    session.messages.push({
      role: 'assistant',
      content: reply,
      at: Date.now(),
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
    res.end();
  }
}

// 发给前端的配置：**永不带出完整 Key**，只回显"有没有"和尾 4 位。
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
function thinkPlan(config) {
  if (!config || config.thinkOff !== true) return { systemInject: false, payloadThink: false, how: '' };
  const control = thinkControl(config.model);
  return control === 'think_false'
    ? { systemInject: false, payloadThink: true, how: 'think:false（请求体）' }
    : { systemInject: true, payloadThink: false, how: '/no_think（system）' };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const method = req.method;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  // --- 设置 ---
  // 版本号：方便确认"手机上跑的是不是新包"
  if (pathname === '/api/version' && method === 'GET') {
    return sendJson(res, 200, { version: VERSION });
  }

  if (pathname === '/api/config') {
    if (method === 'GET') {
      return sendJson(res, 200, redactConfig(await getConfig()));
    }
    if (method === 'PUT') {
      const patch = await readBody(req);
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
    const config = await getConfig();
    // 「查看上下文」看到的就是真发出去的 —— 资料块也要按同样规则挑出来算进去
    const ctxLastUser = [...session.messages].reverse().find((m) => m.role === 'user')?.content || '';
    const ctxKnowledge = (await pickKnowledgeFor(character, session, config, ctxLastUser)).chunks;
    // 联网搜索也要按同样规则算进来 —— 否则开了联网，预览里却看不到那段【网页搜索结果】，
    // 又变成"预览撒谎"（v0.53.0 踩过一次，冒烟测试现在盯着）。走缓存：刚聊过的那条
    // 查询直接复用同一批结果，不会再打一次必应。
    const ctxSearchPlan = searchPlan(config);
    const ctxSearch = await pickSearchFor(session, ctxSearchPlan, ctxLastUser);
    const preview = previewContext(character, session.messages, CONTEXT_BUDGET, config.narrative, {
      cleanHistory: config.cleanHistory !== false,
      dims: character?.dims?.length ? character.dims : config.dims,
      hint: String(character?.hint || '').trim() || config.hint,
      synonyms: config.synonyms,   // 等义词：全角色通用
      synonymsOutput: config.synonymsOutput === true,
      memo: config.memo,
      maxChars: config.maxChars,
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
      system: preview.messages[0].content,
      history: preview.messages.slice(1),
      stats: preview.stats,
    });
  }

  if (pathname === '/api/models' && method === 'GET') {
    const models = await listModels(await getConfig());
    return sendJson(res, 200, { models });
  }

  // ---- 应用内「切模型」（v0.55.0）：不用再敲 tools\switch-model.mjs ----
  // ① 列出本机 Ollama 里装了什么（带规模/量化/支不支持思考）
  if (pathname === '/api/local-models' && method === 'GET') {
    const config = await getConfig();
    const out = await listLocalModels(config);
    const same = (a, b) => a === b || String(a).split(':')[0] === String(b).split(':')[0];
    return sendJson(res, 200, {
      ...out,
      current: config.model,
      isLocalNow: Boolean(localOllamaBase(config)) && same(config.model, (out.models || []).find((m) => same(m.name, config.model))?.name || config.model),
      savedCloud: config.savedCloud ? { baseUrl: config.savedCloud.baseUrl, model: config.savedCloud.model } : null,
    });
  }

  // ② 一键切到某个本机模型（或一键切回云端）：baseUrl / apiKey / 模型名 / 关思考 一次配好。
  //    这个逻辑原来只在命令行脚本里 —— 搬进来之后手机端也能切。
  if (pathname === '/api/switch-model' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
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

    // 顺手核对一下这个模型在不在本机（不在也允许，只是提示一句），并拿"支不支持思考"
    const list = await listLocalModels(config);
    const hit = (list.models || []).find((m) => m.name === want || m.name.split(':')[0] === want.split(':')[0]);
    // 「关掉思考」自动判断：优先用 Ollama 报的能力，问不到就退回按名字猜（qwen3 这代）
    const thinkOff = hit ? hit.thinking : /qwen3/i.test(want);

    const patch = {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama',
      model: want,
      // 原来那份额外参数（通常是 {"seed":-1}）留着；空的就给个默认，别让本地模型拿不到 seed
      extraBody: String(config.extraBody || '').trim() || '{"seed":-1}',
      thinkOff,
    };
    // 从云端切到本地之前，先把云端那套存下来（这样「切回云端」才有得还原）
    if (!isLocalEndpoint(config.baseUrl) && config.baseUrl) {
      patch.savedCloud = { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, extraBody: config.extraBody || '' };
    }
    await saveConfig(patch);
    return sendJson(res, 200, {
      ok: true, mode: 'local', model: want, thinkOff,
      known: Boolean(hit),
      ...(hit ? {} : { warning: `本机 Ollama 里没有 ${want}（${list.ok ? '现有：' + list.models.map((m) => m.name).join('、') : list.error}）` }),
      config: redactConfig(await getConfig()),
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

  // --- 同步：整包导出 / 合并导入 ---
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

  // --- 角色卡 ---
  if (pathname === '/api/characters') {
    if (method === 'GET') return sendJson(res, 200, { characters: await listCharacters() });
    if (method === 'POST') return sendJson(res, 200, { character: await saveCharacter(await readBody(req)) });
  }
  // 资料库：每角色一份纯文本。GET 取回；PUT 保存（空文本 = 删掉）。
  // 还能带一个 query 做"预演"：只返回这一轮会挑中哪几块，方便你先看效果。
  if (pathname === '/api/knowledge') {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (method === 'GET') {
      const characterId = u.searchParams.get('characterId') || '';
      const text = await getKnowledge(characterId);
      const q = u.searchParams.get('query') || '';
      // 预演必须和真正生成时**走同一条检索路径**（否则预览会撒谎，v0.53.1 踩过这个坑）
      const config = await getConfig();
      const r = q ? await pickChunksSmart(text, mappedQuery(q, config), knowledgeOpts(config)) : { chunks: [], mode: null };
      if (r.err) knowledgePickWarnOnce(r.err);
      return sendJson(res, 200, {
        characterId, text, max: KNOWLEDGE_MAX, picked: r.chunks, mode: r.mode, degradeErr: r.err || null,
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

  // 直连模式的资料库（v0.60.0）：和上面同一套用法，只是 characterId 固定传 `_direct`。
  // 单独开一个端点是为了语义清楚（直连本来就没有 characterId），也方便前端分流。
  if (pathname === '/api/direct/knowledge') {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (method === 'GET') {
      const text = await getDirectKnowledge();
      const q = u.searchParams.get('query') || '';
      const config = await getConfig();
      const r = q ? await pickChunksSmart(text, mappedQuery(q, config), knowledgeOpts(config)) : { chunks: [], mode: null };
      if (r.err) knowledgePickWarnOnce(r.err);
      return sendJson(res, 200, {
        scope: 'direct', text, max: KNOWLEDGE_MAX, picked: r.chunks, mode: r.mode, degradeErr: r.err || null,
      });
    }
    if (method === 'PUT' || method === 'POST') {
      const { text } = await readBody(req);
      if (String(text || '').length > KNOWLEDGE_MAX) {
        return sendJson(res, 400, { error: `资料太长（${String(text).length} 字，上限 ${KNOWLEDGE_MAX} 字）` });
      }
      const saved = await saveDirectKnowledge(text);
      return sendJson(res, 200, { ok: true, scope: 'direct', chars: saved.length, max: KNOWLEDGE_MAX });
    }
  }
  const charMatch = pathname.match(/^\/api\/characters\/([\w-]+)$/);
  if (charMatch && method === 'DELETE') {
    const ok = await deleteCharacter(charMatch[1]);
    return sendJson(res, ok ? 200 : 404, { ok });
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
      if (!text && characterId) {
        const card = await getCharacter(characterId);
        text = String(card?.greeting || '').trim();
      }
      if (text) {
        session.messages.push({ role: 'assistant', content: text, at: Date.now() });
        await saveSession(session);
      }
      return sendJson(res, 200, { session });
    }
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
      const { title, action, index, content, rejectedIndex } = await readBody(req);
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
    server.listen(port, host, () => { activeServer = server; resolve(server); });
  });
}
