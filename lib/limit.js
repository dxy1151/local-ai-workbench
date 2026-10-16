// 字数上限：超了就在**句子边界**截断，绝不切断半句。
//
// 为什么需要它：提示词里写"控制在 100 字以内"模型经常不当回事（实测照样写
// 300~1200 字）。真要落实只能靠代码裁。裁掉的部分会进「已否决」，
// 所以裁错了也能一键换回来。
//
// 纯字符串逻辑，不碰 DOM / 网络，node smoke.js 可直接测。

// 可以作为"一句话结束"的字符：句末标点、收尾的引号/括号、动作段收尾的星号
const BOUNDARY = /[。！？!?…”」』）\*]/;

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

  // 1) 先往**前**找最后一个句子边界
  let cut = -1;
  for (let i = Math.min(limit, t.length) - 1; i >= 0; i -= 1) {
    if (BOUNDARY.test(t[i])) { cut = i + 1; break; }
  }
  // 2) 截得太靠前（一句话都没说完）就往后找**下一个**句子边界，
  //    宁可稍微超一点，也不要留下半句话
  if (cut < minKeep) {
    for (let i = limit; i < t.length; i += 1) {
      if (BOUNDARY.test(t[i])) { cut = i + 1; break; }
    }
  }
  // 3) 实在找不到合适边界（比如整段没有标点）→ 宁可不裁
  if (cut < minKeep) return { text: t, trimmed: '' };

  return { text: t.slice(0, cut).trim(), trimmed: t.slice(cut).trim() };
}

/** 给用户看的提示。 */
export function describeTrim(kept, total) {
  return `超出字数上限，已在句号处截断（${total} → ${kept} 字）`;
}
