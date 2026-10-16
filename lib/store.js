// 极简 JSON 文件存储。数据全部留在本机数据目录下，不上传任何地方。
//
// 存储布局（刻意做成「一个对象一个文件」）：
//   <data>/characters/<角色id>.json   角色卡
//   <data>/sessions/<会话id>.json     会话
//   <data>/config.json                本机配置（API Key 等，不参与同步）
//
// 为什么要一对象一文件：Syncthing 这类同步工具是「文件级」的。两台设备各自
// 新增内容时，只要落在不同文件就能干净合并；若全塞进一个大 JSON，两边一改
// 就是同一个文件冲突，必然丢一边。
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeHint, normalizeMemo, normalizeMaxChars, clampDimLevel, DIM_MAX } from './prompt.js';
import { normalizeVisionModel } from './vision.js';

/** 资料库每轮注入的字数上限（0 = 不注入；上限 2000，别把历史挤没了）。 */
export function normalizeKnowledgeChars(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 500;
  return Math.max(0, Math.min(2000, n));
}

/**
 * v0.61.0 语义检索的相似度阈值（0 = 不设门槛，全部放行；1 = 只放几乎完全相同的）。
 * 实测 20 个真问题最低 0.55+、6 个无关问题最高 0.47，所以 0.5 附近是分界；
 * 留出 0.2~0.9 的可调区间，默认 0.5。
 */
export function normalizeKnowledgeThreshold(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(0.9, Math.round(n * 100) / 100));
}
import { fileURLToPath } from 'node:url';

/** 联网搜索：用哪个必应站点。'intl' = 国际版（需代理），'cn' = 国内版（可直连）。 */
export function normalizeSearchSite(v) {
  return v === 'cn' ? 'cn' : 'intl';
}

/** 联网搜索取前几条结果（1~10，默认 5）。太少模型看不到有用信息，太多会挤历史预算。 */
export function normalizeSearchCount(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, n));
}

/** 联网搜索每轮最多注入多少字（0 = 只搜不注入，等于关闭注入；上限 4000，别把历史挤没了）。 */
export function normalizeSearchChars(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 1600;
  return Math.max(0, Math.min(4000, n));
}

// 用 fileURLToPath 而非 import.meta.dirname，兼容 Node 18（Termux 上更稳）。
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 数据目录解析优先级：环境变量 > 项目根的 data-dir.txt > 默认 ./data
// data-dir.txt 用来把数据指到 Syncthing / 网盘等自动同步目录里。
function resolveDataDir() {
  // 新名优先；旧名继续兼容，老用户的脚本不用改。
  const envDir = process.env.WORKBENCH_DATA_DIR || process.env.XINGYE_DATA_DIR;
  if (envDir) return path.resolve(envDir);
  try {
    const raw = fsSync.readFileSync(path.join(ROOT, 'data-dir.txt'), 'utf8');
    const line = raw.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
    if (line) return path.resolve(ROOT, line);
  } catch {
    /* 没有 data-dir.txt 就用默认位置 */
  }
  return path.join(ROOT, 'data');
}

export const DATA_DIR = resolveDataDir();
const CHARACTERS_DIR = path.join(DATA_DIR, 'characters');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const CONFIG = path.join(DATA_DIR, 'config.json');
// 老版本把全部角色塞在这一个文件里；首次启动会迁移成上面的一角色一文件。
const LEGACY_CHARACTERS = path.join(DATA_DIR, 'characters.json');
const STIGNORE = path.join(DATA_DIR, '.stignore');

export const uid = () => crypto.randomBytes(8).toString('hex');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`读取 ${path.basename(file)} 失败: ${err.message}`);
  }
}

// 先写临时文件再改名，避免写一半断电把数据写坏；同步工具也不会读到半截文件。
//
// ⚠ 但 Windows 上「改名」会被**瞬时占用**搞失败：只要此刻有别人在读这个文件
//   （实测：沙箱/杀毒/Syncthing 扫文件，甚至我们自己并发的一次读取），
//   `rename` 就会抛 `EPERM: operation not permitted` —— 原来是直接往外抛，
//   结果**整次保存失败、这条消息就没了**（实测：点停止时那一版消失）。
//   所以对这类瞬时错误退避重试；实在换不了名就直接覆写目标文件：
//   宁可这一瞬间不"原子"，也不能把用户的消息丢掉。
const TRANSIENT_FS_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const data = JSON.stringify(value, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.writeFile(tmp, data, 'utf8');
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT_FS_ERRORS.has(err.code)) throw err;
      await sleep(20 * (attempt + 1)); // 20/40/60/80ms 退避
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.writeFile(file, data, 'utf8'); // 放弃原子换名，保住数据
      return;
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT_FS_ERRORS.has(err.code)) throw err;
      await sleep(50 * (attempt + 1));
    }
  }
  throw lastErr;
}

