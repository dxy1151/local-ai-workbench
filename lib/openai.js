// 调用 OpenAI Chat Completions，并把流式增量通过 onDelta 回调吐出来。
// 只用 Node 内置模块，不依赖 openai SDK、也不依赖 undici。
// 支持可选的 HTTP 代理（CONNECT 隧道），方便国内直连不通时走本地代理。

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { streamChatNative, localOllamaBase, isOllamaBase } from './ollama.js';

export class OpenAIError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
  }
}

/* ---------- 模型别名 ---------- */
// 云端模型真实 id 和用户习惯叫法不一样时在这里映射（v1.4.1）。
// 例：DeepSeek 的 V4 Flash，/v1/models 里的 id 是 `deepseek-flash`
//（展示名 DeepSeek-V4.1-Flash），但习惯叫 `deepseek-v4-flash`。
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4-flash-latest': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
};

/** 把用户填的模型名换成接口认的真实 id；不是别名就原样返回。 */
export function resolveModelId(model) {
  const m = String(model || '').trim();
  if (!m) return m;
  return MODEL_ALIASES[m.toLowerCase()] || m;
}

/** 可选的云端模型别名列表（给设置页的模型下拉用）。 */
export function cloudModelAliases(baseUrl = '') {
  if (!/deepseek/i.test(String(baseUrl))) return [];
  return ['deepseek-v4-flash', 'deepseek-v4-pro'];
}

/* ---------- 代理解析 ---------- */

// 支持这些写法：127.0.0.1:7897 / http://127.0.0.1:7897 / http://user:pass@127.0.0.1:7897
export function parseProxy(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
  } catch {
    throw new OpenAIError(`代理地址格式不对：${s}（示例：127.0.0.1:7897）`, 400);
  }
  if (url.protocol !== 'http:') {
    throw new OpenAIError('只支持 HTTP 代理。Clash / V2rayN 的 mixed 或 http 端口即可，暂不支持纯 SOCKS5。', 400);
  }
  const proxy = {
    host: url.hostname,
    port: Number(url.port) || 80,
    auth: url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : '',
  };
  if (!proxy.host) throw new OpenAIError('代理地址缺少主机名。', 400);
  return proxy;
}

/* ---------- 底层请求（直连或走代理） ---------- */

// 通过 HTTP 代理建立到目标 https 主机的 CONNECT 隧道，返回一个 TLS socket。
// 导出给 lib/search.js 复用（联网搜索的必应请求走同一条代理路，别写第二份）。
export function connectTunnel(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    socket.setNoDelay(true);
    const onError = (e) => reject(e);
    socket.once('error', onError);

    socket.once('connect', () => {
      const headers = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        'Proxy-Connection: keep-alive',
      ];
      if (proxy.auth) headers.push(`Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}`);
      socket.write(headers.join('\r\n') + '\r\n\r\n');
    });

    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.removeListener('data', onData);
      const statusLine = buf.slice(0, idx).split('\r\n')[0] || '';
      if (!statusLine.includes(' 200')) {
        socket.destroy();
        return reject(new OpenAIError(`代理 CONNECT 失败：${statusLine || '无响应'}`, 502));
      }
      // 隧道打通后，把已建立好的 TCP 连接升级成 TLS 会话。
      const secure = tls.connect({ socket, servername: targetHost }, () => resolve(secure));
      secure.on('error', onError);
    };
    socket.on('data', onData);
  });
}

