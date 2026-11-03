// 括号自动补全：输入左括号时，在光标右侧自动补上对应的右括号。
//
// 这里只放"纯逻辑"（给一个字符串 + 光标位置，算出新字符串和新光标），不碰 DOM，
// 所以 node smoke.js 可以直接 import 进来测，浏览器侧只负责把结果写回 textarea。

// 左 → 右。中文括号是这个 App 里写「环境描写」用的，英文括号顺手一起支持。
export const PAIRS = {
  '（': '）',
  '【': '】',
  '「': '」',
  '《': '》',
  '〔': '〕',
  '｛': '｝',
  '(': ')',
  '[': ']',
  '{': '}',
};

const CLOSERS = new Set(Object.values(PAIRS));

/**
 * 用户刚在光标左侧插入了 data（一个字符），算出需要改写成的结果。
 *
 * @param {string} value  插入之后的完整文本
 * @param {number} cursor 插入之后的光标位置（selectionStart）
 * @param {string} data   这次插入的字符（输入法提交时是提交的整串）
 * @returns {{value: string, cursor: number} | null} 不需要改动时返回 null
 */
export function applyAutoPair(value, cursor, data) {
  if (typeof value !== 'string' || typeof cursor !== 'number') return null;
  if (typeof data !== 'string' || data.length !== 1) return null;

  // 1) 敲的是左括号 → 右侧补一个右括号，光标留在中间
  const close = PAIRS[data];
  if (close) {
    if (value[cursor - 1] !== data) return null; // 左边不是刚敲的那个括号，别自作主张
    if (value[cursor] === close) return null; // 光标右边已经是配对的右括号了（在括号里打字），不重复补
    return { value: value.slice(0, cursor) + close + value.slice(cursor), cursor };
  }

  // 2) 敲的是右括号，而右边正好跟着同一个右括号 → 用户其实是想"跳过"它，不要把括号越打越多
  if (CLOSERS.has(data) && value[cursor - 1] === data && value[cursor] === data) {
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor };
  }

  return null;
}

/**
 * Backspace：光标正好夹在一对空括号中间、且没有选中内容时，一次删掉整对。
 *
 * @returns {{value: string, cursor: number} | null} 不需要特殊处理时返回 null
 */
export function applyBackspacePair(value, start, end) {
  if (typeof value !== 'string') return null;
  if (start !== end) return null; // 有选中内容时按普通删除处理
  const left = value[start - 1];
  const right = value[start];
  if (!left || !right) return null;
  if (PAIRS[left] !== right) return null;
  return { value: value.slice(0, start - 1) + value.slice(start + 1), cursor: start - 1 };
}
