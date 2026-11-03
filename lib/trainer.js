// ============================================================================
//  训练队列 + 会话级 QLoRA 任务
//
//  点 🧠 → 导出该会话 → 数据清洗 → 进入「待开始」队列 → 串行训练 → 自动归档
//
//  队列状态：queued(待开始) / running(训练中) / done / error / canceled
//  16G 显卡一次只能训一个；取消正在跑的任务会触发下一项。
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { openSync, writeSync } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportTrainingSamples, toJsonl, cleanSamples, exportPreferencePairs } from './export.js';
import { DEFAULT_WEIGHTS, normalizeWeights, applySampleWeights, expandPairs, describeWeights } from './weights.js';
import { unloadOllama, llamaServerUp, stopLlamaServer, prepareGpuForTraining, restoreGpu } from './gpu.js';

const LLM_DIR = process.env.LLM_CHAT_DIR || '/home/don0ox1/deepseek/llm-chat';
const PY = path.join(LLM_DIR, '.venv-train', 'bin', 'python');
const TRAINER = path.join(LLM_DIR, 'train_qlora.py');
const DPO_TRAINER = path.join(LLM_DIR, 'train_dpo.py');
const DATA_DIR = path.join(LLM_DIR, 'data');
// Claude 模仿训练包（/home/don0ox1/deepseek/claude-imitation）从真实会话导出的
// 「Claude 文风」SFT 数据。混进队列训练用，格式和本项目的 clean.jsonl 完全一致
//（都是 {messages:[...]}），所以直接拼行即可。
const CLAUDE_DIR = process.env.CLAUDE_IMITATION_DIR || '/home/don0ox1/deepseek/claude-imitation';
// ⚠ 只认「SL-CAI 改写过的」数据，不认 runs/xingye/sft.jsonl ——
// 那份是 export_workbench.mjs 从真实会话**原样导出**的，实测它 341 条 assistant
// 文本全都在本项目自己的导出里出现（341/341 重复），
// 混进来等于把同一批会话说两遍，既没有 Claude 味又放大了重复。
// 正确来源：pipeline/02_sl_cai.py 产出的 revisions/sft.jsonl + data/rp-style-gold.jsonl，
// 由 tools/build-claude-style.mjs 汇总到这个目录。
const CLAUDE_STYLE_DIR = process.env.CLAUDE_STYLE_DIR || path.join(CLAUDE_DIR, 'runs', 'claude-style');
const CLAUDE_SFT = path.join(CLAUDE_STYLE_DIR, 'sft.jsonl');
// DPO 混训要用 **short system** 的那份导出（16G 卡只能跑 short，见 claude-imitation
// docs/04-xingye-integration.md §4.7：「full 与 short 不要混训」）。
// 用这条命令生成：
//   node integration/xingye/export_workbench.mjs --system-mode short --out runs/xingye-short
// 文件不存在就自动跳过（不报错）。
const CLAUDE_DPO = path.join(CLAUDE_STYLE_DIR, 'dpo.jsonl');
// 2026-10-30 训练产物改存 4TB 盘（/mnt/data4t），llm-chat 目录只留代码
const CKPT_DIR = process.env.LLM_CKPT_DIR || '/mnt/data4t/ai-models/training/llm-chat/ckpt';
const LOG_DIR = path.join(LLM_DIR, 'logs');
const QUEUE_FILE = path.join(DATA_DIR, '.train-queue.json');

/**
 * 训练一开始自动弹一个「训练控制台」窗口（ptyxis/xterm 里跑 tools/train-console.mjs）。
 * 控制台里能看到：显存余量（含每个占卡进程）、训练数据统计、实时日志（loss/epoch）。
 * 已经开着就不重复开；没有图形会话（纯 SSH）或 XINGYE_NO_TRAIN_CONSOLE=1 就跳过。
 */
