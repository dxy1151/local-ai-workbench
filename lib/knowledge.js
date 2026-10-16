// 资料库：把一大段文本切成小块，按和"这一轮在聊什么"的相关度挑几块塞进提示词。
// 为什么不用训练：知识类的东西训练记不牢、改一条要重训；检索是即改即生效，也不吃显存。
//
// 纯字符串 + 纯计算，零依赖（不下载嵌入模型），node smoke.js 可直接测。
// 中文没有空格，所以按**字符二元组**当词来算 —— 够用，而且不需要分词库。

/** 把文本切成块：先按空行分段，太长的段再按句子切开、按上限合并。 */
export function chunkText(text, maxLen = 260) {
  const paras = String(text || '')
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of paras) {
    if (p.length <= maxLen) { out.push(p); continue; }
    // 按句末切；`\n` 单独一行时也算断点
    const sents = p.split(/(?<=[。！？!?；;])|\n/).map((s) => s.trim()).filter(Boolean);
    let buf = '';
    for (const s of sents) {
      if (buf && (buf + s).length > maxLen) { out.push(buf); buf = ''; }
      buf += s;
    }
    if (buf) out.push(buf);
  }
  return out;
}

// 单字里这些是"到处都有"的虚词，当词用只会制造假命中
// （实测：「刚烧开的水」里的"的"竟然跟「城南的」对上，把无关的块也拉进来了）。
const STOP_CHARS = new Set(Array.from('的了是在有和就不也都又很才把被给对从到与及或而但如果所以这那什么怎么还只没我你他她它们上下里外中前后个一之其并为以能会要就着过地得'));

/**
 * 把一段文字变成"词 → 权重"。
 * - 主词是**字符二元组**（中文没空格，二元组最省事）；
 * - 另外给**单字**一份低权重（0.35）：短问句常常只跟资料共享单字 ——
 *   实测「（递过一杯刚烧开的水）喝点」跟资料里的「她怕烫，喝水前一定先吹两口」
 *   二元组完全不重叠（一个是"刚烧/烧开/的水"，一个是"怕烫/烫喝/喝水"），
 *   只靠"水"这一个字才搭上线；没有单字兜底，这种相关的块永远挑不中。
 * - 虚词单字（的/了/一…）不算，否则噪声比信号还大。
 */
function tfOf(s) {
  const tf = new Map();
  const t = String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '');
  const add = (k, w) => tf.set(k, (tf.get(k) || 0) + w);
  if (t.length === 1) { tf.set(t, 1); return tf; }
  for (let i = 0; i < t.length - 1; i += 1) add(t.slice(i, i + 2), 1);
  for (const ch of t) if (!STOP_CHARS.has(ch)) add(ch, 0.35);
  return tf;
}

/** 词表（供测试/调试看用了哪些词）。 */
export function tokens(s) {
  return [...tfOf(s).keys()];
}

/** 标记为"常驻"的块：每轮都带上（写法：块里任意一行以 `常驻:` 或 `[常驻]` 开头）。 */
function isAlways(chunk) {
  return /(^|\n)\s*(\[常驻\]|常驻[:：])/.test(chunk);
}

/**
 * 按相关度挑块。
 * @param {string} text 资料全文
 * @param {string} query 这一轮在聊什么（一般用最新一条用户消息 + 上一条角色回复）
 * @param {{maxChars?: number, topK?: number}} opts
 * @returns {string[]} 选中的块（按相关度从高到低；常驻块排在最前）
 */
