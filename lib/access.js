// ============================================================================
//  远程访问口令：给「绑到 0.0.0.0 / Tailscale」的工作台加一道门
//
//  为什么需要：这个工作台**原本没有任何认证** —— 谁能打开页面，谁就能看到
//  全部聊天记录、角色卡、训练数据，还能改配置。只监听 127.0.0.1 时这没问题；
//  一旦为了让手机/外网访问而绑到 0.0.0.0，同网段的任何人就都能进来了。
//
//  设计取舍（故意做得很轻）：
//    · 单个共享口令，不做用户系统 —— 这是私人工具，不是多租户服务
//    · 口令放环境变量 WORKBENCH_PASSWORD / XINGYE_PASSWORD，不落盘
//    · 登录后发一个 HttpOnly Cookie，30 天有效
//    · 只保护「非本机」请求：127.0.0.1 / ::1 免密（本机就是你自己）
//      这样本机用起来完全不变，也不用担心把自己锁在外面
// ============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COOKIE = 'xingye_pass';
const MAX_AGE = 30 * 24 * 3600;   // 30 天

// v2.3.9：口令/2FA 密钥改成「**网页里能改**」—— 存一个 JSON 文件，
// 环境变量作为兜底（老部署继续用 env 也照常工作）。
//   文件: ~/.config/xingye-tunnel/auth.json  { password, totpSecret }
//   优先级: 文件 > 环境变量
// 为什么不用环境变量：改个口令还得登服务器改 unit 文件再重启，太麻烦；
// 用户明确要求「改密码和 2FA 的二维码做进去」。
const AUTH_DIR = path.join(os.homedir(), '.config', 'xingye-tunnel');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');

// ── auth.json 读缓存（v2.4.1 审计修复）────────────────────────────────────
// 问题：isAuthorized() 对**每个 HTTP 请求**（含静态资源）都同步 readFileSync 一次
//   auth.json，isTrusted() → inTrustedCidr() → parseCidrs() 还会**再读一次**。
//   页缓存下实测 2µs，但进程在同步盘的机器上、或冷缓存/杀软扫盘时就是 ms 级
//   **阻塞事件循环**（本项目自己的 PROJECT.md 也写着"读配置一律走 getConfig()"）。
// 修法：按 mtimeMs 缓存解析结果 —— stat 仍然每次做（很便宜），内容没变就不重新
//   JSON.parse，也不需要额外的失效通知。saveAuthFile 写完顺手更新缓存。
let authCache = { mtimeMs: -1, data: {} };

function readAuthFile() {
  let st = null;
  try { st = fs.statSync(AUTH_FILE); } catch { authCache = { mtimeMs: -1, data: {} }; return {}; }
  if (authCache.mtimeMs === st.mtimeMs) return authCache.data;
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    const data = j && typeof j === 'object' ? j : {};
    authCache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return {};
  }
}

/** 写回 auth.json（600 权限，目录 700）。 */
export function saveAuthFile(patch) {
  const cur = readAuthFile();
  const next = { ...cur, ...patch };
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${AUTH_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE);
  try { fs.chmodSync(AUTH_FILE, 0o600); } catch { /* 无所谓 */ }
  // 写完立刻让缓存跟上（否则同进程里紧接着的 isAuthorized 还在用旧口令）
  try { authCache = { mtimeMs: fs.statSync(AUTH_FILE).mtimeMs, data: next }; } catch { authCache = { mtimeMs: -1, data: {} }; }
  return next;
}

/** 从文件或环境变量取口令；都没有就返回空串（= 不启用认证）。 */
export function accessPassword() {
  const fromFile = String(readAuthFile().password || '').trim();
  if (fromFile) return fromFile;
  return String(process.env.WORKBENCH_PASSWORD || process.env.XINGYE_PASSWORD || '').trim();
}

