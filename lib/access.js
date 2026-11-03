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

const COOKIE = 'xingye_pass';
const MAX_AGE = 30 * 24 * 3600;   // 30 天

/** 从环境变量取口令；没设就返回空串（= 不启用认证）。 */
export function accessPassword() {
  return String(process.env.WORKBENCH_PASSWORD || process.env.XINGYE_PASSWORD || '').trim();
}

/** 这个请求是不是来自本机（本机免密）。 */
export function isLoopback(req) {
  const a = String(req.socket?.remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
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
  if (isLoopback(req)) return true;  // 本机免密
  const want = tokenFor(pass);
  const got = parseCookies(req.headers.cookie)[COOKIE];
  if (!got || got.length !== want.length) return false;
  // 定长比较，避免时序侧信道（这里其实无所谓，但是好习惯）
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
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
export function loginPage(error = '') {
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
  <h1>🔒 需要口令</h1>
  <p>这台工作台开了远程访问，先输口令</p>
  <input type="password" name="password" autofocus autocomplete="current-password"
         placeholder="访问口令" required>
  <button type="submit">进入</button>
  ${error ? `<div class="err">${error}</div>` : ''}
</form></body></html>`;
}
