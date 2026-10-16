// 本地 Ollama 的三件事：查状态 / 启动 / 常驻不卸载 / 立刻释放显存。
//
// 主页那三个按钮就是调这里：
//   🟢 启动 Ollama   → start()
//   📌 不关闭        → setKeepAlive(-1)  （模型常驻显存，不再自动卸载）
//   🧹 立刻释放显存  → freeNow()         （与 quit 命令用的是同一套逻辑）
//
// 只认回环地址：这些请求会打到 baseUrl 上，绝不能误发到别人的服务去。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 找 ollama 可执行文件。
 * Windows 上这台机器把它装在 D:\ollama\bin\ollama.exe，**并没有加进 PATH** ——
 * 直接 spawn('ollama') 会 ENOENT（而那个错误是异步事件，能把应用搞崩）。
 * 所以这里按顺序找：环境变量 → 本平台常见安装位置 → 最后才交给 PATH。
 * Linux / macOS 同理，候选换成 /usr/local/bin、/usr/bin、Snap 等。
 */
export function findOllamaExe() {
  const home = process.env.HOME || os.homedir();
  const win = process.platform === 'win32';
  const candidates = [
    process.env.OLLAMA_EXE,
    // Linux / macOS：发行版包、官方脚本、Snap 的常见位置
    !win && '/usr/local/bin/ollama',
    !win && '/usr/bin/ollama',
    !win && '/snap/bin/ollama',
    !win && '/opt/ollama/bin/ollama',
    !win && '/usr/share/ollama/.local/bin/ollama',
    !win && home ? path.join(home, '.local', 'bin', 'ollama') : '',
    // Windows
    win && 'D:\\ollama\\bin\\ollama.exe',
    win && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : '',
    win && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Ollama', 'ollama.exe') : '',
    win && 'C:\\Program Files\\Ollama\\ollama.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* 权限之类，跳过 */ }
  }
  return 'ollama';   // PATH
}

/**
 * 找模型目录（OLLAMA_MODELS）。
 * Windows 上模型在 D:\ollama\models，你平时的 start-ollama.cmd 里写着这一行；
 * **不带它的话** Ollama 会去默认的 %USERPROFILE%\.ollama\models 找，
 * 结果就是一句话：model 'xxx' not found（我上一版漏了这行，踩过）。
 * Linux 上默认是 ~/.ollama/models（systemd 服务版是 /usr/share/ollama/.ollama/models）。
 */
export function findOllamaModelsDir() {
  const home = process.env.HOME || os.homedir();
  const win = process.platform === 'win32';
  const candidates = [
    process.env.OLLAMA_MODELS,
    // Linux / macOS
    !win && home ? path.join(home, '.ollama', 'models') : '',
    !win && '/usr/share/ollama/.ollama/models',
    // Windows
    win && 'D:\\ollama\\models',
    win && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Ollama', 'models') : '',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* 跳过 */ }
  }
  return '';
}

/** 这个 Ollama 里现在有哪些模型（/api/tags）。 */
async function tagNames(base) {
  try {
    const j = await getJson(`${base}/api/tags`);
    return (j.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

/** 从 baseUrl 里取出本地 Ollama 的根地址；不是本地就返回 ''（调用方据此隐藏按钮）。 */
export function localOllamaBase(config) {
  const base = String(config?.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(base) ? base : '';
}

async function getJson(url, ms = 3000, init = null) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), ...(init || {}) });
  return res.json();
}

/**
 * 本机 Ollama 里装了哪些模型（给应用内的「切模型」用）。
 *
 * 为什么要 /api/show 逐个问：`/api/tags` 只有名字和大小，**没有"支不支持思考"** ——
 * 而 Qwen3 这代不关思考会先写一大段思考（慢 10 倍），所以切过去时必须知道该不该自动开「关掉思考」。
 * /api/show 只读清单和 GGUF 元数据，不加载模型，很快。
 */
