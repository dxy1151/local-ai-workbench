// 发送 / 停止按钮的状态计算。
// 单独拎出来是因为这里踩过坑：生成中按钮文案变成「停止」，但同时被 disabled，
// 结果那个"暂停键"根本点不动。纯函数，node smoke.js 可以直接测。

/**
 * @param {{locked: boolean, streaming: boolean, hasText: boolean, hasSession: boolean}} s
 * @returns {{disabled: boolean, label: string, isStop: boolean}}
 */
export function sendButtonState({ locked, streaming, hasText, hasSession }) {
  if (locked) return { disabled: true, label: '已锁定', isStop: false };
  // 生成中必须可点：这时候它是「停止」
  if (streaming) return { disabled: false, label: '停止', isStop: true };
  return { disabled: !hasText || !hasSession, label: '发送', isStop: false };
}
