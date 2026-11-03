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
  // 4) 星号必须成对：奇数个说明动作段被切开或没收尾 —— 补一个收尾星号。
  //    比"再往回退到上一个完整动作段"安全：退太多会把整条回复裁没。
  const stars = (kept.match(/\*/g) || []).length;
  if (stars % 2 === 1) kept = `${kept}*`;
  // 5) 括号同理：留着没闭合的 （ 很难看
  const open = (kept.match(/[（(]/g) || []).length;
  const close = (kept.match(/[）)]/g) || []).length;
  if (open > close) kept = `${kept}${kept.includes('(') && !kept.includes('（') ? ')' : '）'}`;

  const trimmed = t.slice(cut).trim();
  return { text: kept, trimmed };
}

/** 给用户看的提示。 */
export function describeTrim(kept, total) {
  return `超出字数上限，已在句号处截断（${total} → ${kept} 字）`;
}