// 发出一次请求，返回 { status, headers, stream }，其中 stream 是可异步迭代的字节流。
function rawRequest({ url, method, headers, body, proxy, signal }) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const targetPort = u.port ? Number(u.port) : isHttps ? 443 : 80;

  const requestHeaders = { ...headers };
  if (body) requestHeaders['Content-Length'] = Buffer.byteLength(body);

  const build = (overSocket) => new Promise((resolve, reject) => {
    // 直连：让 http/https 自己建连接；走代理：把隧道 socket 交出去。
    const reqOptions = {
      method,
      hostname: u.hostname,
      port: targetPort,
      path: u.pathname + u.search,
      headers: requestHeaders,
      // ⚠ 不复用连接：node 默认开启 keep-alive，会从连接池里捡一条
      // llama-server 已经关掉的空闲连接 → 请求还没发出去就 ECONNRESET
      // （症状：accLen 0、偶发、并发时更容易撞）。agent:false = 每次新建、不保活。
      agent: false,
      createConnection: overSocket ? () => overSocket : undefined,
    };
    const lib = isHttps ? https : http;
    const req = lib.request(reqOptions, (res) => {
      // 响应流也要挂 error：llama-server 在流末**直接关连接**（不发 [DONE]，
      // 也不按 chunked 正常收尾），node 会在 res 上抛 ECONNRESET。
      // 不接住它就会冒成未捕获错误，被上层变成「连接 OpenAI 失败」——
      // 表现就是「回复已经显示出来了，同时弹一个网络错误」（实测）。
      // 内容完整性由 consumeSSE 判断，这里只负责别让进程层面的错误炸出来。
      res.on('error', () => {});
      resolve({ status: res.statusCode || 0, headers: res.headers, stream: res });
    });
    req.once('error', reject);
    // socket 层也要挂一个 error 处理：中途 abort（用户点停止 / 复读截断 / 卡住超时）
    // 时 req.destroy(err) 的错误会冒到 socket 上 —— 没人接的话进程直接崩（实测崩过）。
    // 真正的错误仍然由上面的 req 'error' 走 reject，这里只是别让事件变成 unhandled。
    req.once('socket', (socket) => socket.on('error', () => {}));
    if (signal) {
      signal.addEventListener('abort', () => {
        // 中止要抛成 AbortError，否则会被上层当成"连接失败"报错，
        // 用户点「停止」就会看到一条假的网络错误（而且服务端会走错误分支而不是中止分支）。
        const e = new Error('aborted');
        e.name = 'AbortError';
        req.destroy(e);
      }, { once: true });
    }
    if (body) req.write(body);
    req.end();
  });

  if (proxy && isHttps) {
    // https 目标走 CONNECT 隧道。
    return connectTunnel(proxy, u.hostname, targetPort).then(
      (socket) => build(socket),
      (err) => Promise.reject(err),
    );
  }
  if (proxy && !isHttps) {
    // http 目标走代理：把绝对路径发给代理，让它代为转发。
    throw new OpenAIError('代理暂不支持 http:// 的接口地址，请把 Base URL 换成 https:// 开头。', 400);
  }
  return build(null);
}

// 把字节流切成 SSE 事件，逐段回调。
// llama-server 默认只有 1 个槽位（--parallel 1）：两个请求同时进来，
// 两个都会以 ECONNRESET 失败（实测复现）。而工作台会并发发请求 ——
// 比如聊天还没结束就点了「重新生成」、或者手写素材页同时在起草。
// 这里按 baseUrl 做一把串行锁：后到的排队等前一个结束，不增加显存也不改服务参数。
const backendLocks = new Map();
export function withBackendLock(key, fn) {
  const prev = backendLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);          // 前一个失败也要放行下一个
  backendLocks.set(key, next.then(() => {}, () => {}));
  return next;
}

async function consumeSSE(stream, onDelta, onReasoning, onUsage) {
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let reasoningAll = '';
  let streamErr = null;
  try {
  for await (const value of stream) {
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n');
    buffer = chunks.pop() ?? '';
    for (const line of chunks) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // 忽略心跳或半截数据
      }
      // 用量（v1.5.3）：OpenAI/DeepSeek 流式最后一包带 usage（需 stream_options.include_usage）
      if (json.usage) onUsage?.(json.usage);
      const d = json.choices?.[0]?.delta || {};
      // DeepSeek / R1 这类思考型云端模型：思考过程在 delta.reasoning_content
      //（OpenAI 新格式叫 delta.reasoning，也兼容一下）
      const think = typeof d.reasoning_content === 'string' ? d.reasoning_content
        : (typeof d.reasoning === 'string' ? d.reasoning : '');
      if (think) { reasoningAll += think; onReasoning?.(think); }
      const delta = d.content;
      if (delta) {
        full += delta;
        onDelta?.(delta);
      }
    }
  }
  } catch (err) {
    // llama-server 在流末直接关连接（不发 [DONE]、也不按 chunked 结尾），
    // undici 会抛 ECONNRESET。内容其实已经收全了，这种情况不能当失败 ——
    // 否则工作台会「回复已经显示出来、同时又弹一个连接错误」。
    const code = String(err?.code || err?.cause?.code || '');
    const gotSomething = full.trim().length > 0;
    if (!(gotSomething && /ECONNRESET|EPIPE|UND_ERR_SOCKET|terminated|other side closed/i.test(code + String(err?.message || '')))) {
      streamErr = err;
    }
  }
  if (streamErr) throw streamErr;
  // v2.2.2：content 全空但 reasoning 有内容 —— 内容被分流进了思考通道。
  // 宁可把这段当正文交出去，也不要返回空串让上层判"模型没产出内容"然后反复重抽。
  if (!full.trim() && reasoningAll.trim()) {
    const salvaged = reasoningAll.replace(/^\s+/, '');
    console.log(`[salvage] content 为空、思考通道有 ${salvaged.length} 字，当正文用`);
    onDelta?.(salvaged);
    return salvaged;
  }
  return full;
}