/** 口令是从文件来的还是环境变量来的（网页里要提示「要不要迁到文件」）。 */
export function passwordSource() {
  if (String(readAuthFile().password || '').trim()) return 'file';
  const env = String(process.env.WORKBENCH_PASSWORD || process.env.XINGYE_PASSWORD || '').trim();
  return env ? 'env' : 'none';
}

/** TOTP 密钥：同样「文件 > 环境变量」。 */
export function totpSecretFromStore() {
  const fromFile = String(readAuthFile().totpSecret || '').trim();
  if (fromFile) return fromFile.toUpperCase();
  return String(process.env.WORKBENCH_TOTP_SECRET || '').trim().toUpperCase();
}

/**
 * 取真实客户端 IP（用于黑名单 / 审计）。
 *
 * 优先级：cf-connecting-ip > x-forwarded-for 第一段 > x-real-ip > socket 地址。
 *
 * ⚠ 信任链说明：这些头**只有本机反代可信**。cloudflared 会把真实访客 IP 写进
 * cf-connecting-ip 并覆盖掉客户端伪造的值，所以走隧道时这个头是对的。
 * 但如果是别人直接打 5178（绕过 Cloudflare），他自己就能伪造任何 IP ——
 * 所以黑名单只能当「减少噪声」用，不能当唯一防线（真正兜底的是口令 + TOTP）。
 * 对外暴露时最好只绑 127.0.0.1，或者用防火墙只放行 cloudflared。
 */