export async function listLocalModels(config) {
  // 注意：**没在本地模式时也要能列** —— 你现在是云端，正是最想切到本地的时候。
  // 所以取不到配置里的本地地址就直接用默认端口。
  const base = localOllamaBase(config) || 'http://127.0.0.1:11434';
  let tags;
  try {
    tags = await getJson(`${base}/api/tags`, 5000);
  } catch {
    return { ok: false, base, models: [], error: `连不上本机 Ollama（${base}）—— 先点主页的「⚪ 启动」` };
  }
  const raw = Array.isArray(tags?.models) ? tags.models : [];
  const models = await Promise.all(raw.map(async (m) => {
    let caps = [];
    try {
      const info = await getJson(`${base}/api/show`, 8000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name }),
      });
      caps = Array.isArray(info?.capabilities) ? info.capabilities : [];
    } catch { /* 单个模型问不到就不带能力，不影响列表 */ }
    return {
      name: m.name,
      sizeBytes: m.size || 0,
      quant: m.details?.quantization_level || '',
      params: m.details?.parameter_size || '',
      family: m.details?.family || '',
      contextLength: m.details?.context_length || 0,
      modifiedAt: m.modified_at || '',
      capabilities: caps,
      thinking: caps.includes('thinking'),
      vision: caps.includes('vision'),
    };
  }));
  models.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { ok: true, base, models };
}

/** 当前状态：在不在跑、显存里有哪些模型、现在是常驻还是自动卸载、在用的模型可用吗。 */
export async function status(config) {
  const base = localOllamaBase(config);
  const keepAlive = config?.keepAlive ?? null;
  const want = String(config?.model || '');
  if (!base) return { local: false, up: false, base: '', models: [], keepAlive, model: want, ready: false, available: [] };
  try {
    const [ver, ps, tags] = await Promise.all([
      getJson(`${base}/api/version`).catch(() => null),
      getJson(`${base}/api/ps`).catch(() => null),
      getJson(`${base}/api/tags`).catch(() => null),
    ]);
    const models = (ps?.models || []).map((m) => ({
      name: m.name,
      sizeVram: m.size_vram || 0,
      expiresAt: m.expires_at || '',
    }));
    const available = (tags?.models || []).map((m) => m.name);
    const sameName = (a, b) => a === b || a.split(':')[0] === b.split(':')[0];
    return {
      local: true,
      up: Boolean(ver),
      base,
      version: ver?.version || '',
      models,
      keepAlive,
      model: want,
      // 「可用吗」= 这个 Ollama 认识它
      known: want ? available.some((n) => sameName(n, want)) : false,
      // 「准备好了吗」= 已经在显存里（预热完成）
      ready: want ? models.some((m) => sameName(m.name, want)) : false,
      available,
    };
  } catch {
    return { local: true, up: false, base, models: [], keepAlive, model: want, known: false, ready: false, available: [] };
  }
}

/**
 * 「关掉思考」得**按模型分派** —— 两种模型的开关完全不是一回事（2026-10-06 实测）：
 *
 *   · Qwen3 这代：只认 **system 里的 `/no_think`**（think:false 被忽略，见 HANDOFF §5）
 *   · DeepSeek-R1 这代这类推理模型：system 里的 `/no_think` **完全无效**
 *     （实测：思考 462 字、正文 0 字），但 **Ollama 官方的请求体 `think: false` 有效**
 *     （思考 275 字、正文正常出来）
 *
 * 所以"支持思考"这个 capability 不能直接等价于"该注入 /no_think" ——
 * 应用内切模型时如果按 capability 自动勾「关掉思考」，对 R1 就是"看着开了其实没用"。
 * 返回 'no_think'（往 system 里加）或 'think_false'（往请求体里加），由调用方各自实现。
 */
export function thinkControl(model) {
  const m = String(model || '');
  if (/qwen3/i.test(m)) return 'no_think';
  if (/(deepseek[-_.]?r1|r1[-_.]?distill|qwq|reasoning)/i.test(m)) return 'think_false';
  return 'no_think';   // 认不出来就沿用老行为（至少不会比现在更差）
}

/**
 * 把"预热失败"翻译成人话。
 *
 * 最坑的一类：**模型装不进显存**时 Ollama 不会干净地报 OOM，而是 llama-server 直接崩：
 *   HTTP 500
 *   {"error":"llama-server process has terminated: exit status 0xc0000409 ...
 *             CUDA error: shared object initialization failed"}
 * （2026-10-06 实测：15.7GB 的 Q8 在 num_ctx 8192 下必崩、预热按钮就是这个报错；
 *   同一时刻 8.1GB / 12.1GB 那两个 14B 加载完全正常，把它压到 num_ctx 6144 也就好了。）
 * 光把 JSON 甩给用户等于没说，所以这里翻译成"可能是什么 + 怎么救"。
 */
