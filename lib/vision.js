// 「识图」：把一张图交给本地视觉模型，换回一段自然语言描述。
//
// 为什么不复用 lib/openai.js 那条路（OpenAI 兼容的 /v1/chat/completions）：
// 一些视觉模型是**思考型**，走兼容端点时思维链会跑到 message.reasoning、
// message.content 是空字符串（max_tokens 被思考吃光，finish_reason=length）——
// 前端只会拿到一片空白。原生 /api/chat 带 think:false 才拿得到干净的一段话（已实测）。
//
// 只认回环地址：这条请求会打到 baseUrl 上，绝不能把图片发到别人的服务去。
import { localOllamaBase } from './ollama.js';

/**
 * 默认识图模型：Qwen2.5-VL 3B（Ollama 官方库里的视觉模型，约 3.2GB，带视觉塔，
 * 8GB 显存可全量装载）。换 7b 质量更好但显存吃紧；换更小的更省。
 * 任何本机 Ollama 里带视觉能力的模型都可以填。
 */
export const DEFAULT_VISION_MODEL = 'qwen2.5vl:3b';
export const VISION_MODEL_MAX = 120;
export const VISION_PROMPT_MAX = 2000;
// 单张图 base64 之后的上限（约等于原图 9MB）。再大就别挤这条同步接口了。
export const VISION_IMAGE_MAX = 12 * 1024 * 1024;

/** 默认提示词：要的是「画面里正在发生什么」，不是一句标签。 */
export const VISION_PROMPT = [
  '用连贯的自然语言描述这张图片里正在发生的事情，覆盖：',
  '1) 画面主体（人/动物/物体）是谁或是什么，外观与身份线索；',
  '2) 主体正在做什么动作、动作进行到哪一步、与谁或什么互动；',
  '3) 场景、环境、时间与光线；',
  '4) 人物之间的关系、表情、情绪与整体氛围；',
  '5) 画面里可读的文字（原样抄出）。',
  '只写你确实看得见的内容，看不清就写「看不清」；不要客套话，不要编造。',
].join('\n');

/** 设置里留空就用默认模型；顺手去掉空格和换行（模型名里不该有它们）。 */
export function normalizeVisionModel(v) {
  const s = String(v || '').trim().replace(/\s+/g, '').slice(0, VISION_MODEL_MAX);
  return s || DEFAULT_VISION_MODEL;
}

/** Ollama 的模型名同一个（`:latest` 可以省略）。 */
function sameModel(a, b) {
  return a === b || a.split(':')[0] === b.split(':')[0];
}

/** 前端的图片统一成 base64：data URL 和纯 base64 都收。 */
export function parseImagePayload(image, mime) {
  let s = String(image || '').trim();
  if (!s) throw new Error('没有收到图片数据');
  let type = String(mime || '').trim().toLowerCase();
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/is.exec(s);
  if (m) { type = m[1].toLowerCase(); s = m[2]; }
  if (!/^image\//.test(type)) type = 'image/jpeg';     // 前端没给类型就按 jpeg 兜底
  s = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error('图片数据不是合法的 base64');
  if (s.length > VISION_IMAGE_MAX) {
    throw new Error(`图片太大（约 ${Math.round(s.length / 1024 / 1024)}MB，上限 ${Math.round(VISION_IMAGE_MAX / 1024 / 1024)}MB），换一张小点的`);
  }
  return { base64: s, mime: type };
}

/**
 * 让本地视觉模型描述一张图。
 * @param {object} opts
 * @param {object} opts.config  getConfig() 的结果
 * @param {string} opts.image   base64 或 data URL
 * @param {string} [opts.mime]
 * @param {string} [opts.prompt] 自定义提示词（留空用 VISION_PROMPT）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{text: string, model: string, seconds: number, tokens: number}>}
 */
export async function describeImage({ config, image, mime, prompt, signal }) {
  const base = localOllamaBase(config);
  if (!base) {
    throw new Error('当前不是本地模型地址，📷 识图只在本机 Ollama 上可用'
      + '（设置 → Base URL 填 http://127.0.0.1:11434/v1）');
  }
  const model = normalizeVisionModel(config?.visionModel);
  const pic = parseImagePayload(image, mime);
  const text = String(prompt || '').trim().slice(0, VISION_PROMPT_MAX) || VISION_PROMPT;

  // 先确认这个模型在不在、支不支持图片 —— 让报错停在「人话」这一层，
  // 而不是等 Ollama 回个 400 让人猜。
  let caps = [];
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    const hit = (j.models || []).find((m) => sameModel(m.name, model));
    if (!hit) {
      const names = (j.models || []).map((m) => m.name);
      throw new Error(`本机 Ollama 里没有识图模型 ${model}`
        + `。先拉一个：ollama pull ${DEFAULT_VISION_MODEL}`
        + (names.length ? `（它现在有：${names.join('、')}）` : ''));
    }
    caps = Array.isArray(hit.capabilities) ? hit.capabilities : [];
    if (caps.length && !caps.includes('vision')) {
      throw new Error(`模型 ${model} 不支持图片输入（capabilities: ${caps.join(', ')}）。`
        + `识图要用带 vision 的模型，比如 ${DEFAULT_VISION_MODEL}`);
    }
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'TypeError') {
      throw new Error(`连不上本地 Ollama（${base}）—— 先点主页的「🟢 启动 Ollama」`);
    }
    throw err;
  }

  const body = {
    model,
    messages: [{ role: 'user', content: text, images: [pic.base64] }],
    stream: false,
    keep_alive: config?.keepAlive ?? '2m',
    options: { temperature: 0.2, num_ctx: 8192 },
  };
  // 思考型模型必须关掉思考：否则思维链先把输出预算吃光，content 就是空的。
  if (caps.includes('thinking')) body.think = false;

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(300000),   // 4B 冷加载几十秒，给足
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError'
      ? '识图超时（5 分钟）—— 模型可能还在从硬盘加载，等它热了再试'
      : `识图请求失败：${err.message}`);
  }
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`识图失败（HTTP ${res.status}）${detail}`);
  }
  const out = await res.json().catch(() => null);
  const reply = String(out?.message?.content || '').trim();
  if (!reply) {
    throw new Error('模型没有返回描述'
      + (caps.includes('thinking')
        ? '（这个模型带思考，可能把输出都花在思考上了——试个不带思考的视觉模型）'
        : ''));
  }
  return { text: reply, model, seconds, tokens: out?.eval_count || 0 };
}
