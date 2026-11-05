#!/usr/bin/env node
// ============================================================================
//  星野 TUI（blessed 版）—— 鼠标点会话、滚轮翻记录的终端界面
//
//  和 chat-tui.mjs 的区别：
//    chat-tui.mjs  纯 readline，命令式（/s 换会话…），零依赖
//    这个版本       分栏界面 + 鼠标点击 + 滚轮，接近网页 GUI 的手感
//
//  启动：
//    npm i blessed           # 第一次要先装
//    node tools/chat-tui-ui.mjs
//    node tools/chat-tui-ui.mjs --session <id前缀>
//
//  按键：
//    Tab          切换焦点（会话列表 / 聊天区 / 输入框）
//    ↑↓           列表里选会话、聊天区滚动
//    Enter        输入框里发送；列表里选中会话
//    Ctrl+C       中断生成（再按一次退出）
//    F1           帮助
//
//  鼠标：
//    点左侧会话 → 切换
//    滚轮         → 聊天区上下滚
//    点输入框     → 聚焦
// ============================================================================
import blessed from 'blessed';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.WB_URL || 'http://127.0.0.1:5178';
const ENV_FILE = path.join(process.env.HOME || '', '.config/xingye-tunnel/env');

function readPassword() {
  if (process.env.WB_PASSWORD) return process.env.WB_PASSWORD;
  try {
    const m = fs.readFileSync(ENV_FILE, 'utf8').match(/^WORKBENCH_PASSWORD=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* 免密 */ }
  return '';
}
const PASSWORD = readPassword();

// ---------- HTTP ----------
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
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
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

// ---------- 界面 ----------
const screen = blessed.screen({
  smartCSR: true,
  title: '星野 TUI',
  mouse: true,
  fullUnicode: true,
  dockBorders: true,
});

const LEFT_W = '28%';

const sessList = blessed.list({
  parent: screen,
  label: ' 会话 ',
  top: 0, left: 0,
  width: LEFT_W, height: '100%-4',
  border: { type: 'line' },
  style: {
    border: { fg: '#5a7' },
    label: { fg: '#9be3b0', bold: true },
    selected: { bg: '#2a4a3a', fg: 'white', bold: true },
    item: { fg: '#c8d0c8' },
  },
  keys: true, vi: true, mouse: true,
  scrollbar: { ch: '│', style: { bg: '#3a5' } },
  items: [],
});

const chat = blessed.log({
  parent: screen,
  label: ' 对话 ',
  top: 0, left: LEFT_W,
  width: `100%-${LEFT_W}`, height: '100%-4',
  border: { type: 'line' },
  style: {
    border: { fg: '#5a7' },
    label: { fg: '#9be3b0', bold: true },
  },
  scrollable: true, alwaysScroll: true,
  mouse: true,
  scrollbar: { ch: '│', style: { bg: '#3a5' } },
  tags: true,
  padding: { left: 1, right: 1 },
});

const status = blessed.box({
  parent: screen,
  bottom: 3, left: 0,
  width: '100%', height: 1,
  content: ' 就绪',
  style: { fg: '#7d9186' },
});

const input = blessed.textbox({
  parent: screen,
  label: ' 输入（Enter 发送 · Tab 切焦点 · Ctrl+C 中断） ',
  bottom: 0, left: 0,
  width: '100%', height: 3,
  border: { type: 'line' },
  style: {
    border: { fg: '#887' },
    label: { fg: '#cc9', bold: true },
    focus: { border: { fg: '#cba' } },
  },
  inputOnFocus: true,
  keys: true, mouse: true,
});

// ---------- 状态 ----------
let SESSIONS = [];
let S = null;
let CFG = {};
let STREAMING = false;
let ABORT = null;

function setStatus(t) { status.setContent(' ' + t); screen.render(); }

// 会话列表项：用图标区分「角色会话」和「直连会话」
//   直连 ↗   不注入角色卡，也不做后处理
//   角色 ●   走角色卡 + 规则
function shortTitle(s) {
  const direct = s.kind === 'direct';
  const icon = direct ? '\u2197' : '\u25cf';
  const t = (s.title || '无标题').replace(/\s+/g, ' ').slice(0, 18);
  return `${icon} ${t.padEnd(18)} ${String(s.messageCount || 0).padStart(3)}`;
}

// 隐藏空会话（0~1 条消息的壳）：默认隐藏，按 F2 临时显示全部
let SHOW_EMPTY = false;

async function loadSessions() {
  const all = (await api('/api/sessions')).sessions || [];
  SESSIONS = SHOW_EMPTY ? all : all.filter((s) => (s.messageCount || 0) > 1);
  sessList.setItems(SESSIONS.slice(0, 200).map(shortTitle));
  const i = S ? SESSIONS.findIndex((x) => x.id === S.id) : 0;
  sessList.select(Math.max(0, i));
  const hidden = all.length - SESSIONS.length;
  setStatus(`${CFG.model || '?'} · ${SESSIONS.length} 个会话${hidden > 0 ? `（隐藏 ${hidden} 个空会话，F2 显示）` : ''}`);
  screen.render();
}

// 清空聊天区并重画。
// ⚠ 不能只用 chat.setContent('')：blessed 的 log 组件有内部行缓冲（_clines），
//   清 content 之后接着 log() 出来的行不会立即显示（实测表现就是「点会话没反应」）。
//   正确做法是把整个 child 清掉再 log。
function clearChat() {
  try {
    chat.setContent('');
    if (typeof chat.setScroll === 'function') chat.setScroll(0);
    // blessed log 的内部行缓存也要清，否则 pushLine 会往旧缓冲里加
    if (chat._clines) {
      chat._clines.fake = [];
      chat._clines.real = [];
    }
  } catch { /* 老版本没有这些字段就跳过 */ }
}

async function openSession(s) {
  S = { ...s };
  let session;
  try {
    session = (await api(`/api/sessions/${s.id}`)).session;
  } catch (e) {
    setStatus('读会话失败：' + e.message);
    return;
  }
  if (!session) { setStatus('会话不存在'); return; }

  const direct = session.kind === 'direct';
  S.direct = direct;
  S.title = session.title || s.title;
  try {
    const chars = (await api('/api/characters')).characters || [];
    const ch = chars.find((c) => c.id === session.characterId);
    S.characterName = ch?.name || '';
    S.characterId = ch?.id || '';
  } catch { S.characterName = ''; }

  const label = direct ? ' 对话 · 直连（无角色卡） ' : ` 对话 · 角色：${S.characterName || '?'} `;
  chat.setLabel(label);
  clearChat();

  const msgs = (session.messages || []).slice(-40);
  if (!msgs.length) {
    chat.log('{gray-fg}（这个会话还没有消息，在下面输入框里说话）{/gray-fg}');
  } else {
    for (const m of msgs) renderOne(m);
  }

  const think = CFG.thinkOff ? '思考关' : '思考开';
  const mode = direct ? '直连' : `角色 ${S.characterName || '?'}`;
  setStatus(`${CFG.model || '?'} · ${think} · ${mode} · ${S.title || ''} · ${msgs.length} 条`);
  chat.setScrollPerc?.(100);
  screen.render();
}

// 一条消息怎么显示：直连的自己叫「你」，对方叫「模型」；角色模式的叫角色名
function renderOne(m) {
  const me = m.role === 'user';
  let who;
  if (me) who = '{green-fg}你{/green-fg}';
  else if (S?.direct) who = '{cyan-fg}模型{/cyan-fg}';
  else who = `{yellow-fg}${S?.characterName || '角色'}{/yellow-fg}`;
  chat.log(`${who}: ${String(m.content || '').replace(/\n/g, '\n     ')}`);
}

// ---------- 流式聊天 ----------
async function send(text) {
  if (!S) { setStatus('先选个会话'); return; }
  if (STREAMING) { setStatus('正在生成，Ctrl+C 中断'); return; }
  STREAMING = true;
  ABORT = new AbortController();

  chat.log(`{green-fg}你{/green-fg}: ${text}`);
  // 直连会话走 /api/direct/chat（不注入角色卡）；角色会话走 /api/chat
  const endpoint = S.direct ? '/api/direct/chat' : '/api/chat';
  const prefix = S.direct
    ? '{cyan-fg}模型{/cyan-fg}: '
    : `{yellow-fg}${S.characterName || '角色'}{/yellow-fg}: `;
  let acc = '';
  setStatus('生成中…');

  try {
    const res = await fetch(BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
      body: JSON.stringify({ sessionId: S.id, content: text }),
      signal: ABORT.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let lastDraw = 0;
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
        if (d.text !== undefined) acc += d.text;
        else if (d.replace?.text !== undefined) acc = d.replace.text;
        else if (d.error) { chat.log(`{red-fg}✗ ${d.error}{/red-fg}`); }
      }
      // 节流重绘：每 120ms 刷一次，别每来一个字就重画
      const now = Date.now();
      if (now - lastDraw > 120) {
        lastDraw = now;
        redrawStream(prefix, acc);
      }
    }
    redrawStream(prefix, acc);
  } catch (e) {
    if (e.name === 'AbortError') chat.log('{gray-fg}[已中断]{/gray-fg}');
    else chat.log(`{red-fg}✗ ${e.message}{/red-fg}`);
  } finally {
    STREAMING = false;
    ABORT = null;
    setStatus(`${CFG.model || '?'} · 就绪`);
    input.focus();
    screen.render();
  }
}