export function openTrainConsole({ log = '', data = '' } = {}) {
  try {
    if (process.env.XINGYE_NO_TRAIN_CONSOLE === '1') return { ok: false, reason: 'XINGYE_NO_TRAIN_CONSOLE=1，跳过' };
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { ok: false, reason: '没有图形会话（纯 SSH？）' };
    // 是否已经开着：记 PID 文件，并确认那个 pid 真的还活着且确实是控制台
    //（用 pgrep -f 会误匹配命令行里带这个文件名的 shell —— 踩过一次）
    const pidFile = path.join(os.tmpdir(), 'xingye-train-console.pid');
    try {
      const oldPid = Number(fsSync.readFileSync(pidFile, 'utf8').trim());
      if (oldPid > 1) {
        const cmd = fsSync.readFileSync(`/proc/${oldPid}/cmdline`, 'utf8');
        if (cmd.includes('train-console.mjs')) return { ok: false, reason: '控制台已经开着' };
      }
    } catch { /* 没有 PID 文件 / 进程已退出 */ }
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const script = path.join(root, 'tools', 'train-console.mjs');
    if (!fsSync.existsSync(script)) return { ok: false, reason: '找不到 tools/train-console.mjs' };
    const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const parts = [process.execPath, script];
    if (log) parts.push('--log', log);
    if (data) parts.push('--data', data);
    const cmd = parts.map(q).join(' ');
    const env = { ...process.env };
    const tries = [
      ['ptyxis', ['-x', cmd]],
      ['xterm', ['-e', 'bash', '-lc', cmd]],
    ];
    for (const [bin, argv] of tries) {
      try {
        const child = spawn(bin, argv, { detached: true, stdio: 'ignore', env });
        child.unref();
        try { fsSync.writeFileSync(path.join(os.tmpdir(), 'xingye-train-console.pid'), String(child.pid || 0)); } catch { /* ignore */ }
        return { ok: true, via: bin };
      } catch { /* 试下一个终端 */ }
    }
    return { ok: false, reason: '没有可用的终端模拟器（ptyxis/xterm）' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

const MAX_LOG = 4000;
let seq = 0;
let queue = [];
let cur = null;
let pumping = false;

async function loadQueue() {
  try {
    const raw = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8'));
    const saved = (raw.items || []).filter((i) => ['queued', 'running', 'error'].includes(i.status));
    if (!queue.length && saved.length) {
      queue = saved;
      // 上次退出时还在跑的，进程已经没了（服务重启会带走子进程），
      // 打回 queued 重新排 —— 否则它会永远停在 "running" 假装在跑。
      let revived = 0;
      for (const it of queue) if (it.status === 'running') { it.status = 'queued'; revived += 1; }
      if (revived) {
        for (const it of queue) {
          if (it.status === 'queued' && !it.log) it.log = [];
          if (it.status === 'queued') it.log.push('[前端] ⚠️ 服务重启过，之前没跑完的任务已重新排队');
        }
      }
    }
  } catch { /* 首次没有队列文件 */ }
}

/**
 * 服务启动时调用：把队列从磁盘捡回来，并**自动接着跑**。
 *
 * 为什么需要：loadQueue 只读文件、不会开跑。之前服务重启后，
 * 磁盘里明明是 queued 的任务，界面上却一直「待开始」——
 * 因为没有任何地方调 pump()（踩过）。
 */
export async function resumeQueue() {
  await loadQueue();
  if (queue.some((i) => i.status === 'queued')) {
    pump();
    return true;
  }
  return false;
}

/**
 * 把 Claude 文风数据混进本次 SFT。
 *
 * 为什么混：claude-imitation 那份数据是「同一批会话、按 Claude 的写法重写」的结果，
 * 单独训会让模型变得像在写评语（`docs/04-xingye-integration.md` §4.6 的原话），
 * 所以要和原始 workbench 样本**按比例混用**。
 *
 * @param {Array} baseRows 本项目清洗+加权后的样本
 * @param {number} ratio   Claude 样本数 = baseRows.length * ratio（默认 1 = 1:1）
 * @returns {{rows: Array, stat: object|null}}
 */
/**
 * 手写素材训练：把手写页里的一问一答直接拿去跑 SFT。
 *
 * 和 enqueueTraining 的区别：不走会话导出的清洗/否决链路，
 * 因为每一轮都是作者亲手写的，原样就是目标。权重走 meta.origin='handwritten'（默认 8）。
 */
export async function enqueueScriptTraining(o = {}) {
  const { exportScriptSamples } = await import('./export.js');
  const { samples, skipped } = await exportScriptSamples({});
  if (!samples.length) {
    const why = skipped.slice(0, 5).map((x) => `${x.why}`).join('、');
    return { ok: false, error: `没有可用的手写素材（跳过 ${skipped.length} 条：${why}）` };
  }
  const weights = normalizeWeights(o.weights || {});
  const w = applySampleWeights(samples, { weights });

  // 手写素材照样可以混入改写数据：手写定方向，改写提供场景多样性。
  // 默认 1:1（mixRatio=1），mixRatio=0 关闭。
  let baseSamples = w.rows;
  let claudeStat = null;
  const mixRatio = o.mixClaude === false ? 0 : Number(o.mixRatio ?? 1);
  if (mixRatio > 0) {
    const mixed = await mixClaudeSft(baseSamples, mixRatio);
    baseSamples = mixed.rows;
    claudeStat = mixed.stat;
  }

  const id = 's' + Date.now().toString(36) + (seq++).toString(36);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const dataPath = path.join(DATA_DIR, `script-${stamp}.jsonl`);
  await fs.writeFile(dataPath, toJsonl(baseSamples), 'utf8');

  const item = {
    id, sessionId: '', title: `手写素材 ${samples.length} 条`,
    status: 'queued', createdAt: Date.now(),
    stat: { turns: samples.length, sessions: 0, skippedShort: 0, skippedLong: 0, rejected: 0, errors: 0, maxTokens: 0, tokMedian: 0, tokP90: 0, tokMax: 0 },
    clean: { input: samples.length, output: samples.length, removedTimeSkip: 0, removedTooShort: 0, removedNoAction: 0, removedDuplicate: 0 },
    dataPath, rawDataPath: dataPath,
    outPath: path.join(CKPT_DIR, 'script-' + stamp),
    params: {
      maxTokens: 0,
      maxSeqLen: Number(o.maxSeqLen) || 4096,
      epochs: Number(o.epochs) || 3,
      lr: Number(o.lr) || 1e-4,
      batchSize: Number(o.batchSize) || 1,
      // 手写素材样本少（一个素材=一条样本），用默认的 accum=8 会让
      // 「每轮步数」永远是 1：1 个素材×权重3=3 条样本 ÷ 8 = 1 步，
      // 也就是只有 3 次梯度更新 —— 只够把内容背下来，学不到风格（实测）。
      // 按样本量自适应：少样本用小 accum，保证至少十几次更新。
      gradAccum: Number(o.gradAccum) || (w.rows.length >= 24 ? 4 : w.rows.length >= 12 ? 2 : 1),
      deleteOllama: o.deleteOllama !== false,
      deleteLlama: o.deleteLlama !== false,
      base: String(o.base || ''),
      autoDeploy: o.autoDeploy !== false,
      deployVersion: String(o.deployVersion || ''),
      weights,
      baseSamples: samples.length,
      mixClaude: mixRatio > 0, mixRatio,
    },
    claudeStat, claudeDpoStat: null,
    weightStat: w.stat, pairWeightStat: null, notes: [],
    pairPath: '', pairCount: 0,
    log: [], error: '',
  };
  queue.push(item);
  await saveQueue();
  pump();
  return { ok: true, item: publicItem(item) };
}

async function mixClaudeSft(baseRows, ratio = 1) {
  if (!(ratio > 0)) return { rows: baseRows, stat: null };
  let all = [];
  try {
    const raw = await fs.readFile(CLAUDE_SFT, 'utf8');
    all = raw.split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter((r) => r && Array.isArray(r.messages) && r.messages.length);
  } catch {
    return { rows: baseRows, stat: { error: '找不到 ' + CLAUDE_SFT, added: 0 } };
  }
  if (!all.length) return { rows: baseRows, stat: { error: 'Claude 数据为空', added: 0 } };

  // 不能超过源文件条数 —— 否则会在同一批小数据上重复采样，
  // 等于把那几条放大几倍（实测：26 条源要 63 条，会每条重复 2.4 次）
  const want = Math.min(all.length, Math.max(1, Math.round(baseRows.length * ratio)));
  // 均匀抽样而不是取前 N —— 导出文件常按会话更新时间排序，取前 N 会偏
  const picked = [];
  for (let i = 0; i < want; i++) {
    picked.push(all[Math.floor((i + 0.5) * all.length / want)]);
  }
  return {
    rows: baseRows.concat(picked),
    stat: { source: CLAUDE_SFT, available: all.length, added: picked.length, ratio, total: baseRows.length + picked.length },
  };
}

/**
 * 把 Claude 偏好对混进本次 DPO。
 *
 * 只读 `runs/xingye-short/dpo.jsonl`（short system 那份）—— 队列的 DPO 固定用
 * systemMode:'short'，full 的 prompt 有 2600 token，混进来会被 max_length 1280 截光。
 * 文件不存在就返回空，不当作错误。
 */
async function mixClaudeDpo(baseRows, ratio = 1) {
  if (!(ratio > 0)) return { rows: baseRows, stat: null };
  let all = [];
  try {
    const raw = await fs.readFile(CLAUDE_DPO, 'utf8');
    all = raw.split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter((r) => r && r.messages && r.chosen && r.rejected);
  } catch {
    return { rows: baseRows, stat: null };      // 没导出过就静默跳过
  }
  if (!all.length) return { rows: baseRows, stat: null };
  const want = Math.max(1, Math.round(baseRows.length * ratio));
  const picked = [];
  for (let i = 0; i < want; i++) picked.push(all[Math.floor((i + 0.5) * all.length / want)]);
  return { rows: baseRows.concat(picked), stat: { source: CLAUDE_DPO, available: all.length, added: picked.length, ratio } };
}

function serialize(it) {
  return {
    id: it.id, sessionId: it.sessionId, title: it.title, status: it.status,
    createdAt: it.createdAt, stat: it.stat, clean: it.clean, params: it.params,
    dataPath: it.dataPath, outPath: it.outPath, archivePath: it.archivePath || '',
    pairPath: it.pairPath || '', pairCount: it.pairCount || 0,
    error: it.error || '',
    phase: it.phase || '',
    retries: it.retries || 0,
    weights: it.params?.weights || DEFAULT_WEIGHTS,
    baseSamples: it.params?.baseSamples || 0,
    claudeStat: it.claudeStat || null, claudeDpoStat: it.claudeDpoStat || null,
    weightStat: it.weightStat || null,
    pairWeightStat: it.pairWeightStat || null,
    notes: it.notes || [],
  };
}

async function saveQueue() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(QUEUE_FILE, JSON.stringify({ items: queue.map(serialize) }, null, 2), 'utf8');
  } catch { /* 磁盘问题不影响训练 */ }
}

function pushLog(target, line) {
  if (!target) return;
  if (!Array.isArray(target.log)) target.log = [];
  target.log.push(line);
  if (target.log.length > MAX_LOG) target.log.splice(0, target.log.length - MAX_LOG);
  // 进度：训练脚本里 `disable_tqdm=True`（进度条用 \r 刷同一行会把 loss 冲掉），
  // 所以**没有** "x/y [00:00<00:01" 这种行可解析。改从 loss 行数推算：
  // logging_steps=1，一步一条 loss，数一数就知道跑到第几步。
  const phase = target.phase || 'SFT';
  if (/\{'loss':/.test(line) && target === cur) {
    target.lossSteps = (target.lossSteps || 0) + 1;
    const total = target.totalSteps || 0;
    target.step = total ? `${phase} ${target.lossSteps}/${total}` : `${phase} ${target.lossSteps}`;
  }
  // 总步数从 "总步数约 27" 这行捞
  const tm = String(line).match(/总步数约\s*(\d+)/);
  if (tm && target === cur) {
    target.totalSteps = Number(tm[1]);
    target.lossSteps = 0;
  }
  if (/开始训练/.test(line) && target === cur) target.status = 'running';
  if (/OOM|Traceback|训练失败/.test(line) && target === cur) target.status = 'error';
}

function publicItem(it) {
  if (!it) return null;
  return {
    id: it.id, sessionId: it.sessionId, title: it.title, status: it.status,
    createdAt: it.createdAt, stat: it.stat || null, clean: it.clean || null,
    params: it.params || null, dataPath: it.dataPath || '', outPath: it.outPath || '',
    archivePath: it.archivePath || '', error: it.error || '', step: it.step || '',
    pairPath: it.pairPath || '', pairCount: it.pairCount || 0,
    weights: it.params?.weights || DEFAULT_WEIGHTS,
    baseSamples: it.params?.baseSamples || 0,
    claudeStat: it.claudeStat || null, claudeDpoStat: it.claudeDpoStat || null,
    weightStat: it.weightStat || null,
    pairWeightStat: it.pairWeightStat || null,
    notes: it.notes || [],
    log: (it.log || []).slice(-60).join('\n'),
  };
}

export async function queueState() {
  await loadQueue();
  const order = { running: 0, queued: 1, error: 2, canceled: 3, done: 4 };
  const items = [...queue].sort((a, b) => {
    const d = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    return d !== 0 ? d : a.createdAt - b.createdAt;
  });
  return {
    running: Boolean(cur && cur.proc && cur.proc.exitCode === null),
    currentId: cur ? cur.id : '',
    queuedCount: queue.filter((i) => i.status === 'queued').length,
    items: items.map(publicItem),
  };
}

/**
 * 大模式：用「标准回答库」训练
 *  - 数据来自 gold/corpus.jsonl（人工认可的标准回答）
 *  - 默认取 harvest score >= minScore 的条目自动提升
 *  - 带 negative 的自动生成 DPO 偏好对
 * o: { title, mode:'gold', minScore, epochs, lr, ... }
 */
/** gold/dpo_pairs.jsonl 里的来源：挑一版的 sampleId 是 `cand-gNNN`，其余是 harvest。 */
function goldOriginOf(r) {
  if (r.origin) return r.origin;
  const sid = String(r.sessionId || '');
  return sid.startsWith('cand-') ? 'adopted' : 'plain';
}

export async function enqueueGoldTraining(o = {}) {
  await loadQueue();
  const minScore = Number(o.minScore) || 8;
  const { execFile } = await import('node:child_process');

  // 1) 从候选池自动提升到标准库（幂等：重复跑不会重复加）
  const promote = await new Promise((resolve) => {
    execFile(PY, [path.join(LLM_DIR, 'gold_promote.py'), '--min-score', String(minScore)], {
      cwd: LLM_DIR, env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }),
    }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
  });

  // 2) 导出训练集
  let weightNote = '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sftPath = path.join(DATA_DIR, `gold-${stamp}.jsonl`);
  // 加权：--edited-weight/--picked-weight 让 gold_corpus.py 在每条 meta 里写 origin
  const weights = normalizeWeights(o.weights || {});
  const exp = await new Promise((resolve) => {
    const expArgs = [path.join(LLM_DIR, 'gold_corpus.py'), 'export', '--out', sftPath, '--system', String(o.system || '')];
    if (weights.edited !== DEFAULT_WEIGHTS.edited) expArgs.push('--edited-weight', String(weights.edited));
    if (weights.adopted !== DEFAULT_WEIGHTS.adopted) expArgs.push('--picked-weight', String(weights.adopted));
    execFile(PY, expArgs, {
      cwd: LLM_DIR, env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }),
    }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
  });
  if (!exp.ok) return { ok: false, error: '标准库导出失败：' + exp.out.slice(-300) };

  let lines = 0;
  try {
    lines = (await fs.readFile(sftPath, 'utf8')).split('\n').filter(Boolean).length;
  } catch { /* ignore */ }
  let goldSftWeightStat = null;
  if (lines) {
    // gold_corpus.py export 已按 --edited-weight/--picked-weight 写好 meta.weight；
    // 这里按上限剪裁落地成实际条数（同时把权重记进 report，训练日志里能看到）
    try {
      const rows = (await fs.readFile(sftPath, 'utf8')).split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const w = applySampleWeights(rows, { weights });
      if (w.stat.output !== rows.length) {
        await fs.writeFile(sftPath, w.rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        lines = w.rows.length;
        goldSftWeightStat = w.stat;
        weightNote = `样本加权 ${describeWeights(weights)}：${w.stat.input} 条 → ${w.stat.output} 条`;
      }
    } catch { /* 加权失败就用原样 */ }
  }
  if (!lines) {
    return { ok: false, error: `标准回答库里没有 ≥${minScore} 分的条目。先跑 gold_harvest.py harvest，或降低 minScore。`, promote: promote.out.slice(-300) };
  }

  // DPO 偏好对：promote 阶段已经单独导出到 gold/dpo_pairs.jsonl
  let dpoLines = 0;
  let dpoPath = '';
  let goldDpoWeightStat = null;
  let goldDpoBase = 0;
  const goldDpo = path.join(LLM_DIR, 'gold', 'dpo_pairs.jsonl');
  try {
    const raw = (await fs.readFile(goldDpo, 'utf8')).split('\n').filter(Boolean);
    if (raw.length >= 4) {
      dpoPath = path.join(DATA_DIR, `gold-${stamp}.dpo.jsonl`);
      // DPO 需要 {messages, chosen, rejected}；gold 版是 {messages, user, chosen, rejected}
      // 需要角色 system：用 xingye-chat 的 buildMessages 重建（和 SFT 分布一致）
      let buildMessages = null, CONTEXT_BUDGET = 7200, cfg = null, charList = [];
      try {
        const promptMod = await import('./prompt.js');
        const storeMod = await import('./store.js');
        buildMessages = promptMod.buildMessages;
        CONTEXT_BUDGET = promptMod.CONTEXT_BUDGET;
        cfg = await storeMod.getConfig();
        charList = await storeMod.listCharacters();
      } catch { /* 拿不到就用原始 messages */ }

      const dpoOut = [];
      for (const l of raw) {
        let r;
        try { r = JSON.parse(l); } catch { continue; }
        let msgs = (r.messages || []).slice();
        if (r.user && (!msgs.length || msgs[msgs.length - 1].role !== 'user')) {
          msgs.push({ role: 'user', content: r.user });
        }
        if (buildMessages && cfg) {
          const ch = charList.find((c) => c.name === r.charName) || { id: '', name: r.charName || '对话', persona: '' };
          try {
            const withSys = buildMessages(ch, msgs, CONTEXT_BUDGET, cfg.narrative || '', {
              cleanHistory: false,
              dims: ch.dims?.length ? ch.dims : cfg.dims,
              hint: String(ch.hint || '').trim() || cfg.hint,
              synonyms: cfg.synonyms, synonymsOutput: cfg.synonymsOutput === true,
              memo: cfg.memo, maxChars: cfg.maxChars,
              knowledge: [], search: [], thinkOff: false,
            });
            if (withSys.length && withSys[0].role === 'system') msgs = withSys;
          } catch { /* 构建失败就用原样 */ }
        }
        dpoOut.push({
          messages: msgs, chosen: r.chosen, rejected: r.rejected,
          reason: r.reason || '', sessionId: r.sessionId || '',
          origin: goldOriginOf(r),
        });
      }
      // 加权：你挑一版的那几对，DPO 也成对多学几遍
      const dw = expandPairs(dpoOut, { weights });
      await fs.writeFile(dpoPath, dw.rows.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
      dpoLines = dw.rows.length;
      goldDpoWeightStat = dw.stat;
      goldDpoBase = raw.length;
    }
  } catch { /* 没有偏好对就不做 DPO */ }

  const item = {
    id: 'g' + Date.now().toString(36) + (seq++).toString(36),
    sessionId: '', title: `大模式 ≥${minScore}分（${lines} 条）`,
    status: 'queued', createdAt: Date.now(),
    stat: { turns: lines, sessions: 0, skippedShort: 0, skippedLong: 0, rejected: dpoLines, errors: 0, maxTokens: 3072, tokMedian: 0, tokP90: 0, tokMax: 0 },
    clean: { input: lines, output: lines, removedTimeSkip: 0, removedTooShort: 0, removedNoAction: 0, removedDuplicate: 0 },
    dataPath: sftPath,
    rawDataPath: sftPath,
    outPath: path.join(CKPT_DIR, 'gold-' + stamp),
    pairPath: dpoLines ? dpoPath : '',
    pairCount: dpoLines,
    params: {
      maxTokens: 3072,
      maxSeqLen: Number(o.maxSeqLen) || 3072,
      epochs: Number(o.epochs) || 4,
      lr: Number(o.lr) || 8e-5,
      batchSize: Number(o.batchSize) || 1,
      gradAccum: Number(o.gradAccum) || 8,
      deleteOllama: o.deleteOllama !== false,
      deleteLlama: o.deleteLlama !== false,
      base: String(o.base || ''),     // 空 = 用 train_qlora.py 的默认（12B）
      autoDeploy: o.autoDeploy !== false,
      deployVersion: String(o.deployVersion || ''),
      weights,
      baseSamples: lines,
    },
    weightStat: goldSftWeightStat,
    pairWeightStat: goldDpoWeightStat,
    notes: [
      weightNote,
      (goldDpoBase && dpoLines !== goldDpoBase)
        ? `偏好对加权：${goldDpoBase} → ${dpoLines} 组（${describeWeights(weights)}）` : '',
    ].filter(Boolean),
    log: [], error: '',
  };
  queue.push(item);
  await saveQueue();
  pump();
  const st = await queueState();
  return {
    ok: true, item: publicItem(item), position: st.queuedCount, queue: st,
    sft: lines, dpo: dpoLines, weights,
  };
}

export async function enqueueTraining(o = {}) {
  await loadQueue();
  if (!o.sessionId) return { ok: false, error: '缺少 sessionId' };

  const maxTokens = Number(o.maxTokens) || 3072;
  const raw = await exportTrainingSamples({ sessionId: o.sessionId, maxTokens, withRejected: true });
  if (!raw.samples.length) {
    return { ok: false, error: `这个会话导不出样本（回复太短或超出 ${maxTokens} token）`, stat: raw.stat };
  }

  let samples = raw.samples;
  let clean = null;
  if (o.clean !== false) {
    const c = cleanSamples(raw.samples, { minChars: o.minChars });
    samples = c.samples;
    clean = c.report;
  }
  if (!samples.length) {
    return { ok: false, error: '清洗后没有可用样本（调小 minChars 或关闭清洗）', stat: raw.stat, clean };
  }

  // 加权：手改 / 挑一版 的样本被多学几遍（在清洗之后做，避免同一条被重复计入去重）
  const weights = normalizeWeights(o.weights || {});
  let baseSamples = samples;
  let weightStat = null;
  if (weights.edited > 1 || weights.adopted > 1) {
    const w = applySampleWeights(samples, { weights });
    baseSamples = w.rows;
    weightStat = w.stat;
  }

  // 混入 Claude 文风数据（「训练里加上模仿 claude」的落点）。
  // mixClaude:false 可关；mixRatio 控制比例（1 = 与本项目样本 1:1）。
  let claudeStat = null;
  let claudeDpoStat = null;
  const mixRatio = o.mixClaude === false ? 0 : Number(o.mixRatio ?? 1);
  if (mixRatio > 0) {
    const mixed = await mixClaudeSft(baseSamples, mixRatio);
    baseSamples = mixed.rows;
    claudeStat = mixed.stat;
  }

  const id = 'q' + Date.now().toString(36) + (seq++).toString(36);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = String(o.title || 'session').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24);
  const dataPath = path.join(DATA_DIR, 'sess-' + safeName + '-' + stamp + '.jsonl');
  const cleanPath = dataPath.replace(/\.jsonl$/, '.clean.jsonl');

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(dataPath, toJsonl(raw.samples), 'utf8');
  await fs.writeFile(cleanPath, toJsonl(baseSamples), 'utf8');
  if (raw.negatives.length) {
    await fs.writeFile(dataPath.replace(/\.jsonl$/, '.negatives.jsonl'), toJsonl(raw.negatives), 'utf8');
  }

  // 偏好对：用于 DPO（把「被否决的回复」真正用起来）
  let pairPath = '';
  let pairCount = 0;
  let pairWeightStat = null;
  let pushLogLater = '';
  if (o.dpo !== false) {
    try {
      // ⚠ 必须用 systemMode:'short'。full 模式下 prompt 中位 2600 token
      // （system 本身就 1900），DPO 的双路激活会让 16 GB 卡必 OOM；
      // 而且 max_length 一压到 1280 就会把 100% 的样本截光，
      // trl 的 dataloader 变空 → torch.cat 报 "expected a non-empty list"（踩过）。
      // short 模式把 prompt 降到约 500 token，1280 绰绰有余。
      const pref = await exportPreferencePairs({ sessionId: o.sessionId, maxTokens, systemMode: 'short' });
      if (pref.pairs.length >= (Number(o.minDpoPairs) || 4)) {
        // DPO 对也按来源加权：chosen 是手改/挑一版的那几对，成对复制几次
        const w = expandPairs(pref.pairs, { weights });
        // 混入 Claude 偏好对（只有导出了 short system 那份才生效）
        let dpoRows = w.rows;
        if (mixRatio > 0) {
          const md = await mixClaudeDpo(dpoRows, mixRatio);
          if (md.stat) { dpoRows = md.rows; claudeDpoStat = md.stat; }
        }
        pairPath = dataPath.replace(/\.jsonl$/, '.dpo.jsonl');
        await fs.writeFile(pairPath, dpoRows.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
        pairCount = dpoRows.length;
        pairWeightStat = w.stat;
        if (pairCount !== pref.pairs.length) {
          pushLogLater = `偏好对加权：${pref.pairs.length} → ${pairCount} 组（${describeWeights(weights)}）`;
        }
      }
    } catch { /* 没有偏好对就跳过 DPO */ }
  }

  const item = {
    id, sessionId: o.sessionId, title: String(o.title || '会话').slice(0, 40),
    status: 'queued', createdAt: Date.now(), stat: raw.stat, clean,
    dataPath: cleanPath, rawDataPath: dataPath,
    outPath: path.join(CKPT_DIR, 'sess-' + stamp),
    params: {
      maxTokens,
      maxSeqLen: Number(o.maxSeqLen) || Math.max(3072, maxTokens),
      epochs: Number(o.epochs) || 3,
      lr: Number(o.lr) || 8e-5,
      batchSize: Number(o.batchSize) || 1,
      gradAccum: Number(o.gradAccum) || 8,
      deleteOllama: o.deleteOllama !== false,
      deleteLlama: o.deleteLlama !== false,
      base: String(o.base || ''),     // 空 = 用 train_qlora.py 的默认（12B）
      autoDeploy: o.autoDeploy !== false,
      deployVersion: String(o.deployVersion || ''),
      weights,
      baseSamples: samples.length,
      mixClaude: mixRatio > 0, mixRatio,
    },
    claudeStat, claudeDpoStat,
    weightStat, pairWeightStat, notes: pushLogLater ? [pushLogLater] : [],
    pairPath, pairCount,
    log: [], error: '',
  };
  queue.push(item);
  await saveQueue();
  pump();
  const st = await queueState();
  return { ok: true, item: publicItem(item), position: st.queuedCount, queue: st };
}

export async function cancelQueued(id) {
  await loadQueue();
  const it = queue.find((x) => x.id === id);
  if (!it) return { ok: false, error: '队列里没有这一项' };
  if (it.status === 'running') {
    try { if (it.proc) it.proc.kill('SIGINT'); } catch { /* ignore */ }
    it.status = 'canceled';
    pushLog(it, '[前端] ⏹ 已取消正在训练的任务');
    await saveQueue();
    return { ok: true, canceled: 'running', queue: await queueState() };
  }
  if (it.status !== 'queued') return { ok: false, error: '该任务状态是 ' + it.status + '，无法取消' };
  it.status = 'canceled';
  await saveQueue();
  return { ok: true, canceled: 'queued', queue: await queueState() };
}

export async function removeQueued(id) {
  await loadQueue();
  const it = queue.find((x) => x.id === id);
  if (!it) return { ok: false, error: '队列里没有这一项' };
  if (it.status === 'running') return { ok: false, error: '正在训练的任务不能直接移除，请先取消' };
  queue = queue.filter((x) => x.id !== id);
  await saveQueue();
  return { ok: true, queue: await queueState() };
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    await loadQueue();
    for (;;) {
      if (cur && cur.proc && cur.proc.exitCode === null) break;
      // 按 createdAt 取最早的 —— OOM 重试会把 createdAt 刷新成当前时间，
      // 于是它自然排到队尾，不会立刻原地重试（否则连撞两次同样的 OOM）。
      const pending = queue.filter((i) => i.status === 'queued')
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const next = pending[0];
      if (!next) break;
      await runItem(next);
    }
  } finally {
    pumping = false;
  }
}

async function runItem(item) {
  item.status = 'running';
  item.log = [];
  item.step = '';
  cur = item;
  await saveQueue();

  const unload = item.params.deleteOllama ? await unloadOllama() : { note: '跳过卸载 Ollama' };
  if (unload && unload.note) pushLog(item, '[前端] ' + unload.note);
  if (await llamaServerUp(8080) && item.params.deleteLlama) {
    const r = await stopLlamaServer();
    pushLog(item, '[前端] ' + r.note);
  }
  // 开跑前先等显存够（上一个任务的残留可能还没回收）
  const preFree = await waitForGpuRelease(20000);
  if (preFree !== null && preFree < 8) {
    pushLog(item, `[前端] ⏳ 显存只剩 ${preFree.toFixed(1)} GB，等一会儿再开`);
  }
  const gpu = await prepareGpuForTraining();
  item.stoppedServices = gpu.stopped || [];
  if (gpu.note) pushLog(item, '[前端] ' + gpu.note);

  const args = [
    TRAINER, '--data', item.dataPath, '--out', item.outPath,
    // 基座：入队时没指定就用默认（12B）。想训 8B 就在入队参数里给 base。
    ...(item.params.base ? ['--base', String(item.params.base)] : []),
    '--max-seq-len', String(item.params.maxSeqLen),
    '--epochs', String(item.params.epochs),
    '--lr', String(item.params.lr),
    '--batch-size', String(item.params.batchSize),
    '--grad-accum', String(item.params.gradAccum),
    '--save-steps', '50',
  ];

  await fs.mkdir(LOG_DIR, { recursive: true });
  item.logPath = path.join(LOG_DIR, 'train-' + item.id + '.log');
  const logFd = openSync(item.logPath, 'a');
  item.phase = 'SFT';
  if (item.claudeStat && item.claudeStat.added) {
    pushLog(item, `[前端] 混入 Claude 文风样本 ${item.claudeStat.added} 条`
      + `（源 ${item.claudeStat.available} 条，比例 ${item.claudeStat.ratio}）→ 合计 ${item.claudeStat.total} 条（含加权复制）`);
  } else if (item.claudeStat && item.claudeStat.error) {
    pushLog(item, '[前端] ⚠️ Claude 数据没混进来：' + item.claudeStat.error);
  }
  pushLog(item, '[前端] 开始训练：' + path.basename(item.dataPath));
  const wts = normalizeWeights(item.params.weights || {});
  if (item.weightStat) {
    const o = item.weightStat.byOrigin || {};
    pushLog(item, `[前端] 样本加权 ${describeWeights(wts)}：${item.params.baseSamples || '?'} 条 → ${item.weightStat.output} 条`
      + `（手改 ${o.edited || 0} / 挑一版 ${o.adopted || 0} / 原始 ${o.plain || 0}）`);
  }
  for (const n of item.notes || []) pushLog(item, '[前端] ' + n);

  const proc = spawn(PY, args, {
    cwd: LLM_DIR,
    env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1', HF_HOME: path.join(LLM_DIR, 'models', 'hf') }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  proc.unref();
  item.proc = proc;
  // 训练一开始就把控制台窗口弹出来（显存余量 / 数据 / 日志）
  openTrainConsole({ log: item.logPath, data: item.dataPath });

  const onData = (buf) => {
    try { writeSync(logFd, buf); } catch (e) { /* ignore */ }
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (const line of lines) {
      if (line.trim()) pushLog(item, line);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.stdout.on('error', () => {});
  proc.stderr.on('error', () => {});

  await new Promise((resolve) => {
    proc.on('error', (e) => {
      item.status = 'error';
      item.error = '启动失败：' + e.message;
      pushLog(item, '[前端] ❌ 启动失败：' + e.message);
      resolve();
    });
    proc.on('close', async (code, signal) => {
      if (item.status === 'canceled') {
        pushLog(item, '[前端] ⏹ 已取消');
      } else if (code === 0) {
        pushLog(item, '[前端] ✅ SFT 训练完成');
        // 有偏好对时接着跑 DPO：用「被否决的回复」教模型什么叫不要写
        let dpoOk = true;
        if (item.pairPath && item.pairCount > 0) {
          item.phase = 'DPO';
          item.step = '';
          item.lossSteps = 0;
          item.totalSteps = 0;
          pushLog(item, `[前端] 开始 DPO：${item.pairCount} 组偏好对（chosen vs 被否决）`);
          dpoOk = await runDpo(item);
          if (dpoOk) pushLog(item, '[前端] ✅ DPO 完成');
          else pushLog(item, '[前端] ⚠ DPO 失败，保留 SFT 的结果');
        }
        item.status = 'done';
        pushLog(item, '[前端] ✅ 训练完成' + (dpoOk && item.pairCount ? '（SFT + DPO）' : ''));
        try {
          const archived = await archiveAdapter(item.outPath, item.title, item.pairCount ? 'dpo' : '');
          if (archived) {
            item.archivePath = archived;
            pushLog(item, '[前端] 📦 已归档：' + path.basename(archived));
          }
        } catch (e) {
          pushLog(item, '[前端] ⚠ 归档失败：' + e.message);
        }
        // 自动部署：合并 → 转 GGUF → 量化（默认开，入队时可用 autoDeploy:false 关掉）
        if (item.params.autoDeploy !== false) {
          try {
            const adapter = pickDeployAdapter(item);
            pushLog(item, '[前端] 🚀 开始自动部署：' + adapter);
            deployQueue.push({ adapter, version: item.params.deployVersion || '', title: item.title, fromId: item.id, auto: true });
            pumpDeploy();
          } catch (e) {
            pushLog(item, '[前端] ⚠ 自动部署准备失败：' + e.message);
          }
        }
      } else if (signal === 'SIGINT') {
        item.status = 'canceled';
        pushLog(item, '[前端] ⏹ 手动停止');
      } else {
        // OOM 自动重试一次：队列里上一个任务的显存可能没完全释放，
        // 或者 Ollama/ComfyUI 刚好又占回去了。这种情况重跑一次通常就过。
        const oom = /显存不足|OutOfMemory|OOM/.test((item.log || []).slice(-30).join('\n'));
        const retried = (item.retries || 0);
        if (oom && retried < 1) {
          item.retries = retried + 1;
          item.status = 'queued';          // 放回队列
          item.createdAt = Date.now();     // 排到队尾
          item.step = '';
          pushLog(item, `[前端] 🔁 显存不足导致的失败，已自动重新排队（第 ${item.retries} 次重试）`);
        } else {
          item.status = 'error';
          item.error = '训练退出码 ' + code;
          pushLog(item, '[前端] ❌ 训练失败（退出码 ' + code + '）');
        }
      }
      try {
        const restored = await restoreGpu(item.stoppedServices || []);
        for (const r of restored) {
          pushLog(item, '[前端] ' + (r.ok ? '已恢复' : '请手动启动') + ' ' + r.unit);
        }
      } catch (e) { /* ignore */ }
      resolve();
    });
  });

  cur = null;
  await saveQueue();

  // ⚠ 等显存真的释放，再让队列跑下一个任务。
  // 训练进程退出后 CUDA 上下文/缓存要几秒才回收，这期间下一个任务一加载模型
  // 就报「显存不足：空闲 2.1 GB」（实测：3 个任务的队列，第 1 个跑完后
  // 后两个全撞在这上面）。
  await waitForGpuRelease(12000);
}

/**
 * 等 GPU 显存回落到「够跑下一个任务」的水平。
 * 训练进程退出不代表显存立刻可用：CUDA context 和 caching allocator
 * 要几秒才回收，而 paged_adamw_8bit 的优化器状态也会拖一会儿。
 * @param {number} maxMs 最多等多久（毫秒）
 */
async function waitForGpuRelease(maxMs = 12000) {
  const { execFile } = await import('node:child_process');
  const freeGB = () => new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(null);
        const n = Number(String(stdout).trim().split('\n')[0]);
        resolve(Number.isFinite(n) ? n / 1024 : null);
      });
  });
  const t0 = Date.now();
  for (;;) {
    const free = await freeGB();
    // 4bit 8B 加载大约要 6.5 GB，留一点余量
    if (free === null || free >= 8) return free;
    if (Date.now() - t0 > maxMs) return free;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * 训练完成后自动部署该用哪个适配器：
 *   有 DPO 就用 dpo/final（SFT + 偏好对齐都在里面），否则用 final。
 */
function pickDeployAdapter(item) {
  const dpo = path.join(item.outPath, 'dpo', 'final');
  const sft = path.join(item.outPath, 'final');
  // eslint-disable-next-line no-sync
  const exists = (p) => { try { return fsSync.existsSync(path.join(p, 'adapter_config.json')); } catch { return false; } };
  if (exists(dpo)) return dpo;
  if (exists(sft)) return sft;
  throw new Error('SFT 和 DPO 都没有产出可用的适配器');
}

/**
 * 自动部署队列：训练完一个就排一个，串行跑完（部署要占磁盘 + CPU，不适合并行）。
 */
const deployQueue = [];
let deployPumping = false;

async function pumpDeploy() {
  if (deployPumping) return;
  deployPumping = true;
  try {
    while (deployQueue.length) {
      const job = deployQueue.shift();
      // 把日志挂到触发它的那个训练项上，训练面板里能直接看到部署进度
      const target = queue.find((x) => x.id === job.fromId);
      job.item = target;
      try {
        const r = await runDeploy(job);
        if (target) {
          target.deployPath = r.done;
          pushLog(target, '[部署] ✅ 完成：' + (r.done || '见日志 ' + r.logPath));
        }
      } catch (e) {
        if (target) pushLog(target, '[部署] ❌ ' + e.message);
      }
    }
  } finally {
    deployPumping = false;
  }
}

/**
 * 在 SFT 产出的 LoRA 基础上跑 DPO。返回是否成功。
 */
async function runDpo(item) {
  const sftAdapter = path.join(item.outPath, 'final');
  const dpoOut = path.join(item.outPath, 'dpo');
  const args = [
    DPO_TRAINER,
    // 必须和 SFT 用同一个基座 —— 否则 LoRA 形状不匹配，DPO 直接崩。
    // 默认跟 train_dpo.py 的 DEFAULT_BASE 一致（现在是 Qwen3-8B）；
    // 不写死 12B 路径，免得脚本默认值改了这里还在用旧的。
    ...(item.params.base ? ['--base', String(item.params.base)] : []),
    '--pairs', item.pairPath,
    '--out', dpoOut,
    // DPO 的序列长度要单独管：SFT 用 3072 没问题（一份模型），
    // 但 DPO 的激活是双路（chosen + rejected 同时前向），3072 会直接 OOM。
    // 1280 能覆盖实测 p90（546）+ 大部分长尾（max 1302，只截 2/116 组）。
    '--max-length', String(item.params.dpoMaxLen || 1280),
    '--epochs', String(item.params.dpoEpochs || 1),
    '--lr', String(item.params.dpoLr || 5e-6),
    '--beta', String(item.params.dpoBeta || 0.1),
    '--batch-size', '1',
    '--grad-accum', '4',
    '--save-steps', '50',
    // ⚠ 这两条**必须带**，否则 DPO 会：
    //   ① ref-mode=copy（默认）→ 参考模型 = 策略副本 → margin 恒为 0，
    //      loss 卡在 ln(2)=0.693，一个参数都学不对
    //   ② 两份模型同时在场 → 16 GB 卡上必 OOM（实测 12.97 GB 分配后只剩 338 MB）
    // ref-mode=base 的做法是把 ref 适配器清零（等价于纯基座），
    // 显存上始终只有一份模型。
    '--precompute-ref',
    '--ref-mode', 'base',
  ];
  // DPO 从 SFT 权重继续：把 SFT 的 LoRA 作为初始适配器
  args.push('--init-adapter', sftAdapter);

  const p = spawn(PY, args, {
    cwd: LLM_DIR,
    env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1', HF_HOME: path.join(LLM_DIR, 'models', 'hf') }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  p.unref();
  const logFd = openSync(path.join(LOG_DIR, 'dpo-' + item.id + '.log'), 'a');
  openTrainConsole({ log: path.join(LOG_DIR, 'dpo-' + item.id + '.log'), data: item.dataPath || '' });
  const onData = (buf) => {
    try { writeSync(logFd, buf); } catch (e) { /* ignore */ }
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (const line of lines) if (line.trim()) pushLog(item, '[DPO] ' + line);
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.stdout.on('error', () => {});
  p.stderr.on('error', () => {});
  return new Promise((resolve) => {
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

async function archiveAdapter(runDir, label) {
  // 有 DPO 时优先归档 DPO 产物（它建立在 SFT 之上）
  let adapter = path.join(runDir || '', 'dpo', 'final');
  try {
    await fs.access(path.join(adapter, 'adapter_model.safetensors'));
  } catch {
    adapter = path.join(runDir || '', 'final');
  }
  try {
    await fs.access(path.join(adapter, 'adapter_model.safetensors'));
  } catch (e) {
    return '';
  }
  return new Promise((resolve) => {
    const p = spawn('bash', [path.join(LLM_DIR, 'archive.sh'), adapter, '--label', String(label || 'lora')], {
      cwd: LLM_DIR, env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { out += b.toString(); });
    p.on('error', () => resolve(''));
    p.on('close', () => {
      const m = out.match(/归档完成：(.+)/);
      resolve(m ? m[1].trim() : '');
    });
  });
}

export function trainState() {
  return {
    running: Boolean(cur && cur.proc && cur.proc.exitCode === null),
    status: cur ? cur.status : 'idle',
    step: cur ? cur.step : '',
    outPath: cur ? cur.outPath : '',
    archivePath: cur ? cur.archivePath || '' : '',
    log: cur ? (cur.log || []).slice(-120).join('\n') : '',
  };
}

export async function recoverTraining() {
  await loadQueue();
  return null;
}

export function stopTraining() {
  if (!cur || !cur.proc) return { ok: false, error: '没有正在跑的训练' };
  try { cur.proc.kill('SIGINT'); } catch (e) { /* ignore */ }
  cur.status = 'canceled';
  pushLog(cur, '[前端] ⏹ 手动停止');
  return { ok: true };
}

/**
 * 跑一次 deploy.sh（合并 → 转 GGUF → 量化）。
 * 被 deployTraining（手动）和 pumpDeploy（训练后自动）共用。
 */
async function runDeploy(job) {
  const adapter = String(job.adapter || '');
  if (!adapter) throw new Error('没有适配器路径');
  try {
    await fs.access(path.join(adapter, 'adapter_config.json'));
  } catch {
    throw new Error('找不到适配器：' + adapter + '/adapter_config.json');
  }
  const args = [path.join(LLM_DIR, 'deploy.sh'), '--adapter', adapter];
  if (job.version) args.push('--version', String(job.version));
  // 把训练用的基座传下去 —— 不传的话 deploy.sh 用自己的默认，
  // 一旦两者不一致就会「拿 A 的 LoRA 去合 B 的 config」，
  // 产出的 GGUF 元数据是坏的（踩过：qwen3-8b 的 LoRA 被合进 gemma4 的 config，
  // general.architecture=gemma4 而 block_count=48 ≠ Qwen3 的 36 层）。
  if (job.base) args.push('--base', String(job.base));

  await fs.mkdir(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, 'deploy-' + (job.fromId || Date.now()) + '.log');
  const logFd = openSync(logPath, 'a');
  if (job.item) pushLog(job.item, '[部署] 开始：合并 → 转 GGUF → 量化');
  const tail = [];
  const code = await new Promise((resolve) => {
    const p = spawn('bash', args, {
      cwd: LLM_DIR, env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    const onData = (buf) => {
      try { writeSync(logFd, buf); } catch { /* ignore */ }
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        if (job.item) pushLog(job.item, line);
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.stdout.on('error', () => {});
    p.stderr.on('error', () => {});
    p.on('error', () => resolve(-1));
    p.on('close', (c) => resolve(c));
  });
  if (code !== 0) {
    const why = tail.filter((l) => /❌|失败|error|Error|No space/.test(l)).slice(-3).join(' | ');
    throw new Error(`deploy.sh 退出码 ${code}${why ? '：' + why : ''}`);
  }
  // deploy.sh 最后会打一行带版本目录的输出，捞出来给前端
  const done = [...tail].reverse().find((l) => /部署完成|→\s*models\/registry|current/.test(l)) || '';
  return { logPath, done };
}

export async function deployTraining(o = {}) {
  const doneItems = queue.filter((i) => i.status === 'done' && i.outPath);
  const adapter = String(o.adapter || '').trim()
    || (doneItems.length ? path.join(doneItems[doneItems.length - 1].outPath, 'final') : '');
  if (!adapter) return { ok: false, error: '没有可部署的训练产物（先完成一次训练）' };
  try {
    await fs.access(path.join(adapter, 'adapter_config.json'));
  } catch (e) {
    return { ok: false, error: '找不到适配器：' + adapter + '/adapter_config.json' };
  }
  if (cur && cur.proc && cur.proc.exitCode === null) {
    return { ok: false, error: '训练还在跑，等它结束再部署' };
  }

  const args = [path.join(LLM_DIR, 'deploy.sh'), '--adapter', adapter];
  if (o.version) args.push('--version', String(o.version));

  const item = {
    id: 'deploy-' + Date.now(), title: '部署 ' + path.basename(path.dirname(adapter)),
    status: 'running', createdAt: Date.now(), log: [], proc: null, step: '',
    outPath: '', dataPath: '', error: '',
  };
  queue.push(item);
  cur = item;

  await fs.mkdir(LOG_DIR, { recursive: true });
  const logFd = openSync(path.join(LOG_DIR, item.id + '.log'), 'a');
  pushLog(item, '[前端] 开始部署：合并 → 转 GGUF → 量化');

  const p = spawn('bash', args, {
    cwd: LLM_DIR, env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  p.unref();
  item.proc = p;
  const onData = (buf) => {
    try { writeSync(logFd, buf); } catch (e) { /* ignore */ }
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (const line of lines) {
      if (line.trim()) {
        pushLog(item, line);
        if (/部署完成/.test(line)) item.status = 'done';
      }
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.stdout.on('error', () => {});
  p.stderr.on('error', () => {});
  p.on('close', (code) => {
    if (item.status !== 'done') {
      item.status = code === 0 ? 'done' : 'error';
      if (code !== 0) item.error = '部署退出码 ' + code;
    }
    cur = null;
  });
  return { ok: true, state: trainState(), adapter };
}