async function readText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/* ---------- 「动作开头」前缀（prefill） ---------- */

// 把最后一条 assistant 消息当续写前缀发给服务端（Ollama 的 OpenAI 兼容端点支持），
// 模型就必须从这个开头往下写，没有机会用「你来了就好 / 要不要先坐下」这类礼貌开场回避推进。
//
// 各家服务端行为不一致（Ollama 会把前缀一起回显，标准 prefill 只回续写部分），
// 所以这里只做一件事：**保证前缀在最终文本里不多不少出现一次**，让 *动作* 的星号始终配对。
// 注意不能把前缀"剥掉" —— 前缀本身就是 `*角色名`，剥掉会把动作块的左星号吃掉。
export function makePrefixJoiner(prefill, onDelta) {
  const pre = String(prefill || '');
  let held = '';
  let released = !pre;
  let full = '';
  const emit = (t) => {
    if (!t) return;
    full += t;
    onDelta?.(t);
  };
  return {
    push(delta) {
      if (released) return emit(delta);
      held += delta;
      if (pre.startsWith(held)) {
        if (held.length < pre.length) return; // 还在前缀内部，先扣住
        released = true; // 服务端正好回显完前缀
        const all = held;
        held = '';
        return emit(all);
      }
      if (held.startsWith(pre)) {
        released = true; // 服务端回显了前缀，并且已经往下写了
        const all = held;
        held = '';
        return emit(all);
      }
      // 服务端没有回显前缀（标准 prefill 只回续写部分）：自己把前缀补上再放行。
      released = true;
      const all = pre + held;
      held = '';
      emit(all);
    },
    flush() {
      if (held) {
        emit(held);
        held = '';
        return;
      }
      if (!released) {
        released = true;
        emit(pre); // 只收到半截前缀：完整前缀先补出来，交给上层判废稿
      }
    },
    get text() {
      return full;
    },
  };
}

// 输出上限（tokens）。Ollama 默认 num_predict = -1 是**不设上限**的，
// 小模型一旦退化复读就会一直吐到把上下文窗口塞满（能连续吐十几分钟）。
// 这里给一个天花板当兜底 —— 但要留足空间：实测中文 1 token ≈ 1 字，
// 把「描写幅度」调大 / 提示里要求"多写点"时，一条回复能到 1500 字以上，
// 上限太小会**从中间截断**（原来定 700，踩过这个坑）。真正的防复读靠
// lib/loopguard.js 实时截断，这个上限只是"万一都漏了"的保险。
// 想自己调：⚙ 设置 →「额外请求参数」里写 {"max_tokens": 3000}（会覆盖这个默认值）。
export const MAX_OUTPUT_TOKENS = 2200;

/**
 * 把 system 消息的内容拼到最后一条 user 消息里（v2.3.40）。
 *
 * 实测（控制变量实验，6 臂 × 3 塞法 × 432 次生成）：同一个模型，
 * 设定塞进 user 消息 → 最长复读 0；塞成 system 消息 → 整段复读一遍（复读长度 24.1）。
 * 小模型对 system 消息的处理很不稳定，当成「用户说的话」时续写分布更自然。详见 lora.md §3.22。
 *
 * @param {Array<{role:string,content:string}>} messages
 * @returns {Array} 新的消息数组（不改原数组）
 */
export function hoistSystemIntoUser(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const sysIdx = messages.findIndex((m) => m && m.role === 'system');
  if (sysIdx < 0) return messages;
  const sysText = String(messages[sysIdx].content || '').trim();
  if (!sysText) return messages;
  const rest = messages.filter((_, i2) => i2 !== sysIdx);
  let lastUser = -1;
  for (let i2 = rest.length - 1; i2 >= 0; i2 -= 1) {
    if (rest[i2]?.role === 'user') { lastUser = i2; break; }
  }
  if (lastUser < 0) return messages;  // 没有 user 可挂 → 原样返回，别把设定丢了
  rest[lastUser] = {
    ...rest[lastUser],
    content: `【设定】\n${sysText}\n\n【对话】\n${rest[lastUser].content}`,
  };
  return rest;
}