// 只认自己的文件：跳过同步工具的冲突副本和写到一半的临时文件。
const isOurJson = (f) =>
  f.endsWith('.json') && !f.includes('.sync-conflict-') && !f.endsWith('.tmp');

/* ---------- 启动时的一次性整理 ---------- */

let readyPromise = null;

export function ensureDataReady() {
  if (!readyPromise) readyPromise = initDataDir();
  return readyPromise;
}

async function initDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await migrateLegacyCharacters();
  await ensureStignore();
}

// 老格式 characters.json → characters/<id>.json；转换完把原文件改名留底。
async function migrateLegacyCharacters() {
  const legacy = await readJson(LEGACY_CHARACTERS, null);
  if (!Array.isArray(legacy)) return;
  await fs.mkdir(CHARACTERS_DIR, { recursive: true });
  for (const card of legacy) {
    if (!card?.id) continue;
    const target = path.join(CHARACTERS_DIR, `${card.id}.json`);
    if (await readJson(target, null)) continue; // 已迁移过就不覆盖
    await writeJson(target, card);
  }
  await fs.rename(LEGACY_CHARACTERS, `${LEGACY_CHARACTERS}.migrated`).catch(() => {});
}

// Syncthing 场景下必须排除 config.json，否则 API Key 会被同步到别的设备。
// 由应用自己维护，省得每台设备都要手动建一份。
async function ensureStignore() {
  // `.embed-cache-*` 是 v0.61.0 语义检索的块向量缓存（十几 MB，本机重算即可），
  // 没必要跟着 Syncthing 同步到手机 —— 那是纯浪费流量。
  const want = ['config.json', '*.tmp', '*.migrated', '.embed-cache-*'];
  try {
    const cur = await fs.readFile(STIGNORE, 'utf8').catch(() => null);
    if (cur && want.every((w) => cur.split('\n').includes(w))) return; // 已经齐了

    // Windows 上 Syncthing 会把这个文件设成「隐藏」属性，而隐藏文件不能直接
    // 覆盖写（EPERM），所以先删掉再新建。
    await fs.unlink(STIGNORE).catch(() => {});
    await fs.writeFile(STIGNORE, `${want.join('\n')}\n`, 'utf8');
  } catch (err) {
    // 这文件只是给 Syncthing 看的，写不了也不该拦住启动，但要明确提示风险。
    console.warn(
      `  ⚠ 无法维护 .stignore（${err.code || err.message}）。` +
        '请手动确认里面包含 config.json，否则 API Key 可能被同步到其他设备。',
    );
  }
}

/* ---------- 配置（API Key / base_url / 模型） ---------- */
// 「描写幅度」维度表：[{name, level(0~5)}]。null = 没启用（不改现有行为）。
// 存进来的是用户手改过的 JSON，这里做一次收敛，坏数据不能让聊天挂掉。
export function normalizeDims(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const name = String(d.name || '').trim().slice(0, 8);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, level: clampDimLevel(d.level) });
    if (out.length >= 10) break;
  }
  return out.length ? out : null;
}

// 提示预设：一串"常说的要求"（"别提钱""让她主动点"…），界面上一点就填进提示框。
// 纯 UI 便利，不参与提示词拼接；这里只做去空/去重/限量。上限 20 条。
export const HINT_PRESET_MAX = 20;

export function normalizeHintPresets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const text = normalizeHint(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= HINT_PRESET_MAX) break;
  }
  return out;
}

