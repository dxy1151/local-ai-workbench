// 星野（m.xingyeai.com）角色抓取：签名请求 / 分享链接解析 / 角色卡映射 / 本地落盘。
//
// 全部零依赖（只用 Node 内置模块）。算法来自反向工程脚本：
//   /home/don0ox1/deepseek/星野抓提示词/星野提示词采集.py
//   /home/don0ox1/deepseek/星野抓提示词/星野链接抓卡.py
// 具体契约见 xingye-work-art/SPEC.md §3（抓取算法）、§4（数据落盘）、§5（API）。
//
// 数据落盘（<DATA_DIR> = store.js 的 DATA_DIR）：
//   <DATA_DIR>/xingye/registry.json        {version:1, items:{ "<npcId>": RegistryItem }}
//   <DATA_DIR>/xingye/cards/<npcId>.json   完整角色卡（toCard 输出）
//   <DATA_DIR>/xingye/avatars/<npcId>.<ext>头像原图
//   <DATA_DIR>/xingye/links.jsonl          分享链接 ↔ npcId 追加日志（可选）
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, saveCharacter, getCharacter, listCharacters } from './store.js';

export const XINGYE_DIR = path.join(DATA_DIR, 'xingye');
export const CARDS_DIR = path.join(XINGYE_DIR, 'cards');
export const AVATARS_DIR = path.join(XINGYE_DIR, 'avatars');
export const REGISTRY_FILE = path.join(XINGYE_DIR, 'registry.json');
export const LINKS_FILE = path.join(XINGYE_DIR, 'links.jsonl');

const HOST = 'https://m.xingyeai.com';
const SALT = '987c331b';
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';
const TIMEOUT_MS = 20000;
const AVATAR_MAX_BYTES = 3 * 1024 * 1024;

/* ---------------- 通用小工具 ---------------- */

function clampInt(v, def, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function trimStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 打日志用：把异常压成一句话。 */
function errMsg(err) {
  return err && err.message ? err.message : String(err);
}

/* ---------------- 签名请求 ---------------- */

function signedQuery(uid = 2) {
  const params = {
    user_id: uid,
    device_id: String(Date.now()),
    os: 3,
    app_id: 300,
    device_platform: 'pc',
  };
  return Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
}

/**
 * 星野 weaver API 的签名 POST。签名算法（从 APK 逆出来的盐）：
 *   raw = 字典序 query + JSON.stringify(body) + "x-timestamp=" + ts + "salt=987c331b"
 *   x-sign = sha1(raw).hex
 * 读接口对 user_id 只做弱校验，任意非 0 值都能读公开数据。
 */
export async function signCall(apiPath, body = {}, opts = {}) {
  const { uid = 2, token = '', timeout = TIMEOUT_MS } = opts;
  const params = {
    user_id: uid,
    device_id: String(Date.now()),
    os: 3,
    app_id: 300,
    device_platform: 'pc',
  };
  const ts = Math.round(Date.now() / 1000);
  const q = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const payload = JSON.stringify(body);
  const raw = `${q}${payload}x-timestamp=${ts}salt=${SALT}`;
  const sign = crypto.createHash('sha1').update(raw).digest('hex');
  const url = `${HOST}${apiPath}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-token': token,
      'x-timestamp': String(ts),
      'x-sign': sign,
    },
    body: payload,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`星野接口 ${apiPath} 返回 HTTP ${res.status}`);
  return res.json();
}

/** 带一次重试的取资料（SPEC §3.3：profile 最多重试 1 次）。 */
async function withRetry(fn, retries = 1) {
  let last;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < retries) await sleep(400);
    }
  }
  throw last;
}

/* ---------------- 分享链接 ---------------- */

// 从任意文本里抠链接：遇到中文标点/空白/引号/括号就停，URL 自身的 % - _ 都保留。
const URL_RE = /https?:\/\/[^\s，。！？、；：()（）【】《》<>"'`]+/g;

export function extractUrls(text) {
  const matches = String(text || '').match(URL_RE) || [];
  return [...new Set(matches)];
}

const NPC_ID_RE = /[?&]npc_id=(\d+)/;

/** 分享短链 → { npcId, finalUrl }。跟随 HEAD/GET 跳转后从最终 URL 抠 npc_id。 */
export async function resolveShare(url, opts = {}) {
  const { timeout = TIMEOUT_MS } = opts;
  const raw = trimStr(url);
  if (!/^https?:\/\//i.test(raw)) throw new Error(`不是合法链接：${raw || '(空)'}`);
  let lastErr = null;
  let finalUrl = raw;
  const head = await fetch(raw, {
    method: 'HEAD',
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeout),
  }).then((r) => r.url || raw).catch((e) => { lastErr = e; return ''; });
  if (head) finalUrl = head;
  let m = finalUrl.match(NPC_ID_RE) || raw.match(NPC_ID_RE);
  if (!m) {
    // 有些短链 HEAD 不给跳转目标，补一次 GET 跟随。
    const got = await fetch(raw, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeout),
    }).then((r) => r.url || raw).catch((e) => { lastErr = e; return ''; });
    if (got) finalUrl = got;
    m = finalUrl.match(NPC_ID_RE) || raw.match(NPC_ID_RE);
  }
  if (!m) {
    throw new Error(`无法从 ${raw} 解析 npc_id（最终地址 ${finalUrl || '未知'}）${lastErr ? `：${errMsg(lastErr)}` : ''}`);
  }
  return { npcId: Number(m[1]), finalUrl };
}

