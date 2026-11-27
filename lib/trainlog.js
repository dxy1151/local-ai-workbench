// ============================================================================
//  训练监控：直接解析 logs/*.log，不看进程状态
//
//  为什么要「解析日志」而不是「问进程」：
//    训练是用 setsid 单独起的，和 Web 服务没有父子关系；服务重启、人走开、
//    甚至换个终端启动，服务那边都不知道。日志文件是唯一可靠的事实来源。
//
//  解析什么：
//    · 当前 step / 总步数 / 每步耗时 / 预计剩余
//    · loss 曲线（grad_norm / lr / token 准确率）
//    · DPO 阶段（trainer.js 会另写 dpo-*.log，这里一起扫）
//    · 部署阶段（deploy-*.log）
// ============================================================================
import fs from 'node:fs/promises';
import path from 'node:path';

const LLM_DIR = process.env.LLM_CHAT_DIR || '/home/don0ox1/deepseek/llm-chat';
const LOG_DIR = path.join(LLM_DIR, 'logs');

/** 只读文件末尾 N 字节 —— 训练日志能到几 MB，全读没必要。 */
async function tailFile(file, maxBytes = 512 * 1024) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * 从 tqdm 进度行里抠 step/总数/耗时。
 * 行样子：` 50%|█████     | 15/30 [20:26<20:50, 83.38s/it]`
 * ⚠ 用 \r 分隔：tqdm 是在同一行上不断刷新的，直接按 \n 切只能拿到最后一条。
 */
function parseTqdm(text) {
  const lines = text.split(/\r?\n|\r/).filter(Boolean);
  let last = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/(\d+)\/(\d+)\s*\[([\d:]+)<([\d:]+),\s*([\d.]+)s?\/it\]/);
    if (m) {
      last = {
        step: Number(m[1]),
        total: Number(m[2]),
        elapsed: m[3],
        eta: m[4],
        secPerIt: Number(m[5]),
      };
      break;
    }
  }
  return last;
}

/** 把 hh:mm:ss 或 mm:ss 换成秒。 */
function hmsToSec(s) {
  const p = String(s || '').split(':').map(Number);
  if (p.some((x) => !Number.isFinite(x))) return 0;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
}

/**
 * 解析 loss 行。transformers 的 dict 是单引号、值可能是字符串：
 *   {'loss': '5.791', 'grad_norm': '7.688', 'learning_rate': '7.79e-05', ...}
 */
function parseLossLines(text) {
  const out = [];
  const re = /\{([^{}]*'loss'[^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const obj = {};
    const kv = /'([a-z_]+)':\s*'?([-\d.eE+]+)'?/g;
    let p;
    while ((p = kv.exec(m[1]))) obj[p[1]] = Number(p[2]);
    if (Number.isFinite(obj.loss)) out.push(obj);
  }
  return out;
}

/**
 * 从 loss 行推算进度和剩余时间。
 *
 * 为什么不用 tqdm：训练脚本已经 `disable_tqdm=True`（进度条用 \r 刷同一行，
 * 会把 loss 冲掉）。所以只能自己算：
 *   总步数   —— 从 `[xx:xx:xx] 总步数约 27（每轮 9 步）` 这行捞
 *   已完成   —— loss 行数（logging_steps=1，一步一条）
 *   每步耗时 —— 日志 mtime 减去第一行的时间戳，除以步数
 */
function parseTrainingEta(text, mtimeMs) {
  const totalM = text.match(/总步数约\s*(\d+)/);
  const total = totalM ? Number(totalM[1]) : 0;
  const done = (text.match(/\{'loss':/g) || []).length;
  const firstT = text.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
  let secPerIt = 0;
  let eta = 0;
  let elapsed = 0;
  let finishAt = 0;
  if (total > 0 && done > 0 && firstT) {
    const startSec = Number(firstT[1]) * 3600 + Number(firstT[2]) * 60 + Number(firstT[3]);
    const d = new Date(mtimeMs);
    const nowSec = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    elapsed = Math.max(0, nowSec - startSec);
    secPerIt = elapsed / done;
    eta = Math.max(0, Math.round((total - done) * secPerIt));
    finishAt = mtimeMs + eta * 1000;
  }
  return { total, done, secPerIt, elapsed, eta, finishAt };
}

/** 从日志里捞关键的「人类可读」事件行（[05:14:30] 开头的那种）。 */
function parseEvents(text, limit = 60) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.+)$/);
    if (m) out.push({ t: m[1], msg: m[2].trim() });
  }
  return out.slice(-limit);
}