export function pickChunks(text, query, opts = {}) {
  const maxChars = Math.max(0, Number(opts.maxChars ?? 500));
  const topK = Math.max(1, Number(opts.topK ?? 3));
  const chunks = chunkText(text);
  if (!chunks.length || maxChars <= 0) return [];

  const always = chunks.filter(isAlways);
  const rest = chunks.filter((c) => !isAlways(c));

  const picked = [];
  let used = 0;
  for (const c of always) {
    if (used + c.length > maxChars) break;
    picked.push(c);
    used += c.length;
  }

  const q = String(query || '').trim();
  if (!q || rest.length === 0) return picked;

  // BM25 的简化版：词权重 tf × idf，再按词数开根号归一（免得长块永远赢）
  const qs = new Set(tfOf(q).keys());
  const dfs = new Map();
  const tfs = rest.map((c) => {
    const tf = tfOf(c);
    for (const t of tf.keys()) dfs.set(t, (dfs.get(t) || 0) + 1);
    return tf;
  });
  const N = rest.length;
  const scored = rest
    .map((c, i) => {
      let score = 0;
      let bigrams = 0;
      const unis = new Set();
      for (const [t, w] of tfs[i]) {
        if (!qs.has(t)) continue;
        score += w * (Math.log(1 + N / (dfs.get(t) || 1)) + 1);
        if (t.length >= 2) bigrams += 1; else unis.add(t);
      }
      // 只靠**一个字**撞上的不算相关（「今天月亮真圆」↔「月结工钱」就是这么误中的）。
      // 要么命中二元组，要么至少两个不同单字（「刚烧开的水」↔「喝水前…」靠"水"+"喝"成立）。
      const ok = bigrams > 0 || unis.size >= 2;
      return { text: c, score: ok ? score / Math.sqrt(tfs[i].size || 1) : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // 只带上"明显相关"的：分数掉到最高分四成以下的就不带了。
  // 小资料库（几十块）里 idf 区分度很弱，没有这道阈值，靠单字勉强对上的块也会被拉进来。
  const top = scored.length ? scored[0].score : 0;
  const floor = top * 0.4;
  for (const s of scored) {
    if (picked.length >= topK) break;
    if (s.score < floor) break;
    if (used + s.text.length > maxChars) break;
    picked.push(s.text);
    used += s.text.length;
  }
  return picked;
}

/** 把选中的块拼成给模型看的一段。位置和「场景备忘」一样靠后（越靠后越当回事）。 */
export function knowledgeBlock(chunks) {
  const list = (Array.isArray(chunks) ? chunks : []).filter((c) => String(c || '').trim());
  if (!list.length) return '';
  return [
    '【资料（只作参考，不是台词）】',
    '下面几段是从这个角色的资料里挑出来的、跟这一轮最相关的内容。请**据此**来写，但：',
    '- 不要照抄原文，更不要把它当台词念出来；',
    '- 资料里没写到的事不要编；',
    '- 和上面「扮演要求」冲突时，以扮演要求为准。',
    '',
    ...list.map((c) => `· ${c}`),
  ].join('\n');
}

/* =====================================================================
 * v0.61.0：语义检索（embedding）
 *
 * 为什么加：纯字符二元组的 BM25 在"直白问法"上只有 10/16 —— 最糟的是
 * 「生孩子要多久」和「怀不上孩子怎么办」都因为"孩子"二字命中了同一段
 * 一段看似相关、其实无关的资料，把完全无关的内容喂给模型。
 * 实测 16 题：BM25 10/16 → 语义 15/16。
 *
 * 设计原则：
 *  1) **BM25 一行不删**，语义不可用时自动降级回它（老行为仍然是兜底，不是被替换掉）；
 *  2) 阈值是**绝对分数**（不是相对最高分）—— 无关问题直接不注入，
 *      避免"矮子里拔将军"把跑偏的块塞进去（以前那套只有 top*0.4 的相对门槛）；
 *  3) 常驻块（`常驻:` / `[常驻]`）永远优先、不参与阈值过滤；
 *  4) 结果与 BM25 共用同一套 chunkText，两种模式挑出来的块可以互相比较。
 * ===================================================================== */

/** 本地 embedding 端点（和 srv 共用 Ollama；不额外依赖任何 npm 包）。 */
function embedEndpoint(opts = {}) {
  const base = String(opts.embedBaseUrl || (process.env.WORKBENCH_EMBED_BASE || process.env.XINGYE_EMBED_BASE) || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  return {
    url: /\/v\d+$/.test(base) ? `${base}/embeddings` : `${base}/api/embed`,
    model: opts.embedModel || (process.env.WORKBENCH_EMBED_MODEL || process.env.XINGYE_EMBED_MODEL) || 'qwen3-embedding:0.6b',
    openai: /\/v\d+$/.test(base),
  };
}

/** 调一次 embedding；失败抛错（由调用方决定是否降级）。 */
export async function fetchEmbedding(text, opts = {}) {
  const [v] = await fetchEmbeddings([text], opts);
  return v;
}

/**
 * 批量 embedding —— 1208 块逐条请求会发 1208 次 HTTP（实测不可接受），
 * 所以一次请求带一批。批次大小默认 32。
 */
export async function fetchEmbeddings(texts, opts = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || ''));
  if (!list.length) return [];
  const ep = embedEndpoint(opts);
  const body = ep.openai
    ? { model: ep.model, input: list }
    : { model: ep.model, input: list, keep_alive: opts.keepAlive || '30m' };
  const ctrl = new AbortController();
  // 批量大 + 文本长时给足时间（1208 块要分约 38 批，每批单独限时）
  const timer = setTimeout(() => ctrl.abort(), Number(opts.timeoutMs) || 60000);
  try {
    const r = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`embedding HTTP ${r.status}`);
    const j = await r.json();
    const arr = ep.openai
      ? (j.data || []).map((d) => d.embedding)
      : (j.embeddings || []);
    if (!Array.isArray(arr) || !arr.length || !Array.isArray(arr[0])) {
      throw new Error('embedding 返回格式不对');
    }
    return arr;
  } finally {
    clearTimeout(timer);
  }
}

/** 分批跑完所有文本的 embedding。 */
export async function fetchEmbeddingsAll(texts, opts = {}) {
  const batch = Math.max(1, Number(opts.batchSize) || 32);
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const part = await fetchEmbeddings(texts.slice(i, i + batch), opts);
    out.push(...part);
  }
  return out;
}

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 把口语映射表应用到查询上。
 * 格式：每行 `口语=术语`（右侧可写多个术语，用空格或 / 分隔）。
 * 命中的行把**右侧术语追加**到查询后面，而不是替换原句 ——
 * 因为原句里的规范词（如"小阴唇肥大"）本身就是 BM25 最有效的线索，不能丢。
 */
