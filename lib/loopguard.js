// 复读检测：小模型偶尔会「退化复读」——同一小段话连着重复，而且停不下来
// （配合 Ollama 默认 num_predict = -1 不设上限，就会一直吐到把上下文塞满，看着像死循环）。
//
// 这里只做纯字符串判断：在文本**尾部**找"同一个片段连续重复 N 次"的位置，
// 找到了就把循环起点返回给调用方，让它在起点处截断。
// 不碰网络、不读配置，node smoke.js 可以直接 import 进来测。

// 至少要有这么长的重复单元才算复读（太短会误伤："哈哈哈""……""好好好"）
const MIN_UNIT = 6;
// 最长认到这么长的重复单元
// v2.3.20：60 → 200。实测 deepseek-v4-flash 会把整整两段话（65 字）重复一遍：
//   （本子往桌上一磕，人往前探）四十五！你倒是跟我杠上了是吧？
//   再问一个字，这买卖我不做了。（手按在本子上，眼睛盯着你）说——几钟。
// 原来的 60 字上限直接漏判，三个检测器（tailLoop / duplicateSentence /
// finalLoopCheck）全都没抓到，用户看到的就是「在复读」。
const MAX_UNIT = 200;
// 超过这么长的单元，紧挨着重复 2 次就算复读（短单元 2 次可能是正常强调）
const LONG_UNIT = 40;
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
    // v2.3.20：**长单元重复 2 次**也算复读。
    // 实测 deepseek-v4-flash 会把 65 字整段话紧挨着重复一遍（A B A B 里的 B），
    // 只重复 2 次 → 原来 MIN_REPEATS=3 的规则漏判，用户看到的就是「在复读」。
    // 短于 40 字的单元重复 2 次可能是正常强调（"好好好""别别别"），不算。
    if (repeats === 2 && unit >= LONG_UNIT) {
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
  // 最后清万能填充句（「烟灰落了一截」这类，实测 v12m 100 条里 54 条带）
  const fill = cutFiller(raw);
  if (fill.hit) return { text: fill.text, hit: fill.hit, note: fill.note };
  return { text: raw, hit: null, note: '' };
}

// ============================================================================
//  万能填充句检测（v2.3.20）
//
//  问题：模型会在动作括号里塞「烟灰落了一截」「空气安静了一秒」这类跟情节
//  无关的句子凑长度。实测 v12m 100 条里 54 条带这个，v13 是 40%。
//  这些话语义断裂（烟灰不会"落了一截"），读起来像乱码。
//
//  策略：硬截断——一旦在靠后的位置出现，就把这句和它后面的一起砍掉。
//  为什么砍后面而不只删这句：这类句子后面往往跟着一串同样拼接出来的内容。
// ============================================================================
const FILLER_PATTERNS = [
  /烟灰落了?[一二半几]?截/g,
  /一阵沉默/g,
  /空气(?:突然|一下)?安静了?(?:一[秒会阵])?/g,
  /时间仿佛(?:静止|停住)/g,
  /不知过了多久/g,
];

