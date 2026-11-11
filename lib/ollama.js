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
import { isLocalBaseUrl } from './net.js';
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

/**
 * 本地模型的重复惩罚（v2.3.15）。
 * Ollama 默认 1.1 对 8B 中文角色扮演太松：一旦句式固定下来就会原地复读，
 * 短上下文看不出来，历史一长就成片出现（见 streamChatNative 里的实测记录）。
 * 1.3 是实测出来的平衡点；想更狠可以调到 1.5，代价是话变短变干。
 */
export const REPEAT_PENALTY = 1.1;

/** 从 baseUrl 里取出本地 Ollama 的根地址；不是本地就返回 ''（调用方据此隐藏按钮）。 */
// 「这个 baseUrl 真的是 Ollama 吗」——带缓存探活。
// 只靠 localOllamaBase 判断主机名是不够的：llama-server 也跑在 127.0.0.1，
// 会被误当成 Ollama 去调 /api/chat，结果 404（踩过：切 gemma 后工作台回空）。
const ollamaProbe = new Map();
// 每个 base 上一个模型「思考」能力缓存的 key：`<base>|<model>`
const thinkCapCache = new Map();

/**
 * 问 Ollama「这个模型到底怎么关思考」——**以服务端自己说的为准，不猜模型名**。
 *
 * v2.4.1：原来 thinkControl() 是按模型名硬编码的（/qwen3/、/gemma3/…），
 *   问题有两个：① 认不出来的名字一律走 think_false，等于把 1/8 的命中率当默认；
 *   ② 微调版/newer 版本换了模板之后，代码里的名字表完全跟不上，用户只能"点开关没反应"。
 *
 * 现在改成：拉一次 `/api/show`，看这份模型真正的能力与模板：
 *   · caps 里有 'thinking'        → 服务端支持思考，think:false 是可以关的
 *   · 模板/参数里出现 enable_thinking → 同上（有些实现只体现在模板里）
 *   · 模板里出现 /no_think        → system 软开关这条也可能有效
 *   · 都没有                      → 这个模型根本没有思考，无所谓关不关
 *
 * 返回 { supportsThinking, thinkField, noThinkPrompt, source }，缓存 5 分钟
 * （模型装/换不会发生在请求路径上，缓存过期重探一次足够）。
 * 探测失败（离线、非 Ollama、/api/show 不认）→ 全部 false，调用方据此决定"没什么可关的"。
 */
export async function probeThinkCapability(config, ms = 1500) {
  const base = localOllamaBase(config);
  const model = String(config?.model || '');
  if (!base || !model) return { supportsThinking: false, thinkField: false, noThinkPrompt: false, source: 'no-backend' };
  const key = `${base}|${model}`;
  const hit = thinkCapCache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl ?? 300000)) return hit.cap;
  const cap = { supportsThinking: false, thinkField: false, noThinkPrompt: false, source: 'probe-failed' };
  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(ms),
    });
    if (res.ok) {
      const j = await res.json();
      const caps = Array.isArray(j?.capabilities) ? j.capabilities.map((x) => String(x)) : [];
      // 模板可能出现在 template 字段，也可能藏在 model_info / details 里，能拿到的都拼起来看
      const blob = JSON.stringify(j || {});
      const hasThinkingCap = caps.includes('thinking');
      const hasEnableThinking = /enable_thinking|thinking/i.test(j?.template || '') || /enable_thinking/i.test(blob);
      const noThinkPrompt = /no_think/i.test(j?.template || '') || /no_think/i.test(blob);
      cap.supportsThinking = hasThinkingCap || hasEnableThinking;
      // 支持思考 → 请求体 think:false 是 Ollama 官方开关（不认识的模板会忽略，无害）
      cap.thinkField = cap.supportsThinking;
      cap.noThinkPrompt = noThinkPrompt;
      cap.source = hasThinkingCap ? 'api-show:capabilities' : (hasEnableThinking ? 'api-show:template' : 'api-show:no-thinking');
    }
  } catch { /* 离线 / 非 Ollama：保持 probe-failed */ }
  // v2.4.1：和 isOllamaBase 一个道理 —— **探测失败的结论不能长期缓存**。
  //   服务刚起来 / Ollama 还没拉起时探一次失败，如果缓存 5 分钟，
  //   用户这一整段时间里"点关思考都没反应"，而且看不出为什么。
  //   成功（或服务端明确回答了）才缓存 5 分钟；失败只压 5 秒。
  const ok = cap.source.startsWith('api-show');
  thinkCapCache.set(key, { cap, at: Date.now(), ttl: ok ? 300000 : 5000 });
  return cap;
}