export function applyColloquialMap(query, rawMap) {
  const q = String(query || '');
  const map = String(rawMap || '');
  if (!map.trim()) return q;
  const hits = [];
  for (const line of map.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const from = s.slice(0, i).trim();
    const to = s.slice(i + 1).trim();
    if (!from || !to) continue;
    // 右侧可能是 "术语1 术语2" 或 "术语1/术语2"
    const terms = to.split(/[\/、,，\s]+/).map((x) => x.trim()).filter(Boolean);
    if (q.includes(from)) hits.push(...terms);
  }
  if (!hits.length) return q;
  return `${q} ${[...new Set(hits)].join(' ')}`;
}

/**
 * 块向量缓存 —— **这是能做到"每轮 60ms"的关键**。
 * 不做缓存的话每轮都要把整库（1208 块）重新 embedding 一遍，
 * 实测要几秒，完全不可接受。缓存键是"块文本的哈希"，所以资料一改就自动失效。
 * 上限防止长期运行内存无限涨。
 */
const EMBED_CACHE = new Map();
const EMBED_CACHE_MAX = 4000;

// 磁盘缓存：冷启动要把整库 1208 块向量化，实测 25 秒 —— 每次重启都付这个代价不可接受。
// 所以把块向量持久化到磁盘（按 embedding 模型区分文件名），下次启动直接读。
let DISK_PATH = null;
let DISK_LOADED = false;
let DISK_DIRTY = false;
let DISK_TIMER = null;

function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + s.length;
}

function cacheGet(text) {
  const k = simpleHash(text);
  const v = EMBED_CACHE.get(k);
  if (v) { EMBED_CACHE.delete(k); EMBED_CACHE.set(k, v); }  // LRU 触碰
  return v;
}

function cacheSet(text, vec) {
  if (EMBED_CACHE.size >= EMBED_CACHE_MAX) {
    const oldest = EMBED_CACHE.keys().next().value;
    EMBED_CACHE.delete(oldest);
  }
  EMBED_CACHE.set(simpleHash(text), vec);
  DISK_DIRTY = true;
}

/**
 * 指定磁盘缓存目录（一般是 data/knowledge 旁边）。
 * 传 null 则关闭持久化（测试里常用）。
 */
export function setEmbedCacheDir(dir) {
  DISK_PATH = dir ? `${String(dir).replace(/[\\/]+$/, '')}/.embed-cache-${encodeURIComponent(embedEndpoint().model)}.json` : null;
  DISK_LOADED = false;
}

async function loadDiskCache() {
  if (DISK_LOADED || !DISK_PATH) return;
  DISK_LOADED = true;
  try {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(DISK_PATH, 'utf8');
    const j = JSON.parse(raw);
    const n = Number(j?.dim) || 0;
    if (n > 0 && j.vectors && typeof j.vectors === 'object') {
      for (const [k, arr] of Object.entries(j.vectors)) {
        if (Array.isArray(arr) && arr.length === n) EMBED_CACHE.set(k, arr);
      }
    }
  } catch { /* 首次没有缓存文件，正常 */ }
}

