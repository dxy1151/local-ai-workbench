// 「作弊指令」：在输入框里敲特定内容来触发一些非对话行为。
// 目前两个：
//   cheats=1        → 不当作你说的话，直接让角色接着往下演一句（"生成下一句"）
//   quit / exit / 退出 / 关闭 → 立刻关掉这个程序（顺手把显存里的模型卸掉）
//
// 都是**整条输入精确匹配**（去掉首尾空白、忽略大小写），不会误伤正常聊天内容。
// 纯字符串判断，放 public/ 下面是为了前端和冒烟测试都能 import。

const NEXT_RE = /^cheats\s*=\s*1$/i;
const QUIT_RE = /^(quit|exit|退出|关闭|关闭ai|退出ai|关掉)$/i;

/**
 * @param {string} text 输入框里的原文
 * @returns {'next'|'quit'|null} 'next' = 生成下一句；'quit' = 关闭程序
 */
export function parseCheat(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (NEXT_RE.test(t)) return 'next';
  if (QUIT_RE.test(t)) return 'quit';
  return null;
}

/** 给用户看的说明。 */
export function describeCheat(kind) {
  if (kind === 'next') return '生成下一句（cheats=1）';
  if (kind === 'quit') return '关闭本地AI对话工作台…';
  return '';
}
