#!/usr/bin/env node
// ============================================================================
//  训练控制台（TUI）：显存余量 / 训练数据 / 实时日志，一个窗口看全
//
//  训练一开始（工作台队列 / 手动训练脚本）会自动弹一个 ptyxis 窗口跑它。
//  用法：
//    node tools/train-console.mjs                        # 自动找正在跑的训练
//    node tools/train-console.mjs --log <日志> --data <数据>
//    node tools/train-console.mjs --once                 # 只打印一屏（给脚本/测试）
//
//  按键：q 退出 · p 暂停/继续刷新 · l 切换日志行数 · r 立即刷新
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LLM_DIR = process.env.LLM_CHAT_DIR || '/home/don0ox1/deepseek/llm-chat';
const LOG_DIR = path.join(LLM_DIR, 'logs');

const argv = process.argv.slice(2);
const arg = (name, def = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const optLog = arg('--log');
const optData = arg('--data');
const once = argv.includes('--once') || !process.stdout.isTTY;
const INTERVAL = Math.max(1, Number(arg('--interval', '2')) || 2);

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const color = (c, s) => `${C[c] || ''}${s}${C.reset}`;
const fmt = (n, d = 1) => Number(n).toFixed(d);
const bar = (ratio, width) => {
  const n = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(n) + '░'.repeat(Math.max(0, width - n));
};
const hhmmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function sh(cmd, args = []) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000 });
    return String(r.stdout || '').trim();
  } catch {
    return '';
  }
}

/* ---------- GPU ---------- */
function gpuInfo() {
  const line = sh('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits']);
  if (!line) return null;
  const [name, total, used, free, util, temp] = line.split(',').map((x) => x.trim());
  const procs = sh('nvidia-smi', ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'])
    .split('\n').filter(Boolean).map((l) => {
      const [pid, pname, mb] = l.split(',').map((x) => x.trim());
      return { pid: Number(pid), short: path.basename(pname || ''), mb: Number(mb) || 0 };
    });
  return { name, totalMB: +total, usedMB: +used, freeMB: +free, util: +util, temp: +temp, procs };
}

/* ---------- 找训练进程 / 日志 ---------- */
function findTraining() {
  let found = null;
  for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    let raw = '';
    try { raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    const parts = raw.split('\0').filter(Boolean);
    if (!parts.length) continue;
    const idx = parts.findIndex((p) => /train_(qlora|dpo)\.py$/.test(p));
    if (idx < 0) continue;
    const get = (flag) => { const i = parts.indexOf(flag); return i >= 0 ? parts[i + 1] : ''; };
    found = {
      pid: Number(pid),
      script: path.basename(parts[idx]),
      phase: /dpo/.test(parts[idx]) ? 'DPO' : 'SFT',
      data: get('--data'),
      out: get('--out'),
      epochs: get('--epochs'),
      seqLen: get('--max-seq-len'),
      startedAt: (() => { try { return fs.statSync(`/proc/${pid}`).ctimeMs; } catch { return 0; } })(),
    };
    break;
  }
  return found;
}

function pickLog(training) {
  if (optLog && fs.existsSync(optLog)) return optLog;
  const candidates = [];
  const push = (dir, filter) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!filter(f)) continue;
        const p = path.join(dir, f);
        try { const st = fs.statSync(p); if (st.size > 0) candidates.push({ p, mt: st.mtimeMs }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  };
  // 正在跑的训练：优先它 stdout 指向的文件
  if (training) {
    try {
      const target = fs.readlinkSync(`/proc/${training.pid}/fd/1`);
      if (target.startsWith('/') && fs.existsSync(target)) return target;
    } catch { /* 管道输出就往下找 */ }
  }
  push(LOG_DIR, (f) => /\.log$/.test(f));
  push('/tmp', (f) => /train.*\.log$/i.test(f));
  candidates.sort((a, b) => b.mt - a.mt);
  // 优先最近 3 小时内写过的（避免打开一个几天前的旧日志）；没有就退回最新那个
  const recent = candidates.find((c) => Date.now() - c.mt < 3 * 3600 * 1000);
  return (recent || candidates[0])?.p || '';
}