/** 清掉思考能力缓存（换模型 / 测试用）。 */
export function clearThinkCapCache() { thinkCapCache.clear(); }

/**
 * 清掉探活缓存（v2.4.1）。
 *
 * 为什么要这个函数：探活按 host:port 缓存 60 秒，而**同一个端口可能先后是不同的服务**
 * （换后端、或测试里起一个 OpenAI 兼容的 mock）。不清缓存就会在换过去之后
 * 仍然按"这是 Ollama"处理 —— 冒烟测试里实测到过：mock 先被当成 Ollama 走了 /api/chat。
 */
export function clearOllamaProbe(base = '') {
  if (base) ollamaProbe.delete(base);
  else ollamaProbe.clear();
}
export async function isOllamaBase(config, ms = 1200) {
  const base = localOllamaBase(config);
  if (!base) return false;
  const hit = ollamaProbe.get(base);
  // v2.4.1 审计修复：**成功**结果缓存 60 秒没问题（探活开销省下来），
  //   但**失败**的结果也缓存 60 秒就很坑：Ollama 刚启动、或机器刚开机 Ollama 还没起来时
  //   第一秒探到 ECONNREFUSED，接下来整整一分钟都会按"这不是 Ollama"处理 ——
  //   本机 Ollama 被当成 OpenAI 兼容服务去打 /v1/chat/completions，用户看到的就是"回空/报错"。
  //   实测在冒烟测试里更明显：一个连不上的端口先把结论缓存住，60 秒内的后续请求全走错分支。
  //   现在负结果只缓存 NEGATIVE_TTL（3 秒），失败本来就便宜，重探一次无妨。
  const ttl = hit?.ok ? 60000 : 3000;
  if (hit && Date.now() - hit.at < ttl) return hit.ok;
  let ok = false;
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(ms) });
    ok = res.ok;
  } catch { ok = false; }
  ollamaProbe.set(base, { ok, at: Date.now() });
  return ok;
}

export function localOllamaBase(config) {
  const base = String(config?.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  // v2.3.6：**局域网 / Tailscale 上的 Ollama 也算本地后端**。
  // 原来只认 127.0.0.1 / localhost / [::1]，于是平板上的工作台把
  // baseUrl 指向电脑（http://100.x.x.x:11434）时，这里返回空串 →
  // 回退到 127.0.0.1 → 查的是平板自己那一个模型，电脑的 45 个全看不见
  //（用户反馈「模型还是只有平板 v7k」）。
  // 判据：只要不是公网云服务（api.deepseek.com 这类），就当本地 Ollama。
  //
  // v2.4.1 审计修复：这段判据原来在本文件**自己实现了一份**，和
  //   workguard.js / openai.js 的两份口径不一致（最要命的是 Tailscale 只有这里认，
  //   于是"聊天走得通、工作时段锁却把它锁住"）。现在统一到 lib/net.js（isLocalBaseUrl）。
  // ⚠ 但这里的**口径比 isLocalBaseUrl 更宽**，不能直接等号替换 —— 原实现把
  //   「任何裸 IP」都当作本地后端（连 127.0.0.1 上转发到 OpenAI 兼容服务的本地 mock 也算），
  //   收窄成只有 Privet 网段会让这类部署突然改走 Ollama 原生 /api/chat（冒烟测试立刻抓到
  //   "模型端收到的是 /api/chat 而不是 /v1/chat/completions"）。所以这里保留"裸 IP 即本地"，
  //   只把网段/域名的判定换成统一实现。
  const isBareIp = /^https?:\/\/\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/i.test(base);
  return (isBareIp || isLocalBaseUrl(base)) ? base : '';

}

async function getJson(url, ms = 3000, init = null) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), ...(init || {}) });
  return res.json();
}

