// 字数上限：超了就在**句子边界**截断，绝不切断半句，也绝不切坏 *动作* 的星号。
//
// 为什么需要它：提示词里写"控制在 100 字以内"模型经常不当回事（实测照样写
// 300~1200 字）。真要落实只能靠代码裁。裁掉的部分会进「已否决」，
// 所以裁错了也能一键换回来。
//
// 纯字符串逻辑，不碰 DOM / 网络，node smoke.js 可直接测。

// 可以作为"一句话结束"的字符：句末标点、收尾的引号/括号
const BOUNDARY = /[。！？!?…”」』）]/;

/**
 * 这个位置能不能当截断点。
 * 星号单独判断：* 既是"动作段的收尾"也是"动作段的开头"，只有当它**是收尾**
 * （前面配对的星号数已为偶数）时才算边界。否则会把 `*我慢慢` 切成
 * `...*我慢慢*` —— 星号配了对，但动作是半句，看着就像被硬切了。
 */
function boundaryAt(t, i, starsBefore) {
  const ch = t[i];
  if (ch === '*') return starsBefore % 2 === 1;   // 前面的 * 是奇数 = 这个 * 在收尾
  return BOUNDARY.test(ch);
}

/** 统计 [0, end) 里有几个 *。 */
function countStars(t, end) {
  let n = 0;
  for (let i = 0; i < end; i += 1) if (t[i] === '*') n += 1;
  return n;
}

/**
 * @param {string} text
 * @param {number} max 字数上限（0 或负数 = 不限）
 * @returns {{text: string, trimmed: string}} trimmed 非空表示裁过
 */
export function trimToLimit(text, max) {
  const t = String(text || '').trim();
  const limit = Math.floor(Number(max) || 0);
  if (limit <= 0 || t.length <= limit) return { text: t, trimmed: '' };

  const minKeep = Math.max(20, Math.floor(limit * 0.4));
  const starsBeforeLimit = countStars(t, Math.min(limit, t.length));

  // 1) 先往**前**找最后一个句子边界
  let cut = -1;
  for (let i = Math.min(limit, t.length) - 1; i >= 0; i -= 1) {
    if (i === 0) break;
    if (boundaryAt(t, i, countStars(t, i))) { cut = i + 1; break; }
  }
  // 2) 截得太靠前（一句话都没说完）就往后找**下一个**句子边界，
  //    宁可稍微超一点，也不要留下半句话
  if (cut < minKeep) {
    for (let i = Math.min(limit, t.length); i < t.length; i += 1) {
      if (boundaryAt(t, i, countStars(t, i))) { cut = i + 1; break; }
    }
  }
  // 3) 实在找不到合适边界（比如整段没有标点）→ 宁可不裁
  if (cut < minKeep) return { text: t, trimmed: '' };

  let kept = t.slice(0, cut).trim();
  // 4) **先拆掉被切开的半截括号/引号**（v2.4.3）。
  //    原来只会"补一个收尾符号"，于是 `（她抬起头看你，眼里有点湿` 会变成
  //    `（她抬起头看你，眼里有点湿）` —— 动作本身是半句，看着像被硬切；
  //    更糟的是引号根本没处理过，`你来啦。“我等了你好久…` 这种**引号永远闭不上**。
  //    现在：找出末尾那个没配对的起符号，直接把**整段**去掉（动作/台词不完整就不留）。
  kept = dropDanglingOpen(kept);
  // 5) 星号必须成对：奇数个说明动作段被切开或没收尾 —— 补一个收尾星号。
  //    比"再往回退到上一个完整动作段"安全：退太多会把整条回复裁没。
  const stars = (kept.match(/\*/g) || []).length;
  if (stars % 2 === 1) kept = `${kept}*`;
  // 6) 括号/引号兜底（dropDanglingOpen 没覆盖到的嵌套情况）
  const open = (kept.match(/[（(]/g) || []).length;
  const close = (kept.match(/[）)]/g) || []).length;
  const openQ = (kept.match(/[“「『]/g) || []).length;
  const closeQ = (kept.match(/[”」』]/g) || []).length;
  // 引号不闭合：把最后一个“之后的内容删掉（台词没说完就整句不留）
  if (openQ > closeQ) {
    const at = kept.lastIndexOf('“');
    if (at > 0) kept = kept.slice(0, at).trim();
  }
  if (open > close) kept = `${kept}${kept.includes('(') && !kept.includes('（') ? ')' : '）'}`;

  const trimmed = t.slice(cut).trim();
  return { text: kept, trimmed };
}

/**
 * 去掉末尾**没配对的**开符号所在的整段（v2.4.3）。
 *
 * 场景：截断点落在 `（她抬起头看你，眼里有点湿` 或 `你来啦。“我等了好久` 这种位置。
 * 判据很朴素：哪个开符号的配对收符号没出现，就从它开始整段丢掉 ——
 * 宁可这一轮少一句动作/台词，也不要留一个视觉上明显坏掉的残片。
 * 丢掉后如果剩下的太短（< 12 字），就返回原文（让上层按"整条作废"处理更合理）。
 */
function dropDanglingOpen(s) {
  const PAIRS = [['（', '）'], ['(', ')'], ['“', '”'], ['「', '」'], ['『', '』']];
  for (const [open, close] of PAIRS) {
    let depth = 0;
    let lastOpenAt = -1;
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === open) { depth += 1; lastOpenAt = i; }
      else if (s[i] === close && depth > 0) depth -= 1;
    }
    if (depth > 0 && lastOpenAt >= 0) {
      const cutTo = s.slice(0, lastOpenAt).trim();
      if (cutTo.length >= 12) return cutTo;
    }
  }
  return s;
}

/** 给用户看的提示。 */
export function describeTrim(kept, total) {
  return `超出字数上限，已在句号处截断（${total} → ${kept} 字）`;
}
