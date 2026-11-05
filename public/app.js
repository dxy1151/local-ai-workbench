// 前端逻辑：角色管理、会话切换、流式聊天。
import { applyAutoPair, applyBackspacePair } from './autopair.js';
import { sendButtonState } from './uistate.js';
import { parseCheat, describeCheat } from './cheat.js';
import { slashTrigger, filterCharacters, conversationSpeakers } from './slashpick.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  characters: [],
  sessions: [],
  activeCharacterId: null,
  activeSessionId: null,
  // 'character' = 角色卡模式（默认）；'direct' = 直连模式（不加任何系统提示词）
  mode: 'character',
  // 直连模式的会话列表与当前会话
  directSessions: [],
  activeDirectId: null,
  // 当前会话的消息数组（含下标），撤回/改写都按下标操作。
  messages: [],
  streaming: false,
  abort: null,
  // 输入 quit 关闭程序之后置 true：输入框和发送键都锁死（服务已经没了）
  shutDown: false,
  config: { baseUrl: '', model: '', temperature: 0.85, hasApiKey: false },
  // 工作时段锁的当前状态（来自 /api/workguard）
  work: null,
  // 描写幅度（维度图）的工作副本 + 是否已启用
  dims: null,
  dimsActive: false,
  // 给 AI 的微调提示（工作副本）+ 是否"只在这次用"
  hint: '',
  hintOnce: false,
  // 提示预设（点一下就填进提示框；存一份在本地做即时反馈）
  hintPresets: [],
  // 场景备忘（常驻事实，改动立刻存盘）
  memo: '',
  memoTimer: null,
  // 回复字数上限（0 = 不限）
  maxChars: 0,
  // 🖼 附图：待发送的图片（data URL，浏览器里已经压过）+ 文件名。只挂下一条消息，发完就清。
  pendingImage: null,
  pendingImageName: '',
  // 星野面板：已抓角色卡 / 当前任务 / 搜索结果 / 本地筛选 / 懒加载标记。
  // 逻辑在文件末尾「星野面板」段落，这里只放数据，避免和其它状态混在一起。
  xingye: {
    loaded: false,
    refreshing: false,
    searching: false,
    jobStarting: false,
    registering: false,
    stats: { fetched: 0, registered: 0 },
    cards: [],
    results: [],
    filter: '',
    jobId: null,
    jobTimer: null,
    detailNpc: null,
    detailRemote: false,
  },
};

/* ---------- 基础工具 ---------- */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 头像可以是「文字/emoji」（默认），也可以是本地或远程图片 URL（星野抓取的头像走这里）。
function isImageAvatar(avatar) {
  return /^(\/|https?:\/\/)/i.test(String(avatar || '').trim());
}

// 图片头像加载失败时回退的文字：名字首字，空则 '?'（与文字头像的显示规则一致）。
function avatarFallbackChar(name) {
  return String(name ?? '').trim().slice(0, 1) || '?';
}

function avatarMark(character) {
  const avatar = character?.avatar;
  if (isImageAvatar(avatar)) {
    const fb = escapeHtml(avatarFallbackChar(character?.name));
    return `<img class="avatar-img" src="${escapeHtml(String(avatar).trim())}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${fb}">`;
  }
  return avatar ? escapeHtml(avatar) : '?';
}

// 图片头像 404/加载失败时替换成文字首字，避免破图（SPEC §6.5）。
// 用 capture 阶段监听 document 的 error：img 的 error 不冒泡，但捕获阶段能拿到；
// 只注册一次，动态重绘出来的新 <img> 也能被同一监听兜住。
let avatarFallbackBound = false;
function bindAvatarFallback() {
  if (avatarFallbackBound) return;
  avatarFallbackBound = true;
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('avatar-img')) return;
    const span = document.createElement('span');
    span.className = 'avatar-fallback';
    span.textContent = img.dataset.fallback || '?';
    img.replaceWith(span); // 替换后 img 被移除，不会二次触发
  }, true);
}

function scrollBottom() {
  const m = $('#messages');
  m.scrollTop = m.scrollHeight;
}

// 当前模式对应哪个会话 / 哪个聊天接口。
// 两种模式共用会话存储与「读改删」接口，只有"生成"这一步分成两条路：
// /api/chat 走角色卡（系统提示词 + 质量门），/api/direct/chat 是不带提示词的。
function activeSessionId() {
  return state.mode === 'direct' ? state.activeDirectId : state.activeSessionId;
}
function chatEndpoint() {
  return state.mode === 'direct' ? '/api/direct/chat' : '/api/chat';
}

/* ---------- 角色列表 ---------- */
function renderCharacters() {
  const list = $('#character-list');
  if (!state.characters.length) {
    list.innerHTML = '<li class="item-sub" style="padding:8px 4px">还没有角色，点上面新建一个吧</li>';
    return;
  }
  list.innerHTML = state.characters.map((c) => `
    <li class="card-item ${c.id === state.activeCharacterId ? 'active' : ''}" data-id="${c.id}">
      <div class="mini-avatar">${avatarMark(c)}</div>
      <div class="item-text">
        <div class="item-title">${escapeHtml(c.name)}</div>
        <div class="item-sub">${escapeHtml(c.tagline || '未填写简介')}</div>
      </div>
      <button class="item-edit" data-edit="${c.id}" title="编辑人设">✎</button>
      <button class="item-del" data-del="${c.id}" title="删除">✕</button>
    </li>
  `).join('');
}

function renderSessions() {
  const list = $('#session-list');
  // 直连模式的会话（kind='direct'、没有 characterId）不进这个列表，它们在「直连」标签页里。
  const mine = state.sessions.filter((s) => s.kind !== 'direct' && s.characterId === state.activeCharacterId);
  if (!state.activeCharacterId) {
    list.innerHTML = '<li class="item-sub" style="padding:8px 4px">先选择一个角色</li>';
    return;
  }
  if (!mine.length) {
    list.innerHTML = '<li class="item-sub" style="padding:8px 4px">还没有历史会话</li>';
    return;
  }
  list.innerHTML = mine.map((s) => `
    <li class="session-item ${s.id === state.activeSessionId ? 'active' : ''}" data-id="${s.id}">
      <div class="item-text">
        <div class="item-title">${escapeHtml(s.title)}</div>
        <div class="item-sub">${s.messageCount} 条 · ${escapeHtml(s.preview || '')}</div>
      </div>
      <button class="item-train" data-train="${s.id}" title="用这个会话训练模型">🧠</button>
      <button class="item-export" data-export="${s.id}" title="导出聊天记录（Markdown 文件，可直接下载）">⬇</button>
      <button class="item-del" data-del="${s.id}" title="删除">✕</button>
    </li>
  `).join('');
}

/* ---------- 角色编辑弹窗 ---------- */
function openCharacterModal(character = null) {
  const form = $('#character-form');
  form.reset();
  $('#character-modal-title').textContent = character ? '编辑角色' : '新建角色';
  form.id.value = character?.id || '';
  form.name.value = character?.name || '';
  form.avatar.value = character?.avatar || '';
  form.tagline.value = character?.tagline || '';
  form.gender.value = character?.gender || '';
  form.partnerGender.value = character?.partnerGender || '';
  if (form.allowShort) form.allowShort.checked = character?.allowShort === true;
  form.persona.value = character?.persona || '';
  form.scenario.value = character?.scenario || '';
  form.greeting.value = character?.greeting || '';
  form.phrases.value = character?.phrases || '';
  form.keywordActions.value = character?.keywordActions || '';
  fillCastForm(character);          // 多人模式：把 cast 填进人物行
  $('#character-modal').hidden = false;
  form.name.focus();
}

// 二次编辑人设的统一入口：角色列表的 ✎ 和聊天头部的 ✎ 都走这里。
function editCharacter(id) {
  const character = state.characters.find((c) => c.id === id);
  if (!character) return;
  setNav(false); // 手机上先收起抽屉，弹窗才看得清
  openCharacterModal(character);
}

/* ---------- 多人模式表单 ---------- */
function castEnabled() {
  return Boolean($('#cast-enabled')?.checked);
}

function collectCast() {
  return [...document.querySelectorAll('.cast-row')].map((row) => ({
    name: row.querySelector('.cast-name').value.trim(),
    desc: row.querySelector('.cast-desc').value.trim(),
  })).filter((c) => c.name);
}

function addCastRow(name = '', desc = '') {
  const box = $('#cast-rows');
  const row = document.createElement('div');
  row.className = 'cast-row';
  row.innerHTML = `<input class="cast-name" placeholder="人物名" maxlength="12" value="">
    <textarea class="cast-desc" rows="2" placeholder="这个人的性格、说话习惯、和别人的关系…"></textarea>
    <button type="button" class="cast-del" title="删除这个人物">×</button>`;
  row.querySelector('.cast-name').value = name;
  row.querySelector('.cast-desc').value = desc;
  row.querySelector('.cast-del').onclick = () => { row.remove(); syncCastUi(); };
  box.append(row);
  syncCastUi();
}

function syncCastUi() {
  const on = castEnabled();
  const rows = document.querySelectorAll('.cast-row');
  $('#cast-rows').hidden = !on;
  $('#cast-add').hidden = !on;
  $('#cast-note').hidden = !on;
  // 打开多人时至少给两行（一卡多人至少两个人）
  if (on && rows.length < 2) {
    if (rows.length === 0) { addCastRow(); addCastRow(); }
    else addCastRow();
  }
  // 行数少于 2 时提示一句
  const n = document.querySelectorAll('.cast-row').length;
  const note = $('#cast-note');
  if (note) {
    note.textContent = n >= 2
      ? `共 ${n} 个人物。第一个是「主视角」。回复按「名字：内容」输出，聊天页分气泡显示。`
      : '至少要有 2 个人物才会进入多人模式。';
    note.style.color = n >= 2 ? '' : '#ffb86c';
  }
}

function fillCastForm(character) {
  const rows = $('#cast-rows');
  rows.innerHTML = '';
  let list = Array.isArray(character?.cast) ? character.cast : [];
  if (!list.length && character?.persona) {
    // 兼容老卡：从 persona 里的「【人物】」标记还原
    const marks = [...String(character.persona).matchAll(/^[ \t]*【人物】[ \t]*([^\n]{1,12})[ \t]*$/gm)];
    list = marks.map((m, i) => ({
      name: m[1].trim(),
      desc: String(character.persona).slice(m.index + m[0].length,
        i + 1 < marks.length ? marks[i + 1].index : undefined).trim(),
    }));
  }
  const on = list.length >= 2;
  $('#cast-enabled').checked = on;
  for (const c of list) addCastRow(c.name || '', c.desc || '');
  syncCastUi();
}

