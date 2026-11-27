// 联网搜索（必应网页抓取）。v0.62.0。
//
// 为什么是"抓网页"而不是官方 API：官方 Bing Search API 要在 Azure 开 key，
// 而网页版零成本、免注册。代价是**解析页面结构**（所以解析器单独可测，见 smoke.js）。
//
// 实测（2026-10-09，本机）：
//   · 直连 www.bing.com → 被 **302 到 cn.bing.com**（国内版，链接是直链）——按 IP 地域跳，改 host / mkt / cookie 都没用；
//   · 走本机 Clash(127.0.0.1:7897) 的 CONNECT 隧道 → 真的是 www.bing.com 国际版，
//     但结果链接被包成 /ck/a?...&u=a1<base64url>，**必须解码**，否则拿到的一堆点不开的 bing 内链。
// 所以：国际版要靠代理，国内版可直连；两条路都走同一个解析器。
//
// 只依赖 node 内置模块 + lib/openai.js 里那套已验证的 CONNECT 隧道（不重复实现一遍代理）。

import http from 'node:http';
import https from 'node:https';
import { connectTunnel, parseProxy } from './openai.js';

/** 必应站点：intl = 国际版（需代理），cn = 国内版（可直连）。 */
export const SITES = {
  intl: { host: 'www.bing.com', label: '必应国际版（www.bing.com）' },
  cn: { host: 'cn.bing.com', label: '必应国内版（cn.bing.com）' },
};

export const SEARCH_TIMEOUT_MS = 8000;
// 一页结果大概 100~130 KB；给足余量，超了就只留前面这段（不会因为一个畸形页面把内存吃光）。
const MAX_BYTES = 3 * 1024 * 1024;
// 用真实浏览器 UA：必应对"不像浏览器"的请求会给更少的结果、甚至给同意页。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ---------- 文本清洗 / 实体解码 ---------- */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
    })
    .replace(/&nbsp;/g, ' ').replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ').replace(/&middot;/g, '·')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');   // &amp; 必须最后解，否则 &amp;lt; 会被解成 <
}

