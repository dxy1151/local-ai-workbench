// 「这个接口地址是不是本地 / 内网」——**唯一实现**（v2.4.1 审计修复）
//
// 为什么要有这个文件：修复前全仓库有 4 份互相不同的判定，
// 同一个 baseUrl 在不同模块里结论不一样，能直接造成"行为打架"：
//
//   文件:行（修复前）            认 127/10/192.168/172.16-31   认 Tailscale 100.64/10   端口兜底
//   ollama.js  localOllamaBase          是                         是                    否
//   workguard.js isLocalEndpoint        是                         否                    否
//   openai.js  isLocalBaseUrl           是                         否                   11434/18080
//   openai.js  localHost（匿名 IIFE）    是                         否                   11434
//
// 实测会出问题的那一种：baseUrl = http://100.x.x.x:11434/v1（Tailscale 上的 Ollama）
//   · localOllamaBase 说"本地" → 聊天走 Ollama 原生 /api/chat ✅
//   · isLocalEndpoint 说"云端" → 被「工作时段锁」在上班时间拦下 ❌
//   于是"连自己家的 Ollama 却被当云端锁住"，而且报错文案还是"只对云端接口生效"。
//
// 现在统一到下面这一份，四个调用点全部改调它：
//   回环、内网段、Tailscale(CGNAT 100.64/10)、.local 域名、host.docker.internal 都算本地；
//   显式认 Ollama / llama-server 的默认端口（用户可能写 localhost:11434 之外的主机名）。

/** 取 URL 的 hostname；解析失败就退回字符串粗取（和原来的兜底行为一致）。 */
export function hostOf(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
  } catch {
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(raw);
    const hostport = m ? m[1] : raw;
    return hostport.split(/[/?#]/)[0].split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  }
}

/** 取 URL 的端口；没写端口时按协议给默认值（'' = 未知）。 */
export function portOf(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    const u = new URL(withScheme);
    if (u.port) return u.port;
    return u.protocol === 'https:' ? '443' : '80';
  } catch {
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(raw);
    const hostport = m ? m[1] : raw.split(/[/?#]/)[0];
    const p = hostport.split(':')[1];
    return p || '';
  }
}

/** 回环地址（本机）。 */
export function isLoopbackHost(host) {
  const h = String(host || '');
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '[::1]' || /^127\./.test(h);
}

/**
 * 内网 / 私有网段。
 *   10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 —— RFC1918
 *   100.64.0.0/10 —— CGNAT，Tailscale 就用这一段（**这是原来漏掉的那条**）
 *   .local / .lan / .internal 主机名、host.docker.internal —— 局域网/容器常见写法
 */
export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (h === 'host.docker.internal') return true;
  if (/\.(local|lan|internal|home|localdomain)$/.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;   // 100.64.0.0/10
  return false;
}

/**
 * 这个 baseUrl 是不是本地 / 内网接口（本地接口不需要 API Key，也不受工作时段锁限制）。
 * @param {string} baseUrl 例如 http://127.0.0.1:11434/v1
 */
export function isLocalBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return false;
  const host = hostOf(raw);
  if (!host) return false;
  if (isLoopbackHost(host) || isPrivateHost(host)) return true;
  // 兜底：明确指向 Ollama / llama-server 的默认端口也当本地（有人会写自定义主机名 + 转发）
  const port = portOf(raw);
  if (port === '11434' || port === '18080') return true;
  return false;
}
