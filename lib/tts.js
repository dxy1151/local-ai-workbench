// 朗读（TTS）：把角色的回复读出来。
//
// 对接的是 **OpenAI 兼容的 `/v1/audio/speech`** —— 不绑死某一个引擎：
// 本地任何实现了这个接口的服务都能用（openedai-speech、Kokoro-FastAPI、
// GPT-SoVITS 的 OpenAI 兼容封装、CosyVoice 的 FastAPI 封装…），换引擎只改设置里的地址。
//
// 为什么默认只接本机服务：台词文本不该离开这台机器，云 TTS 还会把内容上传给第三方。
//
// 纯字符串 + 一次 fetch，没有依赖，node smoke.js 可以直接测。

/**
 * 从一条回复里挑出"该读出来的话"，并**保留节奏**。
 *
 * 老版本的两个毛病（2026-11 实测）：
 *   1. `*动作*` / `（环境）` 整段删掉 —— 停顿信息全没了，读起来一口气不停。
 *   2. 换行一律 `.join('。')` —— 硬塞句号，把「别过来。」变成「别过来。你先出去。」这种平读。
 *
 * 现在的做法：
 *   - 动作/环境**不删**，换成停顿标记 `……`（TTS 读到省略号会自然停顿）。
 *     `（沉默）`/`（半晌）`/`（停顿）` 这类明显的沉默给更长的停顿。
 *   - 换行不再一刀切：上句已有句末标点就原样保留，没有才补 `，`。
 *   - 纯动作/纯环境（没有台词）时照旧退回读全文，免得"点了没声音"。
 *   - **句首/句尾的停顿不丢**：块在句首 → 停顿放前面；在句尾 → 放后面。
 */
export function speechText(reply, limit = 2000, speakers = null) {
  const raw = String(reply || '');
  if (!raw.trim()) return '';

  // 纯动作/纯环境（去掉块后没有台词）：退回读全文。
  // 但"沉默/停顿/半晌"这类**本身没有台词**的词条不该念出来 —— 它们就是停顿本身。
  const silent = raw
    .replace(/[*＊][^*\n]*[*＊]/g, '')
    .replace(/[（(][^）)\n]*[）)]/g, '');
  if (!silent.replace(/[\s\p{P}]/gu, '')) {
    const spoken = raw
      .replace(/[*＊]/g, '')
      .replace(/[（()）]/g, '')
      .replace(/(沉默|停顿|半晌|良久|片刻|怔|愣|不语|无语|安静|静默)/g, ' ')
      .trim();
    // 剩下的没有实际可读内容 → 返回一次停顿，让"点了不出声"变成"点了有停顿"
    if (!spoken) return '……';
    return cleanup(spoken).slice(0, limit);
  }

  // 1) 动作/环境 → 停顿标记（保留位置：句首也是停顿）
  const withPauses = raw
    .replace(/\r/g, '')
    // 多角色卡：每行开头的「名字：」是说话人标注，不读。
    // 必须**知道说话人名单**才剥（否则会把「他叹了口气：我不知道」的冒号误剥）；
    // 名单由调用方传进来（server 端知道这张卡有谁），没传就原样不动。
    .replace(speakerLineRe(speakers), '')
    // *…* 动作
    .replace(/\*([^*\n]{0,80})\*/g, (m, inner) => pauseFor(inner))
    // （…）/ (…) 环境
    .replace(/[（(]([^）)\n]{0,120})[）)]/g, (m, inner) => pauseFor(inner));

  // 2) 按行处理：行内已经带停顿的，不再重复补气口
  const out = [];
  for (const line of withPauses.split('\n')) {
    const t = line.trim().replace(/\s+/g, '');
    if (!t) continue;
    out.push(out.length ? joinLine(out[out.length - 1], t) : t);
  }
  const text = out
    .join('')
    // 连续停顿合并，但保留至少一次停顿
    .replace(/…{3,}/g, '……')
    .replace(/(……，?){3,}/g, '……，')
    .replace(/，{2,}/g, '，')
    .replace(/^[，、；：]+/, '')
    .trim();
  return text.slice(0, limit);
}

function cleanup(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('。')
    .replace(/。{2,}/g, '。')
    .replace(/^。+|。+$/g, '')
    .trim();
}

/** 构造"剥掉说话人前缀"的正则；没给名单就返回永不匹配的正则。 */
function speakerLineRe(speakers) {
  const list = Array.isArray(speakers)
    ? speakers.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (!list.length) return /(?!) /;
  const alt = list
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  return new RegExp(`^[ \\t]*(?:${alt})[ \\t]*[：:][ \\t]*`, 'gm');
}

/** 上一行结尾什么样，决定这一行前面补不补气口。 */
function joinLine(prev, current) {
  if (!prev) return current;
  const last = prev.trim().slice(-1);
  // 已有句末标点 / 停顿 / 右引号 → 直接接
  if (/[。！？!?…～~」”』）)]/.test(last)) return current;
  // 已有逗号类 → 直接接
  if (/[，,、；;：:]/.test(last)) return current;
  // 当前行本身以停顿开头 → 直接接（它会自己制造停顿）
  if (/^…/.test(current)) return current;
  return `，${current}`;
}

/** 动作/环境 → 停顿标记。沉默类的给更长的停顿。 */
function pauseFor(inner) {
  const t = String(inner || '').trim();
  if (!t) return '……';
  if (/(沉默|停顿|半晌|良久|片刻|怔|愣|不语|无语|安静|静默)/.test(t)) return '……，……，';
  return '……，';
}

/** 缓存键：同一段文本 + 同一组参数 → 同一个文件，重复点不再合成。 */
export function ttsCacheKey({ text, model = '', voice = '', speed = 1, baseUrl = '' }) {
  const s = `${baseUrl}|${model}|${voice}|${speed}|${String(text || '')}`;
  // 简易 djb2（不需要密码学强度，够避免碰撞就行）
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const TTS_FORMATS = ['mp3', 'wav', 'opus', 'aac', 'flac'];
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac' };
export const ttsMime = (fmt) => MIME[String(fmt || 'mp3').toLowerCase()] || 'audio/mpeg';

/**
 * 调一次合成，返回音频字节。
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
export async function synthesize({ baseUrl, apiKey = '', model = 'tts-1', voice = 'alloy', speed = 1, format = 'mp3', text, signal }) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('还没填 TTS 服务地址');
  const input = String(text || '').trim();
  if (!input) throw new Error('这条没有可以读的台词');
  const fmt = TTS_FORMATS.includes(String(format).toLowerCase()) ? String(format).toLowerCase() : 'mp3';
  const url = /\/v1$/i.test(base) ? `${base}/audio/speech` : `${base}/v1/audio/speech`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: model || 'tts-1',
      input,
      voice: voice || 'alloy',
      speed: Number(speed) > 0 ? Number(speed) : 1,
      response_format: fmt,
    }),
    signal: signal || AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`TTS 服务返回 ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('TTS 服务返回了空音频');
  return { buffer, contentType: res.headers.get('content-type') || ttsMime(fmt) };
}

/** 设置页「试听」用的一句话。 */
export const TTS_SAMPLE = '（试听）行，那就这样吧。你还有什么想说的？';