/* ---------------- 资料抓取 ---------------- */

/** 头像 URL 优先级（SPEC §3.3）：thumbnail → avatar_list[0].avatar_img_url → url → background_img.img_url。 */
export function pickAvatar(inner) {
  const ai = inner?.avatar_info;
  if (ai && typeof ai === 'object') {
    if (ai.thumbnail_avatar_url) return ai.thumbnail_avatar_url;
    for (const av of ai.avatar_list || []) {
      if (av && typeof av === 'object' && av.avatar_img_url) return av.avatar_img_url;
    }
    if (ai.url) return ai.url;
  }
  const av = inner?.avatar;
  if (av && typeof av === 'object' && av.url) return av.url;
  const bg = inner?.background_img || inner?.bg_image;
  if (bg && typeof bg === 'object' && bg.img_url) return bg.img_url;
  return '';
}

function normTags(tags) {
  const out = [];
  for (const t of tags || []) {
    if (t && typeof t === 'object') {
      out.push(String(t.name || t.tag_name || t.tag || t.title || t.id || ''));
    } else if (t !== undefined && t !== null) {
      out.push(String(t));
    }
  }
  return out.filter(Boolean);
}

function baseRec(npcId) {
  return {
    npcId,
    name: '',
    desc: '',
    long_desc: '',
    hidden_desc: '',
    prologue: '',
    example_dialogue_list: [],
    npc_tone_name: '',
    npc_tag_list: [],
    avatar: '',
    personality_pack_desc: '',
    source: 'v1',
  };
}

async function fetchProfileV1(npcId) {
  const d = await signCall('/weaver/api/v1/npc/get_npc_profile', { npc_id: npcId });
  const inner = d?.npc_info?.npc_info || {};
  const meta = inner.meta_info || {};
  const rec = baseRec(npcId);
  rec.name = trimStr(meta.name);
  rec.desc = trimStr(meta.desc);
  rec.long_desc = trimStr(meta.long_desc);
  rec.hidden_desc = trimStr(meta.hidden_desc);
  rec.prologue = trimStr(meta.prologue);
  rec.example_dialogue_list = Array.isArray(meta.example_dialogue_list) ? meta.example_dialogue_list : [];
  rec.npc_tone_name = trimStr(meta.npc_tone_name);
  rec.npc_tag_list = normTags(meta.npc_tag_list);
  rec.avatar = pickAvatar(inner);
  rec.source = 'v1';
  return rec;
}