/* ---------- 对外接口 ---------- */

// 设置里的「额外请求参数」是段 JSON 文本，直接拼进请求体。
// 写错了就当没填（不能让一个手滑的括号把聊天整个搞挂）。
function parseExtraBody(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    // seed: -1 是 Ollama 的「随机」写法，但云端 API（DeepSeek 等）要求整数≥0，
    // 直接 422：`seed: invalid value: integer`。负值一律不当 seed 发。
    if (obj.seed !== undefined && !(Number.isInteger(obj.seed) && obj.seed >= 0)) delete obj.seed;
    return obj;
  } catch {
    return {};
  }
}

/**
 * @param {object} opts
 * @param {object} opts.config   getConfig() 的结果
 * @param {Array}  opts.messages OpenAI messages 数组
 * @param {(text: string) => void} opts.onDelta 每收到一段文本就调用
 * @param {string} [opts.prefill] 追加在末尾的 assistant 前缀（强制角色从动作开头续写）
 * @returns {Promise<string>} 完整回复（用了前缀时，前缀已补齐，*动作* 的星号保持配对）
 */
function isLocalBaseUrl(baseUrl) {
  try {
    const h = new URL(baseUrl).hostname.toLowerCase();
    return ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(h)
      || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  } catch {
    return /127\.0\.0\.1|localhost|11434|18080/.test(String(baseUrl || '').split('/').slice(0, 3).join('/'));
  }
}