/** 找出所有填充句出现的位置。返回 [{at, len, phrase}]。 */
export function findFillers(text) {
  const raw = String(text || '');
  const hits = [];
  for (const re of FILLER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      hits.push({ at: m.index, len: m[0].length, phrase: m[0] });
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

/**
 * 硬截断：把第一个填充句所在的整段砍掉。
 * minKeep 是保留的最少字数——太短就不截了，宁可留着也别让回复变残句。
 */
export function cutFiller(text, minKeep = 24) {
  const raw = String(text || '');
  const hits = findFillers(raw);
  if (!hits.length) return { text: raw, hit: null, note: '' };
  const h = hits[0];
  // 先试「只删这一句」：填充句常常夹在括号里或句尾，只删它比整段砍掉损失小
  const before = raw.slice(0, h.at);
  const after = raw.slice(h.at + h.len);
  // 把删掉位置两边可能留下的残渣清掉："（…混着" / "，要不要点" 前面多出来的逗号
  let merged = (before.replace(/[（(]?[^（()）]*$/, (m) => (m.startsWith('（') ? m : '')) + after).trim();
  let cleaned = (before + after)
    .replace(/[，,、]{2,}/g, '，')
    .replace(/（\s*）/g, '')
    .replace(/^[，,、\s]+|[，,、\s]+$/g, '')
    .trim();
  // 只在「填充句原本所在的位置」附近清残渣。
  // 之前用全串正则会把「从你肩上抬起来」「在桌沿蹭了一下」这种正常内容误删。
  // 做法：找到删除点，在拼接后的串里定位，左右各看 8 个字。
  const anchor = before.length;
  const tail = cleaned.slice(anchor, anchor + 10);
  if (/^[。，]?\s*(?:在|从|向|往|落|混着)/.test(tail)) {
    // 这一段是从填充句里漏下来的，砍掉到下一个句号
    const stop = cleaned.slice(anchor).search(/[。！？]/);
    if (stop >= 0) {
      cleaned = (cleaned.slice(0, anchor) + cleaned.slice(anchor + stop + 1)).trim();
    }
  }
  cleaned = cleaned
    .replace(/）[，,]+/g, '）')        // ") ，要" → ")。要" 这种删除后多出的逗号
    .replace(/^[，,、\s]+|[，,、\s]+$/g, '')
    .replace(/[，,]+([。！？])/g, '$1')
    .replace(/[，,、]{2,}/g, '，')
    .trim();
  // 括号不配对时就退回"截断"策略
  const openN = (cleaned.match(/（/g) || []).length;
  const closeN = (cleaned.match(/）/g) || []).length;
  if (cleaned.length >= Math.max(8, minKeep / 2) && openN === closeN) {
    return { text: cleaned, hit: h, note: `检测到万能填充句「${h.phrase}」，已删除` };
  }
  const keep = before;
  // 往前退到干净的断点：优先句号/换行
  let cut = keep;
  const br = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('\n'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  if (br > 0) cut = cut.slice(0, br + 1);
  cut = cut.trim();
  // 截完太短就别截了（宁可留着填充句也别给个残句），但底线放宽到 minKeep/2：
  // 实测很多回复口癖在很靠前的位置，原来要求 24 字会整条放过。
  if (cut.length < Math.max(8, minKeep / 2)) return { text: raw, hit: null, note: '' };
  return {
    text: cut,
    hit: h,
    note: `检测到万能填充句「${h.phrase}」，已截断`,
  };
}

/**
 * 检测重复的括号动作。
 *
 * 实测症状（v16，temperature 0.6，规则精简后）：
 *   （指甲掐进大腿外侧肉垫）最想要的是这个位置～
 *   （指甲掐进大腿外侧肉垫）最想要的是这个位置～
 *   （指甲掐进大腿外侧肉垫）最想要的是这个位置～
 *
 * detectDuplicateSentence 漏判：它以句号/换行为界切分，而动作括号后面
 * 跟的是「～」或没有标点，整段被当成一句没写完的话。
 *
 * 这里单独抓「同一个括号内容出现 2 次以上」。
 */
export function detectDuplicateParen(text, opts = {}) {
  const minLen = opts.minLen || 4;
  const t = String(text || '');
  const re = /[（(]([^）)]{4,})[）)]/g;
  const seen = new Map();
  let m;
  while ((m = re.exec(t)) !== null) {
    const key = m[1].replace(/\s/g, '');
    if (key.length < minLen) continue;
    if (seen.has(key)) {
      return { text: key, at: seen.get(key), second: m.index };
    }
    seen.set(key, m.index);
  }
  return null;
}

/** 删掉重复括号之后的所有内容（保留第一遍）。 */
export function cutDuplicateParen(text, hit) {
  const t = String(text || '');
  if (!hit) return t;
  const cut = t.slice(0, hit.second);
  // 去掉结尾可能残留的半个括号
  return cut.replace(/[（(][^）)]*$/, '').trim();
}