async function fetchProfileV2(npcId) {
  const d = await signCall('/weaver/api/v2/npc/get_npc_profile', { npc_id: npcId });
  const npc = d?.npc || {};
  const meta = npc.npc_meta || {};
  const pack = d?.npc_personality_packer_info?.master_personality || {};
  const rec = baseRec(npcId);
  rec.name = trimStr(meta.name || npc.name || pack.npc_name);
  rec.desc = trimStr(npc.desc || meta.desc || pack.npc_desc);
  rec.long_desc = trimStr(meta.long_desc || pack.long_desc);
  rec.hidden_desc = '';
  rec.prologue = trimStr(npc.prologue || meta.prologue || pack.prologue);
  rec.example_dialogue_list = [];
  rec.npc_tone_name = trimStr(pack.npc_tone?.name || npc.npc_tone?.name || npc.npc_tone?.tone_name);
  rec.npc_tag_list = normTags(pack.display_tag_list || npc.npc_tag_list);
  rec.avatar = pickAvatar(npc);
  rec.personality_pack_desc = trimStr(pack.npc_desc);
  rec.source = 'v2';
  return rec;
}

/** 主 v1；字段缺失（或 v1 失败）时用 v2 兜底补人格包正文。 */
export async function getProfile(npcId) {
  const id = Number(npcId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`npc_id 不合法：${npcId}`);
  let rec = null;
  let v1Err = null;
  try {
    rec = await withRetry(() => fetchProfileV1(id), 1);
  } catch (err) {
    v1Err = err;
  }
  if (!rec || !(rec.desc || rec.long_desc || rec.hidden_desc)) {
    try {
      const v2 = await fetchProfileV2(id);
      if (!rec) rec = v2;
      else {
        rec.desc = rec.desc || v2.desc;
        rec.long_desc = rec.long_desc || v2.long_desc;
        rec.prologue = rec.prologue || v2.prologue;
        rec.avatar = rec.avatar || v2.avatar;
        rec.personality_pack_desc = rec.personality_pack_desc || v2.personality_pack_desc;
        if (v2.personality_pack_desc) rec.source = 'v1+v2';
      }
    } catch (v2Err) {
      if (!rec) throw new Error(`抓取 ${id} 失败：v1 ${errMsg(v1Err)}；v2 ${errMsg(v2Err)}`);
    }
  }
  return rec;
}

/* ---------------- 角色卡映射（SPEC §3.3） ---------------- */

function normalizeExampleGroups(list) {
  const groups = [];
  for (const g of list || []) {
    if (Array.isArray(g)) groups.push(g);
    else if (g && typeof g === 'object') groups.push([g]);
  }
  return groups;
}

/** rec → xingye-chat 角色卡。示例对话拼进 persona，**不进 phrases**。 */
export function toCard(rec, opts = {}) {
  const npcId = Number(rec?.npcId ?? rec?.npc_id);
  const name = trimStr(rec?.name) || `星野_${npcId}`;
  const parts = [];
  const push = (v) => {
    const s = trimStr(v);
    if (s && !parts.includes(s)) parts.push(s);
  };
  push(rec?.hidden_desc);
  push(rec?.long_desc);
  push(rec?.desc);
  push(rec?.personality_pack_desc);

  const exLines = [];
  for (const group of normalizeExampleGroups(rec?.example_dialogue_list)) {
    for (const msg of group) {
      if (!msg || typeof msg !== 'object' || !msg.message) continue;
      const role = msg.role_type === 2 ? '用户' : name;
      exLines.push(`${role}：${msg.message}`);
    }
  }
  if (exLines.length) parts.push(`【示例对话】\n${exLines.join('\n')}`);

  const desc = trimStr(rec?.desc);
  const tagline = desc.split('\n')[0].slice(0, 60);
  const avatar = trimStr(opts.avatarUrl) || trimStr(rec?.avatar);
  return {
    name,
    avatar,
    tagline,
    persona: parts.join('\n\n'),
    scenario: desc,
    greeting: trimStr(rec?.prologue),
    phrases: '',
    voice: trimStr(rec?.npc_tone_name),
    dims: null,
    hint: (rec?.npc_tag_list || []).join(', '),
    xingye_npc_id: npcId,
  };
}

/* ---------------- 落盘（SPEC §4） ---------------- */

