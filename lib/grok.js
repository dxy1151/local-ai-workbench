/**
 * Grok CLI 适配器（v2.3.32）
 *
 * 用本地已登录的 `grok` CLI 替代 Ollama 做推理。
 * 实测：grok -p "prompt" --output-format streaming-json
 *   输出 NDJSON：
 *     {"type":"thought","data":"..."}  思考
 *     {"type":"text","data":"..."}     正文分片
 *     {"type":"usage","usage":{...}}
 *     {"type":"end","stopReason":"end_turn",...}
 */
import { spawn } from 'node:child_process';

/** 把 OpenAI 风格的 messages 拼成一个 prompt。 */
export function buildGrokPrompt(messages) {
  const parts = [];
  let sys = '';
  const turns = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    const role = String(m?.role || '');
    const c = String(m?.content || '').trim();
    if (!c) continue;
    if (role === 'system') { sys += (sys ? '\n\n' : '') + c; continue; }
    turns.push({ role, content: c });
  }
  if (sys) parts.push(sys);
  if (turns.length) {
    parts.push('\n【对话】');
    for (const t of turns) {
      if (t.role === 'user') parts.push(`用户：${t.content}`);
      else if (t.role === 'assistant') parts.push(`角色：${t.content}`);
    }
    parts.push('\n现在直接写「角色」这一轮的回复。不要任何前缀、不要解释、不要写「角色：」：');
  }
  return parts.join('\n');
}

/**
 * 流式调用 grok CLI。
 * @returns {Promise<{text:string, usage:object|null, sessionId:string|null}>}
 */
export async function streamChatGrok({ messages, onDelta, onUsage, signal, cwd = '/tmp' }) {
  const prompt = buildGrokPrompt(messages);
  if (!prompt.trim()) throw new Error('grok: 空 prompt');

  const args = ['-p', prompt, '--output-format', 'streaming-json', '--always-approve'];
  const child = spawn('grok', args, {
    cwd,
    env: {
      ...process.env,
      // grok CLI 走代理才能连上
      http_proxy: process.env.http_proxy || 'http://127.0.0.1:7897',
      https_proxy: process.env.https_proxy || 'http://127.0.0.1:7897',
      no_proxy: 'localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let full = '';
  let stderr = '';
  let usage = null;
  let sessionId = null;
  let buf = '';

  const handleLine = (line) => {
    const t = line.trim();
    if (!t) return;
    let obj;
    try { obj = JSON.parse(t); } catch { return; }
    if (obj.type === 'text' && typeof obj.data === 'string') {
      full += obj.data;
      if (onDelta) onDelta(obj.data);
    } else if (obj.type === 'usage' && obj.usage) {
      usage = obj.usage;
    } else if (obj.type === 'end') {
      if (obj.sessionId) sessionId = obj.sessionId;
      if (obj.usage) usage = obj.usage;
    }
  };

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

  const abort = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf);
      if (code !== 0 && !full) {
        reject(new Error(`grok 退出码 ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve();
      }
    });
  });

  if (onUsage && usage) {
    onUsage({
      input: usage.input_tokens,
      output: usage.output_tokens,
      reasoning: usage.reasoning_tokens || 0,
      cached: usage.cache_read_input_tokens || 0,
      total: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    });
  }
  return { text: full, usage, sessionId };
}