/**
 * 真的有训练进程在跑吗？
 * 只看日志 mtime 不够：训练卡住 / 进程被挂起时文件也不更新。
 * 这里扫 /proc 找 train_qlora.py 或 train_dpo.py（排除自己）。
 */
async function trainingProcessAlive() {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('bash', ['-c',
      "for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null) || continue; " +
      "case \"$c\" in *train_qlora.py*|*train_dpo.py*) echo x; break;; esac; done"],
    { timeout: 4000 }, (err, stdout) => resolve(!err && String(stdout).trim() === 'x'));
  });
}

/** 判断一个日志是哪类训练。 */
function kindOf(name) {
  if (name.startsWith('auto-deploy-')) return 'deploy-watch';
  if (name.startsWith('dpo-')) return 'dpo';
  if (name.startsWith('deploy-')) return 'deploy';
  if (name.startsWith('train-')) return 'sft';
  // 一键脚本按模型命名（sft-8b.log / dpo-8b.log），也要认
  if (/^sft[-_.]/.test(name)) return 'sft';
  if (name.endsWith('sft-run.log')) return 'sft';
  return 'other';
}

/**
 * 列出所有训练相关日志，按修改时间倒序。
 * 返回每个任务的摘要：阶段、进度、loss 首末值、是否还在写。
 */
export async function listTrainRuns() {
  let names = [];
  try {
    names = await fs.readdir(LOG_DIR);
  } catch {
    return [];
  }
  const alive = await trainingProcessAlive();
  const runs = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    const kind = kindOf(name);
    if (kind === 'other') continue;
    const file = path.join(LOG_DIR, name);
    let st;
    try {
      st = await fs.stat(file);
    } catch {
      continue;
    }
    const text = await tailFile(file);
    const prog = parseTqdm(text);
    // 阶段：train-*.log 里 SFT 和 DPO 是**写同一个文件**的（DPO 由 trainer.js 接着跑）。
    // 看最后出现的阶段标记判断现在跑到哪一段了。
    let phase = kind;
    if (kind === 'sft') {
      const iSft = text.lastIndexOf('开始训练');
      const iDpo = Math.max(text.lastIndexOf('开始 DPO'), text.lastIndexOf('偏好对：'));
      phase = iDpo > iSft ? 'dpo' : 'sft';
    }
    const etaInfo = parseTrainingEta(text, st.mtimeMs);
    const losses = parseLossLines(text);
    // 判定「还在跑」：日志最近 3 分钟内有写入。
    // 不能只看 30 秒 —— 每步要 60~90 秒，日志一行是步末才写的，
    // 窗口太短会把正常训练误判成已停止（踩过）。
    const live = alive && Date.now() - st.mtimeMs < 180_000;
    runs.push({
      name,
      kind,
      size: st.size,
      mtime: st.mtimeMs,
      live,
      progress: prog,
      lossCount: losses.length,
      firstLoss: losses.length ? losses[0].loss : null,
      lastLoss: losses.length ? losses[losses.length - 1].loss : null,
      // 优先用自己算的（不依赖 tqdm）；算不出来才退回进度条里的值
      eta: etaInfo.eta || (prog ? hmsToSec(prog.eta) : 0),
      elapsed: etaInfo.elapsed || (prog ? hmsToSec(prog.elapsed) : 0),
      etaInfo,
      phase,
    });
  }
  runs.sort((a, b) => b.mtime - a.mtime);
  return runs;
}