async function ensureDirs() {
  await fs.mkdir(CARDS_DIR, { recursive: true });
  await fs.mkdir(AVATARS_DIR, { recursive: true });
}

async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** 读 registry（损坏/不存在都当空）。 */
export async function readRegistry() {
  try {
    const raw = await fs.readFile(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const items = parsed?.items && typeof parsed.items === 'object' ? parsed.items : {};
    return { version: 1, items };
  } catch {
    return { version: 1, items: {} };
  }
}

// 进程内 async mutex：**registry 读改写 与 注册（查重+创建+回填）共用同一把锁**。
// 为什么必须共用：并发 register 若只锁 registry 写入，"查重→创建"之间仍有窗口，
// 5 个并发请求会各建一个同名角色（research 对抗验收抓到的 bug）。
// 注意：锁内不要再调 updateRegistry()（会排在锁后面 → 死锁）；锁内用
// readRegistry()/writeJsonAtomic(CARDS/REGISTRY...) 的无锁组合。
let mutationChain = Promise.resolve();
function withMutationLock(fn) {
  const run = mutationChain.then(fn, fn);
  // 链本身不抛，避免一次失败把后续所有操作卡死。
  mutationChain = run.then(() => undefined, () => undefined);
  return run;
}

export async function updateRegistry(mutator) {
  return withMutationLock(async () => {
    const reg = await readRegistry();
    await mutator(reg);
    await writeJsonAtomic(REGISTRY_FILE, reg);
    return reg;
  });
}

/** 原子写一张角色卡。 */
export async function saveCard(npcId, card) {
  await ensureDirs();
  await writeJsonAtomic(path.join(CARDS_DIR, `${npcId}.json`), card);
}

export async function getCard(npcId) {
  try {
    return JSON.parse(await fs.readFile(path.join(CARDS_DIR, `${npcId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function cardUrl(npcId) {
  return `/api/xingye/avatar/${npcId}`;
}

/** 该 npcId 已下载头像的本地文件信息；没有返回 null。 */
export async function avatarFile(npcId) {
  try {
    const files = await fs.readdir(AVATARS_DIR);
    const prefix = `${npcId}.`;
    const hit = files.find((f) => f.startsWith(prefix));
    if (!hit) return null;
    const ext = path.extname(hit).toLowerCase();
    const mime = ext === '.webp' ? 'image/webp'
      : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
        : ext === '.gif' ? 'image/gif' : 'image/png';
    return { file: path.join(AVATARS_DIR, hit), ext, mime };
  } catch {
    return null;
  }
}

function guessExt(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('png')) return '.png';
  const u = String(url || '').toLowerCase().split('?')[0];
  if (u.endsWith('.webp')) return '.webp';
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return '.jpg';
  if (u.endsWith('.gif')) return '.gif';
  return '.png';
}

/** 下载头像 → 本地文件（上限 3MB）。成功返回本地 URL，失败抛错。 */
export async function downloadAvatar(npcId, url, opts = {}) {
  const { timeout = TIMEOUT_MS } = opts;
  const remote = trimStr(url);
  if (!remote) throw new Error('没有头像地址');
  await ensureDirs();
  const res = await fetch(remote, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`头像下载 HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > AVATAR_MAX_BYTES) throw new Error(`头像超过 3MB（${declared} 字节）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > AVATAR_MAX_BYTES) throw new Error(`头像超过 3MB（${buf.length} 字节）`);
  if (!buf.length) throw new Error('头像下载为空');
  const ext = guessExt(remote, res.headers.get('content-type'));
  const file = path.join(AVATARS_DIR, `${npcId}${ext}`);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, file);
  // 同名不同后缀的旧头像清掉，保证 avatarFile 只有一份。
  const old = (await fs.readdir(AVATARS_DIR)).filter((f) => f.startsWith(`${npcId}.`) && f !== `${npcId}${ext}`);
  for (const f of old) await fs.unlink(path.join(AVATARS_DIR, f)).catch(() => {});
  return cardUrl(npcId);
}

async function appendLinkLog(entry) {
  try {
    await fs.mkdir(path.dirname(LINKS_FILE), { recursive: true });
    await fs.appendFile(LINKS_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch { /* 可选日志，写不了不影响主流程 */ }
}

/* ---------------- registry 查询 ---------------- */

/** 抓一个 NPC：取资料 → 下头像 → 出卡 → 写 cards/ 和 registry。 */
export async function fetchOne(npcId, opts = {}) {
  const { source = 'id', downloadAvatar: wantAvatar = true } = opts;
  const id = Number(npcId);
  const rec = await getProfile(id);
  let localAvatar = '';
  if (wantAvatar && rec.avatar) {
    try {
      localAvatar = await downloadAvatar(id, rec.avatar);
    } catch { /* 下载失败按 SPEC 用 name[0] */ }
  } else if (!wantAvatar) {
    const existing = await avatarFile(id);
    if (existing) localAvatar = cardUrl(id);
  }
  const fallbackAvatar = (rec.name || `星${id}`).slice(0, 1) || '?';
  const card = toCard(rec, { avatarUrl: localAvatar || fallbackAvatar });
  card.xingye_source = source;
  card.xingye_fetched_at = Date.now();
  await saveCard(id, card);

  const prev = (await readRegistry()).items[String(id)] || null;
  const item = {
    npcId: id,
    name: card.name,
    tagline: card.tagline,
    // 与 card.avatar 保持同一个值：有本地头像时都是 /api/xingye/avatar/<id>，
    // 没有时都是首字（非图片，前端 xyAvatarHtml/avatarMark 会走文字首字回退）。
    avatarUrl: card.avatar || '',
    personaChars: card.persona.length,
    greetingChars: card.greeting.length,
    fetchedAt: Date.now(),
    source,
    registered: Boolean(prev?.registered),
    characterId: prev?.characterId || null,
    registeredAt: prev?.registeredAt || null,
  };
  await updateRegistry((reg) => {
    reg.items[String(id)] = item;
  });
  return { item, card, rec };
}

/** 已抓列表（按 fetchedAt 倒序，query 过滤 name/tagline）。 */
export async function listCards(opts = {}) {
  const query = trimStr(opts.query).toLowerCase();
  const limit = clampInt(opts.limit, 200, 1, 500);
  const offset = clampInt(opts.offset, 0, 0, 1e9);
  const reg = await readRegistry();
  let items = Object.values(reg.items).filter(Boolean);
  if (query) {
    items = items.filter((it) => `${it.name || ''}\n${it.tagline || ''}`.toLowerCase().includes(query));
  }
  items.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
  return { total: items.length, items: items.slice(offset, offset + limit) };
}

/** 单条已抓记录（详情弹窗用）：不存在返回 null。 */
export async function getRecord(npcId) {
  const id = Number(npcId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const reg = await readRegistry();
  const item = reg.items[String(id)] || null;
  const card = await getCard(id);
  if (!item && !card) return null;
  const fallbackItem = item || {
    npcId: id,
    name: card?.name || `星野_${id}`,
    tagline: card?.tagline || '',
    avatarUrl: card?.avatar || '',
    personaChars: (card?.persona || '').length,
    greetingChars: (card?.greeting || '').length,
    fetchedAt: 0,
    source: 'id',
    registered: false,
    characterId: null,
    registeredAt: null,
  };
  return { item: fallbackItem, card: card || null };
}

/** status 统计：已抓 / 已注册。 */
export async function stats() {
  const reg = await readRegistry();
  const items = Object.values(reg.items).filter(Boolean);
  return { fetched: items.length, registered: items.filter((it) => it.registered).length };
}

/** 该 npcId 的头像文件是否仍被 registry 指向的已注册角色引用（SPEC §5.6）。 */
async function avatarStillReferenced(npcId, characterId) {
  if (!characterId) return false;
  const ch = await getCharacter(characterId).catch(() => null);
  if (!ch) return false;
  return trimStr(ch.avatar) === cardUrl(npcId);
}

/** 兜底：扫一遍所有本地角色，看还有没有 avatar 指向 /api/xingye/avatar/<npcId>。 */
async function avatarReferencedAnywhere(npcId) {
  const target = cardUrl(npcId);
  for (const ch of await listCharacters().catch(() => [])) {
    if (trimStr(ch.avatar) === target) return true;
  }
  return false;
}

/**
 * 删除「已抓记录」（SPEC §5.6）：删 registry item + cards/<npcId>.json，
 * **不删已注册角色**；头像文件只在该角色已不存在、或它的 avatar 已不再指向
 * `/api/xingye/avatar/<npcId>` 时才删（否则角色列表/聊天头会破图）。
 * 重复 DELETE 返回 false（路由层回 404），且**不会**动已经保留下来的头像文件。
 */
export async function deleteRecord(npcId) {
  const id = Number(npcId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  await ensureDirs();
  let existed = false;
  await withMutationLock(async () => {
    const reg = await readRegistry();
    const item = reg.items[String(id)] || null;
    const cardPath = path.join(CARDS_DIR, `${id}.json`);
    let cardExisted = false;
    try {
      await fs.access(cardPath);
      cardExisted = true;
    } catch { /* 没有卡片 */ }

    // 没有抓取记录（registry item 和卡片都不在）→ 重复 DELETE，什么都不动（含头像）。
    if (!item && !cardExisted) return;

    // 先判断头像是否还被已注册角色引用，再决定删不删文件。
    let keepAvatar = false;
    if (item?.registered && item.characterId) {
      keepAvatar = await avatarStillReferenced(id, item.characterId);
    }
    if (!keepAvatar) keepAvatar = await avatarReferencedAnywhere(id);

    if (item) {
      delete reg.items[String(id)];
      await writeJsonAtomic(REGISTRY_FILE, reg);
      existed = true;
    }
    if (cardExisted) {
      await fs.unlink(cardPath).catch(() => {});
      existed = true;
    }
    if (!keepAvatar) {
      const av = await avatarFile(id);
      if (av) await fs.unlink(av.file).catch(() => {});
    }
  });
  return existed;
}

/**
 * 维护工具（**不会自动执行**，留给需要时手动调用）：
 * 清理没有被任何已注册角色引用的星野头像文件（例如旧的「删记录即删头像」版本留下的孤儿）。
 * 返回被删掉的文件名数组。
 */
export async function cleanupOrphanAvatars() {
  const referenced = new Set();
  const noteRef = (avatar) => {
    const m = trimStr(avatar).match(/^\/api\/xingye\/avatar\/(\d+)$/);
    if (m) referenced.add(Number(m[1]));
  };
  const reg = await readRegistry();
  for (const it of Object.values(reg.items)) {
    // 抓取记录自己的列表头像（avatarUrl）也要算引用：文件删了星野列表会破图。
    noteRef(it?.avatarUrl);
    if (!it?.registered || !it.characterId) continue;
    const ch = await getCharacter(it.characterId).catch(() => null);
    if (ch) noteRef(ch.avatar);
  }
  // registry 里已经没有记录、但已注册角色的 avatar 仍指向星野头像的情况也要算引用。
  for (const ch of await listCharacters().catch(() => [])) noteRef(ch.avatar);
  const files = await fs.readdir(AVATARS_DIR).catch(() => []);
  const removed = [];
  for (const file of files) {
    const m = file.match(/^(\d+)\./);
    if (!m) continue;
    if (referenced.has(Number(m[1]))) continue;
    await fs.unlink(path.join(AVATARS_DIR, file)).catch(() => {});
    removed.push(file);
  }
  return removed;
}

/* ---------------- 注册（SPEC §4 去重规则） ---------------- */

/**
 * 抓取记录 → 本地角色。去重顺序：
 *   1. registry 已 registered 且角色还在 → already-registered
 *   2. 本地已有同名角色 → name-exists（并把 registry 指向已有角色）
 *   3. 否则创建
 *
 * ⚠ 并发安全：「查重 → 创建 → registry 回填」整段在 withMutationLock 里串行执行。
 * 5 个并发 POST /api/xingye/register 同一 npcId 时，第一个创建后其余会读到
 * registry.registered / 本地同名角色而 skip，**不会出现重复角色**。
 * 锁内禁止调 updateRegistry（同一把锁 → 死锁），registry 直接 read + writeJsonAtomic。
 */
export async function registerCharacters(npcIds) {
  const created = [];
  const skipped = [];
  const seen = new Set();
  const targets = [];
  for (const raw of npcIds || []) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      skipped.push({ npcId: raw, name: '', reason: 'not-fetched' });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push(id);
  }
  if (!targets.length) return { created, skipped };

  await withMutationLock(async () => {
    const reg = await readRegistry();
    let regChanged = false;
    const flush = async () => {
      if (!regChanged) return;
      await writeJsonAtomic(REGISTRY_FILE, reg);
      regChanged = false;
    };
    try {
      for (const id of targets) {
        const card = await getCard(id);
        if (!card) {
          skipped.push({ npcId: id, name: '', reason: 'not-fetched' });
          continue;
        }
        const name = trimStr(card.name) || `星野_${id}`;
        const item = reg.items[String(id)] || null;

        // 规则 0：registry 没有这条记录（或 tagline 等摘要缺失）时顺手补齐摘要。
        const ensureItem = () => {
          if (reg.items[String(id)]) return reg.items[String(id)];
          const it = {
            npcId: id,
            name,
            tagline: card.tagline || '',
            avatarUrl: card.avatar || '',
            personaChars: (card.persona || '').length,
            greetingChars: (card.greeting || '').length,
            fetchedAt: Date.now(),
            source: 'id',
            registered: false,
            characterId: null,
            registeredAt: null,
          };
          reg.items[String(id)] = it;
          return it;
        };

        // 规则 1：registry 已 registered 且对应角色仍存在
        if (item?.registered && item.characterId) {
          const exist = await getCharacter(item.characterId);
          if (exist) {
            skipped.push({ npcId: id, name, reason: 'already-registered' });
            continue;
          }
        }

        // 规则 2：本地已有同名角色（锁内查一次）。
        const pointToExisting = (existing) => {
          const it = ensureItem();
          it.registered = true;
          it.characterId = existing.id;
          it.registeredAt = it.registeredAt || Date.now();
          regChanged = true;
          skipped.push({ npcId: id, name, reason: 'name-exists' });
        };
        let existing = (await listCharacters()).find((c) => trimStr(c.name) === trimStr(name));
        if (existing) {
          pointToExisting(existing);
          continue;
        }

        // 防御：**创建前再查一次**。注册路径已被这把锁串行化，但
        // POST /api/characters 等其他入口仍可能并发建同名角色。
        existing = (await listCharacters()).find((c) => trimStr(c.name) === trimStr(name));
        if (existing) {
          pointToExisting(existing);
          continue;
        }

        // 规则 3：创建
        const localAvatar = await avatarFile(id);
        const avatar = localAvatar ? cardUrl(id) : (name.slice(0, 1) || '?');
        const saved = await saveCharacter({
          name,
          avatar,
          tagline: card.tagline || '',
          persona: card.persona || '',
          scenario: card.scenario || '',
          greeting: card.greeting || '',
          phrases: '',
          voice: card.voice || '',
          dims: null,
          hint: card.hint || '',
        });
        const it = ensureItem();
        it.registered = true;
        it.characterId = saved.id;
        it.registeredAt = Date.now();
        it.avatarUrl = avatar;
        regChanged = true;
        created.push({ npcId: id, name, characterId: saved.id });
      }
    } finally {
      // 锁释放前一定落盘（即使中途抛错也把已完成的 registry 回填写进去）。
      await flush();
    }
  });
  return { created, skipped };
}

/* ---------------- 搜索（SPEC §5.8） ---------------- */

function mapRemoteNpc(nd) {
  const desc = trimStr(nd.desc || nd.prologue);
  return {
    npcId: Number(nd.npc_id),
    name: trimStr(nd.name) || `星野_${nd.npc_id}`,
    tagline: desc.split('\n')[0].slice(0, 60),
    avatarUrl: trimStr(pickAvatar(nd)),
    desc,
  };
}

async function realSearch(query, timeout) {
  // research 实测的真实搜索接口（page 从 0 开始，服务端可能只给 10 条）。
  const d = await signCall('/weaver/api/v1/search/query',
    { query, page: 0, size: 20, is_final_query: true }, { timeout });
  const items = [];
  for (const it of d?.item_list || []) {
    const nd = it?.npc_data;
    if (nd && nd.npc_id) items.push(mapRemoteNpc(nd));
  }
  return items;
}

/**
 * 相关性过滤：无结果时服务端会回退成推荐流（乱码词也返回不相关角色），
 * 必须按 name/tagline/desc 命中 query（忽略大小写）保留，过滤后可能为空。
 */
function filterRelevant(items, query) {
  const q = query.toLowerCase();
  return items.filter((it) => `${it.name}\n${it.tagline}\n${it.desc}`.toLowerCase().includes(q));
}

// 搜索兜底：探索流候选池（内存缓存 10 分钟，不落到磁盘，也不对外暴露「热门」入口）。
let explorePoolCache = { at: 0, items: [] };
const EXPLORE_TTL = 10 * 60 * 1000;

function mapExploreItem(nd) {
  if (!nd || !nd.npc_id) return null;
  return mapRemoteNpc(nd);
}

async function explorePool() {
  if (Date.now() - explorePoolCache.at < EXPLORE_TTL && explorePoolCache.items.length) return explorePoolCache.items;
  const found = [];
  const push = (nd) => {
    const m = mapExploreItem(nd);
    if (m && Number.isSafeInteger(m.npcId) && m.npcId > 0) found.push(m);
  };
  await Promise.allSettled([
    (async () => {
      const feed = await signCall('/weaver/api/v1/feed/get_explore_feed', {}, { timeout: 8000 });
      for (const it of feed?.item_list || []) push(it?.npc_data);
    })(),
    (async () => {
      const tabs = await signCall('/weaver/api/v1/explore/get_tab_list', {}, { timeout: 8000 });
      let budget = 3;
      for (const tab of tabs?.tab_list || []) {
        for (const mod of tab?.modules || []) {
          if (budget-- <= 0) return;
          try {
            const ex = await signCall('/weaver/api/v1/explore/page_query_infinite_npc',
              { tab_id: tab?.id, module_id: mod?.id, cursor: 0, count: 10 }, { timeout: 8000 });
            for (const it of ex?.npc_data_list || []) push(it);
          } catch { /* 单个 module 失败跳过 */ }
        }
      }
    })(),
    (async () => {
      const ex = await signCall('/weaver/api/v1/explore/page_query_infinite_npc', { cursor: 0, count: 10 }, { timeout: 8000 });
      for (const it of ex?.npc_data_list || []) push(it);
    })(),
    (async () => {
      const d = await signCall('/weaver/api/v1/post/get_discover_selected_npc', {}, { timeout: 8000 });
      push(d?.npc_info);
    })(),
  ]);
  const seen = new Set();
  explorePoolCache = {
    at: Date.now(),
    items: found.filter((m) => (seen.has(m.npcId) ? false : (seen.add(m.npcId), true))),
  };
  return explorePoolCache.items;
}

function localFilter(pool, query) {
  const q = query.toLowerCase();
  return pool.filter((it) => `${it.name}\n${it.tagline}\n${it.desc}`.toLowerCase().includes(q));
}

/** 搜索星野角色：真实搜索接口（/weaver/api/v1/search/query）+ 相关性过滤；
 * 仅当接口网络失败时才退回探索流候选池本地过滤（结果结构一致）。 */
export async function search(query, opts = {}) {
  const q = trimStr(query);
  if (!q) return [];
  const { timeout = 12000 } = opts;
  let items = [];
  try {
    items = filterRelevant(await realSearch(q, timeout), q);
  } catch {
    try {
      items = localFilter(await explorePool(), q);
    } catch {
      items = [];
    }
  }
  const reg = await readRegistry();
  return items.map((it) => ({
    npcId: it.npcId,
    name: it.name,
    tagline: it.tagline,
    avatarUrl: it.avatarUrl,
    desc: it.desc,
    fetched: Boolean(reg.items[String(it.npcId)]),
  }));
}