export function clientIp(req) {
  const h = req.headers || {};
  const cf = String(h['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const xff = String(h['x-forwarded-for'] || '').trim();
  if (xff) return xff.split(',')[0].trim();
  const xri = String(h['x-real-ip'] || '').trim();
  if (xri) return xri;
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

/** 这个请求是不是来自本机（本机免密）。 */
export function isLoopback(req) {
  const a = String(req.socket?.remoteAddress || '');
  if (!(a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')) return false;
  // v2.3.8 ⚠ 反向代理/隧道的请求**看起来也来自 127.0.0.1**（cloudflared / frp / nginx
  // 都在本机转发），但那不是真正的本机 —— 不判出来的话，把工作台放到公网就等于没设口令。
  // 判据：带了代理转发头就算「外部」，要输口令。
  const h = req.headers || {};
  if (h['cf-connecting-ip'] || h['x-forwarded-for'] || h['x-real-ip'] || h['cf-ray']) return false;
  // Host 是隧道域名（非 IP、非 localhost）时也算外部
  const host = String(h.host || '').split(':')[0].toLowerCase().replace(/^\[|\]$/g, '');
  if (host && host !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== '::1') {
    return false;
  }
  return true;
}

/** 口令 → cookie 值（用哈希，cookie 里不出现明文口令）。 */
function tokenFor(password) {
  return crypto.createHash('sha256').update(`xingye:${password}`).digest('hex').slice(0, 32);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthorized(req) {
  const pass = accessPassword();
  if (!pass) return true;            // 没设口令 = 不启用认证
  if (isTrusted(req)) return true;   // 本机 / 可信网段直连免密
  const want = tokenFor(pass);
  const got = parseCookies(req.headers.cookie)[COOKIE];
  if (!got || got.length !== want.length) return false;
  // 定长比较，避免时序侧信道（这里其实无所谓，但是好习惯）
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}


/**
 * 「可信网段」免密（v2.3.42）。
 *
 * 由来：原来的免密判据只有 127.0.0.1，于是从局域网（192.168.x.x）或 Tailscale
 * （100.64/10）打开工作台也会撞口令墙 —— 用户会觉得「我又没用公网，凭什么要密码」。
 *
 * 配法：环境变量 XINGYE_TRUST_CIDRS（逗号分隔），或 auth.json 里的 trustCidrs 数组。
 *   例：XINGYE_TRUST_CIDRS=192.168.1.0/24,100.64.0.0/10
 *
 * ⚠️ 带了代理转发头（cloudflared/frp/nginx）的请求**永远不算可信**，
 *    否则把工作台挂到公网就等于没设口令（见 isLoopback 的注释）。
 */
function parseCidrs() {
  const raw = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (Array.isArray(j?.trustCidrs) && j.trustCidrs.length) return j.trustCidrs.join(',');
    } catch { /* 没文件就用环境变量 */ }
    return String(process.env.XINGYE_TRUST_CIDRS || '');
  })();
  return String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((c) => {
      const [base, bitsStr] = c.split('/');
      const bits = bitsStr === undefined ? 32 : Number(bitsStr);
      const nums = base.split('.').map(Number);
      if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
      if (!Number.isFinite(bits) || bits < 0 || bits > 32) return null;
      const ip = ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return { net: (ip & mask) >>> 0, mask };
    })
    .filter(Boolean);
}

function inTrustedCidr(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (!m) return false;
  const ip = ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
  return parseCidrs().some((c) => ((ip & c.mask) >>> 0) === c.net);
}

/** 这个请求是否可以直接放行（本机 或 可信网段直连）。 */
export function isTrusted(req) {
  if (isLoopback(req)) return true;
  const h = req.headers || {};
  // 走代理/隧道来的，一律不放行 —— 否则公网就等于没口令
  if (h['cf-connecting-ip'] || h['x-forwarded-for'] || h['x-real-ip'] || h['cf-ray']) return false;
  return inTrustedCidr(req.socket?.remoteAddress);
}

/**
 * CSRF 防护：写操作（POST / PUT / DELETE / PATCH）要求请求来源是本服务自己。
 *
 * 由来：cookie 是 SameSite=Lax，跨站 POST 本来就带不上 cookie，所以纯远程攻击者
 * 触发不了。但有两个真实场景 SameSite 管不住：
 *   ① 免密网段（Tailscale）里的设备 —— 它们根本不带 cookie，isAuthorized 直接放行，
 *      于是一台被恶意网页打开浏览器的 Tailscale 设备就能 POST /api/quit 关掉工作台
 *   ② 同站点的其他页面（比如以后挂了用户可上传的 HTML）
 * 实测：局域网里任一台设备 POST /api/quit 就能把工作台连显存里的模型一起关掉。
 *
 * 判据（任一成立即放行）：
 *   · Origin 缺失 —— curl / 脚本 / 非浏览器客户端；浏览器发起跨站 POST 一定会带 Origin
 *   · Origin 的 host 与请求的 Host 一致
 *   · Origin 是 localhost / 127.0.0.1 / [::1]
 *   · Origin 的 host 与 X-Forwarded-Host 一致（某些反代会改 Host 而不改 XFH）
 * 否决：Origin 存在但和上面都不符 —— 这就是跨站请求。
 *
 * 实测依据（2026-11-28，用临时探针抓的真实头部）：
 *   Cloudflare 隧道 → host: "xingye.don0ox1.lat", origin: "https://xingye.don0ox1.lat"
 *   局域网直连    → host: "192.168.1.45:5178", origin: "http://192.168.1.45:5178"
 * cloudflared **保留原始 Host**（不会改成 127.0.0.1:5178），所以两种场景下
 * Origin 和 Host 都能直接对齐，不需要额外特判。
 */
export function isSameOriginRequest(req) {
  const h = req.headers || {};
  const origin = String(h.origin || '').trim();
  if (!origin) return true;                    // 非浏览器客户端
  let o;
  try { o = new URL(origin); } catch { return false; }   // 有 Origin 但解析不了 = 可疑
  const oHost = o.host.toLowerCase();
  // 本机（含端口）直接放行
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(oHostname(o))) return true;
  const reqHost = String(h.host || '').toLowerCase();
  if (reqHost && oHost === reqHost) return true;
  const fwdHost = String(h['x-forwarded-host'] || '').toLowerCase();
  if (fwdHost && oHost === fwdHost) return true;
  return false;
}

/** 取 Origin 的 hostname（不带端口、去方括号）。 */
function oHostname(u) {
  return u.hostname.toLowerCase();
}

/**
 * 访问日志（2026-11-28）。
 *
 * 由来：2026-11-28 发现 AWS 东京的 IP 通过公网入口拿了 200，但**本地一行日志都没有**，
 * 只能靠 Cloudflare 面板反查，取证成本极高、结论也没法验证。
 * 这个模块只做一件事：把「谁、什么时候、访问了什么、结果如何」写进文件。
 *
 * 文件：~/.config/xingye-tunnel/access.log（JSONL，一行一条，600 权限）
 * 只记**外部请求**（有代理头或来源不是回环）—— 本机自己的轮询太吵，没有取证价值。
 *
 * ⚠ 不记录：请求体、cookie、口令、响应内容。只记元数据。
 */
const ACCESS_LOG = path.join(AUTH_DIR, 'access.log');
const ACCESS_LOG_MAX = 20 * 1024 * 1024;   // 20 MB 后轮转一次
let accessLogBytes = -1;

function rotateIfNeeded(extra) {
  try {
    if (accessLogBytes < 0) {
      try { accessLogBytes = fs.statSync(ACCESS_LOG).size; } catch { accessLogBytes = 0; }
    }
    if (accessLogBytes + extra > ACCESS_LOG_MAX) {
      try { fs.renameSync(ACCESS_LOG, `${ACCESS_LOG}.1`); } catch { /* 没有旧文件 */ }
      accessLogBytes = 0;
    }
  } catch { /* 日志失败不能影响主流程 */ }
}

/**
 * 记一条访问日志。异步写、失败静默 —— 绝不因为日志把请求拖死。
 * @param {object} req
 * @param {object} info  { path, method, status, note }
 */
export function logAccess(req, info = {}) {
  try {
    const h = req.headers || {};
    const viaProxy = Boolean(h['cf-connecting-ip'] || h['x-forwarded-for'] || h['x-ray'] || h['cf-ray']);
    const sock = String(req.socket?.remoteAddress || '');
    // 只记外部：走代理的，或来源不是回环的
    const isLocalSock = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
    if (!viaProxy && isLocalSock) return;

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ip: clientIp(req),
      method: info.method || req.method || '',
      path: info.path || '',
      status: info.status ?? null,
      via: viaProxy ? 'proxy' : 'direct',
      ua: String(h['user-agent'] || '').slice(0, 120),
      ...(info.note ? { note: info.note } : {}),
    }) + '\n';

    rotateIfNeeded(Buffer.byteLength(line));
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
    fs.appendFile(ACCESS_LOG, line, { mode: 0o600 }, () => {});
    accessLogBytes += Buffer.byteLength(line);
  } catch { /* 静默 */ }
}

