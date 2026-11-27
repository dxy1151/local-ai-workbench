import { readFileSync } from 'node:fs';
// ============================================================================
//  L1 常驻知识按话题分段注入
//
//  为什么改：原来每轮把 4705 字的 L1 全文塞进 system，不管用户在聊什么。
//  「问价多少钱」和「你自己弄过没有」拿到的是一样的 4705 字 → 模型要在里面
//  自己找重点，大部分段落跟当前这句无关，等于噪声。
//
//  改成：根据用户这句话命中哪些话题，只注入相关的 2~4 段（600~900 字）。
//  实测 L1 用词命中率从 56% 往上走的空间就在这里。
//
//  匹配思路：不看语义（口语和百科没词面重叠，语义实测也只有 50% 精度），
//  而是按「这句话大概在干什么」分档。宁可多注入一段，也别漏掉该用的。
// ============================================================================

/**
 * 话题定义：命中任一关键词 → 注入该段。
 *
 * v2.5.4（2026-11-19）：**词表外置到 config/l1-topics.json**。
 * 源码里不再出现任何具体词汇 —— 配置缺失时 L1 检索自动禁用（聊天照常，只是不注入分段知识）。
 */
let TOPICS_CACHE = null;

function loadTopics() {
  if (TOPICS_CACHE !== null) return TOPICS_CACHE;
  TOPICS_CACHE = [];
  try {
    const url = new URL('../config/l1-topics.json', import.meta.url);
    const data = JSON.parse(readFileSync(url, 'utf8'));
    const list = Array.isArray(data?.topics) ? data.topics : [];
    for (const t of list) {
      if (!t || typeof t.id !== 'string') continue;
      const keys = Array.isArray(t.keys) ? t.keys.filter((k) => typeof k === 'string' && k) : [];
      const sections = Array.isArray(t.sections) ? t.sections.filter((k) => typeof k === 'string' && k) : [];
      if (!keys.length || !sections.length) continue;
      TOPICS_CACHE.push({ id: t.id, keys, sections });
    }
  } catch {
    // 没有配置文件 = 不启用分段检索
    TOPICS_CACHE = [];
  }
  return TOPICS_CACHE;
}

/** 没有任何话题命中时，兜底注入的段名（配置在 config/l1-topics.json 的 baseSections）。 */
let BASE_SECTIONS_CACHE = null;
function loadBaseSections() {
  if (BASE_SECTIONS_CACHE !== null) return BASE_SECTIONS_CACHE;
  BASE_SECTIONS_CACHE = [];
  try {
    const url = new URL('../config/l1-topics.json', import.meta.url);
    const data = JSON.parse(readFileSync(url, 'utf8'));
    const list = Array.isArray(data?.baseSections) ? data.baseSections : [];
    BASE_SECTIONS_CACHE = list.filter((x) => typeof x === 'string' && x);
  } catch {
    BASE_SECTIONS_CACHE = [];
  }
  return BASE_SECTIONS_CACHE;
}

/** 对外暴露（只读）：需要遍历话题时用。 */
export function getTopics() {
  return loadTopics();
}

/** 拆 L1 全文成 {名称: 内容} 的段落表。 */
export function splitSections(text) {
  const out = new Map();
  const raw = String(text || '');
  // ⚠ 不能用 /^【...】([\s\S]*?)(?=^【|$)/gm：m 标志下 $ 匹配行尾，
  //   [\s\S]*? 会缩到空就满足 $，每段只抓到标题本身。
  //   改用：先按行扫描找标题位置，再切片。
  const lines = raw.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*【([^】]+)】/.exec(lines[i]);
    if (m) marks.push({ name: m[1].trim(), start: i });
  }
  if (!marks.length) return out;
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].start;
    const end = i + 1 < marks.length ? marks[i + 1].start : lines.length;
    const body = lines.slice(start, end).join('\n').trim();
    out.set(marks[i].name, body);
  }
  return out;
}

/**
 * 根据用户这句话挑要注入的 L1 段落。
 * 返回 { text, picked, topics }。
 *
 * 兜底规则：
 *   - 一段都没命中 → 返回「常用基础段」（用词规范 + 称谓 + 长度），
 *     这三段在绝大多数对话里都用得上，体量也小（约 500 字）。
 *   - 命中的段落总字数超过 maxChars → 按优先级截断。
 */
export function pickL1(l1Text, userText, opts = {}) {
  const maxChars = opts.maxChars || 1200;
  // v2.5.4：基础段名也从配置读（config/l1-topics.json 的 baseSections），
  // 没配就退到"命中的所有段都带上"，不再在源码里写死具体段名。
  const base = opts.baseSections || loadBaseSections();
  const whole = String(l1Text || '');
  const sections = splitSections(whole);
  if (!sections.size) return { text: whole, picked: [], topics: [] };

  const q = String(userText || '');
  const topics = [];
  const picked = new Set();

  for (const t of loadTopics()) {
    if (t.keys.some((k) => q.includes(k))) {
      topics.push(t.id);
      for (const s of t.sections) if (sections.has(s)) picked.add(s);
    }
  }

  // 一段没命中：给基础段，别给空
  if (!picked.size) {
    for (const s of base) if (sections.has(s)) picked.add(s);
  } else {
    // 命中了话题，基础段也要带上（用词规范永远有用）
    for (const s of base) if (sections.has(s)) picked.add(s);
  }

  // 按原顺序拼，控制字数
  const order = [...sections.keys()];
  const chosen = [];
  let total = 0;
  for (const name of order) {
    if (!picked.has(name)) continue;
    const body = sections.get(name);
    if (total + body.length > maxChars && chosen.length >= 1) continue;
    chosen.push(name);
    total += body.length;
  }

  const text = chosen.map((n) => sections.get(n)).join('\n\n');
  return { text, picked: chosen, topics };
}