function pickData(training) {
  if (optData && fs.existsSync(optData)) return optData;
  if (training?.data && fs.existsSync(training.data)) return training.data;
  return '';
}

/* ---------- 数据统计 ---------- */
const dataCache = new Map();
function dataStats(file) {
  if (!file) return null;
  const st = (() => { try { return fs.statSync(file); } catch { return null; } })();
  if (!st) return null;
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (dataCache.has(key)) return dataCache.get(key);
  let rows = 0, multi = 0, bytes = 0;
  const lens = [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    bytes = text.length;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      rows += 1;
      if (t.includes('多人扮演规则')) multi += 1;
      if (lens.length < 400) {
        try {
          const row = JSON.parse(t);
          for (const m of row.messages || []) {
            if (m.role === 'assistant' && typeof m.content === 'string') lens.push(m.content.length);
          }
        } catch { /* 坏行跳过 */ }
      }
    }
  } catch { return null; }
  lens.sort((a, b) => a - b);
  const stats = {
    file, rows, bytes,
    multiPct: rows ? Math.round((multi / rows) * 100) : 0,
    median: lens.length ? lens[Math.floor(lens.length / 2)] : 0,
    max: lens.length ? lens[lens.length - 1] : 0,
  };
  dataCache.clear();
  dataCache.set(key, stats);
  return stats;
}

/* ---------- 日志 ---------- */
function logStats(file) {
  if (!file) return null;
  let st = null;
  try { st = fs.statSync(file); } catch { return null; }
  const readBytes = Math.min(st.size, 512 * 1024);
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, st.size - readBytes);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let step = 0, loss = null, epoch = null, lr = null, tokens = null;
  for (const line of lines) {
    if (!line.includes("'loss'")) continue;
    step += 1;
    const m = line.match(/'loss':\s*'([\d.]+)'/);
    if (m) loss = m[1];
    const e = line.match(/'epoch':\s*'([\d.]+)'/);
    if (e) epoch = Number(e[1]);
    const l = line.match(/'learning_rate':\s*'([\d.e+-]+)'/);
    if (l) lr = l[1];
    const t = line.match(/'num_tokens':\s*'([\d.e+]+)'/);
    if (t) tokens = t[1];
  }
  const finished = /EXIT=|train_runtime|✅ LoRA 适配器已保存/.test(text);
  return { file, size: st.size, lines, step, loss, epoch, lr, tokens, finished, mtimeMs: st.mtimeMs };
}

/* ---------- 渲染 ---------- */
let paused = false;
let logLines = 22;

