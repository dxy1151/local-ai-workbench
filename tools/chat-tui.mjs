#!/usr/bin/env node
// ============================================================================
//  工作台终端客户端（TUI）—— 不开浏览器，在终端里和角色聊天
//
//  为什么不用网页：平板/远程 SSH 时开浏览器太重，而且浏览器吃 CPU
//  （实测 Firefox 开着跑训练，每步从 22 秒拖到 32 秒）。
//
//  用法：
//    node tools/chat-tui.mjs                     # 进界面，选角色
//    node tools/chat-tui.mjs --session <id>      # 直接进某个会话
//    node tools/chat-tui.mjs --list              # 只列出会话
//
//  环境变量：
//    WB_URL       工作台地址（默认 http://127.0.0.1:5178）
//    WB_PASSWORD  访问口令（不填就从 ~/.config/xingye-tunnel/env 读）
//
//  按键：
//    Enter 发送 · /quit 退出 · /sessions 换会话 · /new 新会话 · /help 帮助
//    Ctrl+C 中断当前生成
// ============================================================================
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.WB_URL || 'http://127.0.0.1:5178';
const ENV_FILE = path.join(process.env.HOME || '', '.config/xingye-tunnel/env');

function readPassword() {
  if (process.env.WB_PASSWORD) return process.env.WB_PASSWORD;
  try {
    const txt = fs.readFileSync(ENV_FILE, 'utf8');
    const m = txt.match(/^WORKBENCH_PASSWORD=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* 没文件就空着 */ }
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
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) {
    const kv = c.split(';')[0];
    if (kv.startsWith('wb_auth=') || kv.includes('auth')) COOKIE = kv;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${res.status} ${t.slice(0, 120)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

async function login() {
  if (!PASSWORD) return;
  try {
    // 登录是表单 POST，成功会 302 + Set-Cookie
    const body = new URLSearchParams({ password: PASSWORD });
    const res = await fetch(BASE + '/', {
      method: 'POST',
      body,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) {
      const kv = c.split(';')[0];
      if (kv.includes('auth')) COOKIE = kv;
    }
  } catch { /* 本机免密时不需要 */ }
}

// ---------- 界面 ----------
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[36m${s}\x1b[0m`,
  user: (s) => `\x1b[32m${s}\x1b[0m`,
  role: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
};

let SESSION = null;      // { id, title, characterName }
let STREAMING = false;
let ABORT = null;

function out(s = '') { process.stdout.write(s + '\n'); }

function bar(text) {
  const w = process.stdout.columns || 80;
  const line = '─'.repeat(Math.max(0, w - text.length - 3));
  out(C.dim(`── ${text} ${line}`));
}

async function listSessions() {
  const { sessions } = await api('/api/sessions');
  return sessions || [];
}

async function pickSession() {
  const list = (await listSessions()).slice(0, 20);
  if (!list.length) { out(C.err('没有会话，先 /new 开一个')); return null; }
  out();
  bar('会话列表');
  list.forEach((s, i) => {
    const t = (s.title || '(无标题)').slice(0, 28);
    const n = s.messageCount || 0;
    out(`  ${C.bold(String(i + 1).padStart(2))}. ${t.padEnd(30)} ${C.dim(`${n} 条`)}`);
  });
  out();
  out(C.dim('  输入序号选择，回车取消'));
  return new Promise((resolve) => {
    rl.question('> ', (ans) => {
      const i = Number(ans) - 1;
      resolve(list[i] || null);
    });
  });
}

async function openSession(s) {
  SESSION = s;
  const { session } = await api(`/api/sessions/${s.id}`);
  out();
  bar(`${s.title || '会话'} · ${SESSION.characterName || ''}`);
  const msgs = (session.messages || []).slice(-10);
  for (const m of msgs) {
    const who = m.role === 'user' ? C.user('你') : C.role(SESSION.characterName || '角色');
    out(`${who}: ${String(m.content || '').replace(/\n/g, '\n     ')}`);
  }
  if (msgs.length) out();
}

async function streamChat(text) {
  STREAMING = true;
  ABORT = new AbortController();
  process.stdout.write(C.role(SESSION.characterName || '角色') + ': ');
  let acc = '';
  try {
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
      body: JSON.stringify({ sessionId: SESSION.id, content: text }),
      signal: ABORT.signal,
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        let d;
        try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (d.text !== undefined) { acc += d.text; process.stdout.write(d.text); }
        else if (d.replace?.text !== undefined) { acc = d.replace.text; process.stdout.write(d.replace.text.slice(acc.length)); }
        else if (d.error) { out(); out(C.err('✗ ' + d.error)); }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') out(C.dim('\n[已中断]'));
    else out(C.err('\n✗ ' + e.message));
  } finally {
    STREAMING = false;
    ABORT = null;
    out('\n');
  }
}

// ---------- 主循环 ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

const HELP = `
  直接输入就发消息。以 / 开头的是命令：
    /help        显示这个帮助
    /sessions    换一个会话
    /new         新建会话
    /list        列出所有会话
    /quit        退出
  Ctrl+C        中断正在生成的那条
`;

async function main() {
  await login();

  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    for (const s of await listSessions()) {
      out(`${s.id}  ${(s.title || '').slice(0, 30).padEnd(32)} ${s.messageCount || 0} 条`);
    }
    rl.close();
    return;
  }

  const si = argv.indexOf('--session');
  let target = null;
  if (si >= 0 && argv[si + 1]) {
    const all = await listSessions();
    target = all.find((s) => s.id === argv[si + 1]) || null;
  }
  if (!target) target = await pickSession();
  if (!target) { rl.close(); return; }

  // 拿角色名
  const cfg = await api('/api/config').catch(() => ({}));
  out(C.dim(`模型 ${cfg.model || '?'} · ${BASE}`));
  await openSession(target);
  out(C.dim('  输入 /help 看命令；直接打字就是发消息'));

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    if (STREAMING) { out(C.dim('（正在生成，先 Ctrl+C 中断）')); return; }

    if (text === '/quit' || text === '/exit') { rl.close(); return; }
    if (text === '/help') { out(HELP); return; }
    if (text === '/sessions') {
      const s = await pickSession().catch(() => null);
      if (s) await openSession(s).catch((e) => out(C.err(e.message)));
      return;
    }
    if (text === '/list') {
      for (const s of await listSessions()) {
        out(`${s.id}  ${(s.title || '').slice(0, 30).padEnd(32)} ${s.messageCount || 0} 条`);
      }
      return;
    }
    if (text === '/new') {
      out(C.dim('（新建会话请在网页里建，终端暂不支持选角色）'));
      return;
    }

    out(C.user('你') + ': ' + text);
    await streamChat(text);
  });

  rl.on('SIGINT', () => {
    if (STREAMING && ABORT) { ABORT.abort(); return; }
    rl.close();
  });
  rl.on('close', () => {
    out(C.dim('\n再见'));
    process.exit(0);
  });
}

main().catch((e) => {
  out(C.err('启动失败：' + e.message));
  process.exit(1);
});