async function submitCharacter(e) {
  e.preventDefault();
  const form = $('#character-form');
  const body = {
    id: form.id.value || undefined,
    name: form.name.value,
    avatar: form.avatar.value,
    tagline: form.tagline.value,
    gender: form.gender.value,
    partnerGender: form.partnerGender.value,
    allowShort: form.allowShort ? form.allowShort.checked : false,
    persona: form.persona.value,
    scenario: form.scenario.value,
    greeting: form.greeting.value,
    phrases: form.phrases.value,
    keywordActions: form.keywordActions.value,
    cast: castEnabled() ? collectCast() : [],
  };
  const isEdit = Boolean(body.id);
  try {
    const { character } = await api('/api/characters', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await refreshCharacters();
    $('#character-modal').hidden = true;
    if (isEdit) {
      // 二次编辑：不切角色、不清空当前对话。改完的人设从下一条回复开始生效
      // （服务端每轮都用最新的角色卡重新拼系统提示词）。
      if (state.activeCharacterId === character.id) updateChatHeader();
      toast('人设已更新 · 之后的回复立即按新设定走');
    } else {
      selectCharacter(character.id);
      toast('角色已创建');
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 删除确认（比 window.confirm 讲得清楚，损失大的还要手打「删除」） ---------- */

// 消息条数达到这个量，就必须手打「删除」才能继续。
const TYPING_THRESHOLD = 20;

let pendingConfirm = null;

function askDelete({ title, lines, needTyping }) {
  $('#confirm-title').textContent = title;
  $('#confirm-body').innerHTML = lines
    .map((l) => `<div>${l}</div>`)
    .join('');
  const wrap = $('#confirm-type-wrap');
  const input = $('#confirm-type-input');
  const ok = $('#confirm-ok');
  input.value = '';
  wrap.hidden = !needTyping;
  ok.disabled = Boolean(needTyping);
  $('#confirm-modal').hidden = false;
  (needTyping ? input : ok).focus();
  return new Promise((resolve) => {
    pendingConfirm = resolve;
  });
}

function closeConfirm(result) {
  const resolve = pendingConfirm;
  pendingConfirm = null;
  $('#confirm-modal').hidden = true;
  $('#confirm-body').innerHTML = '';
  $('#confirm-type-wrap').hidden = true;
  $('#confirm-type-input').value = '';
  if (resolve) resolve(result);
}

async function removeCharacter(id) {
  const character = state.characters.find((c) => c.id === id);
  const owned = state.sessions.filter((s) => s.characterId === id);
  const msgs = owned.reduce((n, s) => n + (s.messageCount || 0), 0);
  const ok = await askDelete({
    title: '删除角色',
    lines: [
      `角色：<b>${escapeHtml(character?.name || id)}</b>`,
      `会一并删掉它的 <b>${owned.length}</b> 个会话、共 <b>${msgs}</b> 条消息`,
      '<span class="danger-text">删除后无法撤销，也找不回来。</span>',
    ],
    needTyping: msgs >= TYPING_THRESHOLD,
  });
  if (!ok) return;
  try {
    await api(`/api/characters/${id}`, { method: 'DELETE' });
    if (state.activeCharacterId === id) {
      state.activeCharacterId = null;
      state.activeSessionId = null;
    }
    await refreshCharacters();
    await refreshSessions();
    updateChatHeader();
    toast(`已删除角色${owned.length ? `和 ${msgs} 条消息` : ''}`);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 设置弹窗 ---------- */
async function openSettings() {
  const form = $('#settings-form');
  // 打开时先跟服务端对一次表：否则页面如果是在别处（比如 switch-model 命令）改配置
  // 之前打开的，表单里还是旧值，一保存就把新配置覆盖回去（踩过这个坑）。
  try {
    await refreshConfig();
  } catch {
    /* 拉不到就用本地缓存 */
  }
  const config = state.config;
  form.apiKey.value = '';
  form.apiKey.placeholder = config.hasApiKey ? '已保存（留空则不修改）' : 'sk-...';
  fillSettingsForm();             // 其余字段统一由这个函数填（切模型后也复用它刷新表单）
  $('#settings-modal').hidden = false;
  await loadModels();
  await loadLocalModels();        // 本机模型列表（应用内一键切模型）
}

async function loadModels() {
  if (!state.config.hasApiKey) return;
  try {
    const { models } = await api('/api/models');
    $('#model-list').innerHTML = models
      .filter((m) => !m.includes('audio') && !m.includes('tts') && !m.includes('embedding'))
      .map((m) => `<option value="${escapeHtml(m)}">`).join('');
  } catch {
    /* 拉不到列表也没关系，用户可手动填模型名 */
  }
}

/* ---------- 应用内切模型（本机 Ollama / 云端） ---------- */
// 后端的 /api/local-models 会去问本机 Ollama 装了哪些模型（带规模、量化、支不支持思考），
// /api/switch-model 负责把 baseUrl / Key / 模型名 一次写对；
// 「关掉思考」不在里面改（保持用户手动设置），手机端也能用。
const fmtGB = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

async function loadLocalModels() {
  const box = $('#local-models');
  if (!box) return;
  box.innerHTML = '<div class="lm-empty">读取中…</div>';
  let d;
  try {
    d = await api('/api/local-models');
  } catch (err) {
    box.innerHTML = `<div class="lm-empty">读不到：${escapeHtml(err.message)}</div>`;
    return;
  }
  const cloudBtn = $('#cloud-back-btn');
  if (cloudBtn) {
    const saved = d.savedCloud || state.config.savedCloud;
    cloudBtn.hidden = !saved;
    cloudBtn.title = saved ? `还原成 ${saved.model}（${saved.baseUrl}）` : '';
  }
  const cloudModels = (d.models || []).filter((m) => m.backend === 'cloud');
  if (!d.ok && !cloudModels.length) {
    box.innerHTML = `<div class="lm-empty">${escapeHtml(d.error || '读不到本机模型')}`
      + '<br>（本机 Ollama 没起来时，可以点主页那个「⚪ 启动」）</div>';
    return;
  }
  if (!d.models.length) {
    box.innerHTML = '<div class="lm-empty">本机 Ollama 里还没有模型。</div>';
    return;
  }
  const same = (a, b) => a === b || a.split(':')[0] === b.split(':')[0];
  // 排序：当前在用的置顶，其余按名字 —— 模型一多（>20 个）列表要滚很久，
  // 自己训的那几个容易找不到（实测排在 13-16 位，界面里看不见）。
  const kw = String($('#local-models-filter')?.value || '').trim().toLowerCase();
  // 排序：当前在用的 → 最近训练/下载的 → 其余按名字。
  // 原因：模型一多（26 个）自己刚训的那几个会被排到十几行之外，界面里根本翻不到。
  const isCurrent = (m) => (m.backend === 'cloud' ? d.backend === 'cloud' : d.isLocalNow) && same(m.name, d.current);
  const list = [...d.models].sort((a, b) => {
    const na = isCurrent(a) ? 0 : 1;
    const nb = isCurrent(b) ? 0 : 1;
    if (na !== nb) return na - nb;
    const ma = String(a.modifiedAt || '');
    const mb = String(b.modifiedAt || '');
    if (ma !== mb) return mb.localeCompare(ma);   // 新的在前
    return a.name.localeCompare(b.name);
  }).filter((m) => !kw || m.name.toLowerCase().includes(kw));
  if (!list.length) {
    box.innerHTML = `<div class="lm-empty">没有匹配「${escapeHtml(kw)}」的模型</div>`;
    return;
  }
  box.innerHTML = list.map((m) => {
    const now = isCurrent(m);
    const badges = [
      m.backend === 'cloud' ? '<span class="lm-badge cloud">云端</span>' : '',
      m.thinking ? '<span class="lm-badge think">支持思考</span>' : '',
      m.vision ? '<span class="lm-badge">识图</span>' : '',
      now ? '<span class="lm-badge now">当前</span>' : '',
    ].filter(Boolean).join(' ');
    const meta = [fmtGB(m.sizeBytes), m.quant, m.params, m.contextLength ? `${m.contextLength} ctx` : '',
      m.backend === 'llama' ? 'llama.cpp' : '',
      m.backend === 'cloud' ? '云端' : ''].filter(Boolean).join(' · ');
    return `<div class="lm-row${now ? ' on' : ''}">
      <span class="lm-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
      ${badges}
      <span class="lm-meta">${escapeHtml(meta)}</span>
      <button type="button" class="lm-btn" data-model="${escapeHtml(m.name)}" data-backend="${escapeHtml(m.backend || '')}" data-baseurl="${escapeHtml(m.baseUrl || '')}"${now ? ' disabled' : ''}>${now ? '在用' : '用这个'}</button>
    </div>`;
  }).join('');
}

async function switchToLocalModel(name, backend, baseUrl = '') {
  // 卡死保护：state.streaming 正常会在 finally 里复位，但如果某次请求真的挂住
  // （网络半死、上游不关闭连接），它就会一直为 true，之后所有切换都「点了没反应」——
  // 只弹一个容易被忽略的 toast。超过 90 秒就当它已经失效。
  if (state.streaming && Date.now() - (state.streamStartedAt || 0) > 90000) {
    state.streaming = false;
  }
  if (state.streaming) {
    toast('正在生成，等这一轮结束再切（或先点停止）', true);
    return;
  }
  const cur = String(state.config?.model || '');
  if (cur && (cur === name || cur.split(':')[0] === String(name).split(':')[0])) {
    toast(`已经在用 ${name} 了`);
    return;
  }
  toast(`切换中：${name}…`);
  try {
    const r = await api('/api/switch-model', { method: 'POST', body: JSON.stringify({ model: name, backend, ...(baseUrl ? { baseUrl } : {}) }) });
    await refreshConfig();
    await loadLocalModels();
    fillSettingsForm();
    const warnLocalMissing = backend !== 'cloud' && r.known === false;
    toast(`已切到 ${r.model}${warnLocalMissing ? ' ⚠ 本机没有这个模型，可能报 model not found' : ''}`, warnLocalMissing);
  } catch (err) {
    toast(err.message, true);
  }
}

async function switchToCloud() {
  try {
    const r = await api('/api/switch-model', { method: 'POST', body: JSON.stringify({ cloud: true }) });
    await refreshConfig();
    await loadLocalModels();
    fillSettingsForm();
    toast(`已切回云端：${r.model}`);
  } catch (err) {
    toast(err.message, true);
  }
}

// 设置页打开时把它填一遍（原来这段逻辑内联在 openSettings 里）
function fillSettingsForm() {
  const form = $('#settings-form');
  if (!form) return;
  const config = state.config;
  form.baseUrl.value = config.baseUrl;
  form.proxy.value = config.proxy || '';
  form.model.value = config.model;
  form.visionModel.value = config.visionModel || '';
  form.temperature.value = config.temperature;
  form.workGuard.checked = Boolean(config.workGuard);
  form.extraBody.value = config.extraBody || '';
  form.thinkOff.checked = config.thinkOff === true;
  if (form.showReasoning) form.showReasoning.checked = config.showReasoning === true;
  if (form.thinkForce) form.thinkForce.checked = config.thinkForce === true;
  form.reasoningEffort.value = ['none', 'low', 'high', 'max'].includes(config.reasoningEffort)
    ? config.reasoningEffort : 'high';
  // 多人卡每轮开口几率（v1.7.2）
  form.castSpeakChance.value = Number.isFinite(Number(config.castSpeakChance)) ? Number(config.castSpeakChance) : 65;
  const cco = $('#cast-chance-out');
  if (cco) cco.textContent = `${form.castSpeakChance.value}%`;
  // 告诉用户这次会走哪种关思考方式（Qwen3 → /no_think，Gemma → think:false）
  const th = $('#think-hint');
  if (th) {
    const how = config.thinkControl || '';
    th.textContent = how ? `· ${how}` : '';
  }
  form.narrative.value = config.narrative || '';
  form.keywordActions.value = config.keywordActions || '';
  form.rlEnabled.checked = config.rlEnabled === true;
  form.residentKnowledge.value = config.residentKnowledge || '';
  form.contextWindow.value = config.contextWindow || '';
  form.autoClean.checked = config.autoClean !== false;
  form.autoPair.checked = config.autoPair !== false;
  form.forceAction.checked = config.forceAction !== false;
  form.cleanHistory.checked = config.cleanHistory !== false;
  form.gpuArbiter.checked = config.gpuArbiter !== false;
  const tts = config.tts || {};
  form.ttsBaseUrl.value = tts.baseUrl || '';
  form.ttsModel.value = tts.model || 'tts-1';
  form.ttsVoice.value = tts.voice || 'alloy';
  form.ttsSpeed.value = tts.speed || 1;
  form.ttsFormat.value = tts.format || 'mp3';
  form.ttsApiKey.value = '';
  form.ttsApiKey.placeholder = tts.hasApiKey ? `已保存（尾号 ${tts.apiKeyHint}，留空则不修改）` : '留空 = 不需要';
  form.ttsAuto.checked = tts.auto === true;
  // 联网搜索（v0.62.0）
  form.webSearch.checked = config.webSearch === true;
  form.webSearchSite.value = config.webSearchSite === 'cn' ? 'cn' : 'intl';
  form.webSearchCount.value = config.webSearchCount || 5;
  form.webSearchChars.value = config.webSearchChars === 0 ? 0 : (config.webSearchChars || 1600);
  updateAutoSpeakButton();
  updateWebSearchButton();
  renderGlobalDefaults(config);
  const tempOut = $('#temp-out');
  if (tempOut) tempOut.textContent = config.temperature;
  const keyHint = $('#key-hint');
  if (keyHint) keyHint.textContent = config.hasApiKey ? `当前 Key 尾号 ${config.apiKeyHint}` : '本机保存，只用于调用模型接口。';
}

async function submitSettings(e) {
  e.preventDefault();
  const form = $('#settings-form');
  const body = {
    apiKey: form.apiKey.value.trim(),
    baseUrl: form.baseUrl.value.trim(),
    proxy: form.proxy.value.trim(),
    model: form.model.value.trim(),
    visionModel: form.visionModel.value.trim(),
    temperature: Number(form.temperature.value),
    workGuard: form.workGuard.checked,
    extraBody: form.extraBody.value.trim(),
    thinkOff: form.thinkOff.checked,
    showReasoning: form.showReasoning ? form.showReasoning.checked : false,
    thinkForce: form.thinkForce ? form.thinkForce.checked : false,
    reasoningEffort: form.reasoningEffort.value,
    keywordActions: form.keywordActions.value,
    rlEnabled: form.rlEnabled.checked,
    residentKnowledge: form.residentKnowledge.value,
    contextWindow: Number(form.contextWindow.value) || 0,
    // 多人卡每轮开口几率（v1.7.2）
    castSpeakChance: Number(form.castSpeakChance.value),
    narrative: form.narrative.value,
    autoClean: form.autoClean.checked,
    autoPair: form.autoPair.checked,
    forceAction: form.forceAction.checked,
    cleanHistory: form.cleanHistory.checked,
    gpuArbiter: form.gpuArbiter.checked,
    // 联网搜索（v0.62.0）
    webSearch: form.webSearch.checked,
    webSearchSite: form.webSearchSite.value,
    webSearchCount: Number(form.webSearchCount.value) || 5,
    webSearchChars: Number(form.webSearchChars.value) || 0,
    tts: {
      baseUrl: form.ttsBaseUrl.value.trim(),
      model: form.ttsModel.value.trim(),
      voice: form.ttsVoice.value.trim(),
      speed: Number(form.ttsSpeed.value) || 1,
      format: form.ttsFormat.value,
      auto: form.ttsAuto.checked,
      apiKey: form.ttsApiKey.value.trim(),
    },
  };
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
    await refreshConfig();
    await refreshWorkGuard();
    $('#settings-modal').hidden = true;
    toast('设置已保存');
    updateStatusLine();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 会话 ---------- */
async function selectCharacter(id) {
  state.mode = 'character';   // 从直连模式切回来（直连会话不会丢，还在「直连」标签页里）
  state.activeCharacterId = id;
  state.activeSessionId = null;
  state.messages = [];
  clearAsPick();         // 「/ 选回答者」只对当前这一条/这个会话有效，换人就不留着了
  $('#messages').innerHTML = '';
  updateChatHeader();
  await refreshSessions();
  renderCharacters();
  enableComposer(true);
  // 若角色有开场白，先问一句要不要开始新对话。
  const character = state.characters.find((c) => c.id === id);
  showEmptyState(character);
  setNav(false); // 手机上选完角色自动收起抽屉
}

function showEmptyState(character) {
  state.messages = [];
  const m = $('#messages');
  m.innerHTML = '';
  // 从主页点角色进来时**先不建会话**（免得点一下就多一个空会话），
  // 但这样开场白就看不见了 —— 用户的反馈是"从这里开始新对话时不显示开场白"。
  // 所以这里把开场白**当预览画出来**：等你真的发了第一条消息，
  // newSession() 才会把它作为正式的第一条写进会话，届时整体重绘，不会重复。
  const greeting = String(character?.greeting || '').trim();
  if (greeting) {
    const { wrap, meta } = createMessageEl('assistant', greeting);
    meta.textContent = '✦ 角色 · 开场白';
    wrap.classList.add('msg-preview');
    m.appendChild(wrap);
    const tip = document.createElement('div');
    tip.className = 'notice-tip';
    tip.textContent = '这是 TA 的开场白（还没开始记录）—— 说点什么，对话就开始了';
    m.appendChild(tip);
    scrollBottom();
    return;
  }
  m.innerHTML = `<div class="empty" id="empty-state">
    <div class="empty-icon">${avatarMark(character)}</div>
    <p>和「${escapeHtml(character?.name || '')}」开始一段新对话吧</p>
  </div>`;
}

async function newSession() {
  if (!state.activeCharacterId) return;
  if (state.streaming) return;
  state.mode = 'character';
  clearAsPick();
  const character = state.characters.find((c) => c.id === state.activeCharacterId);
  try {
    const { session } = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ characterId: character.id, greeting: character.greeting }),
    });
    state.activeSessionId = session.id;
    await refreshSessions();
    renderMessages(session.messages);
    toast('新对话已开始');
  } catch (err) {
    toast(err.message, true);
  }
}

async function openSession(id) {
  if (state.streaming) return;
  state.mode = 'character';   // 从「会话」标签点进来 = 回到角色模式
  clearAsPick();
  try {
    const { session } = await api(`/api/sessions/${id}`);
    state.activeSessionId = id;
    renderMessages(session.messages);
    updateChatHeader();
    renderSessions();
    setNav(false); // 手机上选完会话自动收起抽屉
    syncBranchPanel();   // 🌿 开关开着就补上分支面板
  } catch (err) {
    toast(err.message, true);
  }
}

async function removeSession(id) {
  const session = state.sessions.find((s) => s.id === id);
  const n = session?.messageCount || 0;
  const ok = await askDelete({
    title: '删除会话',
    lines: [
      `会话：<b>${escapeHtml(session?.title || id)}</b>`,
      `共有 <b>${n}</b> 条消息`,
      '<span class="danger-text">删除后无法撤销，也找不回来。</span>',
    ],
    needTyping: n >= TYPING_THRESHOLD,
  });
  if (!ok) return;
  try {
    const res = await api(`/api/sessions/${id}`, { method: 'DELETE' });
    if (state.activeSessionId === id) {
      state.activeSessionId = null;
      const character = state.characters.find((c) => c.id === state.activeCharacterId);
      showEmptyState(character);
    }
    await refreshSessions();
    toast(`已删除会话（${res.removed ?? n} 条消息）`);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 直连模式（不经过角色卡的无提示词对话） ---------- */

// 直连的会话也存成文件、也同步到手机，只是没有角色卡、请求里没有任何系统提示词。
function renderDirectSessions() {
  const list = $('#direct-list');
  if (!state.directSessions.length) {
    list.innerHTML = '<li class="item-sub" style="padding:8px 4px">还没有直连会话</li>';
    return;
  }
  list.innerHTML = state.directSessions.map((s) => `
    <li class="session-item ${s.id === state.activeDirectId ? 'active' : ''}" data-id="${s.id}">
      <div class="item-text">
        <div class="item-title">${escapeHtml(s.title)}</div>
        <div class="item-sub">${s.messageCount} 条 · ${escapeHtml(s.preview || '')}</div>
      </div>
      <button class="item-train" data-train="${s.id}" title="用这个会话训练模型">🧠</button>
      <button class="item-export" data-export="${s.id}" title="导出聊天记录（Markdown 文件，可直接下载）">⬇</button>
      <button class="item-del" data-del="${s.id}" title="删除">✕</button>
    </li>
  `).join('');
}

// 会话列表 →「⬇」导出聊天记录。
// 服务端 /api/sessions/:id/export 直接吐 .md（?format=json 是整包存档），
// 这里只负责把响应变成一次浏览器下载 —— 不经过 api()，因为要拿原始文本和文件名。
async function exportChatLog(id) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/export`, { cache: 'no-store' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `导出失败（HTTP ${res.status}）`);
    }
    // 文件名以服务端 Content-Disposition 里的中文名为准（日期-角色-标题.md）
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
    const name = m ? decodeURIComponent(m[1]) : `chat-${id}.md`;
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 3000);
    toast(`已导出聊天记录：${name}`);
  } catch (err) {
    toast(err.message || '导出失败', true);
  }
}

async function refreshDirectSessions() {
  const { sessions } = await api('/api/direct/sessions');
  state.directSessions = sessions;
  renderDirectSessions();
}

// 点「直连」标签页：接着上次那个直连会话，没有就先只把输入框准备好
// （**不立刻建文件** —— 免得点一下就在同步目录里多一个空会话；发了第一句才真正建）。
async function enterDirectMode() {
  if (state.streaming) return;
  state.mode = 'direct';
  clearAsPick();         // 直连模式不经过角色卡，没有"谁来回答"可选
  if (state.activeDirectId) return openDirectSession(state.activeDirectId);
  showDirectEmptyState();
  enableComposer(true);
}

function showDirectEmptyState() {
  state.messages = [];
  state.activeDirectId = null;
  $('#messages').innerHTML = `<div class="empty" id="empty-state">
    <div class="empty-icon">↯</div>
    <p>直连模式：说点什么就开始（不经过角色卡，也没有系统提示词）</p>
  </div>`;
  updateChatHeader();
}

async function newDirectSession(opts = {}) {
  if (state.streaming) return;
  try {
    const { session } = await api('/api/direct/sessions', { method: 'POST', body: JSON.stringify({}) });
    state.mode = 'direct';
    state.activeDirectId = session.id;
    clearAsPick();
    await refreshDirectSessions();
    renderMessages(session.messages);
    updateChatHeader();
    enableComposer(true);
    setNav(false);
    if (!opts.silent) toast('已开一个新对话（直连模型）');
  } catch (err) {
    toast(err.message, true);
  }
}

async function openDirectSession(id) {
  if (state.streaming) return;
  try {
    const { session } = await api(`/api/sessions/${id}`);
    state.mode = 'direct';
    state.activeDirectId = id;
    clearAsPick();
    renderMessages(session.messages);
    updateChatHeader();
    renderDirectSessions();
    enableComposer(true);
    syncBranchPanel();   // 🌿 开关开着就补上分支面板
    setNav(false); // 手机上选完会话自动收起抽屉
  } catch (err) {
    toast(err.message, true);
  }
}

async function removeDirectSession(id) {
  const session = state.directSessions.find((s) => s.id === id);
  const n = session?.messageCount || 0;
  const ok = await askDelete({
    title: '删除直连会话',
    lines: [
      `会话：<b>${escapeHtml(session?.title || id)}</b>`,
      `共有 <b>${n}</b> 条消息`,
      '<span class="danger-text">删除后无法撤销，也找不回来。</span>',
    ],
    needTyping: n >= TYPING_THRESHOLD,
  });
  if (!ok) return;
  try {
    // 会话存储是共用的，删会话用同一个接口就够了
    const res = await api(`/api/sessions/${id}`, { method: 'DELETE' });
    if (state.activeDirectId === id) {
      if (state.mode === 'direct') showDirectEmptyState();
      state.activeDirectId = null;
      enableComposer(true);
    }
    await refreshDirectSessions();
    await refreshSessions();
    toast(`已删除会话（${res.removed ?? n} 条消息）`);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 常用语（直连模式的唯一注入项：口头禅 + 出现频率） ---------- */

// 直连模式默认零提示词。这里填的常用语是**唯一**会被注入的一段，
// 所以弹窗里直接把"实际会发出去的那一段"原样显示出来（措辞由服务端渲染，前端不重复实现）。
let phrasesTimer = null;

function phrasesInfo() {
  const text = String(state.config?.directPhrases || '').trim();
  const level = Number.isFinite(Number(state.config?.directPhraseLevel)) ? Number(state.config.directPhraseLevel) : 4;
  return { text, level };
}

async function openPhrases() {
  // 跟设置页一样先跟服务端对一次表，避免表单里是旧值
  try { await refreshConfig(); } catch { /* 拉不到就用本地缓存 */ }
  const { text, level } = phrasesInfo();
  $('#phrases-text').value = text;
  $('#phrases-level').value = String(level);
  $('#phrases-modal').hidden = false;
  await renderPhrasesPreview();
}

// 实时预览（防抖）：把词表 + 档位交给服务端渲染成真正会发出去的那段
function queuePhrasesPreview() {
  $('#phrases-level-out').textContent = `${$('#phrases-level').value} / 10`;
  clearTimeout(phrasesTimer);
  phrasesTimer = setTimeout(renderPhrasesPreview, 250);
}

async function renderPhrasesPreview() {
  const text = $('#phrases-text').value;
  const level = Number($('#phrases-level').value);
  $('#phrases-level-out').textContent = `${level} / 10`;
  try {
    const r = await api('/api/direct/phrases', {
      method: 'POST',
      body: JSON.stringify({ text, level }),
    });
    $('#phrases-preview').textContent = r.block || '（空 —— 直连模式不会加任何提示词）';
    $('#phrases-how').textContent = r.count
      ? `${r.count} 条 · ${r.how}`
      : '没填常用语 → 这一段完全不注入（仍然是零提示词）';
  } catch (err) {
    $('#phrases-how').textContent = `预览失败：${err.message}`;
  }
}

async function savePhrases() {
  const text = $('#phrases-text').value;
  const level = Number($('#phrases-level').value);
  try {
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ directPhrases: text, directPhraseLevel: level }),
    });
    await refreshConfig();
    updateChatHeader();
    $('#phrases-modal').hidden = true;
    toast(text.trim() ? `常用语已保存（频率 ${level}/10）` : '常用语已清空，直连回到零提示词');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 查看上下文 ---------- */
// 不同模式对「角色说的话」叫法不同：角色模式是「角色」，直连模式是「模型」。
const CTX_LABELS = { system: '系统提示词（角色卡渲染结果）', user: '我', assistant: '角色' };

function ctxBlock(role, text, cls = '', labels = CTX_LABELS) {
  const label = labels[role] || role;
  const chars = text.length;
  return `<div class="ctx-block ${cls}">
    <div class="ctx-role">${label} · ${chars} 字符</div>
    <div class="ctx-text">${escapeHtml(text)}</div>
  </div>`;
}

async function openContext() {
  if (state.mode === 'direct') return openDirectContext();
  if (!state.activeSessionId) {
    toast('这个会话还没开始，先发一条消息就有了', true);
    return;
  }
  try {
    const c = await api(`/api/context?sessionId=${encodeURIComponent(state.activeSessionId)}`);
    const s = c.stats;
    const local = /127\.0\.0\.1|localhost|11434/.test(c.baseUrl);
    const bits = [
      `模型 <b>${escapeHtml(c.model)}</b>（${local ? '本地' : '云端'}）`,
      `温度 ${c.temperature}`,
      c.extraBody ? `额外参数 <b>${escapeHtml(c.extraBody)}</b>` : null,
      s.droppedMessages > 0
        ? `<span class="warn">已裁掉最早的 ${s.droppedMessages} 条（预算 ${s.budget} 字符）</span>`
        : '未触发裁剪',
      s.historyCleaned > 0
        ? `<span class="warn">已规整/清洗历史 ${s.historyCleaned} 条${s.historyRemoved ? `（少 ${s.historyRemoved} 字）` : ''}（仅本次发送，存档未改）</span>`
        : null,
      s.maxChars > 0 ? `字数上限 <b>${s.maxChars}</b> 字（超出会在句号处截断）` : null,
      s.knowledgeChunks > 0
        ? `资料库注入 <b>${s.knowledgeChunks}</b> 块（${s.knowledgeChars} 字，历史预算相应减到 ${s.historyBudget}）`
        : (c.knowledgeChars > 0 ? '资料库这一轮没挑中相关的块' : null),
      // 联网搜索（v0.62.0）：这一轮到底搜没搜、搜到什么，预览里必须看得见
      c.webSearch?.enabled
        ? (c.webSearch.error
          ? `<span class="warn">联网搜索失败：${escapeHtml(c.webSearch.error)}</span>`
          : (c.webSearch.count > 0
            ? `联网搜索 <b>${c.webSearch.count}</b> 条（${escapeHtml(c.webSearch.site === 'cn' ? '国内版' : '国际版')} · ${c.webSearch.via === 'proxy' ? '走代理' : '直连'} · ${s.searchChars} 字）`
            : '联网搜索这一轮没有可用查询（话太短）'))
        : null,
      c.webSearch?.notice ? `<span class="warn">${escapeHtml(c.webSearch.notice)}</span>` : null,
    ].filter(Boolean).join(' · ');
    $('#ctx-meta').innerHTML = `${bits}<br>合计 <b>${s.totalChars}</b> 字符 ≈ <b>${s.estTokens}</b> tokens` +
      `（系统提示词 ${s.systemChars} + 历史 ${s.historyChars}）· 消息 ${s.keptMessages}/${s.totalMessages} 条`;
    $('#ctx-body').innerHTML = ctxBlock('system', c.system, 'system')
      + c.history.map((m) => ctxBlock(m.role, m.content)).join('');
    state.contextText = `【系统提示词】\n${c.system}\n\n`
      + c.history.map((m) => `【${m.role === 'user' ? '我' : '角色'}】\n${m.content}`).join('\n\n');
    $('#context-modal').hidden = false;
  } catch (err) {
    toast(err.message, true);
  }
}

// 直连模式的「这次发出去什么」：默认只有你打的字；设了常用语就只有那一段 system。
async function openDirectContext() {
  if (!state.activeDirectId) {
    toast('这个会话还没开始，先发一条消息就有了', true);
    return;
  }
  try {
    const c = await api(`/api/direct/context?sessionId=${encodeURIComponent(state.activeDirectId)}`);
    const s = c.stats;
    const local = /127\.0\.0\.1|localhost|11434/.test(c.baseUrl);
    const bits = [
      c.system
        ? `<b>常用语 ${s.phrasesCount} 条（出现频率 ${s.phrasesLevel}/10）</b>`
        : '<b>没有系统提示词</b>',
      `模型 <b>${escapeHtml(c.model)}</b>（${local ? '本地' : '云端'}）`,
      `温度 ${c.temperature}`,
      c.extraBody ? `额外参数 <b>${escapeHtml(c.extraBody)}</b>` : null,
      '未做清洗 / 改写 / 重抽',
      // 联网搜索（v0.62.0）：直连模式下它也是一段 system，预览里必须显示
      c.webSearch?.enabled
        ? (c.webSearch.error
          ? `<span class="warn">联网搜索失败：${escapeHtml(c.webSearch.error)}</span>`
          : (c.webSearch.count > 0
            ? `联网搜索 <b>${c.webSearch.count}</b> 条（${escapeHtml(c.webSearch.site === 'cn' ? '国内版' : '国际版')} · ${c.webSearch.via === 'proxy' ? '走代理' : '直连'} · ${s.searchChars} 字）`
            : '联网搜索这一轮没有可用查询（话太短）'))
        : null,
      c.webSearch?.notice ? `<span class="warn">${escapeHtml(c.webSearch.notice)}</span>` : null,
    ].filter(Boolean).join(' · ');
    $('#ctx-meta').innerHTML = `${bits}<br>合计 <b>${s.totalChars}</b> 字符 · 消息 <b>${s.totalMessages}</b> 条`;
    const sysBlock = c.system
      ? ctxBlock('system', c.system, 'system', { system: '常用语（直连模式唯一注入的一段）' })
      : '';
    const body = c.history.map((m) => ctxBlock(m.role, m.content, '', { system: '—', user: '我', assistant: '模型' })).join('');
    $('#ctx-body').innerHTML = sysBlock + (body || '<div class="ctx-block"><div class="ctx-text">（还没有消息）</div></div>');
    state.contextText = (c.system ? `【常用语】\n${c.system}\n\n` : '')
      + c.history.map((m) => `【${m.role === 'user' ? '我' : '模型'}】\n${m.content}`).join('\n\n');
    $('#context-modal').hidden = false;
  } catch (err) {
    toast(err.message, true);
  }
}

async function copyContext() {
  try {
    await navigator.clipboard.writeText(state.contextText || '');
    toast('上下文已复制');
  } catch {
    toast('复制失败，手动选中复制吧', true);
  }
}

/* ---------- 朗读（TTS） ---------- */
// 只跟本站的 /api/tts 说话，由服务端去调本地 TTS 服务；音频默认还会落盘缓存。
let ttsAudio = null;

// 设置页的「试听」：直接用**表单里当前填的**参数合成（不依赖是否已保存）
async function testTts() {
  const form = $('#settings-form');
  const btn = $('#tts-test');
  const baseUrl = form.ttsBaseUrl.value.trim();
  if (!baseUrl) { toast('先填 TTS 服务地址', true); return; }
  const old = state.config?.tts;
  // 临时把表单值当成配置，走同一条 /api/tts 链路 —— 但服务端读的是已保存的配置，
  // 所以这里先保存一次（用户填了就是想用它），失败就当试听失败。
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '合成中…';
  try {
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        tts: {
          baseUrl,
          model: form.ttsModel.value.trim(),
          voice: form.ttsVoice.value.trim(),
          speed: Number(form.ttsSpeed.value) || 1,
          format: form.ttsFormat.value,
          apiKey: form.ttsApiKey.value.trim(),
        },
      }),
    });
    await refreshConfig();
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '（试听）行，那就这样吧。你还有什么想说的？' }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `试听失败（HTTP ${res.status}）`);
    }
    const blob = await res.blob();
    if (ttsAudio) ttsAudio.pause();
    ttsAudio = new Audio(URL.createObjectURL(blob));
    await ttsAudio.play();
    toast('试听成功，设置也一并保存了');
  } catch (err) {
    toast(err.message, true);
    if (old) state.config = { ...state.config, tts: old };
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function speakMessage(index, btn, opts = {}) {
  const msg = state.messages[index];
  if (!msg) return;
  if (!state.config?.tts?.baseUrl) {
    if (!opts.silent) toast('还没配朗读服务：右上角 ⚙ → 朗读 → 填本地 TTS 地址', true);
    return;
  }
  // 再点一次 = 停
  if (ttsAudio && !ttsAudio.paused && btn?.dataset.playing === '1') {
    ttsAudio.pause();
    btn.dataset.playing = '';
    btn.textContent = '🔊';
    return;
  }
  const character = state.characters.find((c) => c.id === state.activeCharacterId);
  if (btn) { btn.dataset.playing = '1'; btn.textContent = '⏳'; }
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: msg.content, voice: character?.voice || '' }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `朗读失败（HTTP ${res.status}）`);
    }
    const blob = await res.blob();
    if (ttsAudio) ttsAudio.pause();
    ttsAudio = new Audio(URL.createObjectURL(blob));
    ttsAudio.addEventListener('ended', () => { if (btn) { btn.dataset.playing = ''; btn.textContent = '🔊'; } });
    await ttsAudio.play();
    if (btn) btn.textContent = '⏸';
  } catch (err) {
    if (btn) { btn.dataset.playing = ''; btn.textContent = '🔊'; }
    // 自动触发时不弹错 —— 它自己响的，别打断人；只在控制台留一份
    if (opts.silent) console.warn('[tts] 自动朗读失败:', err.message);
    else toast(err.message, true);
  }
}

/* ---------- 主页的 Ollama 三按钮：启动 / 不关闭 / 立刻释放显存 ---------- */
// 状态来自 GET /api/ollama；不是本地地址（云端 API）时这三个按钮直接隐藏。

function renderOllama(st) {
  state.ollama = st || null;          // 供「不关闭」那个按钮判断当前该切成哪一边
  const on = $('#btn-ollama-on');
  const keep = $('#btn-ollama-keep');
  const free = $('#btn-ollama-free');
  const pre = $('#btn-ollama-preload');
  if (!on || !keep || !free) return;
  if (!st || !st.local) {
    on.hidden = true; keep.hidden = true; free.hidden = true;
    if (pre) pre.hidden = true;
    return;
  }
  on.hidden = false; keep.hidden = false; free.hidden = false;
  if (pre) pre.hidden = false;
  const loaded = (st.models || []).length;
  const running = Boolean(st.up);
  on.textContent = running ? '🟢' : '⚪';
  on.classList.toggle('is-on', running);
  on.title = running
    ? `Ollama 正在运行${st.version ? `（v${st.version}）` : ''} —— 点一下再确认一次状态`
    : 'Ollama 没在跑 —— 点一下启动它';
  const forever = st.keepAlive === -1;
  keep.textContent = forever ? '📌' : '⏱';
  keep.classList.toggle('is-on', forever);
  keep.title = forever
    ? '当前：模型常驻显存（永不自动卸载）—— 点一下改回 2 分钟自动卸载'
    : '当前：空闲自动卸载 —— 点一下让模型常驻显存不卸载';
  free.title = loaded
    ? `立刻释放显存（当前显存里：${loaded} 个模型）`
    : '立刻释放显存（当前显存里：空）';
  free.textContent = loaded ? '🧹' : '🧺';
  // 预启动：✅ = 模型已在显存里（可用），⬇ = 还没加载
  if (pre) {
    const ready = Boolean(st.ready);
    pre.textContent = ready ? '✅' : '⬇';
    pre.classList.toggle('is-on', ready);
    pre.title = !st.up
      ? '预启动模型：Ollama 还没在跑（先点 🟢）'
      : !st.known
        ? `预启动模型：这个 Ollama 里没有 ${st.model}（模型目录不对？）`
        : ready
          ? `${st.model} 已在显存里，可用了 —— 点一下重新确认`
          : `预启动模型：按下就开始把 ${st.model} 加载进显存（冷启动 40~60 秒，之后就快了）`;
  }
}

async function refreshOllama() {
  try {
    renderOllama(await api('/api/ollama'));
  } catch {
    renderOllama(null);   // 拉不到就当本地按钮不用显示，别打扰
  }
}

async function ollamaAction(action) {
  // 预热要几十秒：先把按钮切成沙漏，别让人以为没反应
  if (action === 'preload') {
    const pre = $('#btn-ollama-preload');
    if (pre) { pre.textContent = '⏳'; pre.disabled = true; }
    toast('正在加载模型…第一次要 40~60 秒，这个提示消失前别切页面');
    try {
      const st = await api('/api/ollama', { method: 'POST', body: JSON.stringify({ action }) });
      renderOllama(st);
      toast(st.message || '模型已就绪');
    } catch (err) {
      toast(err.message, true);
      await refreshOllama();
    } finally {
      if (pre) pre.disabled = false;
    }
    return;
  }
  // 「释放显存」不弹"正在…"：它本身很快，而两条提示叠在一起时
  // （先"正在释放显存…"、再"显存里本来就没有模型"）看起来像在自相矛盾。
  if (action !== 'free') {
    const busy = { on: '正在启动 Ollama…', keep: '正在设为常驻…', auto: '正在改回 2 分钟…' };
    toast(busy[action] || '处理中…');
  }
  try {
    const st = await api('/api/ollama', { method: 'POST', body: JSON.stringify({ action }) });
    renderOllama(st);
    toast(st.message || '已处理');
  } catch (err) {
    toast(err.message, true);
  }
}

// 聊天页那个 🧠：一键开关「思考」，不用进设置页。
//
// 为什么需要放在聊天页：思考开着的时候表现为「回复很慢」，用户不会想到
// 是设置里一个复选框导致的。实测 v2 不关思考 21.7 秒 / 667 token，
// 关掉 6.2 秒 / 85 token —— 差 3.5 倍。开关要一眼看得到、一键能切。
//
// 具体走 /no_think 还是 think:false 由服务端按模型决定（见 lib/ollama.js 的
// thinkControl）：Qwen3 认 /no_think，Gemma 3-4 只认请求体的 think:false。
const THINK_HINT = {
  '/no_think（system）': '走系统提示词 /no_think',
  'think:false（请求体）': '走请求体 think:false',
  'thinking:disabled（请求体）': '走请求体 thinking:disabled',
  '模型模板参数（本地推理服务）': '由本地推理服务的模板控制',
};
// v2.3.18：模型能不能关思考（服务端 /api/config 的 thinkCap）
function thinkCap() {
  return state.config?.thinkCap || { canToggle: true, how: '', label: '' };
}

function thinkState() {
  const off = state.config?.thinkOff === true;
  const how = state.config?.thinkControl || '';
  return { off, how, hint: THINK_HINT[how] || (how ? how : '') };
}

function updateThinkButton() {
  const btn = $('#btn-think');
  if (!btn) return;
  const cap = thinkCap();
  const { off, hint } = thinkState();
  // 这个模型关不了思考 → 直接隐藏按钮，别让用户点了没反应
  if (cap.canToggle === false) {
    btn.hidden = true;
    btn.title = cap.label || '这个模型不支持关思考';
    return;
  }
  btn.hidden = false;
  btn.textContent = off ? '🧠' : '💭';
  btn.classList.toggle('is-on', off);
  btn.title = off
    ? `思考：已关（${hint || '按模型自动'}）—— 点一下打开`
    : `思考：开 —— 点一下关掉（${cap.label || '按模型自动'}）`;
}

async function toggleThink() {
  const { off } = thinkState();
  try {
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ thinkOff: !off }),
    });
    state.config = { ...(state.config || {}), thinkOff: !off };
    if (typeof refreshConfig === 'function') await refreshConfig();
    updateThinkButton();
    const { hint } = thinkState();
    toast(!off ? `已关掉思考${hint ? '（' + hint + '）' : ''}` : '已打开思考（回复会变慢）');
  } catch (e) {
    toast(e.message, true);
  }
}

// 聊天页那个 🔊/🔇：一键切换「语言自动触发」，不用进设置
function updateAutoSpeakButton() {
  const btn = $('#btn-autospeak');
  if (!btn) return;
  const tts = state.config?.tts || {};
  const on = tts.auto === true;
  btn.textContent = on ? '🔊' : '🔇';
  btn.title = on
    ? '语言自动触发：开（每条新回复自动读出来）—— 点一下关掉'
    : (tts.baseUrl ? '语言自动触发：关 —— 点一下打开' : '语言自动触发：还没配朗读服务，先去 ⚙ → 朗读 填地址');
  btn.classList.toggle('is-on', on);
}

async function toggleAutoSpeak() {
  const tts = state.config?.tts || {};
  if (!tts.baseUrl) {
    toast('先配朗读服务：⚙ → 朗读 → 填本地 TTS 地址', true);
    try { await openSettings(); } catch { /* 打不开就算了 */ }
    return;
  }
  const next = !(tts.auto === true);
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ tts: { auto: next } }) });
    await refreshConfig();
    updateAutoSpeakButton();
    toast(next ? '语言自动触发：开' : '语言自动触发：关');
    if (next) {
      // 立刻读最后一条，省得等下一轮才知道有没有生效
      autoSpeakLast(state.messages);
    } else if (ttsAudio) {
      ttsAudio.pause();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 联网搜索（v0.62.0） ---------- */

// 聊天页那个 🌐：一键开关「联网搜索」，不用进设置。
// 状态完全以服务端 config 为准（refreshConfig 之后重画），不在前端另存一份。
function updateWebSearchButton() {
  const btn = $('#btn-websearch');
  if (!btn) return;
  const cfg = state.config || {};
  const on = cfg.webSearch === true;
  const siteLabel = cfg.webSearchSite === 'cn' ? '国内版' : '国际版';
  // 开/关靠 CSS 的 .is-on（颜色）+ title，不靠 emoji：🌐 本身没有"关"的形态
  btn.classList.toggle('is-on', on);
  btn.title = on
    ? `联网搜索：开（必应${siteLabel} · 每轮搜一次）—— 点一下关掉`
    : '联网搜索：关 —— 点一下打开（必应，国际版需要代理）';
}

async function toggleWebSearch() {
  const next = !(state.config?.webSearch === true);
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ webSearch: next }) });
    await refreshConfig();
    updateWebSearchButton();
    if (next) {
      const site = state.config?.webSearchSite === 'cn' ? '国内版 cn.bing.com' : '国际版 www.bing.com';
      const proxy = state.config?.proxy ? '' : '（国际版建议先填代理，否则会被重定向到国内版）';
      toast(`联网搜索：开 · ${site}${proxy}`);
    } else {
      toast('联网搜索：关');
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// 设置页的「试搜一次」：用**表单里当前填的**站点/代理/条数真搜一次，不保存也能试。
// 目的很实在 —— 验证"代理到底通不通、拿到的是不是国际版结果"。
async function testWebSearch() {
  const form = $('#settings-form');
  const box = $('#websearch-result');
  const stateEl = $('#websearch-state');
  const query = (form.webSearchQuery?.value || '').trim() || '本地 AI 角色扮演';
  if (stateEl) stateEl.textContent = '正在搜…';
  if (box) { box.hidden = false; box.textContent = '正在搜…'; }
  try {
    const r = await api('/api/search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        site: form.webSearchSite.value,
        count: Number(form.webSearchCount.value) || 5,
        proxy: form.proxy.value.trim(),
      }),
    });
    const via = r.via === 'proxy' ? '走代理' : '直连';
    const head = `搜到 ${r.results.length} 条（${via} → ${r.finalHost || '?'}）`;
    const warn = r.notice ? `\n⚠ ${r.notice}` : '';
    const lines = r.results.map((x, i) => `${i + 1}. ${x.title} · ${x.host}`);
    if (stateEl) {
      stateEl.textContent = `${head}${r.notice ? ' ⚠' : ''}`;
      stateEl.className = r.notice ? 'warn' : '';
    }
    if (box) {
      // 纯文本展示（不拼 HTML）：标题和链接都来自网页
      box.textContent = [head + warn, ...lines].join('\n');
    }
  } catch (err) {
    if (stateEl) { stateEl.textContent = err.message; stateEl.className = 'warn'; }
    if (box) box.textContent = `✗ ${err.message}`;
  }
}

// 自动朗读（「自动触发」开着时才生效）：每条新回复生成完就读出来。
// 正在放上一条就直接被新的顶掉（长回复 + 连续生成时，排队反而更烦）。
function autoSpeakLast(messages) {
  const tts = state.config?.tts;
  if (!tts?.auto || !tts?.baseUrl) return;
  const idx = (messages || []).length - 1;
  const last = messages?.[idx];
  if (!last || last.role !== 'assistant') return;
  // 按钮由 renderMessages 建好了，把那个 🔊 也切成播放态
  const btn = document.querySelector(`.msg-act[data-act="speak"][data-index="${idx}"]`);
  speakMessage(idx, btn, { silent: true });
}

/* ---------- 资料库 ---------- */
function updateKnowCount() {
  const own = $('#know-text')?.value || '';
  const shared = $('#know-shared')?.value || '';
  $('#know-count').textContent = own.length;
  if ($('#know-shared-count')) $('#know-shared-count').textContent = shared.length;
}

// 共享资料：直连和所有角色都读 `_shared.md`（老版本直连用的 `_direct.md` 会自动迁移）。
// 角色模式下额外还有一份「这个角色自己的资料」，两份一起注入。
const isDirectKnowledge = () => state.mode === 'direct';

async function openKnowledge() {
  const direct = isDirectKnowledge();
  const character = state.characters.find((c) => c.id === state.activeCharacterId);
  // 直连模式不需要角色；角色模式必须有角色
  if (!direct && !character) return;
  $('#know-picked').hidden = true;
  $('#know-picked').textContent = '';
  try {
    const k = direct
      ? await api('/api/knowledge/shared')
      : await api(`/api/knowledge?characterId=${encodeURIComponent(character.id)}`);
    // 共享那份两种模式都有；角色那份只有角色模式有
    $('#know-shared').value = direct ? (k.text || '') : (k.sharedText || '');
    $('#know-text').value = direct ? '' : (k.text || '');
    $('#know-char-wrap').hidden = direct;
    $('#know-budget').value = state.config?.knowledgeChars ?? 500;
    // 上限以服务端为准（v0.60.0 从 20000 提到 500000），别在前端写死
    if (k.max) $('#know-max').textContent = k.max;
    // v0.61.0 语义检索三个控件
    $('#know-semantic').checked = state.config?.knowledgeSemantic !== false;
    $('#know-threshold').value = state.config?.knowledgeThreshold ?? 0.5;
    $('#know-map').value = state.config?.knowledgeMap || '';
    $('#know-meta').innerHTML = direct
      ? '下面是<b>共享资料</b> —— 直连模式和所有角色都读这一份（<code>knowledge/_shared.md</code>），手机上也能看到同一份'
      : `共享资料 + 「<b>${escapeHtml(character.name)}</b>」自己的资料，<b>会一起注入</b>；都放在共享目录里，手机上也能看到同一份`;
    updateKnowCount();
    $('#know-modal').hidden = false;
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveKnowledgeText() {
  const direct = isDirectKnowledge();
  const character = state.characters.find((c) => c.id === state.activeCharacterId);
  if (!direct && !character) return;
  try {
    const sharedText = $('#know-shared').value;
    const ownText = direct ? '' : $('#know-text').value;
    const budget = Number($('#know-budget').value);
    // 共享那份永远保存（它同时喂给直连和所有角色）
    await api('/api/knowledge/shared', { method: 'PUT', body: JSON.stringify({ text: sharedText }) });
    if (!direct) {
      await api('/api/knowledge', {
        method: 'PUT',
        body: JSON.stringify({ characterId: character.id, text: ownText }),
      });
    }
    // 注入上限是全局设置，跟着一起存
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ knowledgeChars: budget }) });
    // v0.61.0 语义检索设置（也是全局的）
    const semantic = $('#know-semantic').checked;
    const threshold = Number($('#know-threshold').value);
    const knowledgeMap = $('#know-map').value;
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        knowledgeSemantic: semantic,
        knowledgeThreshold: Number.isFinite(threshold) ? threshold : 0.5,
        knowledgeMap,
      }),
    });
    state.config = {
      ...(state.config || {}), knowledgeChars: budget, knowledgeSemantic: semantic,
      knowledgeThreshold: Number.isFinite(threshold) ? threshold : 0.5, knowledgeMap,
    };
    $('#know-modal').hidden = true;
    toast(sharedText.trim() || ownText.trim()
      ? `资料已保存（共享 ${sharedText.length} 字${direct ? '' : ` ＋ 角色 ${ownText.length} 字`}），下一轮生成就会用上`
      : '资料已清空');
  } catch (err) {
    toast(err.message, true);
  }
}

async function previewKnowledge() {
  const direct = isDirectKnowledge();
  const character = state.characters.find((c) => c.id === state.activeCharacterId);
  if (!direct && !character) return;
  const sharedText = $('#know-shared').value;
  const ownText = direct ? '' : $('#know-text').value;
  if (!(sharedText.trim() || ownText.trim())) { toast('资料还是空的', true); return; }
  // 用会话里最新一条我说的话当线索去试挑（不消耗模型）
  const lastUser = [...state.messages].reverse().find((m) => m.role === 'user')?.content || '';
  const q = lastUser || '（会话里还没有你说的话）';
  try {
    const enc = encodeURIComponent(q);
    const r = direct
      ? await api(`/api/knowledge/shared?query=${enc}`)
      : await api(`/api/knowledge?characterId=${encodeURIComponent(character.id)}&query=${enc}`);
    const box = $('#know-picked');
    // 注意：这里用的是**已保存**的资料，没保存的改动不参与预演
    const picked = r.picked || [];
    const modeLabel = r.mode === 'semantic' ? '语义检索' : (r.mode === 'lexical' ? '词法检索' : '');
    const warn = r.degradeErr ? `\n⚠ 语义检索不可用，已降级为词法检索：${r.degradeErr}` : '';
    box.textContent = picked.length
      ? `用「${q.slice(0, 40)}」当线索（${modeLabel}），这一轮会注入 ${picked.length} 块：\n\n`
        + picked.map((c, i) => `【${i + 1}】${c}`).join('\n\n') + warn
      : `用「${q.slice(0, 40)}」当线索（${modeLabel}），一块都没挑中 —— 资料里没有相关内容，`
        + `这一轮不会注入资料（模型会被要求"不知道就说不知道"）。${warn}`;
    box.hidden = false;
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 联网搜索的来源（v0.62.0） ---------- */

// 气泡下挂一行「🌐 来源 N」，点开是这一轮搜到的网页。
// ⚠ 全程用 DOM 节点 + textContent，绝不拼 innerHTML —— 标题和链接都来自公开网页，
//   拼 HTML 等于把 XSS 的口子开在聊天记录里。
function attachSources(wrap, msg) {
  wrap.querySelector('.src-box')?.remove();
  const list = (Array.isArray(msg?.sources) ? msg.sources : [])
    .filter((s) => s && /^https?:\/\//i.test(String(s.url || '')));
  if (!list.length) return;
  const box = document.createElement('div');
  box.className = 'src-box';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'src-toggle';
  btn.textContent = `🌐 来源 ${list.length}`;
  btn.title = '这一轮联网搜索用到的网页（点开/收起）';
  const panel = document.createElement('div');
  panel.className = 'src-list';
  panel.hidden = true;
  for (const s of list) {
    const a = document.createElement('a');
    a.href = String(s.url);
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = `${s.title || s.url}${s.host ? ` · ${s.host}` : ''}`;
    panel.appendChild(a);
  }
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  box.append(btn, panel);
  const meta = wrap.querySelector('.meta');
  if (meta) meta.before(box); else wrap.appendChild(box);
}

/* ---------- 消息渲染 ---------- */
function renderMessages(messages) {
  state.messages = Array.isArray(messages) ? messages : [];
  const m = $('#messages');
  m.innerHTML = '';
  state.messages.forEach((msg, i) => {
    if (msg.role === 'system') return;
    // 多人卡：服务端存了 segments → 按人物分气泡，每个名字一个色
    if (Array.isArray(msg.segments) && msg.segments.length) {
      const wrap = renderMultiMessage(msg);
      wrap.dataset.index = i;
      attachReasoning(wrap, msg);
      attachActions(wrap, i, msg, i === state.messages.length - 1);
      attachSources(wrap, msg);
      m.appendChild(wrap);
      return;
    }
    const { wrap, meta } = createMessageEl(msg.role, msg.content);
    wrap.dataset.index = i;
    meta.textContent = metaText(msg);
    attachReasoning(wrap, msg);
    attachActions(wrap, i, msg, i === state.messages.length - 1);
    attachSources(wrap, msg);
    m.appendChild(wrap);
  });
  updateUsageBar();
  // 日常强化：会话里最后一条是角色回复 → 可以给这一轮打分
  if (typeof window.__rlOnMessages === 'function') window.__rlOnMessages(state.messages);
  scrollBottom();
}

function metaText(msg) {
  if (msg.role === 'assistant') {
    const who = msg.speaker ? `✦ ${msg.speaker}` : '✦ 角色';
    return msg.editedAt ? `${who} · 已改写` : who;
  }
  const as = msg.as ? `（${msg.as}）` : '';
  return msg.editedAt ? `我${as} · 已改写` : `我${as}`;
}

// 多人消息：每段一个气泡，左上角标人物名（同一人物用同一个颜色）
const CAST_COLORS = ['#7fb8ff', '#ffb86c', '#a0e39b', '#e39bd8', '#ffd166', '#9ad0e3'];
function castColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 997;
  return CAST_COLORS[h % CAST_COLORS.length];
}

function renderMultiMessage(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant multi';
  (msg.segments || []).forEach((seg) => {
    const bubble = document.createElement('div');
    bubble.className = 'bubble cast-bubble';
    if (seg.speaker) {
      const tag = document.createElement('span');
      tag.className = 'cast-name';
      tag.textContent = seg.speaker;
      tag.style.color = castColor(seg.speaker);
      bubble.append(tag);
    }
    const body = document.createElement('span');
    body.className = 'cast-text';
    body.textContent = seg.text || '';
    bubble.append(body);
    wrap.append(bubble);
  });
  const meta = document.createElement('div');
  meta.className = 'meta';
  const names = [...new Set((msg.segments || []).map((s) => s.speaker).filter(Boolean))];
  meta.textContent = `✦ ${names.join(' / ') || '角色'}${msg.editedAt ? ' · 已改写' : ''}`;
  wrap.append(meta);
  return wrap;
}

function createMessageEl(role, content) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  const meta = document.createElement('div');
  meta.className = 'meta';
  wrap.append(bubble, meta);
  return { wrap, bubble, meta };
}

// 流式追加一条。生成结束后会从服务端取回记录整体重绘，所以这里先不挂按钮。
function appendMessageEl(role, content, streaming = false) {
  $('#empty-state')?.remove();
  const { wrap, bubble, meta } = createMessageEl(role, content);
  if (streaming) bubble.classList.add('typing');
  meta.textContent = role === 'assistant' ? '✦ 角色' : '我';
  $('#messages').appendChild(wrap);
  scrollBottom();
  return { wrap, bubble, meta };
}

// 思考过程（v1.5.1）：折叠在消息上方，点操作条里的「💭 思考」展开/收起。
function attachReasoning(wrap, msg) {
  if (!msg || !msg.reasoning) return null;
  const box = document.createElement('div');
  // 常驻显示（v1.5.2）：默认展开，不再需要点「💭 思考」才出现；
  // 想收起再点操作条里的按钮。
  box.className = 'reasoning-box open';
  const label = document.createElement('div');
  label.className = 'reasoning-label';
  label.textContent = `💭 思考过程 · ${msg.reasoning.length} 字`;
  const body = document.createElement('div');
  body.className = 'reasoning-body';
  body.textContent = msg.reasoning;
  box.append(label, body);
  wrap.insertBefore(box, wrap.firstChild);
  return box;
}

function toggleReasoning(wrapEl) {
  const box = wrapEl?.querySelector('.reasoning-box');
  if (box) box.classList.toggle('open');
}

// ---- token 用量（v1.5.3，DSH 样式）----
const fmtTok = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(v);
};
function usageTitle(u, est) {
  if (!u) return '';
  const cached = Number(u.cached) || 0;
  const uncached = Math.max(0, (Number(u.input) || 0) - cached);
  const parts = [`未缓存输入 ${fmtTok(uncached)} tok`];
  if (cached) parts.push(`缓存读取 ${fmtTok(cached)} tok`);
  parts.push(`输出 ${fmtTok(u.output)} tok`);
  if (u.reasoning) parts.push(`其中推理 ${fmtTok(u.reasoning)} tok`);
  return `本轮用量 合计 ${fmtTok(u.total)} tok（${parts.join(' · ')}）${est ? ' —— 本地估算' : ''}`;
}
function usagePill(u, est) {
  const span = document.createElement('span');
  span.className = 'msg-usage';
  span.textContent = `用量 ${fmtTok(u.total)}${est ? '≈' : ''}`;
  span.title = usageTitle(u, est);
  return span;
}
// 聊天下方的状态条：「本轮 xxx tok · 累计 xxx tok · 上下文 xxx tok」
function updateUsageBar(live) {
  const el = $('#usage-bar');
  if (!el) return;
  const msgs = state.messages || [];
  let total = 0, count = 0, last = null, lastEst = false;
  for (const m of msgs) {
    if (m.role !== 'assistant' || !m.usage) continue;
    total += Number(m.usage.total) || 0;
    count += 1;
    last = m.usage;
    lastEst = Boolean(m.usageEstimated);
  }
  if (live && live.usage) {
    last = live.usage;
    lastEst = Boolean(live.estimated);
    total += Number(live.usage.total) || 0;
    count += 1;
  }
  if (!last) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.innerHTML = `本轮 <b>${fmtTok(last.total)}</b> tok · 累计 <b>${fmtTok(total)}</b> tok · 上下文 ${fmtTok(last.input)} tok`;
  el.title = `${usageTitle(last, lastEst)}\n会话累计：${count} 轮 · ${fmtTok(total)} tok`;
}

// 每条消息的操作条：双方都能撤回、都能人工改写；最后一条角色回复还能重新生成。
function attachActions(wrap, index, msg, isLast) {
  wrap.querySelector('.msg-actions')?.remove();
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const mk = (act, label, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'msg-act';
    b.dataset.act = act;
    b.dataset.index = index;
    b.textContent = label;
    b.title = title;
    return b;
  };
  bar.append(mk('edit', '编辑', '人工改写这条内容'));
  if (msg.role === 'assistant' && msg.reasoning) {
    // 思考过程常驻显示，这个按钮只是「收起 / 展开」（v1.5.2）
    bar.append(mk('think', '💭 收起思考', '思考过程默认常驻显示；点这里收起 / 再点展开'));
  }
  if (msg.role === 'assistant') {
    // 朗读：把这条读出来（只读台词，*动作* 和（）不读）
    const sp = mk('speak', '🔊', '朗读这条（只读台词）');
    if (!state.config?.tts?.baseUrl) sp.title = '还没配朗读服务：右上角 ⚙ → 朗读';
    bar.append(sp);
  }
  if (msg.role === 'assistant' && isLast) {
    // 两种模式都有这个入口，但内容不一样：
    //   · 角色模式 = 维度图（描写幅度）+ 提示 + 备忘 + 字数
    //   · 直连模式 = **只有**提示 / 备忘 / 字数（维度那一栏 v0.54.0 删了：无提示词对话不需要"笔墨比重"）
    bar.append(mk('dims', state.mode === 'direct' ? '微调' : '维度', state.mode === 'direct'
      ? '调直连模式的提示 / 备忘 / 字数（跟角色卡无关）'
      : '调动作/神态/语言/反应/环境的笔墨比重，然后重新生成'));
    bar.append(mk('regen', '重新生成', state.mode === 'direct' ? '删掉这条，让模型重新回答' : '删掉这条，让角色重新回复'));
    // 快速修改：生成 4 个候选供挑一个（选中的替换本条并进标准库，其余自动否决）
    bar.append(mk('cands', '🎲 挑一个', '生成 4 个候选回答：选一个替换本条并收进标准库，其余记为负样本'));
  }
  // 有被否掉的版本时给个入口：能看到当时落选的几版，也能把任意一版换回来
  if (Array.isArray(msg.rejected) && msg.rejected.length) {
    const b = mk('veto', `已否决 ${msg.rejected.length}`, '看看这一条当时被否掉的其它版本');
    b.classList.add('msg-act-veto');
    bar.append(b);
  }
  // token 用量（v1.5.3）：DSH 样式的小胶囊，和「撤回 / 重新生成」同一栏，悬停看明细
  if (msg.role === 'assistant' && msg.usage) bar.append(usagePill(msg.usage, msg.usageEstimated));
  bar.append(mk('recall', '撤回', '删除这条及其之后的全部消息'));
  wrap.appendChild(bar);
}

/* ---------- 描写幅度（维度图） ---------- */

// 首次打开时的预置档位（**0~10 十分制**）；应用过之后就以 config.dims 为准。
const DIM_MAX = 10;
const DIM_PRESET = [
  { name: '动作', level: 6 },
  { name: '神态', level: 4 },
  { name: '语言', level: 8 },
  { name: '反应', level: 4 },
  { name: '环境', level: 2 },
  { name: '常用词', level: 4 },
];
const DIM_HINT = {
  动作: '动作、身体移动、肢体接触',
  神态: '表情、眼神、语气里的情绪',
  语言: '说出口的台词',
  反应: '对对方动作/话语的即时反应',
  环境: '场景、光线、声音、气味、陈设',
  常用词: '口头禅 / 常用词出现的频率',
};
// 0~10 每一档的简短说法
const DIM_LEVEL_TEXT = [
  '不写', '几乎没有', '一两笔', '很少', '克制', '偏少',
  '正常', '偏多', '写细', '很多', '浓墨',
];

function cloneDims(list) {
  return list.map((d) => ({ name: d.name, level: d.level }));
}

/* ---------- 设置页里的「默认维度 / 默认提示词」 ---------- */
// 这就是以前维度弹窗写的那份全局值。现在角色各有一份之后，
// 它退居"默认值"：没在 🎛 维度 里单独调过的角色，用这里这份；新角色也从这份起步。

function renderGlobalDefaults(config) {
  const cfg = config || state.config || {};
  const list = Array.isArray(cfg.dims) && cfg.dims.length ? cfg.dims : DIM_PRESET;
  state.globalDims = list.map((d) => ({ name: d.name, level: d.level }));
  $('#cfg-dims').innerHTML = state.globalDims
    .map((d, i) => `<label class="limit-row cfg-dim-row">
      <span class="cfg-dim-name">${escapeHtml(d.name)}</span>
      <input type="number" min="0" max="${DIM_MAX}" step="1" data-i="${i}" value="${d.level}">
      <small>/${DIM_MAX}</small>
      <small class="cfg-dim-tip">${escapeHtml(DIM_LEVEL_TEXT[d.level] || '')}</small>
    </label>`)
    .join('');
  $('#cfg-hint').value = cfg.hint || '';
  $('#cfg-hint-count').textContent = `${(cfg.hint || '').length} / 500`;
  // 系统提示词（扮演规则主干，v1.6.0）
  const rulesEl = $('#cfg-rules');
  if (rulesEl) {
    rulesEl.value = cfg.customRules || '';
    $('#cfg-rules-count').textContent = `${(cfg.customRules || '').length} / 8000`;
  }
  const appendEl = $('#cfg-rules-append');
  if (appendEl) appendEl.checked = cfg.customRulesMode === 'append';
  // 聊天记录存储位置（v1.6.1）
  renderDataDir(cfg);
  // 等义词（全角色通用的一份）：每行「词 = 意思」，行尾可加 `#输出`
  $('#cfg-synonyms').value = cfg.synonyms || '';
  const synOut = $('#cfg-synonyms-output');
  if (synOut) synOut.checked = cfg.synonymsOutput === true;
  $('#cfg-dims-state').textContent = '';
}

/* ---------- 聊天记录存储位置（v1.6.1） ---------- */
function renderDataDir(cfg) {
  const info = cfg?.dataDirInfo || (cfg?.dataDir ? { path: cfg.dataDir } : null);
  const pathEl = $('#datadir-path');
  if (!pathEl) return;
  if (!info?.path) {
    pathEl.textContent = '读取失败';
    return;
  }
  pathEl.textContent = info.path;
  const bits = [];
  if (info.counts) bits.push(`${info.counts.characters} 个角色、${info.counts.sessions} 个会话`);
  if (info.redirected) bits.push('已重定向到自定义目录（data-dir.txt）');
  if (info.exists === false) bits.push('目录还不存在');
  const state = $('#datadir-state');
  if (state) state.textContent = bits.join(' · ');
}

async function openDataDir() {
  const btn = $('#datadir-open');
  const state = $('#datadir-state');
  if (btn) btn.disabled = true;
  if (state) state.textContent = '正在打开…';
  try {
    const r = await api('/api/data-dir/open', { method: 'POST' });
    if (state) state.textContent = `已用 ${r.opened} 打开`;
  } catch (err) {
    if (state) state.textContent = `打开失败：${err.message || err}`;
    toast('打开失败，可以点「复制路径」自己找');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function copyDataDir() {
  const text = $('#datadir-path')?.textContent || '';
  if (!text || text === '读取中…') return;
  try {
    await navigator.clipboard.writeText(text);
    toast('路径已复制');
  } catch {
    // 非 https 环境下 clipboard 可能不可用，退化到弹窗手选
    window.prompt('复制这个路径：', text);
  }
}

async function saveGlobalDefaults() {
  const dims = (state.globalDims || []).map((d, i) => {
    const el = $(`#cfg-dims input[data-i="${i}"]`);
    const raw = Math.round(Number(el ? el.value : d.level) || 0);
    const lv = Math.max(0, Math.min(DIM_MAX, Number.isFinite(raw) ? raw : 0));
    if (el) el.value = String(lv);
    return { name: d.name, level: lv };
  });
  const hint = $('#cfg-hint').value.trim().slice(0, 500);
  const synonyms = $('#cfg-synonyms').value.trim().slice(0, 2000);
  const synonymsOutput = Boolean($('#cfg-synonyms-output')?.checked);
  const customRules = ($('#cfg-rules')?.value || '').trim().slice(0, 8000);
  const customRulesMode = $('#cfg-rules-append')?.checked ? 'append' : 'replace';
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ dims, hint, synonyms, synonymsOutput, customRules, customRulesMode }) });
    await refreshConfig();
    renderGlobalDefaults(state.config);
    $('#cfg-dims-state').textContent = '已保存 ✓ 没单独设过的角色立刻生效';
    toast('默认维度 / 默认提示词已保存');
  } catch (err) {
    toast(err.message, true);
  }
}

async function openDims() {
  if (state.streaming) { toast('正在生成，等这一轮结束再调', true); return; }
  try {
    const cfg = await api('/api/config');
    // 直连模式：弹窗编辑的是**直连自己那一份**（direct*），跟角色卡/全局默认完全无关。
    // 这就是当初说的"直连单独一份"——改直连不会动到任何角色的设置。
    state.dimsDirect = state.mode === 'direct';
    if (state.dimsDirect) {
      // 直连模式：**没有"维度"这一栏**（v0.54.0 删）。
      // 维度是角色扮演的"笔墨比重"（动作 5/10、神态 5/10…），塞进无提示词对话里只会把模型往演戏方向带；
      // 直连这份现在只剩：微调提示 / 回复字数上限 / 提示预设 / 场景备忘（都不填 = 零注入）。
      state.dims = cloneDims(DIM_PRESET);
      state.dimsActive = false;
      state.dimsOwn = false;
      state.hint = cfg.directHint || '';
      state.hintOwn = Boolean(String(cfg.directHint || '').trim());
      state.maxChars = Number(cfg.directMaxChars) || 0;
      state.memo = cfg.directMemo || '';
      state.synonyms = cfg.directSynonyms || '';
      state.hintPresets = Array.isArray(cfg.hintPresets) ? cfg.hintPresets.slice() : [];
    } else {
      // 角色模式：先看这个角色自己有没有设，没设就显示设置里的全局值（作为起点），保存时写进角色卡。
      const character = state.characters.find((c) => c.id === state.activeCharacterId);
      const own = Array.isArray(character?.dims) && character.dims.length ? character.dims : null;
      const current = own || (Array.isArray(cfg.dims) ? cfg.dims : null);
      state.dims = cloneDims(current?.length ? current : DIM_PRESET);
      state.dimsActive = Boolean(current?.length);
      state.dimsOwn = Boolean(own);          // true = 用的是这个角色自己的档位
      state.hint = (character?.hint || '').trim() || cfg.hint || '';
      state.hintOwn = Boolean((character?.hint || '').trim());
      state.maxChars = Number(cfg.maxChars) || 0;
      state.memo = cfg.memo || '';
      state.synonyms = cfg.synonyms || '';   // 等义词：全角色通用那份（这里只显示，保存走设置页）
      state.hintPresets = Array.isArray(cfg.hintPresets) ? cfg.hintPresets.slice() : [];
    }
    state.hintOnce = false;
    // 直连模式：藏掉"维度"那一栏和"关闭维度控制"按钮，标题也换掉（这里只剩提示/字数/备忘）
    $('#dims-section').hidden = state.dimsDirect;
    $('#dims-off').hidden = state.dimsDirect;
    $('.hint-once').hidden = state.dimsDirect;   // 直连没有"只在这次用"的请求级提示，别摆个假开关
    $('#dims-title').textContent = state.dimsDirect ? '直连微调（提示 / 字数 / 备忘）' : '描写幅度（维度图）';
    $('#dims-hint').value = state.hint;
    $('#dims-hint-once').checked = false;
    $('#dims-maxchars').value = String(state.maxChars || 0);
    $('#dims-memo').value = state.memo;
    updateHintCount();
    updateMemoCount();
    renderPresets();
    renderDims();
    $('#dims-modal').hidden = false;
  } catch (err) {
    toast(err.message, true);
  }
}

// 雷达图：把各维度的档位画成一张图，一眼看出笔墨偏到哪去了
function dimsChart(list) {
  const n = Math.max(3, list.length);
  const R = 66;
  const cx = 90;
  const cy = 90;
  const pt = (i, r) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const ring = (k) => {
    const pts = [];
    for (let i = 0; i < n; i += 1) pts.push(pt(i, (R * k) / DIM_MAX).join(','));
    return `<polygon points="${pts.join(' ')}" class="dims-ring"/>`;
  };
  const rings = Array.from({ length: DIM_MAX }, (_, i) => ring(i + 1)).join('');
  let spokes = '';
  let labels = '';
  for (let i = 0; i < n; i += 1) {
    const [x, y] = pt(i, R);
    spokes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="dims-spoke"/>`;
    const [lx, ly] = pt(i, R + 15);
    const name = list[i]?.name || '';
    labels += `<text x="${lx}" y="${ly}" class="dims-label">${escapeHtml(name.slice(0, 4))}</text>`;
  }
  const poly = list.length
    ? `<polygon points="${list.map((d, i) => pt(i, (R * Math.max(0, Math.min(5, d.level))) / 5).join(',')).join(' ')}" class="dims-poly"/>`
    : '';
  const dots = list.map((d, i) => {
    const [x, y] = pt(i, (R * Math.max(0, Math.min(5, d.level))) / 5);
    return `<circle cx="${x}" cy="${y}" r="2.6" class="dims-dot"/>`;
  }).join('');
  return `<svg viewBox="0 0 180 180" class="dims-svg">${rings}${spokes}${poly}${dots}${labels}</svg>`;
}

function renderDims() {
  const list = state.dims || [];
  const who = state.characters.find((c) => c.id === state.activeCharacterId)?.name || '这个角色';
  // 直连模式：**没有"维度"这一栏**（v0.54.0 删）—— 这里只说明剩下那几项
  if (state.dimsDirect) {
    const set = state.hintOwn || Boolean(String(state.memo || '').trim()) || Number(state.maxChars) > 0;
    $('#dims-meta').innerHTML = '这一份属于：'
      + (set
        ? '<b>直连模式</b>专属的一份（跟任何角色卡都无关）'
        : '直连模式还没设过 —— <b>不填就一条提示词都不注入</b>')
      + '。<br>直连模式<b>没有「维度」</b>（维度是角色扮演的描写比重，塞进无提示词对话会把模型往演戏方向带）。'
      + '这里只剩：微调提示 / 回复字数上限 / 提示预设 / 场景备忘。'
      + (state.hint ? `<br>微调提示（${state.hintOnce ? '只这次用' : '一直用'}）：<b>${escapeHtml(state.hint.slice(0, 60))}${state.hint.length > 60 ? '…' : ''}</b>` : '');
    $('#dims-chart').innerHTML = '';
    $('#dims-rows').innerHTML = '';
    return;
  }
  // 先说清"这一份是谁的" —— 现在有三种归属（角色专属 / 设置里的全局默认 / 直连专属），最容易搞混
  const owner = state.dimsOwn || state.hintOwn
    ? `<b>${escapeHtml(who)}</b> 专属`
    : `还没单独设过，现在显示的是「设置」里的<b>全局默认</b>（保存后会变成 ${escapeHtml(who)} 专属的）`;
  $('#dims-meta').innerHTML = `这一份属于：${owner}。`
    + (state.dimsActive
      ? '当前<b>已启用</b>：这些幅度会一直用在后面的每一次生成，直到你再改。'
      : '当前<b>未启用</b>。调好后点「应用并重新生成」，这一版会按新幅度重写，<b>原来那版会自动进「已否决」</b>。')
    + (state.hint ? `<br>特点提示词（${state.hintOnce ? '只这次用' : '一直用'}）：<b>${escapeHtml(state.hint.slice(0, 60))}${state.hint.length > 60 ? '…' : ''}</b>` : '');
  $('#dims-chart').innerHTML = dimsChart(list);
  $('#dims-rows').innerHTML = list.map((d, i) => {
    const segs = Array.from({ length: DIM_MAX + 1 }, (_, lv) => {
      const cls = lv === 0 ? 'dims-seg dims-seg-zero' : 'dims-seg';
      const on = (lv === 0 ? d.level === 0 : d.level >= lv) ? ' on' : '';
      return `<button type="button" class="${cls}${on}" data-set="${lv}" data-i="${i}" title="${lv}／${DIM_MAX}：${DIM_LEVEL_TEXT[lv]}">${lv}</button>`;
    }).join('');
    const hint = DIM_HINT[d.name] ? `<span class="dims-hint">${escapeHtml(DIM_HINT[d.name])}</span>` : '';
    return `<div class="dims-row">
      <div class="dims-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</div>
      <div class="dims-bar">${segs}</div>
      <div class="dims-val">${d.level}<small>/${DIM_MAX}</small> ${escapeHtml(DIM_LEVEL_TEXT[d.level])}</div>
      <div class="dims-ctrl">
        <button type="button" class="msg-act" data-delta="-1" data-i="${i}" title="降一档">−</button>
        <button type="button" class="msg-act" data-delta="1" data-i="${i}" title="升一档">＋</button>
        <button type="button" class="msg-act" data-remove="1" data-i="${i}" title="移除这个维度">✕</button>
      </div>
      ${hint}
    </div>`;
  }).join('');
}

function setDimLevel(i, level) {
  const d = state.dims[i];
  if (!d) return;
  d.level = Math.max(0, Math.min(DIM_MAX, level));
  renderDims();
}

function updateHintCount() {
  const t = $('#dims-hint');
  if (!t) return;
  $('#hint-count').textContent = `${t.value.length} / 500`;
}

function updateMemoCount() {
  const t = $('#dims-memo');
  if (!t) return;
  $('#memo-count').textContent = `${t.value.length} / 800`;
}

// 备忘是"随时补充的事实"，所以**改动立刻存盘**、不触发重新生成
// （它影响的是下一次生成，不像幅度/提示那样需要马上重写当前这一条）。
async function saveMemo() {
  const text = $('#dims-memo').value.trim().slice(0, 800);
  if (text === state.memo) return;
  state.memo = text;
  try {
    // 直连模式写 directMemo，角色模式写全局 memo —— 绝不能互相写串
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify(state.dimsDirect ? { directMemo: text } : { memo: text }),
    });
  } catch (err) {
    toast(err.message, true);
  }
}

function queueSaveMemo() {
  updateMemoCount();
  clearTimeout(state.memoTimer);
  state.memoTimer = setTimeout(saveMemo, 700); // 边打字边存，但别每敲一个字发一次请求
}

async function applyDims() {
  const dims = (state.dims || [])
    .filter((d) => d.name.trim())
    .map((d) => ({ name: d.name.trim(), level: d.level }));
  const hint = $('#dims-hint').value.trim().slice(0, 500);
  const hintOnce = $('#dims-hint-once').checked;
  if (state.dimsDirect) {
    // 直连模式没有维度（v0.54.0 删），能应用的就是这句提示。
    // 注意：直连接口**没有"请求级提示"**（不像角色模式能"只在这次用"），所以这里只存不临时用；
    // 弹窗里那个「只在这次用」勾选框在直连模式下是藏起来的（不摆假开关）。
    if (!hint) { toast('写一句提示再应用（直连模式没有维度）', true); return; }
    try {
      await api('/api/config', { method: 'PUT', body: JSON.stringify({ directHint: hint }) });
      await refreshConfig();
    } catch (err) {
      toast(err.message, true);
      return;
    }
    state.hintOwn = true;
    state.hint = hint;
    $('#dims-modal').hidden = true;
    toast('提示已应用，正在重新生成…');
    await regenerate({ rejectedReason: '改提示前的一版' });
    return;
  }
  if (!dims.length && !hint) { toast('至少留一个维度，或写一句提示', true); return; }
  if (!state.activeCharacterId) { toast('先选一个角色再调', true); return; }
  try {
    // 角色模式：存进**这个角色**的角色卡。
    await api('/api/characters', {
      method: 'POST',
      body: JSON.stringify({ id: state.activeCharacterId, ...(hintOnce ? { dims } : { dims, hint }) }),
    });
  } catch (err) {
    toast(err.message, true);
    return;
  }
  // 本地那份也跟着更新，省一次请求
  const ch = state.characters.find((c) => c.id === state.activeCharacterId);
  if (ch) { ch.dims = dims; if (!hintOnce) ch.hint = hint; }
  state.dimsActive = dims.length > 0;
  state.dimsOwn = true;
  state.hintOwn = !hintOnce && Boolean(hint);
  state.hint = hintOnce ? '' : hint;
  $('#dims-modal').hidden = true;
  toast(hint ? '幅度和提示已应用，正在重新生成…' : '幅度已应用，正在按新比重重新生成…');
  await regenerate({
    rejectedReason: '调整描写幅度前的一版',
    ...(hintOnce && hint ? { hint } : {}),
  });
}

async function turnDimsOff() {
  if (!state.activeCharacterId) { toast('先选一个角色', true); return; }
  try {
    // dims: [] / hint: '' = 把这个角色卡里的这两项清掉 → 回到「设置」里的全局值
    await api('/api/characters', {
      method: 'POST',
      body: JSON.stringify({ id: state.activeCharacterId, dims: [], hint: '' }),
    });
    const ch = state.characters.find((c) => c.id === state.activeCharacterId);
    if (ch) { ch.dims = null; ch.hint = ''; }
  } catch (err) {
    toast(err.message, true);
    return;
  }
  state.dimsActive = false;
  state.dimsOwn = false;
  state.hintOwn = false;
  state.hint = '';
  $('#dims-modal').hidden = true;
  toast('这个角色已改回用「设置」里的全局维度和提示词');
}


/* ---------- 提示预设 ---------- */

const PRESET_MAX = 20;

function renderPresets() {
  const list = state.hintPresets || [];
  const box = $('#preset-list');
  if (!box) return;
  $('#preset-count').textContent = list.length ? `${list.length} / ${PRESET_MAX}` : '（还没有，写好一句后点右边保存）';
  if (!list.length) {
    box.innerHTML = '<div class="preset-empty">常用要求存成预设，下次一点就填进提示框。</div>';
    return;
  }
  box.innerHTML = list.map((text, i) => `
    <span class="preset-chip">
      <button type="button" class="preset-use" data-use="${i}" title="填进提示框">${escapeHtml(text.length > 28 ? `${text.slice(0, 28)}…` : text)}</button>
      <button type="button" class="preset-del" data-del="${i}" title="删掉这个预设">✕</button>
    </span>`).join('');
}

// 预设是"随手攒的小抄"，所以改动立刻存盘（不像幅度那样要等「应用」）
async function persistPresets() {
  try {
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ hintPresets: state.hintPresets }),
    });
    // 以服务端返回的收敛结果为准（会去重、限量、截断）
    const after = await api('/api/config');
    state.hintPresets = Array.isArray(after.hintPresets) ? after.hintPresets : state.hintPresets;
  } catch (err) {
    toast(err.message, true);
  }
  renderPresets();
}

async function savePreset() {
  const text = $('#dims-hint').value.trim().slice(0, 500);
  if (!text) { toast('先在上面写一句提示，再存为预设', true); return; }
  if ((state.hintPresets || []).includes(text)) { toast('这句已经在预设里了', true); return; }
  if ((state.hintPresets || []).length >= PRESET_MAX) { toast(`预设最多 ${PRESET_MAX} 条，先删几条`, true); return; }
  state.hintPresets = [...(state.hintPresets || []), text];
  await persistPresets();
  toast('已存为预设');
}

async function removePreset(i) {
  state.hintPresets = (state.hintPresets || []).filter((_, k) => k !== i);
  await persistPresets();
  toast('已删除这个预设');
}


/* ---------- 已否决的版本 ---------- */

const VETO_LABEL = {
  regen: '重新生成前的一版',
  quality: '质量分更低的一版',
  cleaned: '清理前（含凭空动静）',
  swap: '被换下的这一版',
  loop: '复读被截断前的全文',
};

// 否决版本上的「错在哪」标记。可以同时打多个（设定不符 + 常识写错是两回事）。
// 标上之后它仍是负样本，但会带着理由进 DPO —— 告诉模型"错在哪"比单纯判负有用。
const VETO_TAGS = [
  { key: '知识错误', tip: '把常识/设定里的客观事实写错了（身体构造、物品性能、物理规律…）' },
  { key: '设定不符', tip: '不符合这个角色的身份/关系/性格（语气像别人、关系搞错、说话方式跑偏）' },
];

/** 从消息里取出某一版的标记数组（兼容老数据的单个 tag 字符串）。 */
function tagsOf(r) {
  if (Array.isArray(r?.tags)) return r.tags;
  if (r?.tag) return [r.tag];
  return [];
}

function renderVeto(index) {
  const msg = state.messages[index];
  if (!msg || !Array.isArray(msg.rejected) || !msg.rejected.length) {
    toast('这条没有已否决的版本', true);
    return;
  }
  $('#veto-meta').innerHTML = `当前正文 ${msg.content.length} 字符 · 已否决 <b>${msg.rejected.length}</b> 版`
    + '（点「用这版」会把正文换过去，被换下的那版进入列表，可以随时换回来）';
  const blocks = msg.rejected.map((r, i) => `
    <div class="veto-block">
      <div class="ctx-role">第 ${i + 1} 版 · ${escapeHtml(VETO_LABEL[r.source] || r.reason || '')}
        · ${r.text.length} 字符
        <button type="button" class="btn-ghost btn-tiny" data-adopt="${i}" data-index="${index}">用这版</button>
        ${VETO_TAGS.map((t) => {
          const on = tagsOf(r).includes(t.key);
          return `<button type="button" class="btn-ghost btn-tiny${on ? ' veto-tag-on' : ''}"
            data-tag="${i}" data-key="${escapeHtml(t.key)}" data-on="${on ? '1' : '0'}"
            title="${escapeHtml(t.tip)}">${on ? '✕ ' + t.key : t.key}</button>`;
        }).join('')}
      </div>
      <div class="ctx-text">${escapeHtml(r.text)}</div>
      ${tagsOf(r).length ? `<div class="veto-tag">⚠ 已标为：${tagsOf(r).map((x) => escapeHtml(x)).join(' · ')}</div>` : ''}
      ${r.reason && r.source !== 'swap' ? `<div class="veto-why">否决理由：${escapeHtml(r.reason)}</div>` : ''}
    </div>`);
  $('#veto-body').innerHTML = blocks.join('');
  $('#veto-modal').hidden = false;
}

async function adoptRejected(index, rejectedIndex) {
  try {
    const { session } = await api(`/api/sessions/${activeSessionId()}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'adopt', index, rejectedIndex }),
    });
    renderMessages(session.messages);
    toast('已换成这一版');
    renderVeto(index); // 弹窗内容跟着刷新（换下来的那版会出现在列表里）
  } catch (err) {
    toast(err.message, true);
  }
}