export async function getConfig() {
  const saved = await readJson(CONFIG, {});
  return {
    apiKey: saved.apiKey || process.env.OPENAI_API_KEY || '',
    baseUrl: saved.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1',
    model: saved.model || process.env.OPENAI_MODEL || 'deepseek-flash',
    temperature: typeof saved.temperature === 'number' ? saved.temperature : 0.85,
    proxy: saved.proxy || '',
    // 工作时段锁默认开着；只有显式存过 false 才关。
    workGuard: saved.workGuard !== false,
    // 额外请求参数（JSON 字符串）：本地模型常用，例如 {"reasoning_effort":"none"}
    // 关掉 Qwen3 之类模型的「思考」；也可以塞 top_p、num_ctx 等厂商支持的字段。
    extraBody: saved.extraBody || '',
    // 「关掉思考」：往系统提示词末尾加一句 /no_think。
    // 为什么单开一个开关而不是塞 extraBody：**Qwen3 这代只有这个软开关真管用**
    // （实测 Ollama 0.34：think:false、reasoning_effort:none 全都被忽略，
    //  思考照吐、还白白慢 10 倍）。默认关，切到 Qwen3 系模型时由
    // tools/switch-model.mjs 自动打开，设置页也能手动勾。
    thinkOff: saved.thinkOff === true,
    // 叙事推进指令：**默认不注入**（没有内置默认值）；写了才注入，清空即关闭。
    narrative: typeof saved.narrative === 'string' ? saved.narrative : '',
    // 输出后处理：自动剔除模型凭空造出来的外部事件（默认开）
    autoClean: saved.autoClean !== false,
    // 「动作开头」：给模型一个 *角色名… 的前缀强制它从动作续写，绕开"要不要/你来了就好"这类礼貌开场（默认开）
    forceAction: saved.forceAction !== false,
    // 发送前清洗历史：把记录里早就写进去的套路（凭空动静 / 成句的拖延征询）在发出去之前擦掉（默认开）
    // 只影响这一次请求，存档原文不动
    cleanHistory: saved.cleanHistory !== false,
    // 描写幅度（维度图）：[{name, level}]，null = 没调过、不启用
    dims: normalizeDims(saved.dims),
    // 给 AI 的微调提示（维度图里手写的那句），空串 = 没有
    hint: normalizeHint(saved.hint),
    // 提示预设：界面上一点就填进提示框（纯 UI 便利，不进提示词）
    hintPresets: normalizeHintPresets(saved.hintPresets),
    // 场景备忘：一段常驻的既成事实（地点/姿势/约定/称呼），放在系统提示词最末尾
    memo: normalizeMemo(saved.memo),
    // 输入左括号时自动补右括号（中文括号是这个 App 写环境描写用的）。默认开。
    autoPair: saved.autoPair !== false,
    // 回复字数上限（0 = 不限）。超了会在句号处截断，裁掉的部分进「已否决」。
    maxChars: normalizeMaxChars(saved.maxChars),
    // 资料库每轮最多注入多少字（0 = 不注入）。它占的是历史预算，所以别调太大。
    knowledgeChars: normalizeKnowledgeChars(saved.knowledgeChars),
    // v0.61.0 语义检索（实测把资料检索正确率从 14/20 提到 19/20，热查询 ~23ms）：
    //   knowledgeSemantic  —— 是否启用（默认开；embedding 不可用时自动降级回词法检索）
    //   knowledgeThreshold —— 余弦相似度**绝对**阈值，低于它一块都不注入（默认 0.5）
    //   knowledgeEmbedModel—— 用哪个 embedding 模型（本机 Ollama）
    //   knowledgeMap       —— 口语→术语映射表，每行「口语=术语」，用来兜语义漏掉的长尾
    knowledgeSemantic: saved.knowledgeSemantic !== false,
    knowledgeThreshold: normalizeKnowledgeThreshold(saved.knowledgeThreshold),
    knowledgeEmbedModel: String(saved.knowledgeEmbedModel || 'qwen3-embedding:0.6b').trim().slice(0, 80),
    knowledgeMap: String(saved.knowledgeMap || '').trim().slice(0, 4000),
    // 直连模式的常用语 / 口头禅（一行一个，也可用逗号顿号分隔）+ 出现频率档位（0~10）。
    // 留空 = 一个字都不注入，直连模式保持"零提示词"。
    directPhrases: normalizeDirectPhrases(saved.directPhrases),
    directPhraseLevel: normalizePhraseLevel(saved.directPhraseLevel),
    // 朗读（TTS）：OpenAI 兼容的 /v1/audio/speech。地址留空 = 没配，界面上的 🔊 会提示去设置里填。
    tts: normalizeTts(saved.tts),
    // 本地 Ollama 的 keep-alive（主页那三个按钮）：null = 不干预，-1 = 常驻显存，其余是时长
    keepAlive: normalizeKeepAlive(saved.keepAlive),
    // 等义词（**全角色通用**）：用户自己的用词习惯（梗/俗称/黑话），每行「词 = 意思」。
    // 它不是"换词说"，是让模型**听懂你在说什么**；所有角色卡都会注入这一段。
    synonyms: String(saved.synonyms || '').trim().slice(0, 2000),
    // 「回答时也用我这些说法」（v0.56.0）：勾上后等义词整张表都要求模型在**回答里也用**；
    // 不勾时只有行尾标了 `#输出` 的那几条会进输出侧（见 lib/prompt.js 的 synonymsBlock）。
    synonymsOutput: saved.synonymsOutput === true,
    // 直连模式自己那份等义词（跟上面这份互不干扰，跟维度一样的规矩）
    directSynonyms: String(saved.directSynonyms || '').trim().slice(0, 2000),
    // 从云端切到本地模型时，把原来那套云端设置**自动存一份**在这里 ——
    // 这样应用里点「切回云端」就能一键还原（跟 tools/switch-model.mjs 的 cloud 模式一个效果）。
    savedCloud: normalizeSavedCloud(saved.savedCloud),
    // ---- 直连模式（不经过角色卡）专用的那一套：跟角色模式**互不干扰** ----
    // 默认全空 → 直连保持"一条系统提示词都不加"的原设计；填了才注入。
    // ⚠ v0.54.0：**directDims 已不再注入**（用户要求删掉直连里的"维度"那一栏）——
    //   维度是角色扮演的笔墨比重，塞进无提示词对话会把模型往演戏方向带。
    //   字段在这里保留，只是为了让历史值能被干净地清掉（PUT directDims: null）。
    directDims: normalizeDims(saved.directDims),
    directHint: normalizeHint(saved.directHint),
    directMemo: normalizeMemo(saved.directMemo),
    directMaxChars: normalizeMaxChars(saved.directMaxChars),
    // ---- 联网搜索（必应网页抓取，v0.62.0）----
    // 默认**关**：关着时一次网络请求都不发、system 里一个字都不加。
    // 开着时每一轮先按"这一轮在聊什么"搜一次，结果作为【网页搜索结果】进 system 参考。
    webSearch: saved.webSearch === true,
    // 'intl' = 必应国际版 www.bing.com（**必须走代理**，否则按出口 IP 被 302 到国内版）；
    // 'cn'   = 必应国内版 cn.bing.com（可直连，但结果按国内口径）。
    webSearchSite: normalizeSearchSite(saved.webSearchSite),
    // 取前几条结果 / 最多注入多少字（默认 5 条、1600 字）
    webSearchCount: normalizeSearchCount(saved.webSearchCount),
    webSearchChars: normalizeSearchChars(saved.webSearchChars),
    // 📷 识图用的**视觉**模型：跟聊天用的 model 分开配 ——
    // 聊天那个多半是纯文本的，发图过去只会报错。
    // 留空 = 用默认的 qwen2.5vl:3b。
    visionModel: normalizeVisionModel(saved.visionModel),
  };
}