// 流式重绘：把「角色: 正在写的内容」作为最后一段，每次覆盖
let streamBox = null;
function redrawStream(prefix, text) {
  if (!streamBox) {
    streamBox = blessed.box({
      parent: chat,
      width: '100%-2',
      tags: true,
      style: { fg: '#dfe6e1' },
    });
  }
  streamBox.setContent(`${prefix}${text}`);
  chat.scrollTo(chat.getScrollHeight());
  screen.render();
}

// ---------- 焦点切换 ----------
function cycleFocus() {
  const cur = screen.focused;
  if (cur === input) { sessList.focus(); setStatus('焦点：会话列表（↑↓ 选，Enter 打开）'); }
  else if (cur === sessList) { chat.focus(); setStatus('焦点：聊天区（↑↓ 滚动）'); }
  else { input.focus(); setStatus('焦点：输入框'); }
  screen.render();
}

// ---------- 事件 ----------
sessList.on('select', async (item, idx) => {
  const s = SESSIONS[idx];
  if (!s) { setStatus(`选择无效：idx=${idx}，列表 ${SESSIONS.length} 个`); return; }
  try {
    await openSession(s);
    input.focus();
    screen.render();
  } catch (e) {
    setStatus('打开失败：' + e.message);
  }
});

// 鼠标点列表也走 select（blessed 默认点一次选中、点两次触发 select）
sessList.on('click', (_item, idx) => {
  const s = SESSIONS[idx];
  if (s && (!S || s.id !== S.id)) openSession(s).catch((e) => setStatus(e.message));
});