/** 给「已否决」里的某一版加/去一个标记（可以打多个）。 */
async function tagRejected(index, rejectedIndex, key, on) {
  try {
    const { session } = await api(`/api/sessions/${activeSessionId()}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'vetoReason', index, rejectedIndex, tag: key, on }),
    });
    renderMessages(session.messages);
    renderVeto(index);
    toast(on ? `已标记：${key}` : `已取消：${key}`);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 撤回 / 人工改写 / 重新生成 ---------- */
async function recallFrom(index) {
  if (state.streaming || !activeSessionId()) return;
  const target = state.messages[index];
  if (!target) return;

  const rest = state.messages.length - index;
  const ask = rest > 1
    ? `撤回这条，并删除它之后的 ${rest - 1} 条？（共 ${rest} 条）`
    : '撤回这条消息？';
  if (!confirm(ask)) return;

  try {
    const { session } = await api(`/api/sessions/${activeSessionId()}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'recall', index }),
    });
    // 撤回的是自己发的话，就把内容放回输入框，方便改完重发。
    if (target.role === 'user') {
      $('#input').value = target.content;
      autoResize();
    }
    renderMessages(session.messages);
    updateSendState();
    await refreshCurrentMode();
    toast(`已撤回 ${rest} 条`);
  } catch (err) {
    toast(err.message, true);
  }
}