/**
 * 本地 Ollama 的 keep-alive 取值：
 *   null  = 不干预（让 Ollama 用自己默认的 5 分钟）
 *   -1    = 永不卸载（常驻显存，对应「不关闭」按钮）
 *   其它  = 时长字符串 '2m' / '1h' 或秒数
 */
export function normalizeKeepAlive(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v === -1 || v === '-1') return -1;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  const s = String(v).trim().slice(0, 12);
  return /^\d+(s|m|h|d)?$/i.test(s) ? s : null;
}

/** TTS 设置。地址留空 = 不启用；音色/模型只是原样转发给那个服务，这里不校验。 */
export function normalizeTts(v) {
  const t = v && typeof v === 'object' ? v : {};
  const speed = Number(t.speed);
  const fmt = ['mp3', 'wav', 'opus', 'aac', 'flac'].includes(String(t.format || '').toLowerCase())
    ? String(t.format).toLowerCase()
    : 'mp3';
  return {
    baseUrl: String(t.baseUrl || '').trim().slice(0, 300),
    apiKey: String(t.apiKey || '').trim().slice(0, 200),
    model: String(t.model || '').trim().slice(0, 100) || 'tts-1',
    voice: String(t.voice || '').trim().slice(0, 100) || 'alloy',
    speed: Number.isFinite(speed) && speed > 0 ? Math.min(2, Math.max(0.5, speed)) : 1,
    format: fmt,
    // 自动触发：每条新回复生成完就地读出来（默认关，得先配好地址）
    auto: t.auto === true,
  };
}

