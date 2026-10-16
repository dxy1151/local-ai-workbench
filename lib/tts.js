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
 * 从一条回复里挑出"该读出来的话"：
 *   *动作* 和（环境）不读，只读台词 —— 这是我们这个程序的约定
 *   （`*…*` 动作神态、`（…）` 环境、其余是台词）。
 * 全是动作/环境（没有台词）时，退回读去掉标记的全文，免得"点了没声音"。
 */
export function speechText(reply, limit = 2000) {
  const raw = String(reply || '');
  if (!raw.trim()) return '';
  // 去掉 *…* 和（…）里的内容（连标记一起去掉），剩下的就是台词
  const withoutBlocks = raw
    .replace(/\*[^*\n]*\*/g, '')
    .replace(/（[^）\n]*）/g, '')
    .replace(/\([^)\n]*\)/g, '');
  const speech = cleanup(withoutBlocks);
  if (speech) return speech.slice(0, limit);
  // 纯动作/纯环境：去掉标记本身，把文字读出来
  return cleanup(raw.replace(/[*＊]/g, '').replace(/[（）()]/g, '')).slice(0, limit);
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
