#!/usr/bin/env node
// ============================================================================
//  星野 TUI —— 终端里的完整工作台客户端
//
//  目标：接近网页 GUI 的体验，但不开浏览器
//  （实测 Firefox 开着跑训练，每步从 22 秒拖到 32 秒；关掉后训练快 45%）。
//
//  用法：
//    xn                          # 进界面，选会话
//    xn <会话id>                 # 直接进（可以只写前几位）
//    xn --list                   # 只列会话
//    xn --help                   # 命令列表
//
//  命令：
//    直接打字                      发送
//    /q  /quit                    退出
//    /s                           换会话
//    /c                           换角色
//    /n                           新会话
//    /h  /help                    帮助
//    /think                       切换思考开关
//    /model [名字]                看/换模型
//    /ctx                         看这一轮发出去的上下文
//    /hist [n]                    看最近 n 条历史
//    /branch                      额外生成 2 个走向，选一个替换
//    /presend <话>                先演 4 版再挑（不写进历史）
//    /suggest                     帮我起个头
//    /export                      导出这个会话为 Markdown
//    /clear                       清屏
//    Ctrl+C                       中断生成
// ============================================================================
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.WB_URL || 'http://127.0.0.1:5178';
const ENV_FILE = path.join(process.env.HOME || '', '.config/xingye-tunnel/env');