export function describePreloadFailure(status, detail) {
  const raw = String(detail || '').slice(0, 220);
  if (/llama-server process has terminated|CUDA error|exit status 0x/i.test(raw)) {
    return '预热失败：模型加载时崩了（CUDA 初始化失败）—— 最常见的原因是**这个模型装不进显存**。'
      + '可以试：① 换个小一点的模型（8.1GB 的 IQ4_XS / 12.1GB 的 Q6_K 都比它小）；'
      + '② 把上下文调小（在模型的 Modelfile 里把 num_ctx 改小，再 ollama create 一次）；'
      + '③ 先关掉占显存的程序再点一次。'
      + `原始错误：${raw}`;
  }
  return `预热失败（HTTP ${status}）${raw}`;
}

/**
 * 预启动模型：把模型**加载进显存**（不发问题、不生成），
 * 这样真正开聊时是热的（冷启动 40~60 秒，热了 3~9 秒）。
 * 用的是原生 /api/generate 空 prompt —— Ollama 会只做加载。
 */
export async function preload(config) {
  const base = localOllamaBase(config);
  if (!base) return { ok: false, error: '当前不是本地模型地址，预热用不上' };
  const model = String(config?.model || '').trim();
  if (!model) return { ok: false, error: '设置里没填模型名' };

  const before = await status(config);
  if (!before.up) return { ok: false, error: 'Ollama 还没在跑 —— 先点 🟢 启动它' };
  if (!before.known) {
    return {
      ok: false,
      error: `这个 Ollama 不认识模型 ${model}（它现在只有：${before.available.join('、') || '空'}）。`
        + `多半是启动时没带 OLLAMA_MODELS（应该是 ${findOllamaModelsDir() || '你的模型目录'}）。`,
    };
  }
  if (before.ready) {
    return { ok: true, already: true, seconds: 0, ...(await status(config)), message: `${model} 已经在显存里了，可以直接开聊` };
  }

  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keep_alive 跟着设置走：不设就用 2m（跟你的 start-ollama.cmd 一致）
      body: JSON.stringify({ model, prompt: '', keep_alive: config?.keepAlive ?? '2m' }),
      signal: AbortSignal.timeout(600000),   // 14B 冷加载可能要一分钟以上
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      return { ok: false, error: describePreloadFailure(res.status, detail) };
    }
    await res.text();
  } catch (err) {
    return { ok: false, error: `预热失败：${err.name === 'TimeoutError' ? '超过 10 分钟还没加载完' : err.message}` };
  }

  const seconds = Math.round((Date.now() - t0) / 10) / 100;
  const after = await status(config);
  return {
    ok: true,
    seconds,
    ...after,
    message: after.ready
      ? `${model} 已就绪（加载用了 ${seconds} 秒），现在开聊是热的`
      : `${model} 加载完了，但 /api/ps 里没看到它 —— 可能立刻被卸载了（keep-alive 设太短？）`,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 没在跑就把 `ollama serve` 拉起来（脱离本进程，应用关了它也还在）。
 * 已经在跑就直接返回（幂等）。等到 /api/version 有响应才算成功。
 */
export async function start(config) {
  const base = localOllamaBase(config);
  if (!base) return { ok: false, error: '当前不是本地模型地址，这两个按钮用不上' };
  const cfgModel = String(config?.model || '');
  const before = await status(config);

  // 已经在跑：顺便确认它里面**有没有你在用的那个模型** ——
  // 没有的话十有八九是模型目录不对（见 findOllamaModelsDir 的注释），这里直接说清楚。
  if (before.up) {
    if (cfgModel) {
      const names = await tagNames(base);
      const hit = names.some((n) => n === cfgModel || n.split(':')[0] === cfgModel.split(':')[0]);
      if (!hit) {
        const dir = findOllamaModelsDir();
        return {
          ok: false,
          up: true,
          error: `Ollama 在跑，但里面没有模型 ${cfgModel}（它现在只有：${names.join('、') || '空'}）。`
            + `多半是这个 Ollama 启动时没带 OLLAMA_MODELS${dir ? `（应该是 ${dir}）` : ''}。`
            + '把它关掉（关掉那个 ollama 窗口），再点一次这个按钮。',
        };
      }
    }
    return { ok: true, started: false, message: 'Ollama 已经在跑了' };
  }

  const env = { ...process.env };
  // ★ 三行环境变量跟你 D:\ollama\start-ollama.cmd 保持一致。
  //   漏掉 OLLAMA_MODELS 是最要命的：服务起得来，但一个模型都看不到。
  const modelsDir = findOllamaModelsDir();
  if (modelsDir) env.OLLAMA_MODELS = modelsDir;
  // 常驻按钮设了 -1 就用 -1，否则跟你的脚本一样 2m
  env.OLLAMA_KEEP_ALIVE = String(config?.keepAlive ?? '2m');
  if (!env.OLLAMA_HOST) env.OLLAMA_HOST = base.replace(/^https?:\/\//, '');
  // ⚠ spawn 找不到可执行文件（ENOENT）时**不抛异常**，而是异步 emit 一个 'error' 事件：
  // try/catch 抓不到它，不监听就是**未捕获异常 → 整个本地AI对话工作台进程崩掉** ——
  // 表现就是点完按钮浏览器报 "Failed to fetch"（服务已经没了）。必须接住。
  let spawnErr = null;
  const exe = findOllamaExe();
  const child = spawn(exe, ['serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.on('error', (err) => { spawnErr = err; });
  child.unref();

  // 最多等 20 秒；spawn 一报错就立刻返回，不用干等
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    if (spawnErr) {
      return {
        ok: false,
        error: `起不来 ollama serve（${exe}）：${spawnErr.code === 'ENOENT'
          ? '找不到这个可执行文件 —— 装上 Ollama，或用 OLLAMA_EXE 环境变量指定它的完整路径'
          : spawnErr.message}`,
      };
    }
    const now = await status(config);
    if (now.up) {
      // 起来了还不够：确认模型目录对不对（对的话能看到你在用的模型）
      let extra = '';
      if (cfgModel) {
        const names = await tagNames(base);
        const hit = names.some((n) => n === cfgModel || n.split(':')[0] === cfgModel.split(':')[0]);
        if (!hit) {
          extra = ` —— ⚠ 但它里面没有模型 ${cfgModel}（现在有：${names.join('、') || '空'}），`
            + `检查 OLLAMA_MODELS 是不是指到了 ${modelsDir || '正确的模型目录'}`;
        }
      }
      return { ok: true, started: true, message: `Ollama 已启动（${now.version || '版本未知'}）${extra}` };
    }
  }
  return { ok: false, error: `等 20 秒还没就绪（用 ${exe} 启动的），看一眼端口是不是被占` };
}

/**
 * 改 keep-alive 并让它**立刻**对已加载的模型生效。
 * value = -1 表示永不卸载（常驻）；'2m' / 0 之类就是常规时长。
 */
export async function setKeepAlive(config, value) {
  const base = localOllamaBase(config);
  if (!base) return { ok: false, error: '当前不是本地模型地址' };
  const st = await status(config);
  let touched = 0;
  for (const m of st.models) {
    try {
      await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: value, prompt: '' }),
        signal: AbortSignal.timeout(15000),
      });
      touched += 1;
    } catch { /* 单个失败不影响别的 */ }
  }
  return { ok: true, touched, value, message: touched ? `已对 ${touched} 个已加载模型生效` : '当前没有已加载的模型，下次生成时生效' };
}

/** 立刻把显存里的模型全卸掉（和 quit 命令同一套）。 */
export async function freeNow(config) {
  const base = localOllamaBase(config);
  if (!base) return { ok: false, error: '当前不是本地模型地址' };
  const st = await status(config);
  const before = st.models.length;
  let n = 0;
  for (const m of st.models) {
    try {
      await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0, prompt: '' }),
        signal: AbortSignal.timeout(15000),
      });
      n += 1;
    } catch { /* ignore */ }
  }
  // 卸载后再查一次：报**实际结果**，而不是"我发了几个请求"。
  // 原来只看请求数，连点两下时会先看到"释放了 1 个"、紧接着"本来就没有"，
  // 看起来像自相矛盾（其实是第二次点的时候第一个已经卸完了）。
  let after = 0;
  try {
    await new Promise((r) => setTimeout(r, 300));
    after = (await status(config)).models.length;
  } catch { after = 0; }
  const message = before === 0
    ? '显存里本来就没有模型（不用释放）'
    : after === 0
      ? `已释放 ${before} 个模型，显存现在是空的`
      : `释放了 ${before - after} 个，还剩 ${after} 个没卸掉（再点一次试试）`;
  return { ok: true, unloaded: before - after, before, after, message };
}
