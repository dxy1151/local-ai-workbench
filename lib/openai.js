// 调用 OpenAI Chat Completions，并把流式增量通过 onDelta 回调吐出来。
// 只用 Node 内置模块，不依赖 openai SDK、也不依赖 undici。
// 支持可选的 HTTP 代理（CONNECT 隧道），方便国内直连不通时走本地代理。

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export class OpenAIError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
  }
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
      createConnection: overSocket ? () => overSocket : undefined,
    };
    const lib = isHttps ? https : http;
    const req = lib.request(reqOptions, (res) => {
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
async function consumeSSE(stream, onDelta) {
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
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
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta?.(delta);
      }
    }
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

/* ---------- 对外接口 ---------- */

// 设置里的「额外请求参数」是段 JSON 文本，直接拼进请求体。
// 写错了就当没填（不能让一个手滑的括号把聊天整个搞挂）。
function parseExtraBody(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
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
export async function streamChat({ config, messages, onDelta, signal, prefill }) {
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
  const proxy = parseProxy(config.proxy);
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const pre = String(prefill || '');
  const payload = pre ? [...messages, { role: 'assistant', content: pre }] : messages;
  const extra = parseExtraBody(config.extraBody);
  // 本地 Ollama 的 keep-alive。
  // ⚠ 注意：Ollama 的 OpenAI 兼容端点**会忽略**这个字段（实测：发 '5m'，expires_at 纹丝不动），
  // 所以「不关闭」真正生效靠的是 server.js 里**每轮生成后用原生 /api/generate 重按一次**。
  // 这里仍然带上：无害，而且将来 Ollama 支持了就自动生效、换别的本地实现也可能认。
  const isLocalTarget = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(
    String(config.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, ''),
  );
  const keepAlive = isLocalTarget && config.keepAlive !== null && config.keepAlive !== undefined
    ? config.keepAlive
    : undefined;

  let res;
  try {
    res = await rawRequest({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        // 先铺开用户自定义的额外参数，核心字段放后面，确保不会被覆盖坏
        ...extra,
        // 用户自己指定了长度上限就听用户的，否则用默认上限兜住"复读停不下来"
        ...(extra.max_tokens || extra.num_predict ? {} : { max_tokens: MAX_OUTPUT_TOKENS }),
        model: config.model,
        messages: payload,
        temperature: config.temperature,
        stream: true,
        ...(keepAlive === undefined ? {} : { keep_alive: keepAlive }),
        // 「关掉思考」的另一种实现：R1 这类认 Ollama 官方的 think:false（见 lib/ollama.js 的 thinkControl）。
        // 只对本地端点加：云端接口不认这个字段，可能被拒。
        ...(isLocalTarget && config.think === false ? { think: false } : {}),
      }),
      proxy,
      signal,
    });
  } catch (err) {
    if (err instanceof OpenAIError) throw err;
    if (err.name === 'AbortError') throw err;
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
  const rawFull = await consumeSSE(res.stream, (delta) => joiner.push(delta));
  if (!rawFull) {
    // 用了前缀时可能只是"写完前缀就停"，交给上层换一种前缀重试；否则就是真没内容。
    if (pre) return '';
    throw new OpenAIError('模型没有返回任何内容，可能是模型名不正确或内容被拦截。', 502);
  }
  joiner.flush();
  return joiner.text;
}

export async function listModels(config) {
  const proxy = parseProxy(config.proxy);
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