function startEdit(index) {
  if (state.streaming || !activeSessionId()) return;
  const msg = state.messages[index];
  const wrap = document.querySelector(`.msg[data-index="${index}"]`);
  if (!msg || !wrap || wrap.querySelector('.edit-box')) return;

  const bubble = wrap.querySelector('.bubble');
  const box = document.createElement('div');
  box.className = 'edit-box';

  const ta = document.createElement('textarea');
  ta.value = msg.content;
  ta.rows = Math.min(14, Math.max(3, msg.content.split('\n').length + 1));
  attachAutoPair(ta);

  const row = document.createElement('div');
  row.className = 'edit-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-ghost';
  cancel.textContent = '取消';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn-primary';
  save.textContent = '保存';
  row.append(cancel, save);
  box.append(ta, row);

  // 多人消息是「多个气泡一组」，编辑时要把整组清掉，否则只换掉第一个气泡、
  // 剩下几个还留在编辑框下面。
  if (wrap.classList.contains('multi')) {
    wrap.querySelectorAll('.bubble').forEach((b) => b.remove());
    wrap.insertBefore(box, wrap.querySelector('.meta'));
  } else {
    bubble.replaceWith(box);
  }
  wrap.querySelector('.msg-actions')?.remove();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  cancel.addEventListener('click', () => renderMessages(state.messages));
  save.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) {
      toast('内容不能为空', true);
      return;
    }
    try {
      const { session } = await api(`/api/sessions/${activeSessionId()}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'edit', index, content: text }),
      });
      renderMessages(session.messages);
      await refreshCurrentMode();
      toast('已保存改写');
    } catch (err) {
      toast('保存失败：' + err.message, true);
    }
  });
}

async function regenerate(opts = {}) {
  if (state.streaming || !activeSessionId()) return;
  if (!state.messages.some((m) => m.role === 'user')) {
    toast('还没有你说的话，无法重新生成', true);
    return;
  }
  // 先在界面上抹掉末尾的回复，再让服务端基于同一段历史重新生成。
  const trimmed = state.messages.slice();
  while (trimmed.length && trimmed.at(-1).role === 'assistant') trimmed.pop();
  renderMessages(trimmed);
  return streamReply({ regenerate: true, ...opts });
}

/* ---------- 聊天 ---------- */
function enableComposer(enabled) {
  const on = enabled && !isLocked();
  $('#input').disabled = !on;
  // 按钮状态统一交给 updateSendState：它知道生成中这个按钮是「停止」、而且必须可点，
  // 别在这里把它禁掉（禁用掉的「停止」就是个摆设）。
  updateSendState();
}

async function sendMessage(text, opts = {}) {
  if (state.mode === 'direct' && !opts.pinnedReply) return sendDirectMessage(text);
  if (!state.activeCharacterId || state.streaming) return;
  if (isLocked()) {
    toast('现在是工作时间，对话已锁定', true);
    refreshWorkGuard();
    return;
  }
  if (!state.activeSessionId) await newSession();
  if (!state.activeSessionId) return;

  // 🖼 附图：取这一条消息要带的图（发送后清空，只挂这一条）
  const image = state.pendingImage;
  const content = text.trim() || (image ? '（发了张图）' : '');
  if (!content) return;
  // 「/ 以谁的身份发」：只挂在正常的一条消息上（cheats 指令不带）
  const asPerson = asPick;

  // 作弊指令：不当作你说的话，直接让角色接着演下一句
  const cheat = parseCheat(content);
  if (cheat === 'next') {
    $('#input').value = '';
    autoResize();
    if (!state.messages.length) { toast('这个会话还没有内容，没法接着演', true); return; }
    toast(describeCheat(cheat));
    await streamReply({ next: true });
    return;
  }
  // quit：立刻关闭程序（顺手让 Ollama 把显存里的模型卸掉）。
  // 关掉之后这个页面就没服务了 —— 所以先把界面切成"已关闭"，再发请求。
  if (cheat === 'quit') {
    $('#input').value = '';
    autoResize();
    toast(describeCheat(cheat));
    markShutDown();
    try {
      await fetch('/api/quit', { method: 'POST' });
    } catch { /* 服务已经退了，请求失败是正常的 */ }
    return;
  }

  // 先把用户这条画出来并挂进本地数组（下标要和服务端一致）。
  const shown = appendMessageEl('user', content);
  if (asPerson) shown.meta.textContent = `我（${asPerson.name}）`;
  state.messages = [...state.messages, { role: 'user', content }];
  $('#input').value = '';
  autoResize();
  if (image) clearPendingImage();
  // 胶囊只对这一条生效：请求发出去就取消（服务端已经记下这一条的身份）
  if (asPerson) clearAsPick();

  await streamReply({
    content,
    ...(image ? { image } : {}),
    ...(asPerson ? { as: { name: asPerson.name } } : {}),
    ...(opts.pinnedReply ? { pinnedReply: opts.pinnedReply } : {}),
  });
}

// 直连模式的发送。跟角色模式的区别：没有角色、没有开场白，
// 第一句话来了才真正建会话（免得点一下就在同步目录里多一个空会话）。
async function sendDirectMessage(text) {
  if (state.streaming) return;
  if (isLocked()) {
    toast('现在是工作时间，对话已锁定', true);
    refreshWorkGuard();
    return;
  }
  if (!state.activeDirectId) await newDirectSession({ silent: true });
  if (!state.activeDirectId) return;

  // 🖼 附图：直连模式也支持。图片只在这一次请求里带上，这一轮临时换成视觉模型
  // （直连默认零注入，所以模型切换是这里唯一的变化）。
  const image = state.pendingImage;
  const content = text.trim() || (image ? '（发了张图）' : '');
  if (!content) return;

  const cheat = parseCheat(content);
  // quit 在两种模式下都一样：立刻关掉程序（顺手卸载显存里的模型）
  if (cheat === 'quit') {
    $('#input').value = '';
    autoResize();
    toast(describeCheat(cheat));
    markShutDown();
    try {
      await fetch('/api/quit', { method: 'POST' });
    } catch { /* 服务已经退了，请求失败是正常的 */ }
    return;
  }
  // cheats=1 是"让角色接着演"，直连模式没有角色 —— 说清楚，别把它当成消息发出去
  if (cheat === 'next') {
    toast('cheats=1 是角色模式的功能，直连模式没有角色可演', true);
    return;
  }

  appendMessageEl('user', content);
  state.messages = [...state.messages, { role: 'user', content }];
  $('#input').value = '';
  autoResize();
  if (image) clearPendingImage();

  await streamReply({ content, ...(image ? { image } : {}) });
}

// 统一的流式请求：发新消息和「重新生成」共用同一段逻辑。
// 两种模式的差别只有"发去哪个接口、用哪个会话 id"，走这里分支。
async function streamReply(payload) {
  const sid = activeSessionId();
  if (!sid) return;
  state.streaming = true;
  state.streamStartedAt = Date.now();
  updateSendState();

  const { wrap, bubble } = appendMessageEl('assistant', '', true);
  const controller = new AbortController();
  state.abort = controller;
  let accumulated = '';
  let reasoning = '';
  // 思考过程实时块：一开始就插在气泡上方（有思考才显示文字）
  const rbox = document.createElement('div');
  rbox.className = 'reasoning-box streaming';
  rbox.style.display = 'none';
  rbox.innerHTML = '<div class="reasoning-label">💭 思考中…</div><div class="reasoning-body"></div>';
  wrap.insertBefore(rbox, bubble);
  const rbody = rbox.querySelector('.reasoning-body');
  const rlabel = rbox.querySelector('.reasoning-label');

  try {
    const res = await fetch(chatEndpoint(), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, ...payload }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `请求失败（${res.status}）`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const raw of events) {
        const lines = raw.split('\n');
        const evLine = lines.find((l) => l.startsWith('event:'));
        const line = lines.find((l) => l.startsWith('data:'));
        if (!line) continue;
        let data;
        try { data = JSON.parse(line.slice(5)); } catch { continue; }
        const ev = evLine ? evLine.slice(6).trim() : 'delta';
        if (ev === 'reasoning') {
          // 云端模型的思考过程（DeepSeek reasoning_content）：实时显示在气泡上方
          if (data.text) {
            reasoning += data.text;
            rbox.style.display = 'block';
            rbody.textContent = reasoning;
            rlabel.textContent = '💭 思考中…';
          }
        } else if (ev === 'reset') {
          // 服务端判定上一版在拖延，正在重新生成：把气泡擦掉重打
          accumulated = '';
          reasoning = '';
          rbody.textContent = '';
          rbox.style.display = 'none';
          bubble.textContent = '';
          if (data.reason === 'stall') toast('这轮像在拖延，正在重新生成…');
        } else if (ev === 'replace') {
          // 服务端做了后处理（清掉凭空的动静）：把已显示的内容换成干净版
          accumulated = data.text ?? accumulated;
          bubble.textContent = accumulated;
          if (data.note) toast(data.note);
          scrollBottom();
        } else if (ev === 'web') {
          // 联网搜索（v0.62.0）：服务端在真正请求模型之前先搜必应。
          // phase=start 时给个"正在搜"的占位（第一个 delta 会把它顶掉）；
          // 搜失败/降级（比如国际版被重定向到国内版）一定要说出来，不能装作没发生。
          if (data.phase === 'start') {
            if (!accumulated) bubble.textContent = '🔍 正在联网搜索…';
          } else if (data.error) {
            toast(`联网搜索失败：${data.error}`, true);
          } else if (data.notice) {
            toast(data.notice, true);
          }
        } else if (ev === 'kw') {
          // 关键词 → 动作命中（v1.7.8）：告诉用户这轮触发了哪个暗号
          const kws = (data.matches || []).map((m) => m.kw).join('、');
          if (kws) toast(`🔑 命中暗号：${kws}`);
        } else if (ev === 'usage') {
          // 本轮真实用量（云端有 usage，本地是估算）：立刻更新聊天下方状态条
          updateUsageBar(data);
        } else if (ev === 'done') {
          if (data.rejected) toast(`有 ${data.rejected} 版被否决，点气泡下的「已否决」可以看`);
        } else if (data.text !== undefined) {
          accumulated += data.text;
          bubble.textContent = accumulated;
          scrollBottom();
        } else if (data.error !== undefined) {
          throw new Error(data.error);
        }
      }
    }

    bubble.classList.remove('typing');
    if (!reasoning) rbox.remove();
    else { rlabel.textContent = `💭 思考过程 · ${reasoning.length} 字`; rbox.classList.remove('streaming'); rbox.classList.add('open'); }
    if (!accumulated) bubble.textContent = '（没有内容）';
    // 生成结束：从服务端取回记录整体重绘，这样每条消息都带上操作按钮。
    const { session } = await api(`/api/sessions/${sid}`);
    renderMessages(session.messages);
    autoSpeakLast(session.messages);   // 开了「自动触发」就直接读出来
  } catch (err) {
    bubble.classList.remove('typing');
    if (err.name === 'AbortError') {
      toast('已停止生成');
      try {
        const { session } = await api(`/api/sessions/${sid}`);
        renderMessages(session.messages);
      } catch {
        /* 拉不到就保持现状 */
      }
    } else {
      bubble.textContent = `⚠ ${err.message}`;
      bubble.style.color = 'var(--danger)';
      refreshWorkGuard(); // 可能是刚好到了上班时间被服务端拦下，刷新一下锁状态
    }
  } finally {
    state.streaming = false;
    state.abort = null;
    updateSendState();
    await refreshCurrentMode();
    // v2.3.14 🌿 开关开着：这一轮生成完自动再给 2 个走向。
    // 不 await —— 分支是模型再跑两次，没必要卡住输入框；失败就静默（面板里会显示原因）。
    if (branchIsOn() && branchLastAssistantIndex() >= 0) {
      Promise.resolve().then(() => generateBranches()).catch(() => {});
    }
    // v2.0.0：生成结束后**重新同步评分条**。
    // 之前 syncRlBar() 只在流式开始时被调用过（那时 streaming=true，提交按钮被禁用），
    // 结束后没有人再调一次 → 「提交评分」一直是灰的（实测踩到）。
    if (typeof window.__rlSyncBar === 'function') window.__rlSyncBar();
    // 生成结束后把焦点还给输入框 —— renderMessages() 重建了消息 DOM，焦点会丢到 body 上。
    const inp = $('#input');
    if (inp && !inp.disabled && document.activeElement !== inp) {
      try { inp.focus({ preventScroll: true }); } catch { inp.focus(); }
    }
  }
}

function stopStreaming() {
  state.abort?.abort();
}

/* ---------- 工作时段锁 ---------- */
// 权威判断在服务端 lib/workguard.js；前端只负责显示倒计时、提前禁用输入框。
function isLocked() {
  return Boolean(state.work?.blocked);
}

function humanLeft(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${String(s).padStart(2, '0')} 秒`;
  return `${s} 秒`;
}

// 输入框提示语：锁住 / 直连模式 / 角色模式各不一样。
// 由 updateChatHeader（切模式、切会话时都会调）和 applyWorkGuard 一起维护。
function updatePlaceholder() {
  const input = $('#input');
  if (!input || state.shutDown) return;
  if (isLocked()) {
    input.placeholder = '工作时间不能聊天，先干活吧';
    return;
  }
  input.placeholder = state.mode === 'direct'
    ? '直接跟模型说话…（Enter 发送，Shift+Enter 换行；quit 关闭本地AI对话工作台）'
    : '说点什么…（Enter 发送，Shift+Enter 换行；打 / 以对话里谁的身份发；cheats=1 接着演）';
}

function applyWorkGuard() {
  const bar = $('#lock-bar');
  if (isLocked()) {
    bar.hidden = false;
    bar.textContent = `🔒 工作时间已锁定（${state.work.label} 北京时间）· ${humanLeft(state.work.until - Date.now())} 后自动解锁`;
  } else {
    bar.hidden = true;
  }
  updatePlaceholder();
  updateSendState();
}

async function refreshWorkGuard() {
  try {
    state.work = await api('/api/workguard');
  } catch {
    state.work = null; // 拿不到状态就不锁，别误伤
  }
  applyWorkGuard();
}

function tickWorkGuard() {
  if (!isLocked()) return;
  if (Date.now() >= state.work.until) return refreshWorkGuard(); // 到点了，重新问服务端
  applyWorkGuard();
}

/* ---------- 输入框 ---------- */

// 左括号自动补右括号（输入框和"改写消息"的编辑框都用它）。
// 注意：中文输入法提交时 isComposing 有时还是 true，所以 compositionend 里再补一次。
function attachAutoPair(el) {
  if (!el) return;
  // 设置里的开关：关掉就完全不插手输入（可以随时改，不用刷新页面）
  const on = () => state.config?.autoPair !== false;
  const apply = (data) => {
    if (!on()) return false;
    const r = applyAutoPair(el.value, el.selectionStart, data);
    if (!r) return false;
    el.value = r.value;
    el.setSelectionRange(r.cursor, r.cursor);
    return true;
  };
  el.addEventListener('input', (e) => {
    if (e.isComposing) return; // 输入法合成中，别插手
    apply(e.data);
  });
  el.addEventListener('compositionend', (e) => apply(e.data));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace' || e.isComposing || !on()) return;
    const r = applyBackspacePair(el.value, el.selectionStart, el.selectionEnd);
    if (!r) return;
    e.preventDefault();
    el.value = r.value;
    el.setSelectionRange(r.cursor, r.cursor);
  });
}

function autoResize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 160) + 'px';
}