export async function streamChat({ config, messages, onDelta, onReasoning, onUsage, signal, prefill }) {
  // v2.3.40：把 system 提示词塞进最后一条 user 消息（config.systemInUser）。
  //
  // 为什么：控制变量实验（/mnt/data4t/experiments，6 臂 × 3 塞法 × 432 次生成）实测，
  // 同一个模型「设定塞进 user 消息」比「塞成 system 消息」稳得多：
  //   M1 + U（塞 user）  → 最长复读 0    罚分 3.0
  //   M1 + S（塞 system）→ 最长复读 24.1 罚分 49.7   ← 差 16 倍，整段复读一遍
  // 小模型对 system 消息的处理很不稳定；当成「用户说的话」时续写分布更自然。
  // 另：训练时用哪种塞法，推理就该用哪种（M5 训练塞user + U 推理 = 最优）。
  if (config?.systemInUser === true) messages = hoistSystemIntoUser(messages);

  // v2.3.32：Grok CLI 后端（config.backend === 'grok'）
  // 用本地已登录的 grok CLI 做推理，不占显存、质量比 8B 本地模型高。
  // 实测 21.8s/次（本地 8B 5-10s），成本约 $0.018/次。
  if (String(config?.backend || '') === 'grok') {
    const { streamChatGrok } = await import('./grok.js');
    const r = await streamChatGrok({ messages, onDelta, onUsage, signal });
    return r.text;
  }

  // 本地接口（Ollama 等）不需要 Key —— 别因为 Key 空了就拒绝服务
  const localHost = (() => {
    try {
      const h = new URL(config.baseUrl).hostname.toLowerCase();
      return ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(h)
        || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
    } catch {
      return /127\.0\.0\.1|localhost|11434/.test(String(config.baseUrl || ''));
    }
  })();
  if (!config.apiKey && !localHost) {
    throw new OpenAIError('没有配置 API Key。请点击右上角「设置」填入。', 401);
  }
  // 本地 Ollama 且要关思考 → 走原生 /api/chat。
  // OpenAI 兼容层会把 think 字段丢掉（实测：/v1 + think:false 仍然思考 47 秒、正文全空）。
  // 必须探活：llama-server（gemma）也在 127.0.0.1，但它是 OpenAI 兼容接口，
  // 走原生 /api/chat 会 404。
  // v2.3.12：**本地 Ollama 一律走原生 /api/chat**，不再只在「关思考」时才走。
  // 原因：OpenAI 兼容层(/v1)会丢掉 think 字段、也不返回 thinking 通道 ——
  //   开了思考也拿不到思考内容，usage.reasoning 恒为 0。
  //   原生端点两个方向都支持：think:false 关、think:true（或不传）开。
  if (await isOllamaBase(config)) {
    const wantThink = typeof config.think === 'boolean' ? config.think : undefined;
    // 开思考时**加大输出预算**：实测 qwen3-8b-v7k 一进思考态，思考能吃 250~300 字，
    // 默认 2200 token 的预算会被吃掉大半，正文只剩几个字甚至为空。
    // 4000 给思考和正文都留出空间（本地推理，多几百 token 也就多几秒）。
    const np = wantThink === true ? 6000 : (wantThink === false ? 2200 : 4000);
    const out = await streamChatNative({
      config, messages, onDelta, onUsage, onReasoning, signal, numPredict: np,
      ...(wantThink === undefined ? {} : { think: wantThink }),
    });
    return out;
  }

  // 本地接口不走代理（代理是给云端配的；走代理会把 http://127.0.0.1 拒掉）
  const proxy = isLocalBaseUrl(config.baseUrl) ? null : parseProxy(config.proxy);
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const pre = String(prefill || '');
  let payload = pre ? [...messages, { role: 'assistant', content: pre }] : messages;
  // Gemma 的 jinja 模板强制 user/assistant 交替，连续同角色会直接抛
  // 「Conversation roles must alternate user/assistant/...」（llama-server 报 400）。
  // 我们的历史里确实会出现连续 user（用户连发、或 system 被当成一条 user），
  // 所以发给 gemma 之前把连续同角色合并成一条。
  const modelName = String(config.model || '');
  const needAlt = /gemma/i.test(modelName) || config.strictAlternation === true;
  if (needAlt) {
    // 实测 gemma 模板只接受这几种形状：
    //   S,U / S,U,A,U / U,A,U   → OK
    //   S,U,A,S,U（中间夹 system）/ S,U,U,A（连续 user） → 400
    // 所以先把所有 system 抽出来合并到最前面，再合并连续同角色。
    const sysParts = [];
    const rest = [];
    for (const m of payload) {
      if (m.role === 'system') {
        if (String(m.content || '').trim()) sysParts.push(String(m.content));
      } else {
        rest.push({ ...m });
      }
    }
    const merged = [];
    for (const m of rest) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === m.role) {
        prev.content = `${prev.content}\n${m.content}`;
      } else {
        merged.push({ ...m });
      }
    }
    // 开头不能是 assistant（gemma 要求第一句是 user 或 system）
    while (merged.length && merged[0].role === 'assistant') merged.shift();
    payload = sysParts.length
      ? [{ role: 'system', content: sysParts.join('\n\n') }, ...merged]
      : merged;
  }
  const extra = parseExtraBody(config.extraBody);
  // 本地 Ollama 的 keep-alive。
  // ⚠ 注意：Ollama 的 OpenAI 兼容端点**会忽略**这个字段（实测：发 '5m'，expires_at 纹丝不动），
  // 所以「不关闭」真正生效靠的是 server.js 里**每轮生成后用原生 /api/generate 重按一次**。
  // 这里仍然带上：无害，而且将来 Ollama 支持了就自动生效、换别的本地实现也可能认。
  // 只有确认对方是 Ollama 才发 keep_alive / think 这些 Ollama 私有字段。
  // llama-server（gemma）虽然是本机地址，但它不认这些字段，带上会导致连接被重置
  // （实测：回复已经流出来，随后 ECONNRESET）。
  const isOllama = await isOllamaBase(config);
  const isLocalTarget = isOllama;
  const keepAlive = isLocalTarget && config.keepAlive !== null && config.keepAlive !== undefined
    ? config.keepAlive
    : undefined;

  // 非 Ollama 的本地后端（llama-server）必须串行，见 withBackendLock 注释
  // 锁的 key 必须和别的调用方一致：手写素材的 /api/script/generate 用的是
  // 不带 /v1 的根地址。这里统一去掉 /v1 和末尾斜杠，否则两边各拿一把锁、
  // 照样并发互踢（实测：聊天 + 手写生成同时发，聊天那条 ECONNRESET）。
  const lockKey = isOllama ? '' : String(config.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  if (lockKey) {
    return withBackendLock(lockKey, () => doStreamChat());
  }
  return doStreamChat();

  async function doStreamChat() {
  let res;
  try {
    res = await rawRequest({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify((() => {
        const bodyObj = {
        // 先铺开用户自定义的额外参数，核心字段放后面，确保不会被覆盖坏
        ...extra,
        // 用户自己指定了长度上限就听用户的，否则用默认上限兜住"复读停不下来"
        ...(extra.max_tokens || extra.num_predict ? {} : { max_tokens: MAX_OUTPUT_TOKENS }),
        model: resolveModelId(config.model),
        messages: payload,
        temperature: config.temperature,
        stream: true,
        ...(keepAlive === undefined ? {} : { keep_alive: keepAlive }),
        // 「关掉思考」的另一种实现：R1 这类认 Ollama 官方的 think:false（见 lib/ollama.js 的 thinkControl）。
        // 只对本地端点加：云端接口不认这个字段，可能被拒。
        ...(isLocalTarget && config.think === false ? { think: false } : {}),
        // v2.3.18：DeepSeek v4 系列（v4-flash / v4-pro）**默认先思考再说话**，
        // 思考 token 吃光 max_tokens 后 content 就是空串 —— 用户看到的就是"不输出"。
        // 实测（max_tokens=20）：content=''、reasoning_content 有内容、finish_reason=length。
        // 官方开关是 thinking:{type:'disabled'}，实测关掉后 reasoning 为 0、正文正常。
        // 只在用户没在「额外请求参数」里自己写过 thinking 时才加，免得打架。
        ...(!isLocalTarget && extra.thinking === undefined
          && /deepseek[-_.]?v4/i.test(String(config.model || ''))
          ? { thinking: { type: 'disabled' } }
          : {}),
        // v1.9.2 上下文窗口：Ollama 的 OpenAI 兼容端点认 options.num_ctx（走 options 里传）。
        // 不传就用 Ollama 默认（实测 4096），长提示词（常驻知识 3000 字）会被直接砍掉。
        ...(isLocalTarget && Number(config.contextWindow) > 0
          ? { options: { ...(extra.options || {}), num_ctx: Number(config.contextWindow) } }
          : {}),
        // 推理强度（v1.5.1）：DeepSeek V4 这类模型认 reasoning_effort = none/low/high/max。
        // 只对云端加：llama-server 认不认未知字段不好说，带上可能 400。
        ...(!isLocalTarget && config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        // 流式响应默认不带 usage；云端接口加这个字段，最后一包会带 prompt/completion tokens。
        ...(!isLocalTarget ? { stream_options: { include_usage: true } } : {}),
        };
        return bodyObj;
      })()),
      proxy,
      signal,
    });
  } catch (err) {
    if (err instanceof OpenAIError) throw err;
    if (err.name === 'AbortError') throw err;
    // 我们主动 destroy 连接（用户点停止 / 复读截断 / 同一会话发了新消息）时，
    // node 有时抛的**不是** AbortError 而是 ECONNRESET —— 那就被当成「连接失败」
    // 报到界面上了（实测：同会话并发第一个请求报 ECONNRESET）。
    // 这里看 signal 是否已 abort：是的话就转成 AbortError，交给上层按「已中止」处理。
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    const reason = err.code ? `${err.code}` : err.message;
    throw new OpenAIError(`连接 OpenAI 失败：${reason}`, 502);
  }

  if (res.status < 200 || res.status >= 300) {
    const raw = await readText(res.stream).catch(() => '');
    let detail = raw.slice(0, 500);
    try {
      detail = JSON.parse(raw)?.error?.message || detail;
    } catch {
      /* 保持原始文本 */
    }
    throw new OpenAIError(`OpenAI 返回 ${res.status}：${detail}`, res.status);
  }

  const joiner = makePrefixJoiner(pre, onDelta);
  const rawFull = await consumeSSE(res.stream, (delta) => joiner.push(delta), (t) => onReasoning?.(t), (u) => onUsage?.(u));
  if (!rawFull) {
    // 用了前缀时可能只是"写完前缀就停"，交给上层换一种前缀重试；否则就是真没内容。
    if (pre) return '';
    throw new OpenAIError('模型没有返回任何内容，可能是模型名不正确或内容被拦截。', 502);
  }
  joiner.flush();
  return joiner.text;
  }   // ← doStreamChat 结束
}

export async function listModels(config) {
  const proxy = isLocalBaseUrl(config.baseUrl) ? null : parseProxy(config.proxy);
  const url = `${config.baseUrl.replace(/\/+$/, '')}/models`;
  const res = await rawRequest({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: null,
    proxy,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new OpenAIError(`获取模型列表失败：HTTP ${res.status}`, res.status);
  }
  const json = JSON.parse(await readText(res.stream));
  return (json.data || []).map((m) => m.id).sort();
}