function readPassword() {
  if (process.env.WB_PASSWORD) return process.env.WB_PASSWORD;
  try {
    const m = fs.readFileSync(ENV_FILE, 'utf8').match(/^WORKBENCH_PASSWORD=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* 本机可能免密 */ }
  return '';
}
const PASSWORD = readPassword();
let COOKIE = '';

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(COOKIE ? { Cookie: COOKIE } : {}),
      ...(opts.headers || {}),
    },
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(';')[0];
    if (kv.includes('auth')) COOKIE = kv;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${res.status} ${t.slice(0, 150)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

async function login() {
  if (!PASSWORD) return;
  try {
    const res = await fetch(BASE + '/', {
      method: 'POST',
      body: new URLSearchParams({ password: PASSWORD }),
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const kv = c.split(';')[0];
      if (kv.includes('auth')) COOKIE = kv;
    }
  } catch { /* 免密 */ }
}

// ---------- 配色 ----------
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[36m${s}\x1b[0m`,
  u: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[33m${s}\x1b[0m`,
  e: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[35m${s}\x1b[0m`,
};
const out = (s = '') => process.stdout.write(s + '\n');
const W = () => process.stdout.columns || 80;
function bar(t) {
  const n = Math.max(4, W() - (t ? t.length + 4 : 0));
  out(C.dim('──' + (t ? ` ${t} ` : '') + '─'.repeat(n)));
}
function clear() { process.stdout.write('\x1b[2J\x1b[H'); }

let S = null;          // 当前会话
let CFG = {};
let STREAMING = false;
let ABORT = null;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function sessions() { return (await api('/api/sessions')).sessions || []; }
async function characters() { return (await api('/api/characters')).characters || []; }

async function pickFrom(list, label, render) {
  if (!list.length) { out(C.e('没有可选项')); return null; }
  out();
  bar(label);
  list.forEach((x, i) => out(`  ${C.b(String(i + 1).padStart(2))}. ${render(x)}`));
  out();
  const a = (await ask(C.dim('  序号（回车取消）> '))).trim();
  const i = Number(a) - 1;
  return Number.isInteger(i) && list[i] ? list[i] : null;
}

async function pickSession() {
  const list = (await sessions()).slice(0, 25);
  return pickFrom(list, '会话', (s) =>
    `${(s.title || '无标题').slice(0, 28).padEnd(30)} ${C.dim(`${String(s.messageCount || 0).padStart(3)} 条  ${s.id.slice(0, 10)}`)}`);
}

function renderMsg(m) {
  const who = m.role === 'user' ? C.u('你') : C.r(S?.characterName || '角色');
  out(`${who}: ${String(m.content || '').replace(/\n/g, '\n     ')}`);
}

function header() {
  const think = CFG.thinkOff ? C.y('思考关') : C.dim('思考开');
  out(C.dim(`  ${CFG.model || '?'} · ${think} · ${BASE}`));
  out(C.dim('  /h 帮助   /s 换会话   /c 换角色   /q 退出'));
  out();
}

async function openSession(s) {
  S = { ...s };
  const { session } = await api(`/api/sessions/${s.id}`);
  const chars = await characters();
  const ch = chars.find((c) => c.id === session.characterId);
  S.characterName = ch?.name || s.characterName || '';
  S.characterId = ch?.id || '';
  S.title = session.title || s.title;
  clear();
  bar(`${S.title || '会话'} · ${S.characterName}`);
  const msgs = (session.messages || []).slice(-12);
  for (const m of msgs) renderMsg(m);
  if (msgs.length) out();
  header();
}

// ---------- 流式聊天 ----------
async function streamChat(text, { quiet = false } = {}) {
  STREAMING = true;
  ABORT = new AbortController();
  let acc = '';
  if (!quiet) process.stdout.write(C.r(S?.characterName || '角色') + ': ');
  try {
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
      body: JSON.stringify({ sessionId: S.id, content: text }),
      signal: ABORT.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        let d; try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (d.text !== undefined) { acc += d.text; if (!quiet) process.stdout.write(d.text); }
        else if (d.replace?.text !== undefined) {
          const t = d.replace.text;
          if (!quiet) process.stdout.write(t.slice(acc.length));
          acc = t;
        } else if (d.error) { out(); out(C.e('✗ ' + d.error)); }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') out(C.dim('\n[已中断]'));
    else out(C.e('\n✗ ' + e.message));
  } finally {
    STREAMING = false; ABORT = null;
    out('\n');
  }
  return acc;
}

const HELP = `
  ${C.b('直接打字')} 就是发消息。以 / 开头是命令：

  ${C.b('会话')}
    /s            换会话        /n          新会话（用当前角色）
    /c            换角色        /hist [n]   看最近 n 条历史
    /clear        清屏

  ${C.b('模型')}
    /model [名]   看/换模型     /think      切换思考开关
    /ctx          看这一轮发出去的上下文

  ${C.b('生成')}
    /branch       额外生成 2 个走向，选一个替换上一条
    /presend 话   先演 4 版再挑（不写进历史）
    /suggest      帮我起个头

  ${C.b('其它')}
    /export       导出这个会话   /q   退出
`;

async function cmd(text) {
  const [c, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  switch (c) {
    case 'q': case 'quit': case 'exit': rl.close(); return;
    case 'h': case 'help': out(HELP); return;
    case 'clear': clear(); bar(S?.title || '会话'); header(); return;

    case 's': {
      const t = await pickSession();
      if (t) await openSession(t);
      return;
    }

    case 'c': {
      const chars = await characters();
      const ch = await pickFrom(chars, '角色', (x) =>
        `${x.name.padEnd(22)} ${C.dim((x.tagline || '').slice(0, 22))}`);
      if (ch) {
        S = { ...(S || {}), characterId: ch.id, characterName: ch.name };
        out(C.g(`已选「${ch.name}」—— 用 /n 开新会话`));
      }
      return;
    }

    case 'n': {
      if (!S?.characterId) { out(C.e('先用 /c 选个角色')); return; }
      const r = await api('/api/sessions', {
        method: 'POST', body: JSON.stringify({ characterId: S.characterId }),
      });
      const s = r.session || r;
      await openSession({ id: s.id, title: s.title });
      return;
    }

    case 'hist': {
      const n = Number(arg) || 10;
      const { session } = await api(`/api/sessions/${S.id}`);
      out();
      for (const m of (session.messages || []).slice(-n)) renderMsg(m);
      out();
      return;
    }

    case 'model': {
      if (!arg) {
        out(C.dim(`当前: ${CFG.model}`));
        const r = await api('/api/models').catch(() => null);
        const list = r ? (r.models || r) : [];
        for (const m of (Array.isArray(list) ? list : []).slice(0, 40)) {
          out('  ' + (typeof m === 'string' ? m : m.id || m.name || ''));
        }
        out(C.dim('  用 /model <名字> 切换'));
        return;
      }
      await api('/api/config', { method: 'PUT', body: JSON.stringify({ model: arg }) });
      CFG = await api('/api/config');
      out(C.g(`模型已切到 ${arg}`));
      return;
    }

    case 'think': {
      const next = CFG.thinkOff !== true;
      await api('/api/config', { method: 'PUT', body: JSON.stringify({ thinkOff: next }) });
      CFG = await api('/api/config');
      out(C.g(`思考已${next ? '关' : '开'}（${CFG.thinkControl || '按模型自动'}）`));
      return;
    }

    case 'ctx': {
      const d = await api(`/api/context?sessionId=${S.id}`);
      out();
      bar('这一轮发出去的 system');
      out(d.system || '(空)');
      out();
      bar(`历史 ${(d.history || []).length} 条`);
      for (const m of (d.history || []).slice(-6)) renderMsg(m);
      out();
      out(C.dim('统计: ' + JSON.stringify(d.stats || {})));
      return;
    }

    case 'branch': {
      out(C.dim('生成 2 个别的走向…'));
      const { session } = await api(`/api/sessions/${S.id}`);
      const msgs = session.messages || [];
      let idx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant' && String(msgs[i].content || '').trim()) { idx = i; break; }
      }
      if (idx < 0) { out(C.e('还没有角色回复可以替换')); return; }
      const r = await api('/api/gold/generate', {
        method: 'POST', body: JSON.stringify({ sessionId: S.id, n: 2, endIndex: idx }),
      });
      const orig = String(msgs[idx].content || '').trim();
      const seen = new Set([orig]);
      const cands = [];
      for (const x of r.candidates || []) {
        const t = String(x.text || '').trim();
        if (!t || seen.has(t)) continue;
        seen.add(t); cands.push(t);
        if (cands.length >= 2) break;
      }
      if (!cands.length) { out(C.e('两个都和原来一样，再试一次')); return; }
      out();
      cands.forEach((t, i) => { bar(`分支 ${i + 1}`); out(t); });
      out();
      const p = (await ask(C.dim('  用第几个？（回车不用）> '))).trim();
      const pi = Number(p) - 1;
      if (cands[pi]) {
        await api(`/api/sessions/${S.id}`, {
          method: 'PATCH', body: JSON.stringify({ action: 'edit', index: idx, content: cands[pi] }),
        });
        out(C.g('已替换'));
      }
      return;
    }

    case 'presend': {
      if (!arg) { out(C.e('用法: /presend 你想说的话')); return; }
      out(C.dim('演 4 版…'));
      const r = await api('/api/chat/presend', {
        method: 'POST', body: JSON.stringify({ sessionId: S.id, content: arg, n: 4 }),
      });
      const cs = r.candidates || [];
      if (!cs.length) { out(C.e('没生成出来')); return; }
      out();
      cs.forEach((x, i) => { bar(`版本 ${i + 1}`); out(String(x.text || '').trim()); });
      out();
      const p = (await ask(C.dim('  选一个发出去？（回车不发）> '))).trim();
      const pi = Number(p) - 1;
      if (cs[pi]) {
        out(C.u('你') + ': ' + arg);
        await api('/api/chat', {
          method: 'POST',
          body: JSON.stringify({ sessionId: S.id, content: arg, pinnedReply: String(cs[pi].text || '').trim() }),
        });
        out(C.g('已发出'));
      }
      return;
    }

    case 'suggest': {
      let r;
      try {
        r = await api(`/api/chat/suggest?sessionId=${S.id}`);
      } catch {
        r = await api('/api/chat/suggest', { method: 'POST', body: JSON.stringify({ sessionId: S.id }) });
      }
      out();
      bar('可以这么开头');
      const list = r.suggestions || r.items || (Array.isArray(r) ? r : []);
      for (const x of list) out('  · ' + (typeof x === 'string' ? x : x.text || ''));
      out();
      return;
    }

    case 'export': {
      const { session } = await api(`/api/sessions/${S.id}`);
      const file = path.join(process.env.HOME || '.', `会话-${S.id.slice(0, 8)}.md`);
      const lines = [`# ${session.title || '会话'}`, '', `角色：${S.characterName}`, ''];
      for (const m of session.messages || []) {
        lines.push(`**${m.role === 'user' ? '我' : S.characterName}**：${m.content}`, '');
      }
      fs.writeFileSync(file, lines.join('\n'));
      out(C.g('已导出: ' + file));
      return;
    }

    default:
      out(C.e(`未知命令 /${c}，用 /h 看帮助`));
  }
}

async function main() {
  await login();
  CFG = await api('/api/config').catch(() => ({}));

  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    for (const s of await sessions()) {
      out(`${s.id}  ${(s.title || '').slice(0, 28).padEnd(30)} ${s.messageCount || 0} 条`);
    }
    rl.close(); return;
  }
  if (argv.includes('--help')) { out(HELP); rl.close(); return; }

  let target = null;
  if (argv[0] && !argv[0].startsWith('-')) {
    target = (await sessions()).find((s) => s.id === argv[0] || s.id.startsWith(argv[0])) || null;
    if (!target) { out(C.e(`找不到会话 ${argv[0]}`)); rl.close(); return; }
  }
  if (!target) target = await pickSession();
  if (!target) { rl.close(); return; }
  await openSession(target);

  rl.on('line', async (line) => {
    const t = line.trim();
    if (!t) return;
    if (STREAMING) { out(C.dim('（正在生成，Ctrl+C 中断）')); return; }
    try {
      if (t.startsWith('/')) { await cmd(t); return; }
      out(C.u('你') + ': ' + t);
      await streamChat(t);
    } catch (e) {
      out(C.e('✗ ' + e.message));
    }
  });
  rl.on('SIGINT', () => {
    if (STREAMING && ABORT) { ABORT.abort(); return; }
    rl.close();
  });
  rl.on('close', () => { out(C.dim('\n再见')); process.exit(0); });
}

main().catch((e) => { out(C.e('启动失败：' + e.message)); process.exit(1); });