/**
 * 直连模式的常用语：一段纯文本（一行一个，也认逗号 / 顿号 / 分号）。
 * 只做长度收敛 —— 它是给模型看的一句话，写错了也不会把聊天搞挂。
 */
export const DIRECT_PHRASES_MAX = 1000;

export function normalizeDirectPhrases(raw) {
  return String(raw || '').trim().slice(0, DIRECT_PHRASES_MAX);
}

/**
 * 「切回云端」用的备份：从云端切到本地模型时自动存一份原配置。
 * 存的是**整个对象**（含 apiKey），但它只落在本机 config.json 里（同一个文件本来就存着 apiKey），
 * 不会发给前端 —— 前端只看得到「有没有存过」。
 */
export function normalizeSavedCloud(v) {
  if (!v || typeof v !== 'object') return null;
  const baseUrl = String(v.baseUrl || '').trim().slice(0, 500);
  const model = String(v.model || '').trim().slice(0, 200);
  if (!baseUrl || !model) return null;
  return {
    baseUrl,
    model,
    apiKey: String(v.apiKey || '').slice(0, 500),
    extraBody: String(v.extraBody || '').slice(0, 2000),
  };
}

/** 常用语的「出现频率」档位：0~10 十分制（0 = 一次都不要用），没设过用克制的 4。 */
export function normalizePhraseLevel(v) {  if (v === null || v === undefined || v === '') return 4;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 4;
  return Math.max(0, Math.min(DIM_MAX, n));
}

export async function saveConfig(patch) {  const current = await readJson(CONFIG, {});
  const next = { ...current };
  for (const key of ['apiKey', 'baseUrl', 'model', 'temperature', 'proxy', 'workGuard', 'extraBody', 'thinkOff', 'savedCloud', 'narrative', 'autoClean', 'forceAction', 'cleanHistory', 'dims', 'hint', 'hintPresets', 'memo', 'autoPair', 'maxChars', 'knowledgeChars', 'knowledgeSemantic', 'knowledgeThreshold', 'knowledgeEmbedModel', 'knowledgeMap', 'webSearch', 'webSearchSite', 'webSearchCount', 'webSearchChars', 'directPhrases', 'directPhraseLevel', 'directDims', 'directHint', 'directMemo', 'directMaxChars', 'synonyms', 'synonymsOutput', 'directSynonyms', 'tts', 'keepAlive', 'visionModel']) {
    if (patch[key] === undefined) continue;
    if (key === 'thinkOff') next[key] = patch.thinkOff === true;
    else if (key === 'synonymsOutput') next[key] = patch.synonymsOutput === true;
    else if (key === 'savedCloud') next[key] = normalizeSavedCloud(patch.savedCloud);
    // ⚠ 这里原本是 `if`，破坏了 if/else 链：key==='dims' 时会继续往下走一串 else if。
    // 改成 else if，语义才正确（顺带修掉一个隐藏 bug）。
    else if (key === 'dims') next[key] = normalizeDims(patch.dims);
    else if (key === 'synonyms' || key === 'directSynonyms') next[key] = String(patch[key] || '').trim().slice(0, 2000);
    else if (key === 'directDims') next[key] = normalizeDims(patch.directDims);
    else if (key === 'directHint') next[key] = normalizeHint(patch.directHint);
    else if (key === 'directMemo') next[key] = normalizeMemo(patch.directMemo);
    else if (key === 'directMaxChars') next[key] = normalizeMaxChars(patch.directMaxChars);
    else if (key === 'keepAlive') next[key] = normalizeKeepAlive(patch.keepAlive);
    else if (key === 'visionModel') next[key] = normalizeVisionModel(patch.visionModel);
    else if (key === 'hint') next[key] = normalizeHint(patch.hint);
    else if (key === 'hintPresets') next[key] = normalizeHintPresets(patch.hintPresets);
    else if (key === 'memo') next[key] = normalizeMemo(patch.memo);
    else if (key === 'maxChars') next[key] = normalizeMaxChars(patch.maxChars);
    else if (key === 'knowledgeChars') next[key] = normalizeKnowledgeChars(patch.knowledgeChars);
    // v0.61.0 语义检索相关
    else if (key === 'knowledgeSemantic') next[key] = patch.knowledgeSemantic !== false;
    else if (key === 'knowledgeThreshold') next[key] = normalizeKnowledgeThreshold(patch.knowledgeThreshold);
    else if (key === 'knowledgeEmbedModel') next[key] = String(patch.knowledgeEmbedModel || 'qwen3-embedding:0.6b').trim().slice(0, 80);
    else if (key === 'knowledgeMap') next[key] = String(patch.knowledgeMap || '').trim().slice(0, 4000);
    // v0.62.0 联网搜索（必应）
    else if (key === 'webSearch') next[key] = patch.webSearch === true;
    else if (key === 'webSearchSite') next[key] = normalizeSearchSite(patch.webSearchSite);
    else if (key === 'webSearchCount') next[key] = normalizeSearchCount(patch.webSearchCount);
    else if (key === 'webSearchChars') next[key] = normalizeSearchChars(patch.webSearchChars);
    else if (key === 'directPhrases') next[key] = normalizeDirectPhrases(patch.directPhrases);
    else if (key === 'directPhraseLevel') next[key] = normalizePhraseLevel(patch.directPhraseLevel);
    else if (key === 'tts') next[key] = normalizeTts(patch.tts);
    else next[key] = patch[key];
  }
  await writeJson(CONFIG, next);
  return getConfig();
}

