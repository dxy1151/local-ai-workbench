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
  // v2.3.34：16 还是太长了。27B 这类通用模型会输出「（我）：先聊两句呗，别急。」这种
  // 短句重复，单句去掉括号只剩 9 字，16 直接跳过。降到 6 后实测 6 组正常回复零误报。
  const minLen = opts.minLen || 6;
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

/**
 * 近似重复检测。
 *
 * 现在的 detectDuplicateSentence 比的是**去掉标点后的精确字符串**，
 * 实测漏判严重：模型复读时会把措辞改一点点 ——
 *   「（银簪微晃）你想怎么玩？」
 *   「（银簪微晃）你想怎么玩？」         ← 完全相同，能抓
 *   「（手指轻轻解开银簪）发髻松些好动弹。」 ← 改写了，抓不到
 *   「（突然把整束头发从头顶甩下来…）」 / 「（突然把整束发辫从头顶甩下来…）」
 *
 * 这里改成按「3-gram 指纹集合」比相似度：把文本切成连续 3 字的集合，
 * 两段的 Jaccard 系数 > 0.6 就算重复。
 */
function shingles(text, n = 3) {
  const t = String(text || '').replace(/[^\u4e00-\u9fff]/g, '');
  const set = new Set();
  for (let i = 0; i + n <= t.length; i += 1) set.add(t.slice(i, i + n));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 找「隔了一段又重写同一段」的近似重复。
 * 返回 { at, text }，at 是第二遍的起点。
 */
export function detectNearDuplicate(text, opts = {}) {
  const minLen = opts.minLen || 12;     // 实测复读的最小单元是「（动作）一句话。」共 23 字，
  // 定 30 会漏判（短句被判成太短不参与）
  const threshold = opts.threshold || 0.65;
  const t = String(text || '');
  if (t.length < minLen * 2) return null;

  // 按句末标点切段，但**括号内部的标点不切**。
  // 不能用 /[^。！？～]+[。！？～]?/g —— 会把「嗯？（动作）+ 长句。」整段吃掉，
  // 导致短的开头段被过滤后，剩下的段落划分跟实际不符（实测漏判）。
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (ch === '（' || ch === '(') depth += 1;
    else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ('。！？～\n'.includes(ch))) {
      const seg = t.slice(start, i + 1);
      if (seg.replace(/\s/g, '').length >= minLen) parts.push({ text: seg, at: start });
      start = i + 1;
    }
  }
  // 收尾：最后一段没有句末标点也要算
  if (start < t.length) {
    const seg = t.slice(start);
    if (seg.replace(/\s/g, '').length >= minLen) parts.push({ text: seg, at: start });
  }
  if (parts.length < 2) return null;

  const sigs = parts.map((p) => shingles(p.text));
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const sim = jaccard(sigs[i], sigs[j]);
      // 整段相似
      if (sim >= threshold) {
        return { at: parts[i].at, text: parts[i].text.trim(), sim };
      }
      // 包含式：第 i 段是第 j 段开头的一部分（第二遍只写了一半就断了，
      // 实测「嗯？（手指轻轻拨弄发髻）这可是要拿去绑戏箱上用的。」这种）。
      // 判断方法：把 i 的指纹全部塞进 j 里看覆盖率。
      if (sigs[i].size >= 8) {
        let hit = 0;
        for (const x of sigs[i]) if (sigs[j].has(x)) hit += 1;
        const cover = hit / sigs[i].size;
        if (cover >= 0.85) {
          return { at: parts[i].at, text: parts[i].text.trim(), sim: cover };
        }
      }
    }
  }
  return null;
}

/**
 * 检测「重复开头」。
 *
 * 实测模型复读的另一种形态：不是整段照抄，而是**从同一个开头重写**——
 *   「嗯？（手指轻轻抚过发髻边缘）这银簪可不轻。…」
 *   「嗯？（手指轻轻拨动发髻）这可是台上盘着的好东西。…」
 * 后半段内容不同，Jaccard 只有 0.15，近似重复检测抓不到。
 *
 * 但它们共享同一个「开头骨架」：嗯？+ 括号动作 + 发髻。
 * 这里提取每段的「前 10 个中文字」做指纹，命中两次就截断。
 */
export function detectRepeatOpening(text, opts = {}) {
  const prefixLen = opts.prefixLen || 4;
  const t = String(text || '');
  if (t.length < 60) return null;

  // 按句末标点切段（括号内不切）
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (ch === '（' || ch === '(') depth += 1;
    else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ('。！？～\n'.includes(ch))) {
      const seg = t.slice(start, i + 1);
      if (seg.replace(/\s/g, '').length >= 12) parts.push({ text: seg, at: start });
      start = i + 1;
    }
  }
  if (start < t.length) {
    const seg = t.slice(start);
    if (seg.replace(/\s/g, '').length >= 12) parts.push({ text: seg, at: start });
  }
  if (parts.length < 2) return null;

  const seen = new Map();
  for (const p of parts) {
    const raw = String(p.text);
    // key 用「括号里的前 6 个字」—— 动作括号是复读时最稳定的部分。
    // 实测：「（手指轻轻抚过发髻边缘）」和「（手指轻轻拨动发髻）」前 4 字相同，
    // 拿前 4 字做 key 能命中；前 10 字就命中不了了。
    const m = /[（(]([^）)]{2,})[）)]/.exec(raw);
    const action = m ? m[1].replace(/[^\u4e00-\u9fff]/g, '').slice(0, prefixLen) : '';
    if (action.length < prefixLen) continue;
    // 同一段里出现两次同样的动作开头 = 复读
    if (seen.has(action)) {
      return { at: p.at, text: p.text.trim(), key: action };
    }
    seen.set(action, p.at);
  }
  return null;
}


