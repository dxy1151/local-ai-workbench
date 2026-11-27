// ============================================================================
//  GPU 显存管理：训练前确保有足够显存
//
//  这台机器上会抢显存的常客：
//    - ComfyUI（systemd --user 服务），加载模型后能占 9 GB+
//    - Ollama（加载中的模型）
//    - llama-server(8080)
//    - 桌面本身（gnome-shell / 浏览器约 1 GB）
//
//  策略：训练需要约 12 GB，先卸载可卸载的；还不够再临时停 ComfyUI，
//  并记住停过哪些，训练结束后自动恢复（不替用户做永久决定）。
// ============================================================================
import { execFile, execFileSync } from 'node:child_process';

const REQUIRED_GB = Number(process.env.TRAIN_REQUIRED_GB || 12);

function sh(cmd, args, ms = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms }, (err, stdout) => resolve({ ok: !err, out: String(stdout || ''), err }));
  });
}

/** 查询 GPU 显存（单位 GB）。返回 null 表示查不到（没有 nvidia-smi 或驱动问题）。 */
export async function gpuMemory() {
  const r = await sh('nvidia-smi', ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits']);
  if (!r.ok) return null;
  const line = r.out.trim().split('\n')[0];
  if (!line) return null;
  const [total, used, free] = line.split(',').map((x) => Number(x.trim()));
  if (!Number.isFinite(total)) return null;
  return { totalMB: total, usedMB: used, freeMB: free, freeGB: free / 1024, totalGB: total / 1024 };
}

/** 谁在占显存（进程列表）。 */
export async function gpuProcesses() {
  const r = await sh('nvidia-smi', ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']);
  if (!r.ok) return [];
  return r.out.trim().split('\n').filter(Boolean).map((line) => {
    const [pid, name, mem] = line.split(',').map((x) => x.trim());
    return { pid: Number(pid), name: name || '', memMB: Number(mem) || 0 };
  });
}

async function systemctl(...args) {
  return sh('systemctl', ['--user', ...args, '--no-ask-password'], 20000);
}

async function userServiceActive(unit) {
  const r = await systemctl('is-active', unit);
  return r.out.trim() === 'active';
}

/**
 * 为训练腾显存。返回 { ok, mem, freed: [...], restoredLater: [...] , note }
 * 已经停掉的服务记在 returned.stopped 里，训练结束后调用 restoreGpu() 恢复。
 */
export async function prepareGpuForTraining() {
  const before = await gpuMemory();
  if (!before) {
    return { ok: true, mem: null, stopped: [], note: '查不到 nvidia-smi 显存信息（可能沙箱/驱动问题），跳过显存检查' };
  }
  const stopped = [];
  const notes = [];

  if (before.freeGB >= REQUIRED_GB) {
    return { ok: true, mem: before, stopped, note: `显存充足（空闲 ${before.freeGB.toFixed(1)} GB ≥ ${REQUIRED_GB} GB），无需进一步释放` };
  }

  // 0) 先停 gemma 的 llama-server：它常驻占 ~10 GB（xingye-chat 手写生成的草稿服务），
  //    训练一加载 4bit 8B 就撞 OOM。训练结束后由 restoreGpu 拉回来。
  if (await userServiceActive('gemma-server')) {
    const r = await systemctl('stop', 'gemma-server');
    if (r.ok) {
      stopped.push({ unit: 'gemma-server', wasActive: true });
      notes.push('已临时停止 gemma-server（手写生成的草稿服务），训练结束后会自动恢复');
    } else {
      notes.push('尝试停止 gemma-server 失败，可能需要手动 `systemctl --user stop gemma-server`');
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 400));
      const now = await gpuMemory();
      if (now && now.freeGB >= REQUIRED_GB) break;
    }
  }

  // 1) 再停 ComfyUI（最有可能是那 9 GB 的元凶）
  if (await userServiceActive('comfyui')) {
    const processes = await gpuProcesses();
    const comfyOnGpu = processes.some((p) => /ComfyUI/i.test(p.name));
    const r = await systemctl('stop', 'comfyui');
    if (r.ok) {
      stopped.push({ unit: 'comfyui', wasActive: true });
      notes.push(`已临时停止 ComfyUI${comfyOnGpu ? '（它正占着 GPU）' : ''}，训练结束后会自动恢复`);
    } else {
      notes.push('尝试停止 ComfyUI 失败，可能需要手动 `systemctl --user stop comfyui`');
    }
    // 等显存真正释放
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 400));
      const now = await gpuMemory();
      if (now && now.freeGB >= REQUIRED_GB) break;
    }
  }

  const after = await gpuMemory();
  const ok = after ? after.freeGB >= REQUIRED_GB : true;
  if (!ok) {
    const procs = await gpuProcesses();
    const top = procs.sort((a, b) => b.memMB - a.memMB).slice(0, 3)
      .map((p) => `${p.name.split('/').pop()}(PID ${p.pid}, ${(p.memMB / 1024).toFixed(1)}G)`).join('、');
    notes.push(`⚠ 释放后仍只有 ${after.freeGB.toFixed(1)} GB 空闲（需要 ${REQUIRED_GB} GB）。占用大户：${top || '未知'}`);
  } else if (after) {
    notes.push(`显存已就绪：空闲 ${after.freeGB.toFixed(1)} GB`);
  }

  return { ok, mem: after, stopped, note: notes.join('；') };
}