function render() {
  const width = Math.max(80, process.stdout.columns || 120);
  const g = gpuInfo();
  const training = findTraining();
  const logFile = pickLog(training);
  const dataFile = pickData(training);
  const ds = dataStats(dataFile);
  const lg = logStats(logFile);
  const out = [];
  const rule = '─'.repeat(width);
  const head = ` ${color('bold', '训练控制台')} ${color('dim', new Date().toLocaleTimeString('zh-CN', { hour12: false }))} `;
  out.push(color('cyan', '╭' + head + '─'.repeat(Math.max(0, width - 12 - 8))) + color('cyan', '╮'));

  // GPU
  if (g) {
    const freeGB = g.freeMB / 1024;
    const usedGB = g.usedMB / 1024;
    const totalGB = g.totalMB / 1024;
    const barW = 22;
    const memColor = freeGB < 1.5 ? 'red' : freeGB < 3 ? 'yellow' : 'green';
    const memLine = `${g.name.padEnd(14).slice(0, 14)} ${color(memColor, bar(g.usedMB / Math.max(1, g.totalMB), barW))} `
      + `${color(memColor, `${fmt(usedGB)}/${fmt(totalGB)} GB`)}  ${color('bold', `余量 ${fmt(freeGB)} GB`)}  `
      + `${g.util}% ${g.temp}°C`;
    out.push('│ ' + memLine);
    const procTxt = g.procs.length
      ? g.procs.map((p) => `${p.short}(${p.pid}) ${fmt(p.mb / 1024)}G`).join(' · ')
      : color('dim', '（显卡上没有显存占用）');
    out.push('│ ' + color('dim', '占用：') + procTxt);
    if (freeGB < 1.5) out.push('│ ' + color('red', `⚠ 显存余量只剩 ${fmt(freeGB)} GB —— 训练随时可能 OOM，先停掉别的占卡程序`));
  } else {
    out.push('│ ' + color('red', '读不到 nvidia-smi'));
  }

  // 训练
  if (training) {
    const epochs = Number(training.epochs) || 0;
    const ep = lg?.epoch ?? 0;
    const prog = epochs ? Math.min(1, ep / epochs) : 0;
    const stepTxt = lg ? `step ${lg.step}` : 'step ?';
    const lossTxt = lg?.loss ? `loss ${color('bold', lg.loss)}` : 'loss -';
    const lrTxt = lg?.lr ? `lr ${lg.lr}` : '';
    const elapsed = training.startedAt ? hhmmss(Date.now() - training.startedAt) : '';
    out.push('│ ' + `训练 ${color('green', '● 运行中')}  PID ${training.pid}  ${training.phase}  `
      + `epoch ${fmt(ep, 2)}/${epochs || '?'} ${color('cyan', bar(prog, 14))}  ${stepTxt}  ${lossTxt} ${lrTxt}  ${color('dim', elapsed)}`);
    out.push('│ ' + color('dim', `输出：${training.out || '?'}   seq ${training.seqLen || '?'}  数据 ${path.basename(training.data || '?')}`));
  } else if (lg?.finished) {
    out.push('│ ' + `训练 ${color('yellow', '● 已结束')}  日志：${path.basename(logFile)}`);
  } else {
    out.push('│ ' + color('dim', '训练：没在跑（没有找到 train_qlora.py 进程）'));
  }

  // 数据
  if (ds) {
    out.push('│ ' + `数据 ${color('bold', path.basename(ds.file))}  ${ds.rows} 行 · ${fmt(ds.bytes / 1048576, 1)} MB · `
      + `多人 ${ds.multiPct}% · 回复中位 ${ds.median} 字 / 最长 ${ds.max}`);
  } else {
    out.push('│ ' + color('dim', '数据：没找到训练集文件'));
  }

  // 日志
  if (lg) {
    const tail = lg.lines.slice(-logLines);
    out.push(color('cyan', '├' + '─'.repeat(width - 2)) + color('cyan', '┤'));
    out.push('│ ' + color('dim', `日志：${lg.file}  (${fmt(lg.size / 1048576, 2)} MB)${paused ? '  ⏸ 已暂停' : ''}  [q 退出 · p 暂停 · l 换行数]`));
    for (const line of tail) {
      const t = line.length > width - 6 ? line.slice(0, width - 9) + '…' : line;
      const isLoss = line.includes("'loss'");
      out.push('│ ' + (isLoss ? color('green', t) : t));
    }
  } else {
    out.push('│ ' + color('dim', '日志：还没找到训练日志'));
  }
  out.push(color('cyan', '╰' + '─'.repeat(width - 2)) + color('cyan', '╯'));

  if (once) {
    console.log(out.join('\n').replace(/\x1b\[[0-9;]*m/g, ''));
    return;
  }
  process.stdout.write('\x1b[H' + out.map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
}

/* ---------- 主循环 ---------- */
function cleanup() {
  if (!once) process.stdout.write('\x1b[?25h\x1b[?1049l');
}
if (!once) {
  process.stdout.write('\x1b[?1049h\x1b[?25l');   // 备用屏 + 隐藏光标
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (buf) => {
      const key = buf.toString();
      if (key === 'q' || key === '\x03') process.exit(0);
      else if (key === 'p') paused = !paused;
      else if (key === 'l') logLines = logLines === 22 ? 40 : logLines === 40 ? 8 : 22;
      else if (key === 'r') render();
    });
  } catch { /* 没 tty 就不处理按键 */ }
}
render();
if (!once) {
  setInterval(() => { if (!paused) render(); }, INTERVAL * 1000);
  setTimeout(() => render(), 300); // 首屏字体/尺寸就绪后再画一次
}