/** 把一小段 HTML 变成纯文本（去标签 + 解实体 + 收敛空白）。 */
export function textOf(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * 从聊天文本里提出一条搜索词。
 * 角色扮演的文本里混着 *动作* 和 （环境描写），照原样丢给必应基本搜不出东西 —— 先剥掉。
 * 剥完太短（"嗯""继续"这种）就返回空串：宁可不搜，也别拿一个废词去打必应。
 */
export function cleanQuery(raw, maxLen = 120) {
  let s = String(raw || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/\*[^*\n]*\*/g, ' ');            // *动作 / 神态*
  s = s.replace(/[（(][^）)\n]*[）)]/g, ' ');    // （环境描写）
  s = s.replace(/[「」『』【】\[\]"]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length < 2) return '';
  // 纯语气词 / 纯标点：没有检索价值
  if (/^[嗯哦啊呀哈嘿喂呃唉诶、，。,.!！?？~～…\s]+$/.test(s)) return '';
  return s.slice(0, Math.max(8, maxLen));
}

/* ---------- 结果链接 ---------- */

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * 把必应结果里的 href 还原成真实地址。
 * 国际版把它们包成 https://www.bing.com/ck/a?...&u=a1<base64url(真实地址)>
 * ——不解码的话"来源"就是一串点不开的 bing 内链。
 * 解不出来（真的是 bing 站内跳转）就返回空串，调用方会丢掉这条。
 */
export function decodeBingLink(href) {
  const h = decodeEntities(href).trim();
  if (!/^https?:\/\//i.test(h)) return '';
  let u;
  try { u = new URL(h); } catch { return ''; }
  const host = u.hostname.toLowerCase();
  const isBing = /(^|\.)bing\.com$/.test(host);
  if (!isBing) return h;
  if (!/\/ck\/a/i.test(u.pathname)) return '';   // bing 站内的其它链接（/search、/images…）不算来源
  const raw = u.searchParams.get('u') || '';
  if (!raw.startsWith('a1')) return '';
  const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    const url = Buffer.from(padded, 'base64').toString('utf8');
    return /^https?:\/\//i.test(url) ? url : '';
  } catch {
    return '';
  }
}

/* ---------- 解析 ---------- */

/**
 * 解析必应搜索结果页。
 * 结构（实测 2026-10-09，国内版/国际版一致）：每条结果是 `<li class="b_algo">`，
 * 标题在 `<h2><a href=…>`，摘要在 `<p>`（常带 b_lineclamp 类）。
 * 只做"够用且可测"的解析：拿不到就少一条，绝不抛错。
 */
export function parseBing(html, opts = {}) {
  const count = Math.max(1, Math.min(20, Number(opts?.count) || 5));
  const out = [];
  const seen = new Set();
  const blocks = String(html || '').split(/<li class="b_algo"/).slice(1);
  for (const b of blocks) {
    const m = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const url = decodeBingLink(m[1]);
    if (!url || seen.has(url)) continue;
    const title = textOf(m[2]);
    if (!title) continue;
    const p = b.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      || b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    let snippet = textOf(p && p[1]);
    if (!snippet) {
      const s = b.match(/<span[^>]*class="[^"]*b_snippet[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
        || b.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      snippet = textOf(s && s[1]);
    }
    seen.add(url);
    out.push({
      title: title.slice(0, 200),
      url,
      snippet: snippet.slice(0, 400),
      host: hostOf(url),
    });
    if (out.length >= count) break;
  }
  return out;
}

/* ---------- 请求 ---------- */

function fetchOnce(url, { proxy, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const port = u.port ? Number(u.port) : isHttps ? 443 : 80;
    const lib = isHttps ? https : http;
    // 和 lib/openai.js 一个规矩：CONNECT 隧道只能给 https 目标用。
    // （生产里必应永远是 https；只有测试钩子 WORKBENCH_BING_BASE 会指向 http 假服务。）
    // 关键：**明确报错**，绝不静默忽略代理 —— 否则"以为走了代理、其实直连"会让
    // "国际版结果"变成假的，用户看不出来。
    if (proxy && !isHttps) {
      reject(new Error('代理只支持 https 目标（这次的目标是 http，请把代理留空）'));
      return;
    }
    const go = (tunnel) => {
      const req = lib.request({
        method: 'GET',
        hostname: u.hostname,
        port,
        path: u.pathname + u.search,
        headers,
        // 和 lib/openai.js 同一条路：把隧道 socket 交给 http/https 用
        ...(tunnel ? { createConnection: () => tunnel } : {}),
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (size >= MAX_BYTES) return;      // 超了就不再收，但也不 destroy（否则 end 不触发、Promise 永远挂着）
          size += c.length;
          chunks.push(c);
        });
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
        res.on('error', reject);
      });
      req.once('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`搜索超时（${timeoutMs}ms）`)));
      req.end();
    };
    if (proxy && isHttps) connectTunnel(proxy, u.hostname, port).then(go, reject);
    else go(null);
  });
}

/**
 * 搜一次必应。
 *
 * @param {string} query 关键词（用 cleanQuery 洗过的）
 * @param {object} opts  { site:'intl'|'cn', count, proxy:'127.0.0.1:7897', timeoutMs, base }
 *   base 是**测试钩子**（env WORKBENCH_BING_BASE）：把它指到本地假必应，冒烟测试就能离线跑完解析+注入链路。
 * @returns {{results:Array, query:string, site:string, via:string, finalHost:string, notice:string, status:number, bytes:number}}
 *
 * notice 是"要如实告诉用户"的降级提示：最典型的就是**选了国际版却因为没走代理被重定向到国内版**。
 */
export async function searchBing(query, opts = {}) {
  const q = String(query || '').trim();
  const site = opts.site === 'cn' ? 'cn' : 'intl';
  const count = Math.max(1, Math.min(10, Number(opts.count) || 5));
  // ⚠ 必须过 parseProxy：设置里存的是字符串（'127.0.0.1:7897'），而 connectTunnel 要的是
  // {host, port, auth} 对象。忘了这一步的话，隧道会拿着 undefined 去连 —— 表现成
  // "代理没配好"的各种怪错误（冒烟测试盯着这条）。
  const proxy = opts.proxy ? parseProxy(opts.proxy) : null;
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || SEARCH_TIMEOUT_MS);
  const base = String(opts.base || '').trim();

  if (!q) {
    return { results: [], query: '', site, via: proxy ? 'proxy' : 'direct', finalHost: '', notice: '', status: 0, bytes: 0 };
  }

  const target = base
    ? new URL('/search', new URL(base).origin)
    : new URL('/search', `https://${SITES[site].host}`);
  // 多要几条，因为站内链接会被丢掉；必应本身也只给一页（大约 8~10 条）
  target.searchParams.set('q', q);
  target.searchParams.set('count', String(Math.min(20, count + 4)));

  const cookies = new Map();
  let url = target.toString();
  let res = null;
  for (let hop = 0; hop < 3; hop += 1) {
    const headers = {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'accept-encoding': 'identity',
      'cache-control': 'no-cache',
    };
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    // eslint-disable-next-line no-await-in-loop
    res = await fetchOnce(url, { proxy, headers, timeoutMs });
    for (const sc of [].concat(res.headers['set-cookie'] || [])) {
      const m = /^([^=;]+)=([^;]*)/.exec(String(sc));
      if (m) cookies.set(m[1].trim(), m[2]);
    }
    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, url).toString();
      if (!/^https?:/i.test(next)) break;
      url = next;
      continue;
    }
    break;
  }

  const finalHost = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  const html = res ? res.body : '';
  const results = parseBing(html, { count });
  const via = proxy ? 'proxy' : 'direct';

  let notice = '';
  if (!results.length) {
    if (/captcha|验证码|Consent|同意并继续|to continue/i.test(html)) {
      notice = '必应返回了验证/同意页（可能被判定成机器人）。稍后再试，或换一个代理出口。';
    } else {
      notice = '必应这次没返回可解析的结果（页面结构可能变了，或关键词太怪）。';
    }
  } else if (site === 'intl' && /(^|\.)cn\.bing\.com$/.test(finalHost)) {
    notice = '这次其实走的是国内版 cn.bing.com：必应按出口 IP 把请求重定向了（改站点/语言都没用）。'
      + '想要国际版结果，在设置里填代理（如 127.0.0.1:7897）。';
  }

  return {
    results, query: q, site, via, finalHost, notice,
    status: res ? res.status : 0,
    bytes: html.length,
    // 只有调试工具（tools/test-websearch.mjs --save）才要把原始页面带回去：
    // 平时不带着它，免得一百多 KB 的 HTML 在链路里被顺手存进会话或缓存。
    ...(opts.keepRaw ? { raw: html } : {}),
  };
}