function updateSendState() {
  const t = $('#input');
  // 评分条的可用性也跟着 streaming / 锁定状态走 —— 统一在这里同步，避免漏调（v2.0.0）
  if (typeof window.__rlSyncBar === 'function') {
    try { window.__rlSyncBar(); } catch { /* 还没初始化就算了 */ }
  }
  // 📷 识图 / 🖼 附图 跟输入框同进同退：锁了 / 正在生成 / 已关闭，都不该能点。
  // （附图两种模式都支持：直连模式会把这一轮临时换成视觉模型）
  const busy = state.shutDown || state.streaming || isLocked();
  const vbtn = $('#btn-vision');
  if (vbtn) vbtn.disabled = busy;
  const abtn = $('#btn-attach');
  if (abtn) abtn.disabled = busy;
  // 🎲 预选：没输入内容时不该能点（没东西可发），其余同输入框
  const pbtn = $('#btn-presend');
  if (pbtn) pbtn.disabled = busy || !String(t.value || '').trim() || state.mode === 'direct';
  // 🙋 反过来：**没有**内容时才该点（有内容就去用 🎲 预选）
  const sbtn = $('#btn-suggest');
  if (sbtn) sbtn.disabled = busy || state.mode === 'direct';
  if (state.shutDown) {           // 已经 quit 了：输入和按钮都锁死，别再让人白点
    const btn = $('#btn-send');
    btn.disabled = true;
    btn.textContent = '已关闭';
    btn.classList.remove('is-stop');
    return;
  }
  // 直连模式：第一句话会自己建会话，所以"还没有会话"不该把发送键拦死。
  // 角色模式同理：点角色进来先是「开场白预览」，还没有会话文件，
  // 但 sendMessage() 会先 newSession() 再发 —— 所以只要选了角色就该能点发送。
  const hasSession = state.mode === 'direct'
    ? true
    : Boolean(state.activeSessionId || state.activeCharacterId);
  const { disabled, label, isStop } = sendButtonState({
    locked: isLocked(),
    streaming: state.streaming,
    // 只附图不写字也能发（服务端会补一句「（发了张图）」）
    hasText: Boolean(t.value.trim()) || Boolean(state.pendingImage),
    hasSession,
  });
  const btn = $('#btn-send');
  btn.disabled = disabled;
  btn.textContent = label;
  btn.classList.toggle('is-stop', isStop);
}

/* ---------- 识图（📷） ---------- */

// 手机拍的照片动辄 3~8MB，先压到长边 1280 再发：图像 token 少一大截
// （省显存、快很多），描述质量基本没差别。真发原图也行，服务端有 12MB 的上限兜底。
const VISION_MAX_SIDE = 1280;

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('这个文件读不出来'));
    fr.readAsDataURL(file);
  });
}

async function shrinkImage(file) {
  const raw = await fileToDataUrl(file);
  if (typeof createImageBitmap !== 'function') return raw;   // 老浏览器：原图直发
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, VISION_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    // 本来就是小图就别再压一次（有损重编码白掉质量）
    if (scale >= 1 && raw.length <= 1.5 * 1024 * 1024) return raw;
    return canvas.toDataURL('image/jpeg', 0.9);
  } catch {
    return raw;
  }
}

// 描述插进输入框，**不直接发** —— 留给你改两笔、或者只当素材用。
function insertVisionText(text) {
  const input = $('#input');
  const s = String(text || '').trim();
  if (!s) return;
  const cur = input.value;
  input.value = cur && !cur.endsWith('\n') ? `${cur}\n${s}` : cur + s;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autoResize();
  updateSendState();
}

async function describePickedImage(file) {
  if (!file) return;
  const btn = $('#btn-vision');
  if (btn.disabled) return;
  btn.disabled = true;          // 推理期间别让人连点
  btn.classList.add('busy');
  const label = btn.textContent;
  btn.textContent = '⏳';
  try {
    const dataUrl = await shrinkImage(file);
    const r = await api('/api/vision', { method: 'POST', body: JSON.stringify({ image: dataUrl }) });
    insertVisionText(r.text);
    toast(`识图完成 · ${r.seconds} 秒 · ${r.model}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.textContent = label;
    btn.classList.remove('busy');
    updateSendState();
  }
}

/* ---------- 附图（🖼：图片直接发给角色看） ---------- */

function clearPendingImage() {
  state.pendingImage = null;
  state.pendingImageName = '';
  renderAttachBar();
}

// 输入框上方的确认条：缩略图 + 文件名 + ✕。挂上之后**不会立刻发送**，
// 跟下一条文字一起发出去（这样你能先打字，或者反悔点 ✕）。
function renderAttachBar() {
  const bar = $('#attach-bar');
  if (!bar) return;
  const url = state.pendingImage;
  bar.hidden = !url;
  if (url) {
    $('#attach-thumb').src = url;
    $('#attach-name').textContent = state.pendingImageName || '这张图会跟下一条消息一起发出去';
  } else {
    $('#attach-thumb').removeAttribute('src');
    $('#attach-name').textContent = '';
  }
  updateSendState();
}

// 选图 → 压到长边 1280 → 挂到确认条上
async function attachPickedImage(file) {
  if (!file) return;
  const btn = $('#btn-attach');
  btn.classList.add('busy');
  const label = btn.textContent;
  btn.textContent = '⏳';
  try {
    const dataUrl = await shrinkImage(file);
    state.pendingImage = dataUrl;
    state.pendingImageName = file.name || '（照片）';
    renderAttachBar();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.textContent = label;
    btn.classList.remove('busy');
    updateSendState();
  }
}

// 收到 quit 之后：服务马上就不在了，界面必须自己说清楚，否则用户只会看到"发不出去"。
function markShutDown() {
  state.shutDown = true;
  const input = $('#input');
  input.value = '';
  input.disabled = true;
  input.placeholder = '本地AI对话工作台已关闭 —— 要再用，在电脑上运行 node start.js';
  autoResize();
  updateSendState();
  const tip = document.createElement('div');
  tip.className = 'notice-tip';
  tip.textContent = '本地AI对话工作台已关闭（模型也已从显存卸载）。要再用：在电脑上运行 node start.js';
  $('#messages')?.appendChild(tip);
  $('#messages')?.scrollTo?.({ top: 1e9 });
}

/* ---------- 头部与状态 ---------- */
function updateChatHeader() {
  // 直连模式：头像是 ↯，名字用当前模型，副标题点明"没有系统提示词"
  if (state.mode === 'direct') {
    $('#chat-avatar').innerHTML = '↯';
    $('#chat-name').textContent = state.config.model || '直连模型';
    $('#chat-tagline').textContent = state.activeDirectId
      ? '直连模式 · 不注入任何系统提示词，也不做后处理'
      : '直连模式 · 说点什么就开始（不会写进角色会话）';
    $('#btn-clear').hidden = false;          // 「清空」= 再开一个直连会话
    $('#btn-edit-character').hidden = true;  // 直连没有角色卡可改
    $('#btn-context').hidden = false;        // 👁 = 看这次发出去什么
    // 📚 资料库（v0.60.0）：直连模式也能挂了 —— 存单独一份 `_direct.md`，
    // 和角色那一份互不干扰；没放资料时这一轮仍然零注入。
    $('#btn-knowledge').hidden = false;
    $('#btn-knowledge').title = '直连模式的资料库（单独一份，不挂在任何角色上）';
    $('#btn-autospeak').hidden = false;
    $('#btn-websearch').hidden = false;   // 🌐 联网搜索：两种模式都能用
    // 🧠 思考开关：隐藏与否交给 updateThinkButton（按模型能力判断）
    $('#btn-presend').hidden = true;      // 🎲 预选只对角色模式有效
    $('#btn-suggest').hidden = true;      // 🙋 同上
    $('#btn-branch').hidden = false;      // 🌿 其他分支：两种模式都能用
    updateBranchButton();
    updateThinkButton();
    // 💬 常用语：直连模式唯一会注入的一段（没填就还是零提示词），标题上直接写清楚当前状态
    const ph = phrasesInfo();
    const phraseCount = ph.text ? ph.text.split(/[\n,，、;；]+/).map((s) => s.trim()).filter(Boolean).length : 0;
    $('#btn-direct-phrases').hidden = false;
    $('#btn-direct-phrases').title = phraseCount
      ? `常用语 ${phraseCount} 条 · 出现频率 ${ph.level}/10（点这里改）`
      : '常用语：直连默认零提示词，这里可以加一组口头禅 + 出现频率';
    updateAutoSpeakButton();
    updateWebSearchButton();
    updatePlaceholder();
    updateSendState();   // 🖼 附图按钮在直连模式是禁用的，切模式后要重新判定
    return;
  }
  const character = state.characters.find((c) => c.id === state.activeCharacterId);
  if (!character) {
    $('#chat-avatar').innerHTML = '?';
    $('#chat-name').textContent = '选择一个角色开始';
    $('#chat-tagline').textContent = '从左侧角色列表里挑一个，或者新建一个';
    $('#btn-clear').hidden = true;
    $('#btn-edit-character').hidden = true;
    $('#btn-context').hidden = true;
    $('#btn-knowledge').hidden = true;
    $('#btn-autospeak').hidden = true;
    $('#btn-websearch').hidden = true;
    $('#btn-think').hidden = true;
    $('#btn-presend').hidden = true;
    $('#btn-suggest').hidden = true;
    $('#btn-branch').hidden = true;
    $('#btn-direct-phrases').hidden = true;
    updatePlaceholder();
    updateSendState();
    return;
  }
  $('#chat-avatar').innerHTML = avatarMark(character);
  $('#chat-name').textContent = character.name;
  $('#chat-tagline').textContent = character.tagline || '开始聊天吧';
  $('#btn-clear').hidden = false;
  $('#btn-edit-character').hidden = false;
  $('#btn-context').hidden = false;
  $('#btn-knowledge').hidden = false;
  $('#btn-autospeak').hidden = false;
  $('#btn-websearch').hidden = false;
  $('#btn-presend').hidden = false;         // 🎲 预选回复：先演 4 版再挑
  $('#btn-suggest').hidden = false;         // 🙋 该我说什么：帮我起个头
  $('#btn-branch').hidden = false;          // 🌿 其他分支：换掉上一条回复
  updateBranchButton();                     // 开关开着就保持 .is-on 高亮
  // 🧠 思考开关：隐藏与否交给 updateThinkButton（按模型能力判断）
  updateThinkButton();
  $('#btn-direct-phrases').hidden = true;   // 常用语是直连模式的东西；角色用角色卡的「常用词」
  updateAutoSpeakButton();
  updateWebSearchButton();
  updatePlaceholder();
  updateSendState();   // 🖼 附图按钮在直连模式是禁用的，切回角色模式要重新判定
}

function updateStatusLine() {
  const line = $('#status-line');
  const ver = state.config.version ? ` · v${state.config.version}` : '';
  line.textContent = (state.config.hasApiKey
    ? `已配置 Key · ${state.config.model}`
    : '未配置 API Key') + ver;
  line.style.color = state.config.hasApiKey ? 'var(--accent-2)' : 'var(--danger)';
}

/* ---------- 数据刷新 ---------- */
async function refreshConfig() {
  state.config = await api('/api/config');
  const el = $('#app-version');
  if (el) el.textContent = state.config.version ? `v${state.config.version}` : '未知';
  // 日常强化评分条：开关状态一改就要立刻生效（v1.9.4 修 —— 之前 __rlSync 定义了却从没调用，
  // 导致 rl.enabled 永远是 false，评分条一直 hidden）
  if (typeof window.__rlSync === 'function') window.__rlSync();
}

async function refreshCharacters() {
  const { characters } = await api('/api/characters');
  state.characters = characters;
  renderCharacters();
}

async function refreshSessions() {
  const { sessions } = await api('/api/sessions');
  state.sessions = sessions;
  renderSessions();
}

// 改了会话（发送/撤回/改写/重生成）之后刷新当前模式该刷的那份列表。
async function refreshCurrentMode() {
  if (state.mode === 'direct') await refreshDirectSessions();
  else await refreshSessions();
}

/* ---------- 同步：导出 / 导入 ---------- */
function exportBackup() {
  // 直接下载 /api/export 返回的文件（服务端带了 Content-Disposition）。
  window.location.href = '/api/export';
  toast('已开始下载备份文件');
}

async function importBackup(file) {
  let bundle;
  try {
    bundle = JSON.parse(await file.text());
  } catch {
    toast('这个文件不是有效的 JSON', true);
    return;
  }
  try {
    const r = await api('/api/import', { method: 'POST', body: JSON.stringify(bundle) });
    const c = r.characters || { added: 0, updated: 0 };
    const s = r.sessions || { added: 0, updated: 0 };
    await refreshCharacters();
    await refreshSessions();
    // 当前正在看的会话可能被合并更新了，重新载入一次。
    if (state.activeSessionId) {
      try {
        const { session } = await api(`/api/sessions/${state.activeSessionId}`);
        renderMessages(session.messages);
      } catch {
        /* 会话可能已被删除，忽略 */
      }
    }
    toast(`导入完成：角色 +${c.added} / 更新 ${c.updated}，会话 +${s.added} / 更新 ${s.updated}`);
  } catch (err) {
    toast('导入失败：' + err.message, true);
  }
}

/* ---------- 手机抽屉侧边栏 ---------- */
function setNav(open) {
  document.querySelector('.sidebar').classList.toggle('open', open);
  $('#backdrop').hidden = !open;
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $('#btn-nav').addEventListener('click', () => {
    setNav(!document.querySelector('.sidebar').classList.contains('open'));
  });
  $('#backdrop').addEventListener('click', () => setNav(false));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-settings-cancel').addEventListener('click', () => ($('#settings-modal').hidden = true));
  $('#settings-form').addEventListener('submit', submitSettings);
  $('#settings-form').temperature.addEventListener('input', (e) => ($('#temp-out').textContent = e.target.value));
  $('#settings-form').castSpeakChance?.addEventListener('input', (e) => {
    const out = $('#cast-chance-out');
    if (out) out.textContent = `${e.target.value}%`;
  });

  // 应用内切模型：本机模型列表点「用这个」直接切；「切回云端」还原上次的云端配置
  $('#local-models').addEventListener('click', (e) => {
    const btn = e.target.closest('.lm-btn');
    if (btn && btn.dataset.model) switchToLocalModel(btn.dataset.model, btn.dataset.backend || '', btn.dataset.baseurl || '');
  });
  $('#local-models-refresh').addEventListener('click', loadLocalModels);
  $('#local-models-filter')?.addEventListener('input', () => {
    // 只在已经加载过时本地重绘，避免每敲一个字都打一次 Ollama
    if ($('#local-models')?.querySelector('.lm-row')) loadLocalModels();
  });
  $('#cloud-back-btn').addEventListener('click', switchToCloud);
  wireAuthSettings();
  wireBranchPanel();
  $('#export-training-btn')?.addEventListener('click', exportTraining);

  $('#btn-export').addEventListener('click', exportBackup);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) await importBackup(file);
    e.target.value = '';
  });

  $('#btn-new-character').addEventListener('click', () => openCharacterModal());
  $('#cast-enabled')?.addEventListener('change', syncCastUi);
  $('#cast-add')?.addEventListener('click', () => addCastRow());
  $('#btn-character-cancel').addEventListener('click', () => ($('#character-modal').hidden = true));
  $('#character-form').addEventListener('submit', submitCharacter);

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`));
      // 切到「直连」就把主区域也切过去：接着上次那个直连会话，没有就先只准备输入框
      if (tab.dataset.tab === 'direct') enterDirectMode();
      if (tab.dataset.tab === 'script') renderScriptList();
      // 星野面板：第一次切过来时懒加载一次（之后由任务完成/注册/移除自己刷新）。
      if (tab.dataset.tab === 'xingye') enterXingyeTab();
    });
  });

  // 会话列表 →「🧠」训练：先卸载 Ollama 腾显存，再把这个会话交给 QLoRA
  // ⚠ 必须定义在使用之前：const 有 TDZ，写在后面会让 bindEvents 抛 ReferenceError，
  //   整个初始化就断了（页面上角色/会话/直连全空）。
  const sessionTrainHandler = (e) => {
    const btn = e.target.closest('[data-train]');
    if (!btn) return;
    e.stopPropagation();
    trainFromSession(btn.dataset.train, btn);
  };
  $('#session-list').addEventListener('click', sessionTrainHandler, true);

  // 会话列表 →「⬇」导出聊天记录：角色会话和直连会话共用一套按钮/处理
  const sessionExportHandler = (e) => {
    const btn = e.target.closest('[data-export]');
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();
    exportChatLog(btn.dataset.export);
  };
  $('#session-list').addEventListener('click', sessionExportHandler, true);
  $('#direct-list').addEventListener('click', sessionExportHandler, true);

  // 手写素材面板
  $('#btn-new-script')?.addEventListener('click', newScript);
  $('#script-list')?.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-script-open]');
    if (open) { e.stopPropagation(); openScriptEditor(open.dataset.scriptOpen); return; }
    const del = e.target.closest('[data-script-del]');
    if (del) {
      e.stopPropagation();
      if (!confirm('删掉这份素材？')) return;
      await api('/api/script/delete', { method: 'POST', body: JSON.stringify({ id: del.dataset.scriptDel }) }).catch(() => {});
      renderScriptList();
      return;
    }
    const li = e.target.closest('[data-script]');
    if (li) openScriptEditor(li.dataset.script);
  });
  $('#direct-list').addEventListener('click', sessionTrainHandler, true);

  // 直连模式：新会话 / 打开 / 删除
  $('#btn-new-direct').addEventListener('click', () => newDirectSession());
  $('#direct-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) return removeDirectSession(del.dataset.del);
    const item = e.target.closest('.session-item');
    if (item) openDirectSession(item.dataset.id);
  });

  $('#character-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) return removeCharacter(del.dataset.del);
    const edit = e.target.closest('[data-edit]');
    if (edit) return editCharacter(edit.dataset.edit);
    const item = e.target.closest('.card-item');
    if (item) selectCharacter(item.dataset.id);
  });

  // 聊天头部：随时改当前角色的人设（不用回侧栏、不打断对话）。
  $('#btn-edit-character').addEventListener('click', () => editCharacter(state.activeCharacterId));

  // 查看这次会发给模型的上下文
  $('#btn-context').addEventListener('click', openContext);
  $('#btn-knowledge').addEventListener('click', openKnowledge);
  // 常用语（直连模式）：口头禅 + 出现频率，实时预览真正会注入的那一段
  $('#btn-direct-phrases').addEventListener('click', openPhrases);
  $('#phrases-save').addEventListener('click', savePhrases);
  $('#phrases-cancel').addEventListener('click', () => { $('#phrases-modal').hidden = true; });
  $('#phrases-clear').addEventListener('click', () => { $('#phrases-text').value = ''; queuePhrasesPreview(); });
  $('#phrases-level').addEventListener('input', queuePhrasesPreview);
  $('#phrases-text').addEventListener('input', queuePhrasesPreview);
  $('#know-save').addEventListener('click', saveKnowledgeText);
  $('#know-cancel').addEventListener('click', () => ($('#know-modal').hidden = true));
  $('#know-clear').addEventListener('click', () => {
    $('#know-shared').value = '';
    $('#know-text').value = '';
    updateKnowCount();
  });
  $('#know-preview').addEventListener('click', previewKnowledge);
  $('#know-text').addEventListener('input', updateKnowCount);
  $('#know-shared').addEventListener('input', updateKnowCount);
  $('#tts-test').addEventListener('click', testTts);
  $('#cfg-dims-save').addEventListener('click', saveGlobalDefaults);
  // 系统提示词编辑区（v1.6.0）：字数、填入默认、清空
  const rulesEl = $('#cfg-rules');
  if (rulesEl) {
    rulesEl.addEventListener('input', (e) => {
      const n = $('#cfg-rules-count');
      if (n) n.textContent = `${e.target.value.length} / 8000`;
    });
  }
  const rulesFill = $('#cfg-rules-fill');
  if (rulesFill) {
    rulesFill.addEventListener('click', () => {
      const el = $('#cfg-rules');
      if (!el) return;
      el.value = state.defaultRulesText || '';
      const n = $('#cfg-rules-count');
      if (n) n.textContent = `${el.value.length} / 8000`;
      toast('已填入内置默认规则，改完记得保存');
    });
  }
  $('#datadir-open')?.addEventListener('click', openDataDir);
  $('#datadir-copy')?.addEventListener('click', copyDataDir);
  const rulesClear = $('#cfg-rules-clear');
  if (rulesClear) {
    rulesClear.addEventListener('click', () => {
      const el = $('#cfg-rules');
      if (!el) return;
      el.value = '';
      const n = $('#cfg-rules-count');
      if (n) n.textContent = '0 / 8000';
    });
  }
  $('#cfg-hint').addEventListener('input', (e) => {
    $('#cfg-hint-count').textContent = `${e.target.value.length} / 500`;
  });
  $('#btn-autospeak').addEventListener('click', toggleAutoSpeak);
