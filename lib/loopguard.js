// 复读检测：小模型偶尔会「退化复读」——同一小段话连着重复，而且停不下来
// （配合 Ollama 默认 num_predict = -1 不设上限，就会一直吐到把上下文塞满，看着像死循环）。
//
// 这里只做纯字符串判断：在文本**尾部**找"同一个片段连续重复 N 次"的位置，
// 找到了就把循环起点返回给调用方，让它在起点处截断。
// 不碰网络、不读配置，node smoke.js 可以直接 import 进来测。

// 至少要有这么长的重复单元才算复读（太短会误伤："哈哈哈""……""好好好"）
const MIN_UNIT = 6;
// 最长认到这么长的重复单元（再长基本就是正常的重复用词了）
const MAX_UNIT = 60;
// 连续重复这么多次才判定为复读
const MIN_REPEATS = 3;
// 只看结尾这么多字符，避免长文里正常的重复被误判
const TAIL_WINDOW = 900;

// 单元里必须有点"实词"，纯标点/空白不算
function hasSubstance(unit) {
  const solid = unit.replace(/[\s*（）()【】「」，。！？、…—~～"“”'']/g, '');
  return solid.length >= 3;
}

/**
 * 在文本尾部找复读。
 * @returns {{at: number, unit: number, repeats: number}|null}
 *          at = 循环起点的字符下标（从这里截断即可），unit = 重复单元长度
 */
export function detectTailLoop(text, opts = {}) {
  const raw = String(text || '');
  if (raw.length < MIN_UNIT * MIN_REPEATS) return null;
  const offset = Math.max(0, raw.length - (opts.tailWindow || TAIL_WINDOW));
  const t = raw.slice(offset);
  const n = t.length;

  for (let unit = MIN_UNIT; unit <= Math.min(MAX_UNIT, Math.floor(n / MIN_REPEATS)); unit += 1) {
    const last = t.slice(n - unit);
    if (!hasSubstance(last)) continue;
    let repeats = 1;
    while (repeats < 12) {
      const prev = t.slice(n - unit * (repeats + 1), n - unit * repeats);
      if (prev.length < unit || prev !== last) break;
      repeats += 1;
    }
    if (repeats >= MIN_REPEATS) {
      return { at: offset + n - unit * repeats, unit, repeats };
    }
  }
  return null;
}

/** 给用户看的一句话说明。 */
export function describeLoop(hit) {
  if (!hit) return '';
  return `检测到复读（同一段 ${hit.unit} 字重复了 ${hit.repeats} 次），已在循环处截断`;
}

/* ---------- 整段重复（不是紧挨着的那种） ---------- */

const SKELETON = /[\s*（）()【】「」，。！？、…—~～"“”'']/g;

/**
 * 找出"同一句话又写了一遍"的位置。
 *
 * 为什么需要它：模型经常把刚写过的一整段**再写一遍**（两遍之间还可能夹一行旁白），
 * 这种不是"紧挨着重复"，detectTailLoop 抓不到 —— 实测有这种输出：
 *   *我微微侧过头，看着你。虽然脸上的表情依然保持着平静，但我却感到一种……*
 *   （内心有一丝期待）
 *   *我微微侧过头，看着你。虽然脸上的表情依然保持着平静，但我却感到一种……*
 * 所以按**句子**做去重：只要有较长的句子在前文出现过，就算复读。
 *
 * @returns {{at: number, text: string}|null} at = 这次重复的起点（从这里截断就只剩第一遍）
 */
export function detectDuplicateSentence(text, opts = {}) {
  // 太短会有正常重复；但也不能太长 —— 实测重复的句子只有 16 字
  //（"脸还埋在手臂里，闷着声音骂了一句"这种），原来定 24 字直接漏判。
  const minLen = opts.minLen || 16;
  const t = String(text || '');
  if (t.length < minLen * 2) return null;
  const parts = [];
  const re = /[^。！？!?\n]*[。！？!?\n]/g; // 只匹配"有结尾标点/换行"的完整句子
  let m;
  while ((m = re.exec(t))) parts.push({ text: m[0], at: m.index });
  // 注：正则本身只匹配**已收尾**的句子，所以这里不用丢掉最后一段
  //（曾经按"最后一段没写完"丢掉，结果把重复的那句正好丢了，一直抓不到）
  const seen = new Map();
  let earlier = ''; // 已看过的句子骨架串起来，用来做"包含式"判断
  for (const p of parts) {
    const key = p.text.replace(SKELETON, '');
    if (key.length < minLen) { earlier += key; continue; }
    if (seen.has(key)) {
      // 精确重复：**向前扩展**到"这一遍"的起点。
      // 否则会在第二遍的中间截断、留下半句重复（实测：重复的第一句较短、
      // 没被单独登记，于是截断点落在第二句上）。
      const first = seen.get(key);
      let at = p.at;
      let f = first;
      while (at > 0 && f > 0 && t[at - 1] === t[f - 1]) { at -= 1; f -= 1; }
      return { at, text: t.slice(at, at + key.length) };
    }
    // 包含式重复：第二遍可能只是"被前面的前缀/标记动过一点"（例如第一遍头顶
    // 被「动作开头」加了 `*我`），骨架因此不完全相等。这里放宽成"前面出现过这段"。
    if (earlier.includes(key)) return { at: p.at, text: p.text.trim() };
    seen.set(key, p.at);
    earlier += key;
  }
  return null;
}

/** 在重复起点处截断（保留第一遍）。截剩太少就当废稿。 */
export function cutDuplicate(text, hit, minKeep = 20) {
  if (!hit) return String(text || '');
  const kept = String(text || '').slice(0, hit.at).trim();
  return kept.length >= minKeep ? kept : '';
}

/** 在循环起点处截断；截剩太少就返回空串（这一版直接作废）。 */
export function cutLoop(text, hit, minKeep = 20) {
  if (!hit) return String(text || '');
  const kept = String(text || '').slice(0, hit.at).trim();
  return kept.length >= minKeep ? kept : '';
}

/* ---------- 生成后终检（v2.3.15） ---------- */

/**
 * 对**已经生成完的整段文本**再做一次复读检查。
 *
 * 为什么流式检测抓不到而需要这一层：本地 Ollama 有时把正文写进 thinking 通道，
 * lib/ollama.js 的 salvage 分支会用 `onDelta(full)` **一次性**把整段正文送出来 ——
 * 那时 server 的 onDelta 收到的是"一整段"，acc 直接等于全文，
 * 增量检测自然一次都命中不了（实测：房东卡复读出 266 字车轱辘话，日志里全是
 * `[salvage] content 为空、thinking 通道有 N 字`）。
 *
 * 所以这里对最终文本独立判断，覆盖 salvage / 非流式 / 候选生成等所有旁路。
 * 用比流式检测更宽松的窗口：整段看不到"未来"，只能靠更长回看。
 *
 * @returns {{text:string, hit:object|null, note:string}} text 为截断后的结果（没复读就原样返回）
 */
export function finalLoopCheck(text) {
  const raw = String(text || '');
  if (!raw) return { text: raw, hit: null, note: '' };
  // 先试紧挨着重复（和流式同一套规则，但窗口放宽到整段）
  const tail = detectTailLoop(raw, { tailWindow: Math.min(raw.length, 2000) });
  if (tail) {
    const cut = cutLoop(raw, tail);
    if (cut) return { text: cut, hit: tail, note: describeLoop(tail) };
  }
  // 再试"隔了一段又整句重写"
  const dup = detectDuplicateSentence(raw);
  if (dup) {
    const cut = cutDuplicate(raw, dup);
    if (cut) return { text: cut, hit: dup, note: '检测到整句重复，已在重复处截断' };
  }
  return { text: raw, hit: null, note: '' };
}