/** 单个任务的完整明细（曲线 + 事件 + 原始尾）。 */
export async function trainRunDetail(name) {
  if (!/^[\w.-]+\.log$/.test(name)) return null;   // 只允许 logs/ 下的文件名
  const file = path.join(LOG_DIR, name);
  const text = await tailFile(file, 2 * 1024 * 1024);
  if (!text) return null;
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return null;
  }
  const losses = parseLossLines(text);
  // 只留画图用的字段，减小传输体积
  const series = losses.map((x, i) => ({
    step: x.step ?? (i + 1),
    loss: x.loss,
    grad: Number.isFinite(x.grad_norm) ? x.grad_norm : null,
    lr: Number.isFinite(x.learning_rate) ? x.learning_rate : null,
    acc: Number.isFinite(x.mean_token_accuracy) ? x.mean_token_accuracy : null,
    epoch: Number.isFinite(x.epoch) ? x.epoch : null,
  }));
  return {
    name,
    kind: kindOf(name),
    size: st.size,
    mtime: st.mtimeMs,
    live: Date.now() - st.mtimeMs < 180_000,
    progress: parseTqdm(text),
    etaInfo: parseTrainingEta(text, st.mtimeMs),
    series,
    events: parseEvents(text),
    tail: text.split(/\r?\n|\r/).filter((l) => l.trim()).slice(-40).join('\n'),
  };
}

/**
 * 训练进程的**实时**状态（不依赖日志）。
 *
 * 为什么需要：日志可能因为缓冲/重定向而滞后几分钟，
 * 但「进程还在不在、吃了多少 CPU/内存、开了几个线程」永远是真的。
 * 这个函数直接扫 /proc，训练脚本改了输出方式也不受影响。
 */
export async function liveProcesses() {
  const entries = await fs.readdir('/proc').catch(() => []);
  const rows = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const base = `/proc/${name}`;
    let cmd = '';
    try {
      // cmdline 用 \0 分隔参数
      cmd = (await fs.readFile(`${base}/cmdline`)).toString('utf8').split('\0').join(' ');
    } catch { continue; }
    let kind = '';
    if (cmd.includes('train_dpo.py')) kind = 'dpo';
    else if (cmd.includes('train_qlora.py')) kind = 'sft';
    else if (cmd.includes('convert_hf_to_gguf')) kind = 'convert';
    else if (cmd.includes('llama-quantize')) kind = 'quantize';
    if (!kind) continue;
    try {
      const status = await fs.readFile(`${base}/status`, 'utf8');
      const g = (k) => { const m = status.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : ''; };
      const comm = g('Name');
      // 排除掉只是命令行里带这些字样的 shell
      if (['bash', 'sh', 'grep', 'tr', 'cat', 'tee', 'stdbuf'].includes(comm)) continue;
      const stat = await fs.readFile(`${base}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(tail[11]) + Number(tail[12]);   // utime + stime
      const startTicks = Number(tail[19]);
      const hz = 100;   // Linux 默认 USER_HZ
      const up = (await fs.readFile('/proc/uptime', 'utf8')).split(' ')[0];
      const etimes = Math.max(0, Math.round(Number(up) - startTicks / hz));
      rows.push({
        pid: Number(name), kind, cmd: cmd.slice(0, 160),
        state: g('State').split(' ')[0],
        rssMB: Math.round(Number(g('VmRSS').replace(/\s*kB$/, '') || 0) / 1024),
        threads: Number(g('Threads') || 0),
        ticks, etimes,
      });
    } catch { /* 进程刚好退出 */ }
  }
  return { at: Date.now(), procs: rows };
}

/** 当前 GPU 状态（有 nvidia-smi 才有）。 */
export async function gpuSnapshot() {
  const { execFile } = await import('node:child_process');
  const run = (args) => new Promise((resolve) => {
    execFile('nvidia-smi', args, { timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
  const [mem, util] = await Promise.all([
    run(['--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits']),
    run(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']),
  ]);
  const [used, total, utilization, temp] = mem.trim().split(',').map((x) => Number(x.trim()));
  const procs = util.trim().split('\n').filter(Boolean).map((l) => {
    const [pid, name, m] = l.split(',').map((x) => x.trim());
    return { pid: Number(pid), name: path.basename(name || ''), memMB: Number(m) };
  });
  return {
    ok: Number.isFinite(used),
    usedMB: used, totalMB: total, utilization, temp,
    procs,
  };
}