/**
 * 本机 Ollama 里装了哪些模型（给应用内的「切模型」用）。
 *
 * 为什么要 /api/show 逐个问：`/api/tags` 只有名字和大小，**没有"支不支持思考"** ——
 * 模型列表里要显示「支持思考」这个标记，所以得问。
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
 * 「关掉思考」的**兜底**策略（只在拿不到服务端能力信息时用）。
 *
 * ⚠ 历史：这里原来是"按模型名分派"——Qwen3 → system 里的 /no_think，R1 → think:false。
 *   但 v2.3.x 之后所有分支都改成了 think_false（实测 Qwen3 微调版也不读 /no_think，
 *   往 system 里塞反而污染提示词、思考更久），于是这条函数实际上**只会返回 think_false**，
 *   "system 注入 /no_think"那条路径成了死分支（v2.4.1 审计记录在案）。
 *
 * 现在：正常路径用 probeThinkCapability()（问服务端），这里只留一个保守兜底，
 *   并明确标注它已经不再按模型名猜测。
 */
export function thinkControl(model) {
  return 'think_false';
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

/**
 * 原生 /api/chat 流式对话（绕开 OpenAI 兼容层）。
 *
 * 为什么需要：Ollama 的 `/v1/chat/completions` **会丢弃 `think` 字段**。
 * 实测 qwen3-8b-v1：
 *   原生 /api/chat + think:false     →  6.0s，正文正常
 *   /v1/chat/completions + think     → 47.7s，正文全空（思考吃光 token）
 * 所以凡是「需要关思考」的本地 Ollama 请求，都走这里。
 */
export async function streamChatNative({ config, messages, onDelta, onUsage, onReasoning, signal, numPredict = 2200, think }) {
  const base = localOllamaBase(config) || 'http://127.0.0.1:11434';
  const body = {
    model: config.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    // ⚠ v2.2.1：**不传 think 字段**。
    //   实测 qwen3-8b-v7k + 长上下文（~5000 tok）：
    //     think:false  → 只吐一个 "</think>\n\n"，正文 0 字（done_reason=stop），3/3 复现
    //     不传 think   → 55 字正常
    //     think:true   → 138 字正常（思考区其实也是空的）
    //   原因：微调后的 Qwen3 模板对 think:false 的处理是「强行闭合 think 块然后立刻停」，
    //   短上下文看不出来，上下文一长就 100% 触发 —— 这就是「挑一个老是不返回内容」。
    //   不传字段时 Ollama 走模型默认（非思考），反而是对的。
    // v2.3.12：think 交给调用方决定 —— **开了思考时也必须走这条原生路**，
    // OpenAI 兼容层(/v1)会丢 think 字段、也不返回 thinking 通道，
    // 结果就是"开了思考但看不到思考过程、usage.reasoning 恒为 0"。
    ...(typeof think === 'boolean' ? { think } : {}),
    options: {
      temperature: Number(config.temperature) || 0.85,
      num_predict: numPredict,
      // v2.3.15 反复读：以前这里**只有 temperature + num_predict**，靠 Ollama 默认的
      // repeat_penalty=1.1 —— 对 8B 中文太松。实测（城中村房东卡，真实上下文，temp 0.6）：
      //   不设        → 同一句连说 4 次，结尾两百多字全是「你问包宿，我这边告诉你。」
      //   1.3         → 重复降到 1 次，内容也变实
      //   1.5         → 也正常，但话会变短变干
      // 取 1.3：压住复读又不至于把口吻压死（**这条是给 8B 调的**）。
      //
      // ⚠️ v2.3.37 重要修正：1.3 对 14B/v14j 这类模型**太激进**，会把标点一起惩罚掉。
      // 「。」「，」出现频率极高，重复惩罚一上去它们先被压，于是模型写出一长串没标点的句子，
      // 再往下压就开始吐概率极低的字符 —— 实测用户看到的就是 𘚸 𖠚 ᵌ 这种乱码。
      // 实测（同一 system、同一句「我要你」、temp 0.6）：
      //   rp=1.0  → 788 字 / 中文标点 92 个  ✅
      //   rp=1.12 → 345 字 / 标点 29 个
      //   rp=1.3  → 902 字 / 标点 13 个，还夹乱码 ❌
      // 所以改成可配：config.repeatPenalty（默认 1.1），老行为可用 1.3 复现。
      repeat_penalty: (() => {
        const v = Number(config.repeatPenalty);
        return Number.isFinite(v) && v >= 0.9 && v <= 2 ? v : REPEAT_PENALTY;
      })(),
      // 回看窗口：32768 的默认对短对话没意义，256 token 够它发现"我刚说过这句"
      repeat_last_n: 256,
      // v2.4.1 审计修复：上下文窗口（num_ctx）原来在**真正走的那条路**上根本发不出去。
      //   拼 options.num_ctx 的代码只在 lib/openai.js 的 /v1 分支里，而 v2.3.12 之后
      //   本地 Ollama 一律走原生 /api/chat 并提前 return —— 那段永远执行不到。
      //   后果：config.contextWindow（如 24576）形同虚设，Ollama 用模型默认（实测通常 4096），
      //   而 prompt.js 的 dynamicHistoryBudget 却按 24576 算出 7200 字历史预算 →
      //   提示词被 Ollama 静默截断（正是 prompt.js 顶部注释警告的那个场景）。
      ...(Number(config.contextWindow) > 0 ? { num_ctx: Number(config.contextWindow) } : {}),
    },
  };
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${t.slice(0, 200)}`);
  }
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  let thinking = '';
  let last = null;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      last = j;
      const piece = j.message?.content || '';
      if (piece) { full += piece; onDelta(piece); }
      // v2.2.2：Ollama 可能把整段输出**分流进 thinking 通道**，content 留空。
      // 实测 qwen3-8b-v7k + 顾凌烟那个会话：eval_count=44，content=''，
      // thinking='（从你那边移开视线…）"这算啥…"' —— 内容全在 thinking 里。
      // 老代码只读 content，于是拿到空串 → 判空 → 重抽 → 重抽还是空 → 报"试了 2 次"。
      // 这就是"挑一个老是不返回内容"。
      const th = j.message?.thinking || '';
      if (th) { thinking += th; onReasoning?.(th); }
    }
  }
  // content 空但 thinking 有东西：把 thinking 当正文用（它不是思考，是模型把正文写错了通道）
  // ⚠ v2.3.13：**开了思考时不能这么做** —— 那时 thinking 里的内容就是真的思考过程，
  //   当正文用会让「显示思考过程」永远拿不到东西（实测：think:true 下正文空、
  //   thinking 18 字被 salvage 吞成正文，思考区一片空白）。
  if (!full.trim() && thinking.trim() && think !== true) {
    full = thinking.replace(/^\s+/, '');   // thinking 通道常带前导换行，去掉免得正文开头是空行
    console.log(`[salvage] native: content 为空、thinking 通道有 ${full.length} 字，当正文用`);
    onDelta(full);
  }
  // 原生端点最后一包带 prompt_eval_count / eval_count（真实用量）
  if (last && (last.prompt_eval_count != null || last.eval_count != null)) {
    onUsage?.({
      prompt_tokens: last.prompt_eval_count || 0,
      completion_tokens: last.eval_count || 0,
      total_tokens: (last.prompt_eval_count || 0) + (last.eval_count || 0),
    });
  }
  return full;
}