/**
 * IP 黑名单（2026-11-28）。
 *
 * 由来：2026-11-28 发现 35.77.19.100（AWS EC2 东京机房）对公网入口扫了上万次。
 * 口令 + TOTP 挡得住爆破，但这种扫描会刷日志、加重 Cloudflare 计数、也让人不放心。
 *
 * 存储：~/.config/xingye-tunnel/blocklist.json  { ips: [...], cidrs: [...], notes: {} }
 * 优先级：文件里显式配置的 > 内置默认。带 mtime 缓存，改完不用重启。
 */
const BLOCK_FILE = path.join(AUTH_DIR, 'blocklist.json');
let blockCache = { mtimeMs: -1, data: { ips: [], cidrs: [], notes: {} } };

// 内置默认：即使文件没写也生效（防止手滑删掉）
const DEFAULT_BLOCKED_IPS = ['35.77.19.100'];

function readBlocklist() {
  let st = null;
  try { st = fs.statSync(BLOCK_FILE); } catch { blockCache = { mtimeMs: -1, data: { ips: [], cidrs: [], notes: {} } }; return blockCache.data; }
  if (blockCache.mtimeMs === st.mtimeMs) return blockCache.data;
  try {
    const j = JSON.parse(fs.readFileSync(BLOCK_FILE, 'utf8'));
    const data = {
      ips: Array.isArray(j?.ips) ? j.ips.map(String) : [],
      cidrs: Array.isArray(j?.cidrs) ? j.cidrs.map(String) : [],
      notes: (j?.notes && typeof j.notes === 'object') ? j.notes : {},
    };
    blockCache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return { ips: [], cidrs: [], notes: {} };
  }
}