/** 最长公共子串长度（只用于短文本，O(n*m) 可接受）。 */
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 检测「括号动作整段重复」。
 *
 * v2.3.34：实测两个漏判案例都不符合上面三个检测的假设：
 *
 *   案例 1（括号外用词微调）：
 *     （我把抹布往肩上一搭，下巴朝吧台角落那瓶没开的酒抬了抬）二百一。
 *     （我把手里的抹布往肩上一搭，侧过身，下巴朝吧台角落那瓶没开的酒抬了抬。）
 *     → 句末切段正确切出两段，但 Jaccard 只有 0.52（不到 0.65），漏判
 *
 *   案例 2（整段都在括号里）：
 *     （我侧躺在床上……那一片皮肤先绷紧了一下，起了一层细密的疙瘩。）
 *     （我侧躺在床上，一条腿屈起来压在另一条腿上，把被子推到一边
 *     → 括号外没有句号，按句末切段只切出 1 段，detectNearDuplicate 直接 return null
 *
 * 所以这里**不管句末标点，直接把每个括号动作单独拎出来**，按顺序比对：
 *   - 完全相同的括号（案例 2）→ 直接判重复
 *   - 相似度 >= 0.6 的括号（案例 1）→ 判重复
 * 返回第二遍出现的起点（括号的 `（` 位置）。
 */
export function detectParenDuplicate(text, opts = {}) {
  const minLen = opts.minLen || 8;      // 括号里至少 8 个字才参与比对
  const threshold = opts.threshold || 0.5;
  const t = String(text || '');
  if (t.length < minLen * 2) return null;

  // 把所有括号动作按出现顺序切出来（支持嵌套）
  const spans = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (ch === '（' || ch === '(') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '）' || ch === ')') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        const body = t.slice(start + 1, i);
        if (body.replace(/\s/g, '').length >= minLen) {
          spans.push({ at: start, body, full: t.slice(start, i + 1) });
        }
        start = -1;
      }
    }
  }
  if (spans.length < 2) return null;

  const sigs = spans.map((s) => shingles(s.body));
  for (let i = 1; i < spans.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      // 完全相同的括号动作：内容长度接近就判重复（案例 2）
      if (spans[i].body === spans[j].body) {
        return { at: spans[i].at, text: spans[i].full.trim(), sim: 1, kind: 'paren-exact' };
      }
      const sim = jaccard(sigs[i], sigs[j]);
      if (sim >= threshold) {
        return { at: spans[i].at, text: spans[i].full.trim(), sim, kind: 'paren-near' };
      }
      // v2.3.34：中间插了一小段导致 Jaccard 掉下来的情况。
      // （把抹布搭在肩上，下巴朝吧台角落那瓶没开的酒抬了抬）
      // （我侧了侧身，把搭在肩上的抹布重新捋正，下巴朝吧台角落那瓶没开的酒抬了抬）
      // → Jaccard 只有 0.44，但 76% 的 trigram 被包含、还有 16 字连续相同。
      const bodyA = spans[j].body.replace(/[^\u4e00-\u9fff]/g, '');
      const bodyB = spans[i].body.replace(/[^\u4e00-\u9fff]/g, '');
      if (bodyA.length >= 10 && bodyB.length >= 10) {
        let coverHit = 0;
        for (const x of sigs[j]) if (sigs[i].has(x)) coverHit += 1;
        const cover = coverHit / sigs[j].size;
        const common = longestCommonSubstring(bodyA, bodyB);
        if (cover >= 0.7 && common >= 12) {
          return { at: spans[i].at, text: spans[i].full.trim(), sim: cover, kind: 'paren-cover' };
        }
      }
    }
  }
  return null;
}

/**
 * 检测「引号台词重复」。
 *
 * v2.3.34：detectDuplicateSentence 按句末标点切句，但括号动作和台词混在
 * 同一个「句子」里，导致两句台词相同、前面的括号不同时比对失败：
 *   （我手往下压了压）"先聊两句呗，别急。"
 *   （我伸手轻轻拍开你伸过来的手）"先聊两句呗，别急。"   ← 台词一模一样
 *
 * 这里**先把所有括号内容整段删掉**，只留台词，再逐句比对。
 */
export function detectDialogDuplicate(text, opts = {}) {
  const minLen = opts.minLen || 5;
  const t = String(text || '');
  if (t.length < minLen * 3) return null;

  // 去掉括号里的动作描写（支持嵌套）
  let bare = '';
  {
    let depth = 0;
    for (let i = 0; i < t.length; i += 1) {
      const ch = t[i];
      if (ch === '（' || ch === '(') { depth += 1; continue; }
      if (ch === '）' || ch === ')') { depth = Math.max(0, depth - 1); continue; }
      if (depth === 0) bare += ch;
    }
  }
  // 按句末标点切成台词句，去掉引号和空白
  const parts = [];
  let start = 0;
  for (let i = 0; i < bare.length; i += 1) {
    if ('。！？!?\n'.includes(bare[i])) {
      const seg = bare.slice(start, i + 1);
      const key = seg.replace(/[“”"\s]/g, '').trim();
      if (key.length >= minLen) parts.push({ key, at: -1 });
      start = i + 1;
    }
  }
  if (parts.length < 2) return null;

  // 在原文里定位每个 key 的位置（按顺序找）
  let cursor = 0;
  for (const p of parts) {
    const idx = t.indexOf(p.key.slice(0, Math.min(8, p.key.length)), cursor);
    if (idx >= 0) { p.at = idx; cursor = idx + 1; }
  }

  const seen = new Map();
  for (const p of parts) {
    if (p.at < 0) continue;
    if (seen.has(p.key)) {
      return { at: p.at, text: p.key, kind: 'dialog-repeat' };
    }
    seen.set(p.key, p.at);
  }
  return null;
}