/* ---------- 角色卡（一角色一文件） ---------- */

const characterFile = (id) => path.join(CHARACTERS_DIR, `${id}.json`);

export async function listCharacters() {
  await ensureDataReady();
  // 全新数据目录里 characters/ 还不存在（还没建过角色）。这里先建出来，
  // 跟 listSessions 一个做法 —— 否则 readdir 会 ENOENT，把 /api/characters
  // 打成 500，而前端 boot() 是"一步失败就整段中断"，首屏会跟着一起挂。
  await fs.mkdir(CHARACTERS_DIR, { recursive: true });
  const files = await fs.readdir(CHARACTERS_DIR);
  const characters = [];
  for (const file of files) {
    if (!isOurJson(file)) continue;
    const card = await readJson(path.join(CHARACTERS_DIR, file), null);
    if (card?.id) characters.push(card);
  }
  return characters.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 读单张角色卡（建会话时要用它兜底取开场白）。 */
export async function getCharacter(id) {
  await ensureDataReady();
  return readJson(characterFile(id), null);
}

/* ---------- 朗读缓存 ---------- */

// 放在**程序目录**下（不是数据目录）：数据目录要同步到手机，音频文件别跟着同步。
const TTS_CACHE_DIR = path.join(ROOT, '.tts-cache');

export function ttsCacheFile(key, format = 'mp3') {
  const safe = String(key || '').replace(/[^\w-]/g, '');
  const ext = ['mp3', 'wav', 'opus', 'aac', 'flac'].includes(String(format).toLowerCase()) ? String(format).toLowerCase() : 'mp3';
  return path.join(TTS_CACHE_DIR, `${safe}.${ext}`);
}

export async function fileExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

/* ---------- 资料库（每个角色一份纯文本，单独存，不塞进角色卡） ---------- */
const KNOWLEDGE_DIR = path.join(DATA_DIR, 'knowledge');
// v0.61.0：语义检索的块向量缓存也放这儿（server 启动时用它算磁盘缓存路径）
export const KNOWLEDGE_DIR_PATH = KNOWLEDGE_DIR;
// 资料上限：v0.60.0 从 20000 提到 500000。
// 原来 20000 是"一份角色设定"的量级；但**资料总量大 ≠ 提示词大** ——
// pickChunks 每轮只挑 knowledgeChars（默认 500）字进 system，资料再大也不会撑爆上下文。
// 实测一份医学词条库有 27 万字，卡在 20000 会把 92.6% 的内容**静默丢掉**（只留 24/45 个词条）。
// 500000 只是个防呆上限（同步目录别被撑爆），真超了会在路由层明确报 400，不再悄悄截断。
export const KNOWLEDGE_MAX = 500000;

function knowledgeFile(characterId) {
  const safe = String(characterId || '').replace(/[^\w-]/g, '');
  return path.join(KNOWLEDGE_DIR, `${safe}.md`);
}

// 直连模式的资料库：直连会话没有 characterId，所以单独存一份。
// 文件名用 `_direct.md`（不是 `${safe}.md`，因为知识文件名不做下划线转义会变成 `.md`）。
export const DIRECT_KNOWLEDGE_ID = '_direct';
export function directKnowledgeFile() {
  return path.join(KNOWLEDGE_DIR, '_direct.md');
}

export async function getKnowledge(characterId) {
  if (!characterId) return '';
  try {
    return await fs.readFile(knowledgeFile(characterId), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

export async function saveKnowledge(characterId, text) {
  if (!characterId) throw new Error('缺少 characterId');
  await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });
  const body = String(text || '').slice(0, KNOWLEDGE_MAX);
  const file = knowledgeFile(characterId);
  if (!body.trim()) {
    try { await fs.unlink(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return '';
  }
  // 和 writeJson 一样：先写临时文件再改名，避免同步到一半的半个文件
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, file);
  return body;
}

/* ---------- 直连模式的资料库（单独一份，不挂在任何角色上） ---------- */
export async function getDirectKnowledge() {
  try {
    return await fs.readFile(directKnowledgeFile(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * `_direct.md` 是否**存在**。
 *
 * 为什么要单独判这个：`saveDirectKnowledge('')` 会把文件删掉，于是"直连资料库
 * 关着"和"开着但内容为空"都表现为「读出来是空字符串」，调用方没法区分。
 * 而 v0.61.0 需要这个区分 —— 只有"直连模式开着、这一轮又没挑中相关块"时才注入
 * 「本轮没有可用资料」那句提示；模式没开时必须保持**零 system**（直连模式的立身之本）。
 */
export async function directKnowledgeEnabled() {
  try {
    await fs.access(directKnowledgeFile());
    return true;
  } catch {
    return false;
  }
}

export async function saveDirectKnowledge(text) {
  await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });
  const body = String(text || '').slice(0, KNOWLEDGE_MAX);
  const file = directKnowledgeFile();
  // 注意：这里**故意不删文件**。空内容 = "直连资料库开着，但还没填 / 已清空"，
  // 与"从没配过"是两种状态 —— v0.61.0 靠文件是否存在来区分（见 directKnowledgeEnabled）。
  // 删文件会让两者混为一谈，于是"清空后仍注入【本轮没有可用资料】"这种怪现象就出来了。
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, file);
  return body;
}

export async function saveCharacter(input) {
  await ensureDataReady();
  const now = Date.now();
  const id = input.id || uid();
  const existing = await readJson(characterFile(id), null);

  // **没传的字段保持原样**（不是清空）。
  // 原来是整体覆盖：客户端只要漏传一个字段，那个字段就被抹掉 ——
  // 「填了开场白却怎么都不出现」就是这么来的（开场白被一次局部更新清空了）。
  // 现在的规则：传了就用传的（想清空就显式传 ""），没传就沿用已有的。
  const field = (key) => {
    const v = input[key];
    if (v === undefined || v === null) return existing?.[key] ?? '';
    return String(v).trim();
  };

  // 维度（多维图）和「特点提示词」现在**每个角色各一份**：
  //   没传 = 沿用这个角色已有的；传了就用传的；显式传 [] / "" = 回到全局默认。
  const dims = input.dims === undefined ? (existing?.dims ?? null) : normalizeDims(input.dims);

  const card = {
    id,
    name: field('name') || '未命名角色',
    avatar: field('avatar'),
    tagline: field('tagline'),
    persona: field('persona'),
    scenario: field('scenario'),
    greeting: field('greeting'),
    phrases: field('phrases'),
    // 朗读用的音色（可选）。留空 = 用设置里的默认音色。
    voice: field('voice'),
    // 这个角色专属的维度档位（null = 用设置里的全局维度）
    dims,
    // 这个角色专属的「特点提示词」（空 = 用设置里的全局提示词）
    hint: field('hint'),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await writeJson(characterFile(id), card);
  return card;
}

export async function deleteCharacter(id) {
  await ensureDataReady();
  try {
    await fs.unlink(characterFile(id));
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  // 一并删掉这个角色的所有会话，避免留下孤儿文件。
  const sessions = await listSessions();
  await Promise.all(
    sessions.filter((s) => s.characterId === id).map((s) => deleteSession(s.id)),
  );
  return true;
}

/* ---------- 会话（一会话一文件） ---------- */

const sessionFile = (id) => path.join(SESSIONS_DIR, `${id}.json`);

export async function listSessions() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  const files = await fs.readdir(SESSIONS_DIR);
  const sessions = [];
  for (const file of files) {
    if (!isOurJson(file)) continue;
    const session = await readJson(path.join(SESSIONS_DIR, file), null);
    if (!session) continue;
    // 列表页只需要摘要，不把整段聊天记录塞给前端。
    sessions.push({
      id: session.id,
      characterId: session.characterId,
      // '' = 角色会话（老文件没有这个字段）；'direct' = 直连模式
      kind: session.kind || '',
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      preview: session.messages.filter((m) => m.role !== 'system').at(-1)?.content.slice(0, 60) || '',
    });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 修掉"末尾连着两条角色回复"这种畸形历史。
 *
 * 为什么必须修：OpenAI 兼容接口（Ollama 也是）**不接受两条连续的 assistant 消息**
 *   （实测报 `Cannot have 2 or more assistant messages at the end of the list.`），
 * 一旦历史变成这样，这个会话之后每一次对话都会 400。
 * 语义上两条连续角色回复本来就是同一轮被拆成两条，合并成一条是对的。
 */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages || [];
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (m && last && m.role === 'assistant' && last.role === 'assistant') {
      last.content = `${last.content}\n\n${m.content}`;
      last.at = m.at || last.at;
      if (m.rejected?.length) last.rejected = [...(last.rejected || []), ...m.rejected].slice(0, 5);
      continue;
    }
    out.push({ ...m });
  }
  return out;
}

export async function getSession(id) {
  const session = await readJson(sessionFile(id), null);
  if (session?.messages) session.messages = normalizeMessages(session.messages);
  return session;
}

export async function createSession(characterId, title, kind = '') {
  const now = Date.now();
  const session = {
    id: uid(),
    characterId,
    title: title || '新的对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    // 「直连模式」的会话（kind === 'direct'）没有角色卡：创建时 characterId 传 null。
    // 角色会话不带这个字段，磁盘上的老文件因此完全不变。
    ...(kind ? { kind } : {}),
  };
  await writeJson(sessionFile(session.id), session);
  return session;
}

export async function saveSession(session) {
  session.updatedAt = Date.now();
  // 写盘前也收敛一次：保证磁盘上永远不会留下"连续两条 assistant"的畸形历史
  if (session.messages) session.messages = normalizeMessages(session.messages);
  await writeJson(sessionFile(session.id), session);
  return session;
}

export async function deleteSession(id) {
  try {
    await fs.unlink(sessionFile(id));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/* ---------- 同步：整包导出 / 合并导入 ---------- */

// 导出全部角色与会话。不含 config —— API Key 属于各设备，不该跟着数据跑。
export async function exportBundle() {
  const characters = await listCharacters();
  const sessions = [];
  for (const summary of await listSessions()) {
    const full = await getSession(summary.id);
    if (full) sessions.push(full);
  }
  return {
    app: 'local-ai-workbench',
    version: 1,
    exportedAt: Date.now(),
    characters,
    sessions,
  };
}

// 按 id 合并：同一个 id 谁的 updatedAt 新就用谁，没见过的就追加。
// 两台设备各聊各的再合并，两边的记录都能保住，不会互相覆盖。
export async function mergeBundle(bundle) {
  if (!bundle || !Array.isArray(bundle.characters) || !Array.isArray(bundle.sessions)) {
    throw new Error('这不是有效的本地AI对话工作台备份文件');
  }
  await ensureDataReady();
  const stats = {
    characters: { added: 0, updated: 0, skipped: 0 },
    sessions: { added: 0, updated: 0, skipped: 0 },
  };

  // 角色卡：一角色一文件，逐个比对
  for (const incoming of bundle.characters) {
    if (!incoming?.id) continue;
    const existing = await readJson(characterFile(incoming.id), null);
    if (!existing) {
      await writeJson(characterFile(incoming.id), incoming);
      stats.characters.added += 1;
    } else if ((incoming.updatedAt || 0) > (existing.updatedAt || 0)) {
      await writeJson(characterFile(incoming.id), incoming);
      stats.characters.updated += 1;
    } else {
      stats.characters.skipped += 1;
    }
  }

  // 会话。这里直接落盘而不走 saveSession，避免它把 updatedAt 重写成当前时间。
  for (const incoming of bundle.sessions) {
    if (!incoming?.id || !Array.isArray(incoming.messages)) continue;
    const existing = await getSession(incoming.id);
    if (!existing) {
      await writeJson(sessionFile(incoming.id), incoming);
      stats.sessions.added += 1;
    } else if ((incoming.updatedAt || 0) > (existing.updatedAt || 0)) {
      await writeJson(sessionFile(incoming.id), incoming);
      stats.sessions.updated += 1;
    } else {
      stats.sessions.skipped += 1;
    }
  }

  return stats;
}