/** 把搜索失败翻译成人话（网络层/代理层的错误原文对用户没意义）。 */
export function describeSearchFail(err) {
  const msg = String(err?.message || err || '');
  const code = String(err?.cause?.code || err?.code || '');
  if (/代理只支持 https/.test(msg)) {
    return '代理只能给 https 目标用（这次的目标是 http）——把接口地址换成 https，或把代理留空。';
  }
  // parseProxy 的报错本来就是人话（"代理地址格式不对：…（示例：127.0.0.1:7897）"），原样透出
  if (/代理地址|只支持 HTTP 代理/.test(msg)) return msg;
  if (/CONNECT 失败/.test(msg) || /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/.test(code)) {
    return `连不上${/CONNECT/.test(msg) ? '代理' : '必应'}（${code || msg}）——检查代理是否在跑（Clash 的 127.0.0.1:7897）、或把站点换成国内版直连。`;
  }
  if (/超时|ETIMEDOUT|timeout/i.test(msg + code)) {
    return '搜索超时（8 秒没回来）——网络太慢或代理不通。';
  }
  if (/证书|CERT|TLS|SSL/i.test(msg + code)) {
    return `TLS/证书出错（${code || msg}）——代理隧道可能被中断。`;
  }
  return `搜索失败：${msg || '未知错误'}`;
}