/** 写回黑名单文件（600 权限）。 */
export function saveBlocklist(next) {
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${BLOCK_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, BLOCK_FILE);
  try { fs.chmodSync(BLOCK_FILE, 0o600); } catch { /* 无所谓 */ }
  try { blockCache = { mtimeMs: fs.statSync(BLOCK_FILE).mtimeMs, data: next }; } catch { blockCache = { mtimeMs: -1, data: next }; }
  return next;
}

/** 这个 IP 是否在黑名单里。本机（回环）永远放行，避免把自己锁在外面。 */
export function isBlockedIp(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '').trim();
  if (!a) return false;
  if (a === '127.0.0.1' || a === '::1') return false;      // 本机永不封
  const bl = readBlocklist();
  const all = [...DEFAULT_BLOCKED_IPS, ...bl.ips];
  if (all.includes(a)) return true;
  // CIDR 匹配（只支持 IPv4 /0~/32，够用）
  for (const c of bl.cidrs) {
    const [base, bitsStr] = String(c).split('/');
    const bits = bitsStr === undefined ? 32 : Number(bitsStr);
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(base);
    const n = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
    if (!m || !n || !Number.isFinite(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const b = ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
    const v = ((Number(n[1]) << 24) | (Number(n[2]) << 16) | (Number(n[3]) << 8) | Number(n[4])) >>> 0;
    if (((b & mask) >>> 0) === ((v & mask) >>> 0)) return true;
  }
  return false;
}

/** 登录成功后发 cookie。 */
export function grantCookie(res) {
  const pass = accessPassword();
  if (!pass) return;
  res.setHeader('Set-Cookie',
    `${COOKIE}=${tokenFor(pass)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax`);
}

export function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

/** 校验用户输入的口令对不对。 */
export function checkPassword(input) {
  const pass = accessPassword();
  if (!pass) return true;
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(pass);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 一个极简登录页（不依赖 public/ 里的任何资源，方便单独替换）。 */
export function loginPage(error = '', withTotp = false) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要口令</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14161a;
       color:#e6e8eb;font:14px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif}
  form{background:#1b1e24;border:1px solid #33383f;border-radius:14px;padding:26px 24px;width:min(320px,86vw)}
  h1{font-size:15px;margin:0 0 4px;font-weight:600}
  p{margin:0 0 18px;color:#8b929c;font-size:12px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;
        border:1px solid #33383f;background:#22262e;color:inherit;font-size:14px}
  input:focus{outline:none;border-color:#5aa0ff}
  button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;
         background:#3d7fd6;color:#fff;font-size:14px;cursor:pointer}
  button:hover{background:#4a8ee6}
  .err{margin-top:12px;color:#ff6b6b;font-size:12px}
</style></head><body>
<form method="POST" action="/__login">
  <h1>🔒 需要口令${withTotp ? ' + 验证码' : ''}</h1>
  <p>这台工作台开了远程访问${withTotp ? '，请输入口令和验证器里的 6 位数字' : '，先输口令'}</p>
  <input type="password" name="password" autofocus autocomplete="current-password"
         placeholder="访问口令" required>
  ${withTotp ? `<input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}"
         maxlength="6" autocomplete="one-time-code" placeholder="6 位验证码"
         style="margin-top:10px;letter-spacing:.35em;text-align:center">` : ''}
  <button type="submit">进入</button>
  ${error ? `<div class="err">${error}</div>` : ''}
</form></body></html>`;
}