/** 训练结束后把停掉的服务拉回来。 */
export async function restoreGpu(stopped = []) {
  const restored = [];
  for (const s of stopped) {
    if (s.wasActive && s.unit) {
      const r = await systemctl('start', s.unit);
      restored.push({ unit: s.unit, ok: r.ok });
    }
  }
  return restored;
}

// ============================================================================
//  Ollama / llama-server 的显存管理
// ============================================================================
const OLLAMA = process.env.OLLAMA_HOST_URL || 'http://127.0.0.1:11434';

async function oj(url, init = null, ms = 4000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), ...(init || {}) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 当前 Ollama 里占着显存的模型（/api/ps）。返回 null 表示连不上。 */
export async function ollamaLoaded() {
  try {
    const d = await oj(`${OLLAMA}/api/ps`);
    return (d.models || []).map((m) => ({ name: m.name, sizeVram: m.size_vram || m.size || 0 }));
  } catch {
    return null;
  }
}

/** 把 Ollama 里所有已加载模型卸掉（keep_alive: 0）。 */
export async function unloadOllama() {
  const before = await ollamaLoaded();
  if (before === null) {
    return { ok: true, up: false, before: [], after: [], freed: 0, note: '连不上 Ollama（可能没启动），无需卸载' };
  }
  if (!before.length) {
    return { ok: true, up: true, before: [], after: [], freed: 0, note: 'Ollama 里没有加载中的模型' };
  }
  const freed = before.reduce((n, m) => n + m.sizeVram, 0);
  let sent = 0;
  await Promise.all(before.map(async (m) => {
    try {
      await oj(`${OLLAMA}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0, prompt: '' }),
      }, 15000);
      sent += 1;
    } catch { /* 单个失败不影响其它 */ }
  }));
  await new Promise((r) => setTimeout(r, 600));
  const after = (await ollamaLoaded()) || [];
  return {
    ok: after.length === 0, up: true, before, after, freed, sent,
    note: after.length === 0
      ? `已卸载 ${before.length} 个模型，释放约 ${(freed / 1e9).toFixed(1)} GB 显存`
      : `发了 ${sent} 个卸载请求，但仍有 ${after.length} 个模型在显存里`,
  };
}

/** 这台机器上会常驻抢显存的 systemd 用户服务（都是 12B，16G 卡只能留一个）。
 *  gemma-server（:18080，手写素材用）、llama-gemma4（:8080，本地 gemma4 聊天）。
 *  它们按需能再起，所以腾显存时停掉是安全的。 */
const GPU_SERVICES = ['gemma-server', 'llama-gemma4'];

async function serviceActive(name) {
  const r = await sh('systemctl', ['--user', 'is-active', name]);
  const st = String(r.out).trim();
  // activating / reloading / deactivating 都算"活着"：它们随时会把显存吃掉，
  // 只判 === 'active' 会漏掉正在加载的（实测 llama-gemma4 卡在 activating 没被停）。
  return ['active', 'activating', 'reloading', 'deactivating'].includes(st);
}

/** 停掉除了 keep 里列出的其它 llama-server 服务，返回停掉的名单。 */
export async function stopLlamaServicesExcept(keep = []) {
  const stopped = [];
  for (const name of GPU_SERVICES) {
    if (keep.includes(name)) continue;
    if (!(await serviceActive(name))) continue;
    const r = await sh('systemctl', ['--user', 'stop', name], 25000);
    if (r.ok) stopped.push(name);
  }
  return stopped;
}

/**
 * 聊天前确保本机 Ollama 有地方加载模型。
 *
 * 背景：用户这台机器上曾同时启着 gemma-server + llama-gemma4 + Ollama 三个 12B，
 * 16G 显卡直接爆（表现为「又爆显存了」）。聊天走 Ollama 时，先把那两个常驻
 * llama-server 停掉（它们需要时会自动/按需再起），并等显存真正释放。
 *
 * @param {number} needGB 需要多少空闲显存（GB）
 * @returns {Promise<{ok:boolean, freed:string[], freeGB:number|null}>}
 */
export async function ensureVramForOllama(needGB = 1.5) {
  // 16G 卡只能容一个 12B：只要那两个常驻 llama-server 服务还活着，就先停掉它们。
  // （不看 needGB：它们就算「还没加载完」也马上会占满，等能看到显存不够时就晚了。）
  const freed = await stopLlamaServicesExcept();
  if (freed.length) {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 800));
      const m = await gpuMemory();
      if (m && m.freeGB >= needGB) break;
    }
  }
  const after = await gpuMemory();
  return { ok: Boolean(after && after.freeGB >= needGB), freed, freeGB: after ? after.freeGB : null };
}

/** llama-server 是否健康（gemma 聊天 / 手写素材用：18080 或 8080）。 */
export async function llamaServerUp(port = 8080) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 停掉 llama-server（只杀监听 8080 的那个进程）。训练前腾卡用。 */
export async function stopLlamaServer() {
  return new Promise((resolve) => {
    execFile('pkill', ['-f', 'llama-server.*--port 8080'], (err) => {
      resolve({ ok: !err, note: err ? '没在跑（或没权限停止）' : '已停止 llama-server，显存已释放' });
    });
  });
}

/**
 * 停掉**所有**工作台认识的 llama-server（v2.4.8）。
 *
 * 和上面 stopLlamaServer 的区别：那个只杀 8080（gemma），
 * 这个杀 8080 / 8081 / 18080 全部 —— 用户点「释放显存」时，
 * 8081 上那个 27B（13~14 GB）才是占显存的大头，只杀 8080 等于没清。
 *
 * 顺带把 pkill 自己排除掉：`pkill -f "llama-server"` 在某些 shell 下会匹配到
 * 正在执行的这条命令本身（命令行里就含这个字符串）。
 *
 * @returns {Promise<{ok:boolean, stopped:boolean, killed:number, note:string}>}
 */
export async function stopAllLlamaServers() {
  const pats = [
    'llama-server.*--port 8080',
    'llama-server.*--port 8081',
    'llama-server.*--port 18080',
  ];
  let killed = 0;
  for (const pat of pats) {
    const n = await new Promise((resolve) => {
      // -c：只数，先看有几个
      execFile('pgrep', ['-f', pat], (err, stdout) => {
        resolve(err ? 0 : String(stdout || '').trim().split('\n').filter(Boolean).length);
      });
    });
    if (!n) continue;
    await new Promise((resolve) => {
      execFile('pkill', ['-f', pat], () => resolve());
    });
    killed += n;
  }
  if (!killed) return { ok: true, stopped: false, killed: 0, note: 'llama-server 没在跑' };
  // 等进程真的退出、显存还回来（pkill 是异步的，立刻测量不准）
  await new Promise((r) => setTimeout(r, 1500));
  return { ok: true, stopped: true, killed, note: `已停止 ${killed} 个 llama-server` };
}

// ============================================================================
//  显存自动调度（v1.4.0）：聊天 / 出图（ComfyUI）/ 手写素材（llama）之间自动卸载与重启
//
//  用户要求："做自动卸载和重启 ollama/comfyui/llama"。
//  策略：谁要用显卡谁优先，其他家先卸掉，用完再拉回来；ComfyUI 优先用它的 /free
//  卸模型（服务不杀，下次出图自己重新加载），实在不行才临时停服务、聊天结束后再起。
// ============================================================================
const COMFY = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';

/** ComfyUI 在线吗（/system_stats 能通）。 */
export async function comfyUp() {
  try {
    const r = await fetch(`${COMFY}/system_stats`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** ComfyUI 的进程是否占着显存。 */
export async function comfyOnGpu() {
  const ps = await gpuProcesses();
  return ps.some((p) => /ComfyUI/i.test(p.name));
}

/**
 * 让 ComfyUI 把已加载的模型卸掉（不杀进程）。
 * 用它自带的 /free 接口；下次点「生成」ComfyUI 会自己重新加载模型，用户无感。
 */
export async function comfyUnloadModels() {
  try {
    const r = await fetch(`${COMFY}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(6000),
    });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Ollama 服务健康吗。 */
export async function ollamaHealthy() {
  try {
    // v2.6.7：**别用 /api/tags 探活**。模型库在机械盘上时它要 12~55 秒才回（实测 106 blob / 276G），
    // 2 秒超时必然判"掉线"→ 反复重启 Ollama → 正在加载的 27B 永远加载不完。
    // /api/version 是即时的，探活用它就够了。
    await oj(`${OLLAMA}/api/version`, null, 2500);
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保 Ollama 在线；掉线就自动重启（用户要求"自动重启 ollama"）。
 * @returns {Promise<{ok:boolean, restarted:boolean, note:string}>}
 */
export async function ensureOllamaRunning() {
  if (await ollamaHealthy()) return { ok: true, restarted: false, note: 'Ollama 正常' };
  const r = await systemctl('restart', 'ollama');
  for (let i = 0; i < 20; i += 1) {
    await new Promise((res) => setTimeout(res, 700));
    if (await ollamaHealthy()) return { ok: true, restarted: true, note: 'Ollama 掉线，已自动重启' };
  }
  return { ok: await ollamaHealthy(), restarted: true, note: r.ok ? 'Ollama 重启后仍连不上' : 'Ollama 重启失败' };
}

/** 卸掉 Ollama 里除 keep 之外的模型（keep 按名字前缀匹配）。 */
export async function unloadOllamaExcept(keep = []) {
  const loaded = await ollamaLoaded();
  if (!loaded) return { ok: true, unloaded: [] };
  const keepList = (Array.isArray(keep) ? keep : []).map((x) => String(x || '').trim()).filter(Boolean);
  const isKeep = (name) => keepList.some((k) => name === k || name.split(':')[0] === k.split(':')[0]);
  const targets = loaded.filter((m) => !isKeep(m.name));
  for (const m of targets) {
    try {
      await oj(`${OLLAMA}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0, prompt: '' }),
      }, 15000);
    } catch { /* 单个失败不影响其它 */ }
  }
  return { ok: true, unloaded: targets.map((m) => m.name) };
}

/**
 * 聊天前自动调度显存（v1.4.0）。
 *
 * 顺序（每一步做完都重新量显存，够了就停）：
 *   ① Ollama 掉线 → 重启
 *   ② 停常驻 llama-server（gemma-server / llama-gemma4）
 *   ③ 卸 Ollama 里除聊天模型/embedding 外的模型
 *   ④ ComfyUI 占着显存 → 调 /free 卸模型（服务不杀，下次出图自动重载）
 *   ⑤ 还不够 → 临时停 comfyui 服务（记进 stoppedServices，聊天空闲后自动重启）
 *   ⑥ 最后把 embedding 也卸掉保聊天
 *
 * @returns {{ok:boolean, actions:string[], stoppedServices:Array<{unit:string,wasActive:boolean}>, freeGB:number|null}}
 */
export async function arbitrateForChat({ needGB = 1.2, targetModel = '', embedModel = '', noUnload = false } = {}) {
  const actions = [];
  const stoppedServices = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ensure = async () => { const m = await gpuMemory(); return m ? m.freeGB : null; };
  let free = await ensure();

  // ① Ollama 服务
  const ol = await ensureOllamaRunning();
  if (ol.restarted) actions.push(ol.note);

  // v2.6.8：常驻模式（keepAlive = -1）下**不主动卸载任何东西** —— 用户明确要求
  // 「模型留着，除非我点卸载」。只保留 ① 的在线检查；停 llama / 卸其它模型 /
  // ComfyUI / embedding 全部跳过。（手动点 /api/gpu/arbitrate 仍走完整流程。）
  if (noUnload) {
    return { ok: true, actions, stoppedServices, freeGB: free, skippedUnload: true };
  }

  // ② 常驻 llama-server
  if (free === null || free < needGB) {
    const svc = await stopLlamaServicesExcept();
    if (svc.length) actions.push(`停常驻 llama-server：${svc.join('、')}`);
    await wait(600);
    free = await ensure();
  }

  // ③ Ollama 里别的模型
  if (free !== null && free < needGB) {
    const a = await unloadOllamaExcept([targetModel, embedModel].filter(Boolean));
    if (a.unloaded.length) actions.push(`卸 Ollama 其它模型：${a.unloaded.join('、')}`);
    await wait(600);
    free = await ensure();
  }

  // ④ ComfyUI 卸模型（不杀进程）
  if (free !== null && free < needGB && (await comfyUp())) {
    const c = await comfyUnloadModels();
    if (c.ok) {
      actions.push('ComfyUI 卸掉模型（/free，下次出图自动重载）');
      await wait(1200);
      free = await ensure();
    }
  }

  // ⑤ 临时停 ComfyUI 服务
  if (free !== null && free < needGB && (await userServiceActive('comfyui'))) {
    const r = await systemctl('stop', 'comfyui');
    if (r.ok) {
      stoppedServices.push({ unit: 'comfyui', wasActive: true });
      actions.push('ComfyUI 占着显存，已临时停服务（聊天空闲后自动重启）');
      await wait(1500);
      free = await ensure();
    }
  }

  // ⑥ 保聊天：embedding 也卸
  if (free !== null && free < needGB) {
    const a = await unloadOllamaExcept([targetModel].filter(Boolean));
    if (a.unloaded.length) actions.push(`再卸 Ollama 模型：${a.unloaded.join('、')}`);
    await wait(600);
    free = await ensure();
  }

  return { ok: free === null ? false : free >= needGB, actions, stoppedServices, freeGB: free === null ? null : Math.round(free * 10) / 10 };
}

/** 聊天空闲后把临时停掉的服务拉回来。 */
export async function restoreGpuAfterChat(stoppedServices = []) {
  const restored = [];
  for (const s of stoppedServices) {
    if (!s || !s.unit || !s.wasActive) continue;
    const r = await systemctl('start', s.unit);
    restored.push({ unit: s.unit, ok: r.ok });
  }
  return restored;
}

/** 给前端/接口看的一眼状态。 */
export async function gpuArbiterStatus() {
  const mem = await gpuMemory();
  const loaded = await ollamaLoaded();
  return {
    mem,
    ollamaUp: loaded !== null,
    ollamaLoaded: loaded || [],
    comfyUp: await comfyUp(),
    comfyOnGpu: await comfyOnGpu(),
    llamaServers: {
      gemmaServer: await userServiceActive('gemma-server'),
      llamaGemma4: await userServiceActive('llama-gemma4'),
    },
  };
}