$('#btn-think').addEventListener('click', toggleThink);
  $('#btn-presend').addEventListener('click', preSendCandidates);
  $('#btn-suggest').addEventListener('click', suggestUserReply);
  $('#btn-websearch')?.addEventListener('click', toggleWebSearch);
  $('#websearch-test')?.addEventListener('click', testWebSearch);
  $('#btn-ollama-on').addEventListener('click', () => ollamaAction('on'));
  // 「不关闭」和「2 分钟」是同一个按钮来回切
  $('#btn-ollama-keep').addEventListener('click', () => {
    const forever = state.ollama?.keepAlive === -1;
    ollamaAction(forever ? 'auto' : 'keep');
  });
  $('#btn-ollama-free').addEventListener('click', () => ollamaAction('free'));
  $('#btn-ollama-preload').addEventListener('click', () => ollamaAction('preload'));
  refreshOllama();   // 进页面时先问一次：在不在跑、现在是不是常驻
  $('#ctx-close').addEventListener('click', () => ($('#context-modal').hidden = true));
  $('#ctx-copy').addEventListener('click', copyContext);

  $('#session-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) return removeSession(del.dataset.del);
    const item = e.target.closest('.session-item');
    if (item) openSession(item.dataset.id);
  });

  $('#btn-clear').addEventListener('click', () => {
    // 直连模式：再开一个直连会话；角色模式：新开一段角色对话
    if (state.mode === 'direct') {
      if (confirm('开一个新的直连对话？当前会话会保留在「直连」标签里。')) newDirectSession();
      return;
    }
    if (confirm('开始一段新的对话？当前会话会保留在「会话」标签里。')) newSession();
  });

  // 消息上的「编辑 / 重新生成 / 已否决 / 撤回」——用事件委托，重绘后依然有效。
  $('#messages').addEventListener('click', (e) => {
    const btn = e.target.closest('.msg-act');
    if (!btn) return;
    const index = Number(btn.dataset.index);
    if (btn.dataset.act === 'recall') recallFrom(index);
    else if (btn.dataset.act === 'edit') startEdit(index);
    else if (btn.dataset.act === 'regen') regenerate();
    else if (btn.dataset.act === 'cands') quickCandidates(index);
    else if (btn.dataset.act === 'veto') renderVeto(index);
    else if (btn.dataset.act === 'dims') openDims();
    else if (btn.dataset.act === 'speak') speakMessage(index, btn);
    else if (btn.dataset.act === 'think') toggleReasoning(btn.closest('.msg'));
  });

  // 维度图：点格子 / 加减档 / 删维度 / 加维度
  $('#dims-rows').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-set],[data-delta],[data-remove]');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if (btn.dataset.set !== undefined) setDimLevel(i, Number(btn.dataset.set));
    else if (btn.dataset.delta !== undefined) setDimLevel(i, (state.dims[i]?.level || 0) + Number(btn.dataset.delta));
    else if (btn.dataset.remove !== undefined) {
      if ((state.dims || []).length <= 1) { toast('至少留一个维度', true); return; }
      state.dims.splice(i, 1);
      renderDims();
    }
  });
  const addDim = () => {
    const input = $('#dims-new-name');
    const name = input.value.trim().slice(0, 8);
    if (!name) { input.focus(); return; }
    if ((state.dims || []).some((d) => d.name === name)) { toast('这个维度已经有了', true); return; }
    if ((state.dims || []).length >= 10) { toast('最多 10 个维度', true); return; }
    state.dims.push({ name, level: 3 });
    input.value = '';
    renderDims();
  };
  $('#dims-add-btn').addEventListener('click', addDim);
  $('#dims-new-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addDim(); }
  });
  $('#dims-apply').addEventListener('click', applyDims);
  $('#dims-off').addEventListener('click', turnDimsOff);
  $('#dims-close').addEventListener('click', () => { $('#dims-modal').hidden = true; });
  $('#dims-hint').addEventListener('input', updateHintCount);
  $('#dims-hint-once').addEventListener('change', (e) => { state.hintOnce = e.target.checked; });

  // 场景备忘：边打边存（防抖），失焦时立刻存
  $('#dims-memo').addEventListener('input', queueSaveMemo);
  $('#dims-memo').addEventListener('blur', () => { clearTimeout(state.memoTimer); saveMemo(); });
  // 字数上限：改完立刻存（影响下一次生成，不用重新生成）
  $('#dims-maxchars').addEventListener('change', async (e) => {
    const v = Math.max(0, Math.min(2000, Math.floor(Number(e.target.value) || 0)));
    e.target.value = String(v);
    state.maxChars = v;
    try {
      // 直连模式写 directMaxChars，角色模式写全局 maxChars
      await api('/api/config', {
        method: 'PUT',
        body: JSON.stringify(state.dimsDirect ? { directMaxChars: v } : { maxChars: v }),
      });
      toast(v ? `字数上限定为 ${v} 字（超出会在句号处截断）` : '已取消字数上限');
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#memo-clear').addEventListener('click', async () => {
    $('#dims-memo').value = '';
    updateMemoCount();
    await saveMemo();
    toast('场景备忘已清空');
  });

  // 提示预设：点一下填进提示框 / ✕ 删掉 / 把当前这句存成预设
  $('#preset-list').addEventListener('click', (e) => {
    const use = e.target.closest('[data-use]');
    if (use) {
      const text = state.hintPresets[Number(use.dataset.use)] || '';
      const box = $('#dims-hint');
      box.value = box.value.trim() ? `${box.value.trim()}；${text}` : text;
      updateHintCount();
      box.focus();
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) removePreset(Number(del.dataset.del));
  });
  $('#preset-save').addEventListener('click', savePreset);

  // 弹窗里的「用这版」
  $('#veto-body').addEventListener('click', (e) => {
    const tagBtn = e.target.closest('[data-tag]');
    if (tagBtn) {
      const on = tagBtn.dataset.on === '1';
      tagRejected(Number(tagBtn.dataset.index), Number(tagBtn.dataset.tag), tagBtn.dataset.key, on);
      return;
    }
    const btn = e.target.closest('[data-adopt]');
    if (!btn) return;
    adoptRejected(Number(btn.dataset.index), Number(btn.dataset.adopt));
  });
  $('#veto-close').addEventListener('click', () => { $('#veto-modal').hidden = true; });

  const input = $('#input');
  attachAutoPair(input);
  input.addEventListener('input', () => { autoResize(); updateSendState(); syncSlashPop(); });
  /* ---------- 日常强化评分（v1.9.0） ----------
   * 只记录：按 w 在本轮分数上 +0.5/-0.5（0~3），回车提交。
   * 提交后 POST /api/rl/label，后台把「这一轮喂给模型的消息 + 被评的回复 + w」写进
   * rl-labels/YYYY-MM-DD.jsonl。不改模型、不触发训练。 */
  const rl = { active: false, w: 1.5, enabled: false, submittedAt: 0, readyAt: 0 };
  const RL_STEP = 0.5, RL_MIN = 0, RL_MAX = 3;
  const clampW = (v) => Math.min(RL_MAX, Math.max(RL_MIN, Math.round(v / RL_STEP) * RL_STEP));
  const wText = (w) => `w=${w.toFixed(1)}`;
  const wLabel = (w) => (w >= 3 ? '完美' : w >= 2 ? '很好' : w >= 1.5 ? '不错' : w >= 1 ? '一般' : w > 0 ? '较差' : '很差');

  function syncRlBar() {
    const bar = $('#rl-bar');
    if (!bar) return;
    bar.hidden = !rl.enabled;
    if (!rl.enabled) return;
    const val = $('#rl-val');
    val.textContent = wText(rl.w);
    val.classList.toggle('low', rl.w < 1);
    val.classList.toggle('high', rl.w >= 2);
    $('#rl-submit').disabled = !rl.active || state.streaming || Boolean(rl.submittedAt);
    $('#rl-hint').textContent = rl.submittedAt
      ? `本轮已记（${wText(rl.w)}）`
      : (rl.active ? '按 w 调分 · 回车提交' : '生成完一轮后才能评分');
  }
  function resetRlTurn() {
    rl.active = false; rl.submittedAt = 0; rl.w = 1.5; rl.readyAt = 0;
    syncRlBar();
  }
  async function submitRlLabel() {
    if (!rl.enabled || !rl.active || state.streaming || rl.submittedAt) return;
    const sid = state.activeSessionId;
    if (!sid) return;
    const msgs = state.messages || [];
    const last = [...msgs].reverse().find((m) => m && m.role === 'assistant' && m.at);
    const body = { sessionId: sid, w: rl.w };
    if (last?.at) body.messageAt = last.at;
    try {
      const r = await api('/api/rl/label', { method: 'POST', body: JSON.stringify(body) });
      rl.submittedAt = Date.now();
      const st = r.stats || {};
      toast(`已记录 ${wText(rl.w)}（${wLabel(rl.w)}）· 累计 ${st.count ?? 0} 条`);
      syncRlBar();
    } catch (err) {
      toast(`评分没记上：${err.message}`, true);
    }
  }
  $('#rl-inc')?.addEventListener('click', () => { rl.w = clampW(rl.w + RL_STEP); syncRlBar(); });
  $('#rl-dec')?.addEventListener('click', () => { rl.w = clampW(rl.w - RL_STEP); syncRlBar(); });
  $('#rl-submit')?.addEventListener('click', submitRlLabel);
  // 设置保存后同步开关状态（submitSettings 里也会调一次）
  let __rlLastLog = '';
  window.__rlSync = () => {
    rl.enabled = Boolean(state.config?.rlEnabled);
    const k = `sync:${rl.enabled}`;
    if (k !== __rlLastLog) { __rlLastLog = k; console.log('[rl] sync enabled =', rl.enabled); }
    syncRlBar();
  };
  window.__rlSyncBar = () => syncRlBar();
  window.__rlOnMessages = (messages) => {
    // v1.9.9：每次都从 config 里重新读开关 —— 依赖"boot 时同步过一次"太脆弱
    //（实测 __rlSync 在时序上可能没跑到，rl.enabled 就一直是 false，评分条永远 hidden）
    rl.enabled = Boolean(state.config?.rlEnabled);
    const k2 = `msgs:${rl.enabled}:${messages?.length}`;
    if (k2 !== __rlLastLog) { __rlLastLog = k2; console.log('[rl] onMessages enabled =', rl.enabled, '| msgs =', messages?.length); }
    if (!rl.enabled) { syncRlBar(); return; }
    const msgs = Array.isArray(messages) ? messages : [];
    const lastAssist = [...msgs].reverse().find((m) => m && m.role === 'assistant');
    const lastAny = msgs[msgs.length - 1];
    // 只有「最后一条就是角色回复」且这条还没被打过分，才允许评分
    const can = Boolean(lastAssist && lastAny === lastAssist);
    if (!can) { resetRlTurn(); return; }
    const wasActive = rl.active;
    // v2.1.1：**改写过的消息可以重新评分** —— 内容变了，上一版的分数就不适用了。
    // 判断依据：这条被评过（有 rl），但之后又被改写（editedAt > rl.at）→ 允许重新打。
    const editedAfterLabel = lastAssist.rl && lastAssist.rl.w !== undefined
      && Number(lastAssist.editedAt || 0) > Number(lastAssist.rl.at || 0);
    if (lastAssist.rl && lastAssist.rl.w !== undefined && !editedAfterLabel) {
      rl.active = true; rl.w = clampW(Number(lastAssist.rl.w) || 0); rl.submittedAt = lastAssist.rl.at || 1;
    } else {
      rl.active = true; rl.submittedAt = 0;
      // 改写后重新评分：从上一次的分数继续调（不用从 1.5 重来）
      if (editedAfterLabel) rl.w = clampW(Number(lastAssist.rl.w) || 1.5);
    }
    // v1.9.6：新一轮评分刚可用时给 1.5 秒静默期 ——
    // 否则「发消息时按的回车」恰好落在流式结束之后，会把评分直接提交掉（实测踩到）。
    if (!wasActive) rl.readyAt = Date.now() + 1500;
    syncRlBar();
  };

  input.addEventListener('keydown', (e) => {
    // 「/ 选回答者」的列表开着时，方向键 / 回车 / Esc 归列表用，别把消息发出去。
    if (slash.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (slash.items.length) applySlash(slash.index);
        else closeSlash();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // 日常强化：刚生成完、输入框还空着时，回车 = 提交这一轮的评分。
      // v1.9.6：要求 ①过了 1.5 秒静默期 ②事件确实来自输入框（不是别的地方冒泡过来的），
      // 否则「发消息按的那个回车」会在流式结束后把评分直接提交掉。
      const rlReady = rl.enabled && rl.active && !rl.submittedAt && !state.streaming
        && !input.value.trim() && Date.now() >= rl.readyAt && e.target === input;
      if (rlReady) {
        submitRlLabel();
        return;
      }
      if (!state.streaming) $('#composer').requestSubmit();
    }
    // 日常强化：输入框空着时按 w / W 调分（不打断打字）
    if ((e.key === 'w' || e.key === 'W') && rl.enabled && rl.active && !rl.submittedAt
        && !input.value.trim() && !e.ctrlKey && !e.metaKey && !e.altKey
        && Date.now() >= rl.readyAt && e.target === input) {
      e.preventDefault();
      rl.w = clampW(rl.w + (e.shiftKey ? -RL_STEP : RL_STEP));
      syncRlBar();
    }
  });
  // v1.9.8：评分条的键盘兜底 —— 焦点万一不在输入框（比如刚点过消息、或点了别处），
  // 只要评分条活着，w / Shift+w / 回车 依然生效。输入框内的按键在上面已经处理过，这里跳过。
  document.addEventListener('keydown', (e) => {
    if (!rl.enabled || !rl.active || rl.submittedAt || state.streaming) return;
    if (Date.now() < rl.readyAt) return;
    if (e.target === input) return;              // 输入框内已处理
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing) return;                          // 在别的输入框里打字时别抢
    const idle = !input.value.trim();
    if (!idle) return;                           // 输入框里有字：别把回车当成"提交评分"
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitRlLabel();
      return;
    }
    if ((e.key === 'w' || e.key === 'W') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      rl.w = clampW(rl.w + (e.shiftKey ? -RL_STEP : RL_STEP));
      syncRlBar();
    }
  });

  // 点到别处就收起列表（列表里的 mousedown 自己会 preventDefault，不受影响）
  document.addEventListener('mousedown', (e) => {
    if (!slash.open) return;
    if ($('#slash-pop')?.contains(e.target) || e.target === input) return;
    closeSlash();
  });

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.streaming) return stopStreaming();
    sendMessage(input.value);
  });

  // 📷 识图：选一张图 → 本地视觉模型给一段描述 → 插进输入框
  $('#btn-vision').addEventListener('click', () => {
    if ($('#btn-vision').disabled) return;
    $('#vision-file').click();
  });
  $('#vision-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';        // 清掉，否则连着选同一张图不会再触发 change
    describePickedImage(file);
  });

  // 🖼 附图：选一张图挂到下一条消息上（跟文字一起发，角色能"看见"）
  $('#btn-attach').addEventListener('click', () => {
    if ($('#btn-attach').disabled) return;
    $('#attach-file').click();
  });
  $('#attach-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    attachPickedImage(file);
  });
  $('#attach-clear').addEventListener('click', clearPendingImage);

  // 弹窗点空白处关闭（删除确认除外：必须明确点「取消」或「确认删除」）
  document.querySelectorAll('.modal-mask').forEach((mask) => {
    if (mask.id === 'confirm-modal') return;
    mask.addEventListener('click', (e) => {
      if (e.target === mask) mask.hidden = true;
    });
  });

  // 删除确认
  $('#confirm-cancel').addEventListener('click', () => closeConfirm(false));
  $('#confirm-ok').addEventListener('click', () => closeConfirm(true));
  $('#confirm-type-input').addEventListener('input', (e) => {
    $('#confirm-ok').disabled = e.target.value.trim() !== '删除';
  });
  $('#confirm-type-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('#confirm-ok').disabled) closeConfirm(true);
  });

  // 星野面板（抓取 / 搜索 / 已抓管理）：定义在本文件末尾，函数声明会提升，可直接调用。
  bindXingyeEvents();
  // 图片头像 404 时回退文字首字（只注册一次；监听 document，兼容后续动态重绘）。
  bindAvatarFallback();
}

/* ---------- 输入框「/」：以对话里谁的身份发这条（v1.2.2） ---------- */
// 列表取的是**这个对话里的人物**（多人卡的 cast / 老卡的【人物】标记），不是别的角色卡。
// 选中后不插正文，而是变成输入框右侧的胶囊（带 ✕）：这条消息**以那个人物的身份**发出去，
// 模型只演其他人物。请求体里带 as: { name }，发完自动取消。
let asPick = null;   // { name }
const slash = { open: false, items: [], index: 0, start: -1, query: '', single: null };

function refreshAsChip() {
  const box = $('#composer-chips');
  if (!box) return;
  box.innerHTML = '';
  if (!asPick) { box.hidden = true; return; }
  const chip = document.createElement('span');
  chip.className = 'speaker-chip';
  chip.title = `以「${asPick.name}」的身份发送这条消息（发完自动取消）`;
  const av = document.createElement('span');
  av.className = 'chip-avatar';
  // 本会话人物表只有名字，没有头像 → 用名字首字（和群聊里的 cast-name 一个习惯）
  av.textContent = avatarFallbackChar(asPick.name);
  const name = document.createElement('span');
  name.className = 'chip-name';
  name.textContent = asPick.name;
  const hint = document.createElement('span');
  hint.className = 'chip-hint';
  hint.textContent = '身份发送';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'chip-x';
  x.title = '取消：还是以我自己的身份发送';
  x.textContent = '✕';
  x.addEventListener("click", clearAsPick);
  chip.append(av, name, hint, x);
  box.append(chip);
  box.hidden = false;
}

function setAsPick(person) {
  asPick = person && person.name ? { name: person.name } : null;
  refreshAsChip();
}

function clearAsPick() {
  if (!asPick) return;
  asPick = null;
  refreshAsChip();
}

// 光标前是不是一个 / 命令（纯逻辑在 public/slashpick.js，冒烟测试盯着它）
function currentSlashTrigger() {
  const el = $('#input');
  if (!el || state.mode === 'direct' || state.shutDown) return null;
  return slashTrigger(el.value, el.selectionStart ?? el.value.length);
}

function syncSlashPop() {
  const trig = currentSlashTrigger();
  if (!trig) { if (slash.open) closeSlash(); return; }
  if (!slash.open || slash.query !== trig.query) slash.index = 0;
  const chr = state.characters.find((c) => c.id === state.activeCharacterId);
  const speakers = conversationSpeakers(chr);
  slash.open = true;
  slash.start = trig.start;
  slash.query = trig.query;
  // 只有一个人物的对话没得选：列表里给一句说明，不提供可选项
  slash.single = speakers.length < 2 ? (speakers[0]?.name || '') : null;
  slash.items = slash.single ? [] : filterCharacters(speakers, trig.query);
  if (slash.index >= slash.items.length) slash.index = 0;
  renderSlashPop();
}

function closeSlash() {
  slash.open = false;
  slash.items = [];
  slash.index = 0;
  const pop = $('#slash-pop');
  if (pop) pop.hidden = true;
}

