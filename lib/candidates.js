// 候选回答生成（「🎲 挑一个 / 预选回复 / 该我说什么」共用）
//
// 之前的实现是调 llm-chat/candidate_gen.py，里面**写死了 Ollama 的 11434 + config.model**。
// 这台机器现在聊天走的是 llama-server（http://127.0.0.1:18080/v1，gemma GGUF），
// Ollama 里并没有 gemma3-12b-heretic 这个名字 → 候选一定失败（"全部生成失败"）。
//
// 现在统一走应用自己的 OpenAI 兼容通道（lib/openai.js 的 streamChat）：baseUrl / apiKey /
// model / 代理 / 额外参数全部跟聊天一致，本地 llama-server、本机 Ollama、云端 API 都能用。
//
// 生成策略沿用 Python 版：第 i 个候选温度 = base + i*0.05，被长度截断就翻倍预算重抽（最多 3 次），
// 清掉模型漏出来的角色标记（"用户:" / "<|user|>" 之类）。

import { streamChat } from './openai.js';

const MAX_ATTEMPTS = 3;
const MIN_CHARS = 16;
// 单条候选的生成超时（12B 本地模型写 100~300 token 通常几秒；留足余量）
const PER_CANDIDATE_TIMEOUT_MS = 240_000;

const ROLE_LEAK = /<\|?\/?(?:user|assistant|system|model|start_of_turn|end_of_turn)\|?>|\b(?:user|assistant)\b/gi;

/** 清掉漏进正文的角色标记；砍完几乎不剩就整条作废。 */
export function cleanCandidateText(text) {
  const t = String(text || '');
  ROLE_LEAK.lastIndex = 0;
  const m = ROLE_LEAK.exec(t);
  if (!m) return t.trim();
  const head = t.slice(0, m.index).trim();
  return head.replace(/\s/g, '').length >= MIN_CHARS ? head : '';
}

/** 这条是不是被「长度上限」截断了（动作星号落单 / 括号没闭合 / 结尾悬空）。 */
export function looksTruncated(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const stars = (t.match(/\*/g) || []).length;
  if (stars % 2 === 1) return true;
  if ((t.match(/（/g) || []).length !== (t.match(/）/g) || []).length) return true;
  if ((t.match(/\(/g) || []).length !== (t.match(/\)/g) || []).length) return true;
  if (/[，,、—…]$/.test(t)) return true;
  if (/\*[^*\n]{0,2}$/.test(t)) return true;
  return false;
}

function mergeExtraBody(raw, overrides) {
  let base = {};
  try {
    const obj = raw ? JSON.parse(raw) : {};
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) base = obj;
  } catch { /* 用户填坏了就当空 */ }
  return JSON.stringify({ ...base, ...overrides });
}

/**
 * 生成 n 个候选回答。
 * @param {object}   opts
 * @param {object}   opts.config    getConfig() 的结果（baseUrl/model/apiKey/proxy/extraBody/think…）
 * @param {Array}    opts.messages  [{role, content}]，和真实聊天同一份上下文
 * @param {number}   [opts.n=4]
 * @param {number}   [opts.baseTemp=0.95] 第 0 个候选的温度（第 i 个 + i*0.05）
 * @param {number}   [opts.maxTokens=720] 单条候选的基础预算（截断时翻倍）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Array<{index:number,text:string,temp:number}>>}
 */
export async function generateCandidates({ config, messages, n = 4, baseTemp = 0.95, maxTokens = 720, signal }) {
  const out = [];
  let lastError = null;
  let attempts = 0;

  for (let i = 0; i < n; i++) {
    let best = '';
    let bestTemp = baseTemp;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      attempts += 1;
      // 越往后越热一点：要的是「4 个不同方向」，不是 4 句同样的说法
      const temp = Math.min(1.15, baseTemp + i * 0.05 + attempt * 0.05);
      const budget = maxTokens * 2 ** attempt;
      const cfg = {
        ...config,
        temperature: temp,
        // streamChat 会先铺开 extraBody；这里把 max_tokens 塞进去即可覆盖默认 2200
        extraBody: mergeExtraBody(config.extraBody, { max_tokens: budget, top_p: 0.95 }),
      };
      let text = '';
      try {
        const timeout = AbortSignal.timeout(PER_CANDIDATE_TIMEOUT_MS);
        const combo = signal ? AbortSignal.any([signal, timeout]) : timeout;
        text = await streamChat({ config: cfg, messages, onDelta: () => {}, signal: combo });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        lastError = err;
        // 网络/模型名错误重试也没用，直接抛给上层（界面能看到具体原因）
        if (err?.status) throw err;
        continue;
      }
      text = cleanCandidateText(text);
      if (!text) continue;
      best = text;
      bestTemp = temp;
      if (text.replace(/\s/g, '').length >= MIN_CHARS && !looksTruncated(text)) break;
      // 没截断但结构不完整（模型自己收尾了）→ 再抽一次；抽不出来就用最后一条
    }
    if (best) out.push({ index: i, text: best, temp: bestTemp });
  }

  if (!out.length) {
    const reason = lastError?.message || '模型没有返回内容';
    throw new Error(reason);
  }
  return out;
}