async function saveDiskCache() {
  if (!DISK_PATH || !DISK_DIRTY) return;
  DISK_DIRTY = false;
  try {
    const fs = await import('node:fs/promises');
    const vecs = {};
    let dim = 0;
    for (const [k, v] of EMBED_CACHE) {
      if (!dim) dim = v.length;
      if (v.length === dim) vecs[k] = v;
    }
    await fs.mkdir(DISK_PATH.slice(0, DISK_PATH.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(DISK_PATH, JSON.stringify({ model: embedEndpoint().model, dim, vectors: vecs }));
  } catch { /* 写不进去也不该影响聊天 */ }
}

function scheduleDiskSave() {
  if (!DISK_PATH || DISK_TIMER) return;
  // 攒 2 秒再写，避免每个块都落盘
  DISK_TIMER = setTimeout(() => {
    DISK_TIMER = null;
    saveDiskCache().catch(() => {});
  }, 2000);
  if (typeof DISK_TIMER.unref === 'function') DISK_TIMER.unref();
}

/** 清缓存（资料变更或换 embedding 模型时调用）。 */
export function clearEmbedCache() {
  EMBED_CACHE.clear();
  DISK_DIRTY = true;
}

/** 缓存统计（测试/诊断用）。 */
export function embedCacheStats() {
  return { size: EMBED_CACHE.size, max: EMBED_CACHE_MAX, disk: DISK_PATH, loaded: DISK_LOADED };
}

/** 把磁盘缓存立刻写下去（进程退出前/测试里用）。 */
export async function flushEmbedCache() {
  if (DISK_TIMER) { clearTimeout(DISK_TIMER); DISK_TIMER = null; }
  DISK_DIRTY = true;
  await saveDiskCache();
}

/**
 * 语义检索：按 embedding 余弦相似度挑块。
 * 查询向量每次都算；**块向量走缓存**（首次冷启动付一次全库 embedding 的代价）。
 * @returns {Promise<{chunks: string[], emptyReason: string|null}>}
 *   emptyReason 非空表示"没有相关块"，调用方可以据此决定是否提示模型"别编"。
 */
export async function pickChunksSemantic(text, query, opts = {}) {
  const budget = Math.max(0, Number(opts.maxChars ?? 500));
  const topK = Math.max(1, Number(opts.topK ?? 3));
  const threshold = Number(opts.threshold ?? 0.5);
  const chunks = chunkText(text);
  if (!chunks.length || budget <= 0) return { chunks: [], emptyReason: 'empty' };

  // 常驻块永远带上（不吃阈值），和 BM25 版行为一致
  const always = chunks.filter(isAlways);
  const rest = chunks.filter((c) => !isAlways(c));

  const picked = [];
  let used = 0;
  for (const c of always) {
    if (used + c.length > budget) break;
    picked.push(c);
    used += c.length;
  }

  const q = String(query || '').trim();
  if (!q || !rest.length) return { chunks: picked, emptyReason: picked.length ? null : 'no-query' };

  // 0) 首次调用时把磁盘缓存读进来（避免每次重启都重算全库）
  await loadDiskCache();

  // 1) 先取缓存命中的块向量，只对没缓存的做 embedding
  const vecs = new Array(rest.length);
  const missIdx = [];
  for (let i = 0; i < rest.length; i += 1) {
    const v = cacheGet(rest[i]);
    if (v) vecs[i] = v;
    else missIdx.push(i);
  }
  // 2) 查询向量 + 未命中的块向量，一次批量算完
  const need = missIdx.length ? [q, ...missIdx.map((i) => rest[i])] : [q];
  const got = await fetchEmbeddingsAll(need, opts);
  const qv = got[0];
  missIdx.forEach((idx, k) => {
    vecs[idx] = got[k + 1];
    cacheSet(rest[idx], got[k + 1]);
  });
  if (missIdx.length) scheduleDiskSave();

  const sims = rest.map((_c, i) => cosine(qv, vecs[i]));
  // 阈值 0 = 不设门槛：直接取相似度最高的几块（余弦可能为负，按数值过滤会把它们全挡掉，
  // 那不是"不设门槛"该有的行为）。阈值 > 0 才做绝对分过滤。
  const filt = threshold > 0 ? sims.map((s, i) => [s, i]).filter(([s]) => s >= threshold) : sims.map((s, i) => [s, i]);
  const order = filt.sort((a, b) => b[0] - a[0]);

  for (const [, i] of order) {
    if (picked.length >= topK + always.length) break;
    const c = rest[i];
    if (used + c.length > budget) continue;
    picked.push(c);
    used += c.length;
  }
  return {
    chunks: picked,
    emptyReason: picked.length ? null : 'below-threshold',
  };
}

/**
 * 带降级的检索入口：语义优先，失败或不可用时自动退回 BM25。
 * @returns {Promise<{chunks: string[], mode: 'semantic'|'lexical', emptyReason: string|null, err: string|null}>}
 */
export async function pickChunksSmart(text, query, opts = {}) {
  const useSemantic = opts.semantic !== false;
  if (!useSemantic) {
    const c = pickChunks(text, query, opts);
    return { chunks: c, mode: 'lexical', emptyReason: c.length ? null : 'below-threshold', err: null };
  }
  try {
    const r = await pickChunksSemantic(text, query, opts);
    return { chunks: r.chunks, mode: 'semantic', emptyReason: r.emptyReason, err: null };
  } catch (err) {
    // embedding 拿不到（模型没装 / Ollama 没起）→ 安静降级，聊天不能因此断
    const c = pickChunks(text, query, opts);
    return { chunks: c, mode: 'lexical', emptyReason: c.length ? null : 'below-threshold', err: err.message };
  }
}