function renderSlashPop() {
  const pop = $('#slash-pop');
  if (!pop) return;
  if (!slash.open) { pop.hidden = true; return; }
  pop.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'slash-head';
  head.textContent = '以谁的身份说这句？（↑↓ 选，Enter 确认）';
  pop.append(head);
  if (slash.single) {
    const empty = document.createElement('div');
    empty.className = 'slash-empty';
    empty.textContent = `这个对话里只有「${slash.single}」一个人物，没有别的身份可选`;
    pop.append(empty);
  } else if (!slash.items.length) {
    const empty = document.createElement('div');
    empty.className = 'slash-empty';
    empty.textContent = '没有匹配的人物';
    pop.append(empty);
  } else {
    slash.items.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'slash-item' + (i === slash.index ? ' active' : '');
      item.dataset.index = String(i);
      const av = document.createElement('span');
      av.className = 'slash-avatar';
      av.textContent = avatarFallbackChar(c.name);
      const text = document.createElement('span');
      text.className = 'slash-text';
      const name = document.createElement('span');
      name.className = 'slash-name';
      name.textContent = c.name;
      const tag = document.createElement('span');
      tag.className = 'slash-tag';
      tag.textContent = c.desc || '这个对话里的人物';
      text.append(name, document.createElement('br'), tag);
      item.append(av, text);
      // mousedown 而不是 click：click 之前输入框会先 blur，列表可能已经关了
      item.addEventListener('mousedown', (e) => { e.preventDefault(); applySlash(i); });
      item.addEventListener('mouseenter', () => {
        slash.index = i;
        pop.querySelectorAll('.slash-item').forEach((el, j) => el.classList.toggle('active', j === i));
      });
      pop.append(item);
    });
  }
  // 定位：贴在输入框正上方（输入框可能被多行撑高，所以按实时位置算）
  const rect = $('#input').getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${Math.max(8, rect.top - pop.offsetHeight - 8)}px`;
}

function moveSlash(delta) {
  if (!slash.open || !slash.items.length) return;
  slash.index = (slash.index + delta + slash.items.length) % slash.items.length;
  const pop = $('#slash-pop');
  pop.querySelectorAll('.slash-item').forEach((el, j) => el.classList.toggle('active', j === slash.index));
  pop.querySelector('.slash-item.active')?.scrollIntoView({ block: 'nearest' });
}

// 确认某个人：把输入框里那段 "/查询词" 擦掉，改挂成胶囊
function applySlash(i) {
  const c = slash.items[i];
  if (!c) return;
  const el = $('#input');
  const pos = el.selectionStart ?? el.value.length;
  const caret = slash.start;
  el.value = el.value.slice(0, slash.start) + el.value.slice(pos);
  el.setSelectionRange(caret, caret);
  closeSlash();
  setAsPick(c);
  autoResize();
  updateSendState();
  el.focus();
}

/* ---------- 启动 ---------- */
async function boot() {
  bindEvents();
  try {
    await refreshConfig();
    await refreshWorkGuard();
    updateStatusLine();
    if (!state.config.hasApiKey) {
      toast('首次使用请点右上角 ⚙ 填写 API Key', false);
    }
    await refreshCharacters();
    await refreshSessions();
    await refreshDirectSessions();
    // 默认选中第一个角色
    if (state.characters.length) {
      selectCharacter(state.characters[0].id);
    }
  } catch (err) {
    toast('加载失败：' + err.message, true);
  }
  // 锁状态每秒重画一次倒计时，每 30 秒跟服务端对一次表。
  setInterval(tickWorkGuard, 1000);
  setInterval(refreshWorkGuard, 30000);
}

boot();

/* ---------- 会话级训练（🧠 按钮） ---------- */
let trainTimer = null;

async function trainFromSession(sessionId, btn) {
  const ok = window.confirm(
    '把这个会话加进训练队列？\n\n' +
    '· 导出这个会话的对话（3072 token）\n' +
    '· 自动清洗：剔除跳时间旁白、过短回复、重复句\n' +
    '· 有被否决的回复时，SFT 之后自动接 DPO\n' +
    '· 加入「待开始」队列，前面的训练跑完才轮到它\n' +
    '· 队列项可以随时取消（点面板里的 ✕）\n\n继续？'
  );
  if (!ok) return;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const out = await api('/api/train/session', {
      method: 'POST',
      body: JSON.stringify({ sessionId, maxTokens: 3072, epochs: 3, lr: 8e-5, weights: readWeights() }),
    });
    const c = out.item?.clean;
    toast(`已入队 · ${out.item?.stat?.turns || 0} 轮` + (c ? ` → 清洗后 ${c.output} 条` : '') + (out.item?.pairCount ? ` · DPO ${out.item.pairCount} 组` : ''));
    openTrainPanel(true);
    pollTrain(true);
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🧠'; }
  }
}

/**
 * 候选挑选面板：一次生成 N 条回答，点「就这条」采纳，其余自动变负样本。
 */
function openCandidatePanel(payload) {
  let box = document.getElementById('cand-panel');
  if (!box) {
    box = document.createElement('div');
    box.id = 'cand-panel';
    document.body.appendChild(box);
  }
  box.hidden = false;
  box.innerHTML = `
    <div class="cand-head">
      <b>🎲 候选回答</b>
      <span>${escapeHtml(payload.character || '')} · 共 ${payload.candidates.length} 条 · 模型 ${escapeHtml(payload.model || '')}</span>
      <span style="flex:1"></span>
      <button type="button" class="btn-ghost btn-tiny" id="cand-close">关闭</button>
    </div>
    <div class="cand-list">
      ${payload.candidates.map((c, i) => `
        <div class="cand-item" data-i="${i}">
          <div class="cand-body">${escapeHtml(c.text)}</div>
          <div class="cand-actions">
            <span class="cand-meta">#${i + 1} · temp ${c.temp ?? ''}</span>
            <button type="button" class="btn-primary btn-tiny cand-pick" data-i="${i}">就这条</button>
          </div>
        </div>`).join('')}
    </div>
    <div class="cand-foot">选项：点「就这条」采纳为<b>标准回答</b>，其余 ${payload.candidates.length - 1} 条自动记为<b>负样本</b>（用于 DPO）</div>`;
  box.querySelector('#cand-close').addEventListener('click', () => { box.hidden = true; });
  box.querySelector('.cand-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.cand-pick');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if (!window.confirm(`采纳第 ${i + 1} 条？其余 ${payload.candidates.length - 1} 条会成为负样本。`)) return;
    btn.disabled = true;
    btn.textContent = '采纳中…';
    try {
      const r = await api('/api/gold/choose', {
        method: 'POST',
        body: JSON.stringify({ groupId: payload.groupId, index: i, character: payload.character }),
      });
      // 视觉上标记：选中的高亮，其余打叉
      box.querySelectorAll('.cand-item').forEach((el, k) => {
        el.classList.add(k === i ? 'cand-picked' : 'cand-rejected');
        const b = el.querySelector('.cand-pick');
        if (b) { b.disabled = true; b.textContent = k === i ? '✓ 已采纳' : '✕ 已否决'; }
      });
      toast('已采纳（其余记为负样本）');
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = '就这条';
    }
  });
  return box;
}

/**
 * 样本加权：你亲手改的 / 从候选里挑中的回答，训练时多学几遍。
 * 默认 3 / 2 —— 比这更夸张（比如 8）模型会开始背这些句子。
 */
const WEIGHT_KEY = 'xingye.weights.v1';
function readWeights() {
  const d = { edited: 3, adopted: 2 };
  try {
    const raw = JSON.parse(localStorage.getItem(WEIGHT_KEY) || '{}');
    for (const k of ['edited', 'adopted']) {
      const n = Math.round(Number(raw[k]));
      if (Number.isFinite(n) && n >= 1) d[k] = Math.min(12, n);
    }
  } catch { /* 忽略坏数据 */ }
  return d;
}
function writeWeights(w) {
  try { localStorage.setItem(WEIGHT_KEY, JSON.stringify(w)); } catch { /* 隐私模式 */ }
}
function currentWeights() {
  const p = $('#train-panel');
  const g = (id, dflt) => {
    const el = p && p.querySelector('#' + id);
    const n = Math.round(Number(el?.value));
    return Number.isFinite(n) ? Math.max(1, Math.min(12, n)) : dflt;
  };
  return { edited: g('tw-edited', 5), adopted: g('tw-adopted', 2) };
}
function weightBadge(it) {
  const w = it.weights || {};
  const parts = [];
  if (Number(w.edited) > 1) parts.push(`✍️×${w.edited}`);
  if (Number(w.adopted) > 1) parts.push(`🎲×${w.adopted}`);
  if (!parts.length) return '';
  const out = it.weightStat ? ` → ${it.weightStat.output} 条` : '';
  return ` · ${parts.join(' ')}${out}`;
}

function openTrainPanel(force = false) {
  let panel = $('#train-panel');
  // 重建策略：
  //   force=true（用户主动打开 / 页面版本号变了）→ 重建，保证新按钮出现
  //   否则（每 2 秒的轮询）→ 复用现有 DOM，避免打断日志滚动和按钮点击
  const ver = 'v7';   // 改了面板结构就 +1
  if (panel && (force || panel.dataset.ver !== ver)) { panel.remove(); panel = null; }
  if (panel) { panel.hidden = false; return panel; }
  panel = document.createElement('div');
  panel.id = 'train-panel';
  panel.dataset.ver = ver;
  panel.innerHTML = `
    <div class="train-head">
      <b>🧠 训练中</b>
      <span id="train-status">准备…</span>
      <span style="flex:1"></span>
      <button type="button" class="btn-ghost btn-tiny" id="train-cands" title="生成多个候选回答，挑一个作为标准回答">🎲 生成候选</button>
      <button type="button" class="btn-ghost btn-tiny" id="train-gold" title="用标准回答库训练">⭐ 大模式</button>
      <button type="button" class="btn-ghost btn-tiny" id="train-stop">停止</button>
      <button type="button" class="btn-ghost btn-tiny" id="train-close">收起</button>
    </div>
    <div class="train-weights">
      <span class="tw-label" title="你亲手改过的回答 / 从候选里挑中的回答，会比其他样本多学几遍">加权</span>
      <label>✍️ 手改 ×<input type="number" id="tw-edited" min="1" max="12" step="1" value="5"></label>
      <label>🎲 挑一版 ×<input type="number" id="tw-adopted" min="1" max="12" step="1" value="2"></label>
      <span class="tw-note" id="tw-note"></span>
    </div>
    <div id="train-queue" class="train-queue"></div>
    <pre id="train-log"></pre>`;
  document.body.appendChild(panel);
  panel.querySelector('#train-close').addEventListener('click', () => { panel.hidden = true; });
  // 权重的读写：存 localStorage，下次打开还在
  const wIn = { edited: panel.querySelector('#tw-edited'), adopted: panel.querySelector('#tw-adopted') };
  const saved = readWeights();
  wIn.edited.value = String(saved.edited);
  wIn.adopted.value = String(saved.adopted);
  for (const k of ['edited', 'adopted']) {
    wIn[k].addEventListener('change', () => {
      const n = Math.max(1, Math.min(12, Math.round(Number(wIn[k].value) || 1)));
      wIn[k].value = String(n);
      writeWeights(currentWeights());
    });
  }
  const noteEl = panel.querySelector('#tw-note');
  if (noteEl) noteEl.textContent = '手改/挑一版会把这条多学几遍；原始输出固定 ×1';
  const candBtn = panel.querySelector('#train-cands');
  if (candBtn && !candBtn.dataset.bound) {
    candBtn.dataset.bound = '1';
    candBtn.addEventListener('click', async () => {
      const sessionId = state.activeSessionId || state.activeDirectId;
      if (!sessionId) { toast('先打开一个会话', true); return; }
      const n = window.prompt('生成几个候选？（2–8）', '4');
      if (n === null) return;
      candBtn.disabled = true;
      const old = candBtn.textContent;
      candBtn.textContent = '生成中…';
      try {
        const r = await api('/api/gold/generate', { method: 'POST', body: JSON.stringify({ sessionId, n: Number(n) || 4 }) });
        openCandidatePanel(r);
      } catch (e) { toast(e.message, true); }
      finally { candBtn.disabled = false; candBtn.textContent = old; }
    });
  }

  const goldBtn = panel.querySelector('#train-gold');
  if (goldBtn && !goldBtn.dataset.bound) {
    goldBtn.dataset.bound = '1';
    goldBtn.addEventListener('click', async () => {
      const minScore = window.prompt('用 ≥ 多少分的标准回答训练？（8 推荐 / 9 更精 / 7 更宽松）', '8');
      if (minScore === null) return;
      goldBtn.disabled = true;
      const old = goldBtn.textContent;
      goldBtn.textContent = '入队中…';
      try {
        const r = await api('/api/train/gold', {
        method: 'POST',
        body: JSON.stringify({ minScore: Number(minScore) || 8, epochs: 4, weights: currentWeights() }),
      });
        toast(`大模式已入队：SFT ${r.sft} 条 + DPO ${r.dpo} 组`);
        pollTrain();
      } catch (e) { toast(e.message, true); }
      finally { goldBtn.disabled = false; goldBtn.textContent = old; }
    });
  }

  panel.querySelector('#train-stop').addEventListener('click', async () => {
    try { await api('/api/train/stop', { method: 'POST' }); toast('已请求停止'); } catch (e) { toast(e.message, true); }
  });
  return panel;
}

async function pollTrain(force = false) {
  if (trainTimer) clearTimeout(trainTimer);
  let running = true;
  try {
    const st = await api('/api/train/status');
    const panel = openTrainPanel(force);
    const stEl = panel.querySelector('#train-status');
    const logEl = panel.querySelector('#train-log');
    const qBox = panel.querySelector('#train-queue');
    if (qBox && st.queue) {
      const LI = { queued: '⏳ 待开始', running: '▶ 训练中', done: '✅ 完成', error: '❌ 失败', canceled: '⏹ 已取消' };
      qBox.innerHTML = st.queue.items.map((it) => {
        const canCancel = it.status === 'queued' || it.status === 'running';
        const canRemove = it.status !== 'running';
        return `<div class="tq-item tq-${it.status}">
          <span class="tq-state">${LI[it.status] || it.status}</span>
          <span class="tq-title">${escapeHtml(it.title)}</span>
          <span class="tq-meta">${it.stat ? it.stat.turns + ' 轮' : ''}${it.pairCount ? ' · DPO ' + it.pairCount + ' 组' : ''}${it.step ? ' · ' + it.step : ''}${it.phase && it.status === 'running' ? ' · <b class="tq-phase">' + it.phase + '</b>' : ''}${weightBadge(it)}</span>
          ${canCancel ? `<button class="btn-ghost btn-tiny tq-cancel" data-cancel="${it.id}" title="取消">✕</button>` : ''}
          ${canRemove ? `<button class="btn-ghost btn-tiny tq-remove" data-remove="${it.id}" title="移除">🗑</button>` : ''}
        </div>`;
      }).join('') || '<div class="tq-empty">队列为空</div>';
    }
    const label = { starting: '启动中…', training: '训练中', done: '✅ 完成', error: '❌ 出错', stopped: '⏹ 已停止' }[st.status] || st.status || '';
    stEl.textContent = `${label}${st.step ? ' · ' + st.step : ''}`;
    if (st.log) {
      const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
      logEl.textContent = st.log;
      if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    }
    running = st.running;
    if (!running && st.status === 'done') toast('训练完成：' + (st.outPath || ''));
    if (!running && st.status === 'error') toast('训练出错，看面板日志', true);
  } catch { /* 服务重启时忽略 */ }
  if (running) trainTimer = setTimeout(pollTrain, 2000);
}

// 设置页「导出训练数据」
async function exportTraining() {
  const btn = $('#export-training-btn');
  const box = $('#export-training-result');
  const dl = $('#export-training-dl');
  if (!btn) return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '统计中…';
  try {
    const d = await api('/api/export-training?maxTokens=3072');
    box.innerHTML = `<div class="lm-empty"><b>${d.sampleCount}</b> 条训练样本 · <b>${d.negativeCount}</b> 条负样本 · 长度中位 ${d.stat.tokMedian} token</div>`;
    dl.hidden = false;
    toast(`可导出 ${d.sampleCount} 条样本`);
  } catch (e) {
    box.innerHTML = `<div class="lm-empty">${escapeHtml(e.message)}</div>`;
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ---------- 快速修改：从某条回复处生成候选 ---------- */
/**
 * 在某条角色回复的位置上生成 4 个候选：
 *   · 选一个  → 替换本条内容，选中的进标准库，其余 3 个记为负样本
 *   · 直接关掉 → 4 个全部记为负样本（你都不想用）
 */
/**
 * 发送前预选：把**你还没发出去的话**喂给角色，让它先演 4 个版本，挑一个再发。
 *
 * 和「🎲 挑一版」的区别：那个是替换已经聊过的某条回复（会进标准库当训练数据）；
 * 这个是**发之前**先看看它可能怎么回，挑好的那条直接当作他这次的回复。
 * 不调 /api/gold/choose —— 预览阶段的东西不该污染训练数据。
 */
async function preSendCandidates() {
  const input = $('#input');
  const content = String(input.value || '').trim();
  if (!content) { toast('先输入想说的一句话', true); input.focus(); return; }
  if (state.mode === 'direct') {
    toast('预选暂不支持直连模式（直连不经过角色卡，没法构造角色上下文）', true);
    return;
  }
  // 预览页（刚点进角色、还没开始记录）还没有会话文件：先自动建一个再演
  if (!state.activeSessionId) {
    await newSession();
    if (!state.activeSessionId) { toast('先选一个角色', true); return; }
  }
  const sessionId = state.activeSessionId;

  const btn = $('#btn-presend');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '…';
  toast('正在让角色演 4 个版本…');
  try {
    const r = await api('/api/chat/presend', {
      method: 'POST',
      body: JSON.stringify({ sessionId, content, n: 4 }),
    });
    openPreSendPanel(r.candidates, content);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function openPreSendPanel(cands, content) {
  let box = document.getElementById('presend-panel');
  if (!box) {
    box = document.createElement('div');
    box.id = 'presend-panel';
    document.body.appendChild(box);
  }
  box.hidden = false;
  let settled = false;

  box.innerHTML = `
    <div class="cand-head">
      <b>🎲 挑一个回复</b>
      <span>你说：${escapeHtml(content.slice(0, 40))}${content.length > 40 ? '…' : ''}</span>
      <span style="flex:1"></span>
      <button type="button" class="btn-ghost btn-tiny" id="prs-close">关闭</button>
    </div>
    <div class="cand-list">
      ${cands.map((c, i) => `
        <div class="cand-item" data-i="${i}">
          <div class="cand-body">${escapeHtml(c.text)}</div>
          <div class="cand-actions">
            <span class="cand-meta">#${i + 1} · temp ${c.temp ?? ''}</span>
            <button type="button" class="btn-primary btn-tiny prs-pick" data-i="${i}">用这条发送</button>
          </div>
        </div>`).join('')}
    </div>
    <div class="cand-foot">选中 = 先发出你那句话，再把这一版直接当他的回复（不再重新生成）</div>`;

  const finish = async (picked) => {
    if (settled) return;
    settled = true;
    box.hidden = true;
    if (picked === null) return;
    const text = cands[picked].text;
    // 带 pinnedReply 发送：服务端**不调模型**，直接把这一版落盘并回放。
    // 比「先正常生成再替换」省掉一整轮推理（5~15 秒），也不会白烧一次 GPU。
    try {
      await sendMessage(content, { pinnedReply: text });
    } catch (e) {
      toast(e.message, true);
    }
  };

  box.querySelector('#prs-close').onclick = () => finish(null);
  box.querySelector('.cand-list').onclick = (e) => {
    const b = e.target.closest('.prs-pick');
    if (!b) return;
    const i = Number(b.dataset.i);
    box.querySelectorAll('.cand-item').forEach((el, k) => el.classList.add(k === i ? 'cand-picked' : 'cand-rejected'));
    box.querySelectorAll('.prs-pick').forEach((x) => { x.disabled = true; });
    finish(i);
  };
  const onBackdrop = (e) => { if (e.target === box) { document.removeEventListener('click', onBackdrop, true); finish(null); } };
  document.addEventListener('click', onBackdrop, true);
}

/**
 * 🙋「该我说什么」：让模型**反过来扮演你**，根据角色刚说的话给 4 个可回的候选。
 *
 * 和 🎲 预选的区别：
 *   🎲 预选：你已经想好要说什么 → 先看看它怎么回
 *   🙋 这个：你不知道说什么    → 让它给你几个方向
 *
 * 点一个 = 填进输入框（不直接发），你还能改两个字再发。
 */
async function suggestUserReply() {
  if (state.mode === 'direct') {
    toast('这个功能只对角色模式有效', true);
    return;
  }
  if (state.streaming) { toast('等它这次说完', true); return; }
  // 预览页还没有会话：先建一个，再基于开场白给候选
  if (!state.activeSessionId) {
    await newSession();
    if (!state.activeSessionId) { toast('先选一个角色', true); return; }
  }
  const sessionId = state.activeSessionId;

  const btn = $('#btn-suggest');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '…';
  toast('正在想你可以怎么回…');
  try {
    const r = await api('/api/chat/suggest', {
      method: 'POST',
      body: JSON.stringify({ sessionId, n: 4 }),
    });
    openSuggestPanel(r.candidates);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function openSuggestPanel(cands) {
  let box = document.getElementById('suggest-panel');
  if (!box) {
    box = document.createElement('div');
    box.id = 'suggest-panel';
    document.body.appendChild(box);
  }
  box.hidden = false;
  let settled = false;

  box.innerHTML = `
    <div class="cand-head">
      <b>🙋 你可以这么说</b>
      <span>点一个填进输入框（还能改），不想用就关掉</span>
      <span style="flex:1"></span>
      <button type="button" class="btn-ghost btn-tiny" id="sug-close">关闭</button>
    </div>
    <div class="cand-list">
      ${cands.map((c, i) => `
        <div class="cand-item" data-i="${i}">
          <div class="cand-body">${escapeHtml(c.text)}</div>
          <div class="cand-actions">
            <span class="cand-meta">#${i + 1} · ${c.text.length} 字</span>
            <button type="button" class="btn-primary btn-tiny sug-pick" data-i="${i}">用这句</button>
          </div>
        </div>`).join('')}
    </div>
    <div class="cand-foot">这条不发送、不训练 —— 只是填进输入框给你起个头</div>`;

  const finish = (picked) => {
    if (settled) return;
    settled = true;
    box.hidden = true;
    if (picked === null) return;
    const input = $('#input');
    input.value = cands[picked].text;
    autoResize();
    updateSendState();
    input.focus();
    // 光标放到末尾，方便接着改
    input.setSelectionRange(input.value.length, input.value.length);
  };

  box.querySelector('#sug-close').onclick = () => finish(null);
  box.querySelector('.cand-list').onclick = (e) => {
    const b = e.target.closest('.sug-pick');
    if (!b) return;
    const i = Number(b.dataset.i);
    box.querySelectorAll('.cand-item').forEach((el, k) => el.classList.add(k === i ? 'cand-picked' : 'cand-rejected'));
    finish(i);
  };
  // 点在面板**外面**就关（box-shadow 伪造的遮罩不在 DOM 里，e.target 仍是 body）
  const onBackdrop = (e) => {
    if (box.contains(e.target)) return;
    document.removeEventListener('click', onBackdrop, true);
    finish(null);
  };
  setTimeout(() => document.addEventListener('click', onBackdrop, true), 0);
}

async function quickCandidates(index) {
  const sessionId = state.mode === 'direct' ? state.activeDirectId : state.activeSessionId;
  if (!sessionId) { toast('先打开一个会话', true); return; }
  const session = state.sessions.find((x) => x.id === sessionId)
    || state.directSessions.find((x) => x.id === sessionId);
  // 上下文截止到这条回复之前（含它前面那条 user）
  const endIndex = index;
  toast('正在生成 4 个候选…');
  try {
    const r = await api('/api/gold/generate', {
      method: 'POST',
      body: JSON.stringify({ sessionId, n: 4, endIndex }),
    });
    openQuickCandidatePanel(r, index, sessionId);
  } catch (e) {
    toast(e.message, true);
  }
}

function openQuickCandidatePanel(payload, msgIndex, sessionId) {
  let box = document.getElementById('cand-panel');
  if (!box) {
    box = document.createElement('div');
    box.id = 'cand-panel';
    document.body.appendChild(box);
  }
  box.hidden = false;
  box.dataset.groupId = payload.groupId;
  box.dataset.msgIndex = String(msgIndex);
  box.dataset.sessionId = sessionId;
  let settled = false;

  box.innerHTML = `
    <div class="cand-head">
      <b>🎲 挑一个替换这条</b>
      <span>共 ${payload.candidates.length} 个候选 · 选中的进标准库，其余记为负样本</span>
      <span style="flex:1"></span>
      <button type="button" class="btn-ghost btn-tiny" id="cand-close">关闭（全部否决）</button>
    </div>
    <div class="cand-list">
      ${payload.candidates.map((c, i) => `
        <div class="cand-item" data-i="${i}">
          <div class="cand-body">${escapeHtml(c.text)}</div>
          <div class="cand-actions">
            <span class="cand-meta">#${i + 1}</span>
            <button type="button" class="btn-primary btn-tiny cand-pick" data-i="${i}">用这个</button>
          </div>
        </div>`).join('')}
    </div>
    <div class="cand-foot">直接关闭 = ${payload.candidates.length} 个全部否决（都会记为负样本）</div>`;

  const finish = async (pickedIndex) => {
    if (settled) return;
    settled = true;
    try {
      if (pickedIndex !== null) {
        // 采纳：进标准库 + 替换本条消息 + 其余进负样本
        await api('/api/gold/choose', {
          method: 'POST',
          body: JSON.stringify({ groupId: payload.groupId, index: pickedIndex, character: payload.character }),
        });
        const chosen = payload.candidates[pickedIndex].text;
        await replaceMessage(msgIndex, chosen, '候选替换');
        toast('已替换（其余 3 个已记为负样本）');
      } else {
        // 全部否决
        await api('/api/gold/reject-all', {
          method: 'POST',
          body: JSON.stringify({ groupId: payload.groupId }),
        });
        toast(`${payload.candidates.length} 个候选已全部否决`);
      }
    } catch (e) {
      toast(e.message, true);
    }
    box.hidden = true;
  };

  box.querySelector('#cand-close').onclick = () => finish(null);
  box.querySelector('.cand-list').onclick = (e) => {
    const b = e.target.closest('.cand-pick');
    if (!b) return;
    const i = Number(b.dataset.i);
    box.querySelectorAll('.cand-item').forEach((el, k) => {
      el.classList.add(k === i ? 'cand-picked' : 'cand-rejected');
    });
    box.querySelectorAll('.cand-pick').forEach((x) => { x.disabled = true; });
    finish(i);
  };
  // 点遮罩也当作"全部否决"
  const onBackdrop = (e) => {
    if (box.contains(e.target)) return;
    document.removeEventListener('click', onBackdrop, true);
    finish(null);
  };
  setTimeout(() => document.addEventListener('click', onBackdrop, true), 0);
}

/** 用新文本替换第 index 条消息（旧内容自动进「已否决」，可随时换回）。 */
async function replaceMessage(index, text, reason) {
  const sessionId = state.mode === 'direct' ? state.activeDirectId : state.activeSessionId;
  try {
    // 先用 PATCH edit 改内容（服务端会把旧版本记进 rejected）
    await api(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'edit', index, content: text }),
    });
  } catch (e) {
    toast('替换失败：' + e.message, true);
    return;
  }
  if (state.mode === 'direct') await openDirectSession(sessionId);
  else await openSession(sessionId);
}

/* ============================================================
 * 手写训练素材
 *
 * 需求（作者原话）：「纯手写提示加回复，放在直连后面，发一条自动切换到对面，权重改」。
 * 所以这里是**不调模型的编辑器**：写一句用户说的 → 发送后自动切到角色 → 写角色回复 → …
 * 存下来的东西原样进训练（origin='handwritten'，默认 ×8）。
 * ========================================================== */

const scriptState = { list: [], cur: null, nextRole: 'user' };

async function renderScriptList() {
  const ul = $('#script-list');
  if (!ul) return;
  try {
    const r = await api('/api/script/list');
    scriptState.list = r.scripts || [];
  } catch (e) {
    ul.innerHTML = `<li class="list-empty">读不到素材：${escapeHtml(e.message)}</li>`;
    return;
  }
  if (!scriptState.list.length) {
    ul.innerHTML = '<li class="list-empty">还没有素材。点上面「+ 新素材」开始写。</li>';
    return;
  }
  ul.innerHTML = scriptState.list.map((s) => `
    <li class="list-item" data-script="${s.id}">
      <div class="li-main">
        <div class="li-title">${escapeHtml(s.title)}</div>
        <div class="li-sub">${s.turns} 条 · ${new Date(s.updatedAt || 0).toLocaleString('zh-CN', { hour12: false })}</div>
      </div>
      <div class="li-ops">
        <button class="btn-ghost btn-tiny" data-script-open="${s.id}">编辑</button>
        <button class="btn-ghost btn-tiny" data-script-del="${s.id}">删</button>
      </div>
    </li>`).join('');
}

async function newScript() {
  try {
    const r = await api('/api/script/create', { method: 'POST', body: JSON.stringify({ title: '新素材' }) });
    await renderScriptList();
    openScriptEditor(r.script.id);
  } catch (e) { toast(e.message, true); }
}

async function openScriptEditor(id) {
  let s;
  try {
    s = await api(`/api/script/get?id=${encodeURIComponent(id)}`);
  } catch (e) { toast(e.message, true); return; }
  scriptState.cur = s;
  scriptState.autoGen = s.autoGen !== false;   // 默认开
  // 接着写：上一轮是用户 → 现在写角色；否则写用户
  const last = s.turns[s.turns.length - 1];
  scriptState.nextRole = !last || last.role === 'assistant' ? 'user' : 'assistant';

  let box = $('#script-modal');
  if (!box) {
    box = document.createElement('div');
    box.id = 'script-modal';
    document.body.appendChild(box);
  }
  box.hidden = false;
  box.innerHTML = `
    <div class="script-card">
      <div class="script-head">
        <input id="sc-title" value="${escapeHtml(s.title)}" maxlength="60" placeholder="素材标题">
        <span class="sc-hint">权重 ×8（手写档）</span>
        <button class="btn-ghost btn-tiny" id="sc-close">关闭</button>
      </div>
      <!-- 导入那一行常驻显示：放进折叠区里时，system 有内容就默认收起，
           客户端上完全看不见「导入」按钮（踩过）。 -->
      <div class="sc-sys-bar">
        <select id="sc-char-pick"><option value="">从已有角色导入…</option></select>
        <select id="sc-preset" title="system 的精简程度">
          <option value="lean" selected>精简（推荐）</option>
          <option value="script">手写配比（放开环境/动作）</option>
          <option value="global">跟随全局设置</option>
        </select>
        <button class="btn-ghost btn-tiny" id="sc-char-import">导入角色设定</button>
        <span class="sc-sys-note" id="sc-sys-count"></span>
      </div>
      <details class="sc-sys"${s.system ? '' : ' open'}>
        <summary>角色设定 / system（可空，${(s.system || '').length} 字）</summary>
        <textarea id="sc-system" rows="4" placeholder="留空就不发 system，训练时也不带">${escapeHtml(s.system || '')}</textarea>
      </details>
      <div class="sc-turns" id="sc-turns"></div>
      <div class="sc-compose">
        <div class="sc-gen-bar">
          <label class="sc-gen-auto"><input type="checkbox" id="sc-gen-auto"${scriptState.autoGen === false ? '' : ' checked'}> 自动生成</label>
          <select id="sc-gen-model"></select>
          <button class="btn-ghost btn-tiny" id="sc-gen-run">✨ 生成</button>
          <span class="sc-gen-usage" id="sc-gen-usage"></span>
        </div>
        <div class="sc-role" id="sc-role"></div>
        <textarea id="sc-input" rows="3" placeholder="写这一句…（Enter 发送，Shift+Enter 换行）"></textarea>
        <div class="sc-ops">
          <button class="btn-primary btn-tiny" id="sc-send">发送</button>
          <button class="btn-ghost btn-tiny" id="sc-flip">换个角色</button>
          <button class="btn-ghost btn-tiny" id="sc-undo">撤一句</button>
          <button class="btn-ghost btn-tiny" id="sc-train">用手写素材训练</button>
        </div>
      </div>
    </div>`;
  // 生成用的模型下拉：先放 gemma（llama-server），再列 Ollama 里的模型
  (async () => {
    const sel = $('#sc-gen-model');
    if (!sel) return;
    // 只用 deepseek-flash：v4-pro 是推理模型，思考占 token 又慢，角色扮演没必要
    const opts = [
      { v: 'api::deepseek-flash', t: '☁ deepseek-flash（云端 API）' },
      { v: 'llama::gemma3-12b-heretic', t: '💎 gemma3-12b-heretic（本地）' },
    ];
    try {
      const r = await api('/api/local-models');
      for (const m of (r.models || [])) {
        if (/embedding|reranker/i.test(m.name)) continue;
        opts.push({ v: 'ollama::' + m.name, t: m.name });
      }
    } catch { /* 拿不到就只留 gemma */ }
    const keep = scriptState.genModel || opts[0].v;   // 默认走云端 API，笔力最好
    sel.innerHTML = opts.map((o) => `<option value="${escapeHtml(o.v)}"${o.v === keep ? ' selected' : ''}>${escapeHtml(o.t)}</option>`).join('');
    scriptState.genModel = sel.value;
    sel.onchange = () => { scriptState.genModel = sel.value; };
  })();

  // ✨ 生成下一条：把输入框那句（可空）喂给模型，结果落在下面的输出栏里，带 token 用量
  // ✨ 生成下一条：草稿直接写进**输入框**，全程不用鼠标 ——
  //   Enter 采用 / Tab 重抽 / Esc 清空
  // （原来草稿在上方的输出面板里，要点「采用」按钮 → 手离不开鼠标）
  const runGen = async () => {
    const btn = $('#sc-gen-run');
    const usageEl = $('#sc-gen-usage');
    const input = $('#sc-input');
    const [provider, model] = String(scriptState.genModel || '').split('::');
    if (!model) { toast('先选模型', true); return; }
    const turns = scriptState.cur.turns;
    if (!turns.length || turns[turns.length - 1].role !== 'user') return;

    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    usageEl.textContent = '生成中…';
    usageEl.classList.remove('err');
    try {
      const r = await api('/api/script/generate', {
        method: 'POST',
        body: JSON.stringify({ id: scriptState.cur.id, provider, model }),
      });
      const u = r.usage || {};
      const draft = String(r.text || '').replace(/\s+$/, '');
      // 草稿落到输入框：光标放末尾，直接就能改
      input.value = draft;
      input.focus();
      input.setSelectionRange(draft.length, draft.length);
      scriptState.draftInInput = true;
      input.classList.add('draft');
      usageEl.textContent = `${u.total} tok（${u.prompt}+${u.completion}）`
        + (u.tokPerSec ? ` · ${u.tokPerSec} tok/s` : '')
        + ' · Enter 采用 / Tab 重抽 / Esc 清空';
      renderScriptTurns();
    } catch (e) {
      usageEl.textContent = `失败：${e.message}`;
      usageEl.classList.add('err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✨ 生成'; }
    }
  };
  scriptState.runGen = runGen;
  $('#sc-gen-run').onclick = () => runGen();
  $('#sc-gen-auto').onchange = async (e) => {
    scriptState.autoGen = e.target.checked;
    scriptState.cur.autoGen = e.target.checked;
    await persistScript();
    toast(e.target.checked ? '已开启：发送后自动生成' : '已关闭：只手动写');
  };

  // 角色下拉：打开时异步填
  (async () => {
    try {
      const r = await api('/api/characters');
      const items = Array.isArray(r) ? r : (r.characters || []);
      const sel = $('#sc-char-pick');
      if (sel) sel.innerHTML = '<option value="">从已有角色导入…</option>'
        + items.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    } catch { /* 取不到就只留空选项 */ }
  })();
  $('#sc-char-import').onclick = async () => {
    const id = $('#sc-char-pick')?.value;
    if (!id) { toast('先选一个角色', true); return; }
    try {
      const preset = $('#sc-preset')?.value || 'lean';
      const r = await api(`/api/script/character-system?id=${encodeURIComponent(id)}&preset=${encodeURIComponent(preset)}`);
      const ta = $('#sc-system');
      if (ta.value.trim() && !confirm(`当前设定会被「${r.name}」的覆盖，继续？`)) return;
      ta.value = r.system;
      if (!$('#sc-title').value.trim() || $('#sc-title').value.trim() === '新素材' || $('#sc-title').value.trim() === '未命名') {
        $('#sc-title').value = r.name;
      }
      // 开场白：作为素材的第一条「角色」发言自动插进来（不进 system —— 塞进 system
      // 会让模型每轮都想复述它）。已有的 turns 不动，只在**开头**插。
      let addedGreeting = 0;
      if (r.greeting && String(r.greeting).trim()) {
        const turns = scriptState.cur.turns;
        const hasIt = turns.slice(0, 1).some((t) => t.role === 'assistant' && t.content.trim() === String(r.greeting).trim());
        if (!hasIt) {
          const okAdd = turns.length === 0 || confirm(`这个角色有开场白（${r.greetingChars} 字），插到最前面当第一条？`);
          if (okAdd) {
            turns.unshift({ role: 'assistant', content: String(r.greeting).trim() });
            scriptState.nextRole = 'user';   // 角色先开口，接下来轮到用户
            addedGreeting = 1;
          }
        }
      }
      await persistScript();
      renderScriptTurns();
      const presetName = { lean: '精简', script: '手写配比', global: '全局' }[r.preset] || r.preset;
      toast(`已导入「${r.name}」· ${presetName} system（${r.chars} 字）` + (addedGreeting ? ` + 开场白（${r.greetingChars} 字）` : ''));
    } catch (e) { toast(e.message, true); }
  };

  renderScriptTurns();

  $('#sc-close').onclick = () => { box.hidden = true; renderScriptList(); };
  $('#sc-flip').onclick = () => {
    scriptState.nextRole = scriptState.nextRole === 'user' ? 'assistant' : 'user';
    renderScriptTurns();
    $('#sc-input').focus();
  };
  $('#sc-undo').onclick = async () => {
    if (!scriptState.cur.turns.length) return;
    scriptState.cur.turns.pop();
    const l = scriptState.cur.turns[scriptState.cur.turns.length - 1];
    scriptState.nextRole = !l || l.role === 'assistant' ? 'user' : 'assistant';
    await persistScript();
    renderScriptTurns();
  };
  $('#sc-train').onclick = async () => {
    if (!(await persistScript())) return;
    try {
      const r = await api('/api/train/script', { method: 'POST', body: JSON.stringify({ epochs: 3 }) });
      if (!r.ok) throw new Error(r.error || '加入队列失败');
      toast(`已加入队列：${r.item?.title || ''}（${r.item?.weightStat?.output || '?'} 条，含加权）`);
      box.hidden = true;
      renderScriptList();
    } catch (e) { toast(e.message, true); }
  };
  const send = async () => {
    const t = $('#sc-input').value.trim();
    if (!t) return;
    scriptState.cur.turns.push({ role: scriptState.nextRole, content: t });
    scriptState.nextRole = scriptState.nextRole === 'user' ? 'assistant' : 'user';
    $('#sc-input').value = '';
    scriptState.draftInInput = false;
    $('#sc-gen-usage').textContent = '';
    await persistScript();
    renderScriptTurns();
    // 输完提示词就自动要下一条（可以在上面用「自动生成」关掉）
    if (scriptState.autoGen !== false && scriptState.nextRole === 'assistant') {
      await runGen();
    } else {
      $('#sc-input').focus();
    }
  };
  $('#sc-send').onclick = send;
  $('#sc-input').addEventListener('keydown', (e) => {
    // Tab = 重抽（键盘流：写完提示词 → 自动出草稿 → 不满意直接 Tab 换一版）
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      if (scriptState.cur.turns.length && scriptState.cur.turns[scriptState.cur.turns.length - 1].role === 'user') {
        runGen();
      }
      return;
    }
    // Esc = 清空当前草稿（不采用）
    if (e.key === 'Escape') {
      e.preventDefault();
      $('#sc-input').value = '';
      scriptState.draftInInput = false;
      input.classList.remove('draft');
      $('#sc-gen-usage').textContent = '';
      $('#sc-input').focus();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#sc-input').focus();
}

async function persistScript() {
  const s = scriptState.cur;
  if (!s) return false;
  const title = $('#sc-title')?.value?.trim() || '未命名';
  const system = $('#sc-system')?.value ?? '';
  const autoGen = scriptState.autoGen !== false;
  try {
    const r = await api('/api/script/save', {
      method: 'POST',
      body: JSON.stringify({ script: { ...s, title, system, autoGen } }),
    });
    scriptState.cur = r.script;
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

function renderScriptTurns() {
  const wrap = $('#sc-turns');
  const who = $('#sc-role');
  if (!wrap || !scriptState.cur) return;
  const turns = scriptState.cur.turns;
  wrap.innerHTML = turns.length
    ? turns.map((t, i) => `
      <div class="sc-turn ${t.role}">
        <span class="sc-who">${t.role === 'user' ? '你' : '角色'}</span>
        <span class="sc-text">${escapeHtml(t.content).replace(/\n/g, '<br>')}</span>
        <span class="sc-idx">#${i + 1}</span>
      </div>`).join('')
    : '<div class="sc-empty">还没有内容。下面写第一句（默认从「你」开始）。</div>';
  const cnt = $('#sc-sys-count');
  if (cnt) {
    const n = String(scriptState.cur.system || '').length;
    cnt.textContent = n ? `system ${n} 字` : '还没有设定（可从角色导入）';
  }
  if (who) {
    const auto = scriptState.autoGen !== false;
    who.textContent = scriptState.nextRole === 'user'
      ? '下一条：你' + (auto ? '（写完 Enter，自动生成角色回复）' : '')
      : '下一条：角色' + (auto ? '（正在生成，可 Enter 采用 / Tab 重抽 / Esc 清空）' : '（纯手写）');
    who.className = 'sc-role ' + scriptState.nextRole;
  }
  wrap.scrollTop = wrap.scrollHeight;
}

/* ============================================================================
 * 星野面板（抓取分享链接 / 搜索 / 已抓角色管理）
 * 契约见 xingye-work-art/SPEC.md §5 API、§6 前端结构。
 * 说明：index.html 的结构由 ui 负责，这里所有 DOM 访问都经 xyEl() 守卫 ——
 *      元素缺失时静默跳过，绝不影响现有的角色/会话/聊天/手写逻辑。
 * ========================================================================== */

function xyEl(id) {
  return document.getElementById(id);
}

// 头像：/api/xingye/avatar/123 或 http(s) 图片 → <img>；否则用名字首字（和 avatarMark 同规则）。
function xyAvatarHtml(item, fallbackName) {
  const src = String(item?.avatarUrl || item?.avatar || '').trim();
  const fb = escapeHtml(avatarFallbackChar(fallbackName || item?.name));
  if (isImageAvatar(src)) {
    return `<img class="avatar-img" src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${fb}">`;
  }
  return fb;
}

function xyText(text) {
  return escapeHtml(String(text ?? '')).replace(/\n/g, '<br>');
}

function xyMetaLine(item) {
  const bits = [];
  if (item.personaChars) bits.push(`设定 ${item.personaChars} 字`);
  if (item.greetingChars) bits.push(`开场白 ${item.greetingChars} 字`);
  if (item.source) {
    const label = { share: '分享链接', search: '搜索', id: 'NPC ID' }[item.source] || item.source;
    bits.push(`来源 ${label}`);
  }
  return bits.join(' · ');
}

/* ---------- 已抓列表 ---------- */
function xyItemHtml(item, remote = false) {
  const npc = item.npcId;
  const name = item.name || `星野_${npc}`;
  const registered = Boolean(item.registered);
  let badge = '';
  if (remote) {
    badge = item.fetched
      ? '<span class="xy-badge">已抓取</span>'
      : '<span class="xy-badge mute">未抓取</span>';
  } else if (registered) {
    badge = '<span class="xy-badge ok">已注册</span>';
  }
  const acts = remote
    ? `<button class="xy-mini" data-xy-act="register">注册</button>
       <button class="xy-mini" data-xy-act="detail">详情</button>`
    : `<button class="xy-mini" data-xy-act="register">${registered ? '重新注册' : '注册'}</button>
       <button class="xy-mini" data-xy-act="detail">详情</button>
       <button class="xy-mini danger" data-xy-act="remove">移除</button>`;
  return `<li class="xy-item" data-npc="${escapeHtml(String(npc))}" data-source="${remote ? 'remote' : 'local'}">
    <div class="xy-avatar">${xyAvatarHtml(item, name)}</div>
    <div class="xy-info">
      <div class="xy-name">${escapeHtml(name)} ${badge}</div>
      <div class="xy-tagline">${escapeHtml(item.tagline || item.desc || '（没有简介）')}</div>
      <div class="xy-meta">${escapeHtml(xyMetaLine(item))}</div>
    </div>
    <div class="xy-item-acts">${acts}</div>
  </li>`;
}