input.on('submit', async (val) => {
  const t = String(val || '').trim();
  input.clearValue();
  if (!t) { input.focus(); screen.render(); return; }
  await send(t);
});

input.key(['escape'], () => { input.clearValue(); screen.render(); });
screen.key(['tab'], cycleFocus);
screen.key(['C-c'], () => {
  if (STREAMING && ABORT) { ABORT.abort(); return; }
  process.exit(0);
});
screen.key(['f1'], () => {
  chat.log('{gray-fg}Tab 切焦点 · 点会话切换 · 滚轮翻记录 · F2 显示/隐藏空会话 · Ctrl+C 中断/退出{/gray-fg}');
  screen.render();
});
// F2：临时把空会话（0~1 条消息的壳）也列出来
screen.key(['f2'], () => {
  SHOW_EMPTY = !SHOW_EMPTY;
  loadSessions().catch((e) => setStatus(e.message));
});

// ---------- 启动 ----------
async function main() {
  await login();
  CFG = await api('/api/config').catch(() => ({}));
  await loadSessions();

  const argv = process.argv.slice(2);
  let target = null;
  const key = argv.find((a) => !a.startsWith('-'));
  if (key) target = SESSIONS.find((s) => s.id === key || s.id.startsWith(key)) || null;
  if (!target) target = SESSIONS[0];
  if (target) await openSession(target);

  input.focus();
  screen.render();
  setStatus(`${CFG.model || '?'} · Tab 切焦点 · 鼠标点会话 · Ctrl+C 退出`);
}

main().catch((e) => {
  screen.destroy();
  console.error('启动失败：', e.message);
  process.exit(1);
});