function renderXingyeList() {
  const list = xyEl('xy-list');
  if (!list) return;
  const xy = state.xingye;
  const all = xy.cards;
  const q = String(xy.filter || '').trim().toLowerCase();
  const items = q
    ? all.filter((c) => `${c.name || ''} ${c.tagline || ''}`.toLowerCase().includes(q))
    : all;
  list.innerHTML = items.length ? items.map((c) => xyItemHtml(c)).join('') : '';

  const empty = xyEl('xy-empty');
  if (empty) {
    if (!all.length) {
      empty.hidden = false;
      empty.innerHTML = '还没有抓取过星野角色<br><span>粘贴分享链接开始</span>';
    } else if (!items.length) {
      empty.hidden = false;
      empty.innerHTML = '没有匹配的已抓角色<br><span>换个关键词试试</span>';
    } else {
      empty.hidden = true;
    }
  }
  const count = xyEl('xy-count');
  if (count) count.textContent = q ? `${items.length} / ${all.length}` : String(all.length);
  const title = xyEl('xy-list-title');
  if (title) {
    const reg = xy.stats?.registered || 0;
    title.textContent = reg ? `已抓取的星野角色（已注册 ${reg}）` : '已抓取的星野角色';
  }
}

async function refreshXingye({ silent = false } = {}) {
  const xy = state.xingye;
  if (xy.refreshing) return;
  xy.refreshing = true;
  try {
    const [status, cards] = await Promise.all([
      api('/api/xingye/status').catch(() => null),
      api('/api/xingye/cards?limit=200'),
    ]);
    if (status?.stats) xy.stats = status.stats;
    xy.cards = Array.isArray(cards?.items) ? cards.items : [];
    xy.loaded = true;
    renderXingyeList();
  } catch (err) {
    if (!silent) toast('星野列表加载失败：' + err.message, true);
  } finally {
    xy.refreshing = false;
  }
}

// 切到星野 tab：第一次懒加载；之后只重绘（数据在注册/任务完成后会自己刷新）。
function enterXingyeTab() {
  renderXingyeList();
  if (!state.xingye.loaded && !state.xingye.refreshing) refreshXingye();
}

/* ---------- 搜索 ---------- */
function renderXingyeResults(items, keyword = '') {
  const xy = state.xingye;
  xy.results = Array.isArray(items) ? items : [];
  const list = xyEl('xy-results');
  const head = xyEl('xy-results-head');
  if (head) {
    head.hidden = false;
    const label = head.querySelector('span');
    if (label) {
      label.textContent = keyword
        ? `搜索结果 · ${xy.results.length} 个${keyword ? `（${keyword}）` : ''}`
        : `搜索结果 · ${xy.results.length} 个`;
    }
  }
  if (!list) return;
  list.hidden = false;
  list.innerHTML = xy.results.length
    ? xy.results.map((i) => xyItemHtml(i, true)).join('')
    : '<li class="item-sub" style="padding:8px 4px">没有找到相关角色，换个关键词试试</li>';
}

function clearXingyeResults() {
  const xy = state.xingye;
  xy.results = [];
  const list = xyEl('xy-results');
  if (list) { list.hidden = true; list.innerHTML = ''; }
  const head = xyEl('xy-results-head');
  if (head) head.hidden = true;
  const input = xyEl('xy-search-input');
  if (input) input.value = '';
}

async function xingyeSearch() {
  const xy = state.xingye;
  if (xy.searching) return;
  const input = xyEl('xy-search-input');
  const keyword = String(input?.value || '').trim();
  if (!keyword) {
    toast('先输入要搜索的角色名或标签', true);
    input?.focus();
    return;
  }
  xy.searching = true;
  const btn = xyEl('xy-search-btn');
  const label = btn?.textContent || '搜索';
  if (btn) { btn.disabled = true; btn.textContent = '搜索中…'; }
  try {
    const r = await api('/api/xingye/search', {
      method: 'POST',
      body: JSON.stringify({ query: keyword }),
    });
    const items = Array.isArray(r?.items) ? r.items : [];
    renderXingyeResults(items, keyword);
    if (!items.length) toast(`没搜到「${keyword}」相关的星野角色`);
  } catch (err) {
    toast('搜索失败：' + err.message, true);
  } finally {
    xy.searching = false;
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

/* ---------- 导入分享链接（弹窗 + 任务） ---------- */
function openXingyeLinks() {
  const modal = xyEl('xy-links-modal');
  if (!modal) { toast('导入弹窗还没准备好', true); return; }
  modal.hidden = false;
  setTimeout(() => xyEl('xy-links-text')?.focus(), 30);
}

function closeXingyeLinks() {
  const modal = xyEl('xy-links-modal');
  if (modal) modal.hidden = true;
}

async function startXingyeLinks() {
  const xy = state.xingye;
  if (xy.jobStarting) return;
  const text = String(xyEl('xy-links-text')?.value || '').trim();
  if (!text) {
    toast('先粘贴星野分享链接或整段分享文案', true);
    xyEl('xy-links-text')?.focus();
    return;
  }
  const autoRegister = xyEl('xy-links-autoreg')?.checked ?? true;
  const downloadAvatar = xyEl('xy-links-avatar')?.checked ?? true;
  const btn = xyEl('xy-links-start');
  xy.jobStarting = true;
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/xingye/job', {
      method: 'POST',
      body: JSON.stringify({ mode: 'links', links: text, autoRegister, downloadAvatar }),
    });
    closeXingyeLinks();
    startPollingXingyeJob(r.jobId, 'links');
    toast('已开始抓取，进度看星野面板');
  } catch (err) {
    toast('开始抓取失败：' + err.message, true);
  } finally {
    xy.jobStarting = false;
    if (btn) btn.disabled = false;
  }
}

/* ---------- 任务进度（700ms 轮询） ---------- */
function stopXingyeJobPolling() {
  const xy = state.xingye;
  if (xy.jobTimer) {
    clearTimeout(xy.jobTimer);
    xy.jobTimer = null;
  }
}

function startPollingXingyeJob(jobId, mode = 'links') {
  if (!jobId) return;
  const xy = state.xingye;
  stopXingyeJobPolling();
  xy.jobId = jobId;
  const box = xyEl('xy-job');
  if (box) box.hidden = false;
  const title = xyEl('xy-job-title');
  if (title) title.textContent = mode === 'ids' ? '抓取指定角色…' : '抓取中…';
  const count = xyEl('xy-job-count');
  if (count) count.textContent = '0/0';
  const bar = xyEl('xy-progress-bar');
  if (bar) bar.style.width = '4%';
  const log = xyEl('xy-log');
  if (log) log.innerHTML = '<div class="xy-log-line info">已提交任务，等待进度…</div>';
  pollXingyeJob(jobId); // 立刻拉一次，不等 700ms
}

function renderXingyeJob(job) {
  const box = xyEl('xy-job');
  if (box) box.hidden = false;
  const p = job?.progress || { done: 0, total: 0, ok: 0, fail: 0, registered: 0 };
  const title = xyEl('xy-job-title');
  if (title) {
    let t = job?.mode === 'ids' ? '抓取指定角色…' : '导入分享链接…';
    if (job?.status === 'done') t = '抓取完成';
    else if (job?.status === 'error') t = '抓取出错';
    title.textContent = t;
  }
  const count = xyEl('xy-job-count');
  if (count) {
    const detail = [];
    if (p.ok || p.fail) detail.push(`成功 ${p.ok || 0}`, `失败 ${p.fail || 0}`);
    if (p.registered) detail.push(`已注册 ${p.registered}`);
    count.textContent = `${p.done || 0}/${p.total || 0}${detail.length ? ' · ' + detail.join(' · ') : ''}`;
  }
  const bar = xyEl('xy-progress-bar');
  if (bar) {
    let pct = p.total ? Math.round((p.done / p.total) * 100) : (job?.status === 'running' ? 6 : 0);
    if (job?.status === 'done') pct = 100;
    bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  const log = xyEl('xy-log');
  if (log) {
    const entries = Array.isArray(job?.log) ? job.log : [];
    log.innerHTML = entries.map((e) => `<div class="xy-log-line ${escapeHtml(e.level || 'info')}">${escapeHtml(e.msg || '')}</div>`).join('');
    log.scrollTop = log.scrollHeight; // 永远滚到底，最新一条可见
  }
}

async function pollXingyeJob(jobId) {
  const xy = state.xingye;
  if (xy.jobId !== jobId) return; // 已被新任务接管
  stopXingyeJobPolling();
  let job;
  try {
    job = await api(`/api/xingye/job/${encodeURIComponent(jobId)}`);
  } catch (err) {
    if (xy.jobId !== jobId) return;
    xy.jobId = null;
    const title = xyEl('xy-job-title');
    if (title) title.textContent = '任务状态读取失败';
    const log = xyEl('xy-log');
    if (log) {
      log.insertAdjacentHTML('beforeend', `<div class="xy-log-line err">${escapeHtml(err.message)}</div>`);
      log.scrollTop = log.scrollHeight;
    }
    toast('抓取任务状态读取失败：' + err.message, true);
    return;
  }
  if (xy.jobId !== jobId) return;
  renderXingyeJob(job);
  if (job?.status === 'done') {
    xy.jobId = null;
    const p = job.progress || {};
    const parts = [`抓取完成：成功 ${p.ok || 0}`];
    if (p.fail) parts.push(`失败 ${p.fail}`);
    if (p.registered) parts.push(`注册了 ${p.registered} 个角色`);
    toast(parts.join(' · '));
    await refreshXingye({ silent: true });
    try { await refreshCharacters(); } catch { /* 星野任务不影响聊天页可用性 */ }
    return;
  }
  if (job?.status === 'error') {
    xy.jobId = null;
    toast('抓取出错：' + (job.error || '未知错误'), true);
    await refreshXingye({ silent: true });
    try { await refreshCharacters(); } catch { /* 同上 */ }
    return;
  }
  xy.jobTimer = setTimeout(() => pollXingyeJob(jobId), 700);
}

/* ---------- 注册 / 移除 ---------- */
async function xingyeRegister(npcIds, fromRemote = false) {
  const xy = state.xingye;
  if (xy.registering) return;
  const ids = (Array.isArray(npcIds) ? npcIds : [npcIds]).map(Number).filter((n) => Number.isFinite(n));
  if (!ids.length) return;
  xy.registering = true;
  try {
    if (fromRemote) {
      // 远程搜索结果没有本地角色卡：走 ids 任务（先抓取，再按 autoRegister 注册）。
      const r = await api('/api/xingye/job', {
        method: 'POST',
        body: JSON.stringify({ mode: 'ids', ids, autoRegister: true }),
      });
      startPollingXingyeJob(r.jobId, 'ids');
      toast('已提交抓取，抓完自动注册');
      return;
    }
    const r = await api('/api/xingye/register', {
      method: 'POST',
      body: JSON.stringify({ npcIds: ids }),
    });
    const created = Array.isArray(r?.created) ? r.created.length : 0;
    const skipped = Array.isArray(r?.skipped) ? r.skipped : [];
    if (created) {
      toast(`已注册 ${created} 个角色` + (skipped.length ? `（跳过 ${skipped.length} 个）` : ''));
    } else if (skipped.length) {
      const reasons = [...new Set(skipped.map((s) => s.reason).filter(Boolean))].join(' / ');
      toast(`没有新角色可注册（跳过 ${skipped.length} 个${reasons ? '：' + reasons : ''}）`);
    } else {
      toast('没有可注册的角色');
    }
    await refreshXingye({ silent: true });
    if (created) {
      try { await refreshCharacters(); } catch { /* 忽略 */ }
    }
  } catch (err) {
    toast('注册失败：' + err.message, true);
  } finally {
    xy.registering = false;
  }
}

async function xingyeRemove(npcId) {
  const item = xingyeFindItem(npcId) || {};
  const name = item.name || `星野_${npcId}`;
  const ok = confirm(
    `移除「${name}」的星野抓取记录？\n\n` +
    '只会删除本地保存的抓取记录（角色卡 + 头像），' +
    '不会删除已经注册到角色列表里的角色，也不影响已有会话。'
  );
  if (!ok) return;
  try {
    await api(`/api/xingye/cards/${encodeURIComponent(npcId)}`, { method: 'DELETE' });
    toast(`已移除「${name}」的抓取记录`);
    if (String(state.xingye.detailNpc) === String(npcId)) closeXingyeDetail();
    await refreshXingye({ silent: true });
  } catch (err) {
    toast('移除失败：' + err.message, true);
  }
}

/* ---------- 详情弹窗 ---------- */
function xingyeFindItem(npcId) {
  const id = String(npcId);
  return (
    state.xingye.cards.find((c) => String(c.npcId) === id) ||
    state.xingye.results.find((c) => String(c.npcId) === id) ||
    null
  );
}

function xyDetailSection(label, content) {
  const text = String(content || '').trim();
  if (!text) return '';
  // class 同时覆盖 ui 既有样式（.xy-detail-sec > b / .xy-detail-text）与语义命名。
  return `<div class="xy-detail-sec xy-detail-section">
    <b class="xy-detail-label">${escapeHtml(label)}</b>
    <div class="xy-detail-text">${xyText(text)}</div>
  </div>`;
}

function renderXingyeDetail(item, card, note = '') {
  const body = xyEl('xy-detail-body');
  if (!body) return;
  const name = item.name || `星野_${item.npcId}`;
  const registered = Boolean(item.registered);
  let badge = '';
  if (registered) badge = '<span class="xy-badge ok">已注册</span>';
  else if (state.xingye.detailRemote) badge = '<span class="xy-badge mute">未抓取</span>';
  else badge = '<span class="xy-badge">未注册</span>';
  const metaBits = [];
  if (item.personaChars) metaBits.push(`设定 ${item.personaChars} 字`);
  if (item.greetingChars) metaBits.push(`开场白 ${item.greetingChars} 字`);
  if (item.fetchedAt) {
    const d = new Date(item.fetchedAt);
    if (!Number.isNaN(d.getTime())) metaBits.push(`抓取于 ${d.toLocaleString()}`);
  }
  const c = card || {};
  const persona = c.persona || item.persona || '';
  const greeting = c.greeting || item.greeting || '';
  const scenario = c.scenario || item.scenario || '';
  const hint = c.hint || item.hint || '';
  const tagline = c.tagline || item.tagline || item.desc || '';
  const sections = [
    xyDetailSection('角色设定', persona),
    xyDetailSection('开场白', greeting),
    xyDetailSection('场景', scenario),
    xyDetailSection('关键词', hint),
  ].join('');
  body.innerHTML = `
    <div class="xy-detail-head">
      <div class="xy-avatar">${xyAvatarHtml(item, name)}</div>
      <div class="xy-detail-info">
        <div class="xy-name xy-detail-name">${escapeHtml(name)} ${badge}</div>
        <div class="xy-tagline xy-detail-tag">${escapeHtml(tagline || '（没有简介）')}</div>
        <div class="xy-meta">${escapeHtml(metaBits.join(' · '))}</div>
      </div>
    </div>
    <div class="xy-detail-sections">${sections}</div>
    ${note ? `<div class="xy-detail-note">${escapeHtml(note)}</div>` : ''}
  `;
  const btn = xyEl('xy-detail-register');
  if (btn) {
    btn.textContent = registered ? '已注册（再点会跳过）' : '注册这个角色';
    btn.disabled = false;
  }
}

async function openXingyeDetail(npcId) {
  const item = xingyeFindItem(npcId);
  if (!item) {
    toast('找不到这个角色的信息', true);
    return;
  }
  const xy = state.xingye;
  xy.detailNpc = item.npcId;
  xy.detailRemote = !xy.cards.some((c) => String(c.npcId) === String(item.npcId));
  const modal = xyEl('xy-detail-modal');
  if (!modal) { toast('详情弹窗还没准备好', true); return; }
  const note = xy.detailRemote && !item.fetched
    ? '这个角色还没抓取过。点「注册这个角色」会先抓取完整角色卡，再注册到角色列表。'
    : '';
  renderXingyeDetail(item, null, note);
  modal.hidden = false;

  // 已抓的本地角色按需拉完整角色卡（SPEC §5.2b），404/失败就保持摘要并提示。
  if (!xy.detailRemote) {
    try {
      const r = await api(`/api/xingye/cards/${encodeURIComponent(item.npcId)}`);
      if (String(xy.detailNpc) !== String(item.npcId)) return; // 用户已经切到别的角色
      renderXingyeDetail(item, r?.card || null);
    } catch {
      if (String(xy.detailNpc) !== String(item.npcId)) return;
      renderXingyeDetail(item, null, '完整角色卡已保存在本地（详情接口暂不可用），注册后可以在角色编辑里查看全文。');
    }
  }
}

function closeXingyeDetail() {
  const modal = xyEl('xy-detail-modal');
  if (modal) modal.hidden = true;
}

/* ---------- 事件绑定（由 bindEvents 调用） ---------- */
function bindXingyeEvents() {
  const on = (id, ev, fn) => {
    const el = xyEl(id);
    if (el) el.addEventListener(ev, fn);
  };

  on('xy-search-btn', 'click', () => xingyeSearch());
  on('xy-search-input', 'keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      xingyeSearch();
    }
  });
  on('xy-results-clear', 'click', clearXingyeResults);
  on('xy-filter-input', 'input', (e) => {
    state.xingye.filter = e.target.value || '';
    renderXingyeList();
  });

  on('xy-open-links', 'click', openXingyeLinks);
  on('xy-links-cancel', 'click', closeXingyeLinks);
  on('xy-links-start', 'click', () => startXingyeLinks());
  // Ctrl/Cmd+Enter 直接开始抓取（textarea 里 Enter 用来换行）
  on('xy-links-text', 'keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      startXingyeLinks();
    }
  });

  on('xy-detail-close', 'click', closeXingyeDetail);
  on('xy-detail-register', 'click', () => {
    const npc = state.xingye.detailNpc;
    if (npc == null) return;
    const remote = state.xingye.detailRemote;
    closeXingyeDetail();
    xingyeRegister([npc], remote);
  });

  // 已抓列表 / 搜索结果：事件委托（重绘后依然有效）。点整行 = 详情。
  ['xy-list', 'xy-results'].forEach((id) => {
    const listEl = xyEl(id);
    if (!listEl) return;
    listEl.addEventListener('click', (e) => {
      const li = e.target.closest('.xy-item');
      if (!li) return;
      const npc = li.dataset.npc;
      const btn = e.target.closest('[data-xy-act]');
      const act = btn?.dataset.xyAct;
      if (!act || act === 'detail') { openXingyeDetail(npc); return; }
      if (act === 'register') {
        xingyeRegister([Number(npc)], li.dataset.source === 'remote');
      } else if (act === 'remove') {
        xingyeRemove(npc);
      }
    });
  });
}


// ---- 远程访问安全（v2.3.9）：改口令 + 两步验证 ----
// 安全设置只允许本机改（服务端 /api/auth/* 里也校验了 isLoopback）。
let pendingTotpSecret = '';

async function loadAuthStatus() {
  const box = $('#auth-status');
  if (!box) return;
  try {
    const r = await fetch('/api/auth/status');
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      box.innerHTML = `<div class="lm-empty">${j.error || '读不到状态（安全设置只能在本机改）'}</div>`;
      return;
    }
    const st = await r.json();
    const passBadge = st.hasPassword
      ? `<span class="auth-badge on">已设口令</span>${st.source === 'env' ? '<span class="auth-badge off" style="margin-left:4px">来自环境变量</span>' : ''}`
      : '<span class="auth-badge off">未设口令（不设就等于对公网完全敞开）</span>';
    const totpBadge = st.totpEnabled
      ? '<span class="auth-badge on">已开启</span>'
      : '<span class="auth-badge off">未开启</span>';
    box.innerHTML = `
      <div class="lm-item" style="cursor:default">
        <div class="lm-main">
          <div class="lm-name">访问口令 ${passBadge}</div>
          <div class="lm-sub">手机 / 平板 / 外网访问时必须输入；本机 127.0.0.1 免密</div>
        </div>
      </div>
      <div class="lm-item" style="cursor:default">
        <div class="lm-main">
          <div class="lm-name">两步验证 ${totpBadge}</div>
          <div class="lm-sub">开启后远程登录要「口令 + 验证器 6 位数字」</div>
        </div>
      </div>`;
    const btn = $('#totp-toggle');
    const hint = $('#totp-hint');
    if (btn) btn.textContent = st.totpEnabled ? '关闭' : '开启';
    if (hint) hint.textContent = st.totpEnabled
      ? '已开启。关闭后远程只需口令 —— 建议先确认口令足够复杂。'
      : '开启后即使口令泄露，别人没有你手机上的验证码也进不来。';
  } catch (e) {
    box.innerHTML = `<div class="lm-empty">读取失败：${e.message}</div>`;
  }
}

/** 把二维码矩阵画成 canvas（服务端给的是二维布尔数组，不传图片）。 */
function drawQr(canvas, matrix) {
  const n = matrix.length;
  const scale = Math.max(2, Math.floor(220 / n));
  const quiet = 4;                      // 标准要求四周留 4 格空白，少了扫不出来
  const total = (n + quiet * 2) * scale;
  canvas.width = total;
  canvas.height = total;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, total, total);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue;
      ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
}

function wireAuthSettings() {
  $('#auth-refresh')?.addEventListener('click', loadAuthStatus);

  $('#auth-save-pass')?.addEventListener('click', async () => {
    const a = $('#auth-new-pass')?.value || '';
    const b = $('#auth-new-pass2')?.value || '';
    if (a.length < 6) return toast('口令至少 6 位');
    if (a !== b) return toast('两次输入不一致');
    const r = await fetch('/api/auth/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: a }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error || '改口令失败');
    if ($('#auth-new-pass')) $('#auth-new-pass').value = '';
    if ($('#auth-new-pass2')) $('#auth-new-pass2').value = '';
    toast('口令已改（本机免密，不用重新登录）');
    loadAuthStatus();
  });

  $('#totp-toggle')?.addEventListener('click', async () => {
    const panel = $('#totp-panel');
    // 已开启 → 关闭
    if ($('#totp-toggle')?.textContent === '关闭') {
      if (!confirm('关掉两步验证后，远程只需口令就能登录。确定？')) return;
      const r = await fetch('/api/auth/totp/disable', { method: 'POST' });
      if (r.ok) { toast('两步验证已关闭'); loadAuthStatus(); } else toast('关闭失败');
      return;
    }
    // 未开启 → 生成密钥并显示二维码
    const r = await fetch('/api/auth/totp/new', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error || '生成失败');
    pendingTotpSecret = j.secret;
    if (panel) panel.hidden = false;
    if ($('#totp-secret')) $('#totp-secret').textContent = j.secret.replace(/(.{4})/g, '$1 ').trim();
    const qrBox = $('#totp-qr');
    if (qrBox) {
      qrBox.innerHTML = '';
      const cv = document.createElement('canvas');
      qrBox.appendChild(cv);
      try { drawQr(cv, j.matrix); } catch (e) { qrBox.innerHTML = '<div style="color:#000">二维码画不出来，用手动密钥</div>'; }
    }
    if ($('#totp-code')) { $('#totp-code').value = ''; $('#totp-code').focus(); }
  });

  $('#totp-confirm')?.addEventListener('click', async () => {
    const code = ($('#totp-code')?.value || '').replace(/\D/g, '');
    if (code.length !== 6) return toast('请输入 6 位验证码');
    const r = await fetch('/api/auth/totp/enable', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: pendingTotpSecret, code }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error || '验证码不对');
    toast('两步验证已开启');
    if ($('#totp-panel')) $('#totp-panel').hidden = true;
    pendingTotpSecret = '';
    loadAuthStatus();
  });

  $('#totp-cancel')?.addEventListener('click', () => {
    if ($('#totp-panel')) $('#totp-panel').hidden = true;
    if ($('#totp-code')) $('#totp-code').value = '';
    pendingTotpSecret = '';
  });

  loadAuthStatus();
}

// ---- 其他分支（v2.3.11）----
// 额外生成 2 个别样的走向，点一个就换掉上一条角色回复。
// 和「🎲 挑一个」的区别：
//   · 挑一个 生成 4 个、面板是浮层、选中的进标准库（训练用）
//   · 其他分支 只生成 2 个、面板常驻在聊天下方、单纯换个走向，不进训练
// v2.3.14：改成真正的开关（state.branchOn，存 config.branchOn）——
//   打开后每轮角色回复完自动续 2 个走向，不用每轮手点；关掉面板就收起来。
const BRANCH_KEY = 'branchOn';
function branchIsOn() {
  return !!(state.config && state.config[BRANCH_KEY] === true);
}

function updateBranchButton() {
  const btn = $('#btn-branch');
  if (!btn) return;
  const on = branchIsOn();
  btn.classList.toggle('is-on', on);
  btn.title = on
    ? '其他分支：开（每轮自动多出 2 个走向）—— 点一下关掉'
    : '其他分支：关 —— 点一下打开（开着时每一轮额外生成 2 个走向）';
}

// 切会话 / 换会话后：开关还开着就把分支面板重新补上，否则收起来
function syncBranchPanel() {
  const panel = $('#branch-panel');
  if (!panel) return;
  if (!branchIsOn()) { panel.hidden = true; return; }
  if (branchLastAssistantIndex() < 0 || !activeSessionId()) { panel.hidden = true; return; }
  generateBranches();
}

async function toggleBranch() {
  const on = !branchIsOn();
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ [BRANCH_KEY]: on }) });
    state.config = { ...(state.config || {}), [BRANCH_KEY]: on };
    updateBranchButton();
    const panel = $('#branch-panel');
    if (!on) {
      if (panel) panel.hidden = true;
      toast('已关掉其他分支');
      return;
    }
    toast('已打开其他分支：每轮多给 2 个走向');
    // 打开时如果上一条回复还在，立刻补一次走向，不必等下一轮
    if (branchLastAssistantIndex() >= 0) await generateBranches();
  } catch (e) {
    toast(e.message, true);
  }
}

function branchLastAssistantIndex() {
  const msgs = state.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && String(msgs[i].content || '').trim()) return i;
  }
  return -1;
}

function renderBranchPanel(list) {
  const box = $('#branch-list');
  if (!box) return;
  box.innerHTML = list.map((c, i) => `
    <div class="branch-item" data-i="${i}">
      <div class="branch-body">${escapeHtml(c.text)}</div>
      <div class="branch-actions">
        <span class="branch-meta">分支 ${i + 1}</span>
        <button type="button" class="btn-primary btn-tiny branch-pick" data-i="${i}">用这条</button>
      </div>
    </div>`).join('');
}

async function generateBranches() {
  const panel = $('#branch-panel');
  const list = $('#branch-list');
  const sub = $('#branch-sub');
  if (!panel || !list) return;
  const sessionId = state.mode === 'direct' ? state.activeDirectId : state.activeSessionId;
  if (!sessionId) { toast('先打开一个会话', true); return; }
  const idx = branchLastAssistantIndex();
  if (idx < 0) { toast('还没有角色回复可以替换', true); return; }

  panel.hidden = false;
  list.innerHTML = '<div class="branch-loading">正在生成 2 个别的走向…（温度调高了，会和原来不一样）</div>';
  if (sub) sub.textContent = '生成中…';

  try {
    const r = await api('/api/gold/generate', {
      method: 'POST',
      body: JSON.stringify({ sessionId, n: 2, endIndex: idx }),
    });
    // 过滤掉和原来一字不差的（模型偶尔会原样复读）
    const original = String((state.messages[idx] || {}).content || '').trim();
    const seen = new Set([original]);
    const picked = [];
    for (const c of (r.candidates || [])) {
      const t = String(c.text || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      picked.push({ ...c, text: t });
      if (picked.length >= 2) break;
    }
    if (!picked.length) {
      list.innerHTML = '<div class="branch-err">两个都和原来一样，再点一次 🌿 试试</div>';
      if (sub) sub.textContent = '没生成出不同的分支';
      return;
    }
    renderBranchPanel(picked);
    if (sub) sub.textContent = `共 ${picked.length} 个别的走向 · 点一个换掉上一条`;
    panel.dataset.msgIndex = String(idx);
    panel.dataset.sessionId = sessionId;

    list.querySelectorAll('.branch-pick').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const i = Number(btn.dataset.i);
        const text = picked[i]?.text || '';
        if (!text) return;
        btn.disabled = true;
        try {
          await replaceMessage(Number(panel.dataset.msgIndex), text, '其他分支');
          toast('已换成这条分支');
          panel.hidden = false;
          // 换完把面板留在原地；开关开着的话，下一轮回复完会自动再续 2 个
          if (sub) sub.textContent = '已换用这条 · 下一轮会自动再给 2 个走向';
        } catch (e) {
          toast(e.message, true);
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="branch-err">生成失败：${escapeHtml(e.message)}</div>`;
    if (sub) sub.textContent = '生成失败';
  }
}

function wireBranchPanel() {
  $('#btn-branch')?.addEventListener('click', () => { toggleBranch(); });
  // 面板上的「关掉分支」= 直接把开关关掉，不只是收起面板
  $('#branch-close')?.addEventListener('click', () => {
    if (branchIsOn()) toggleBranch();
    else {
      const panel = $('#branch-panel');
      if (panel) panel.hidden = true;
    }
  });
}
