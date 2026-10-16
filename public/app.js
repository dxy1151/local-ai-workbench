// 前端逻辑：角色管理、会话切换、流式聊天。
import { applyAutoPair, applyBackspacePair } from './autopair.js';
import { sendButtonState } from './uistate.js';
import { parseCheat, describeCheat } from './cheat.js';

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

function avatarMark(character) {
  return character?.avatar ? escapeHtml(character.avatar) : '?';
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
  form.persona.value = character?.persona || '';
  form.scenario.value = character?.scenario || '';
  form.greeting.value = character?.greeting || '';
  form.phrases.value = character?.phrases || '';
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

async function submitCharacter(e) {
  e.preventDefault();
  const form = $('#character-form');
  const body = {
    id: form.id.value || undefined,
    name: form.name.value,
    avatar: form.avatar.value,
    tagline: form.tagline.value,
    persona: form.persona.value,
    scenario: form.scenario.value,
    greeting: form.greeting.value,
    phrases: form.phrases.value,
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
// /api/switch-model 负责把整套配置（baseUrl / Key / 模型名 / 关思考）一次写对。
// 等价于命令行的 tools\switch-model.mjs，但手机端也能用。
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
  if (!d.ok) {
    box.innerHTML = `<div class="lm-empty">${escapeHtml(d.error || '读不到本机模型')}`
      + '<br>（本机 Ollama 没起来时，可以点主页那个「⚪ 启动」）</div>';
    return;
  }
  if (!d.models.length) {
    box.innerHTML = '<div class="lm-empty">本机 Ollama 里还没有模型。</div>';
    return;
  }
  const same = (a, b) => a === b || a.split(':')[0] === b.split(':')[0];
  box.innerHTML = d.models.map((m) => {
    const now = d.isLocalNow && same(m.name, d.current);
    const badges = [
      m.thinking ? '<span class="lm-badge think">支持思考</span>' : '',
      m.vision ? '<span class="lm-badge">识图</span>' : '',
      now ? '<span class="lm-badge now">当前</span>' : '',
    ].filter(Boolean).join(' ');
    const meta = [fmtGB(m.sizeBytes), m.quant, m.params, m.contextLength ? `${m.contextLength} ctx` : ''].filter(Boolean).join(' · ');
    return `<div class="lm-row${now ? ' on' : ''}">
      <span class="lm-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
      ${badges}
      <span class="lm-meta">${escapeHtml(meta)}</span>
      <button type="button" class="lm-btn" data-model="${escapeHtml(m.name)}"${now ? ' disabled' : ''}>${now ? '在用' : '用这个'}</button>
    </div>`;
  }).join('');
}

async function switchToLocalModel(name) {
  if (state.streaming) { toast('正在生成，等这一轮结束再切', true); return; }
  try {
    const r = await api('/api/switch-model', { method: 'POST', body: JSON.stringify({ model: name }) });
    await refreshConfig();
    await loadLocalModels();
    fillSettingsForm();
    toast(`已切到 ${r.model}${r.thinkOff ? '（自动关掉了思考 /no_think）' : ''}${r.known ? '' : ' ⚠ 本机没有这个模型，可能报 model not found'}`, !r.known);
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
  form.narrative.value = config.narrative || '';
  form.autoClean.checked = config.autoClean !== false;
  form.autoPair.checked = config.autoPair !== false;
  form.forceAction.checked = config.forceAction !== false;
  form.cleanHistory.checked = config.cleanHistory !== false;
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
    narrative: form.narrative.value,
    autoClean: form.autoClean.checked,
    autoPair: form.autoPair.checked,
    forceAction: form.forceAction.checked,
    cleanHistory: form.cleanHistory.checked,
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
  try {
    const { session } = await api(`/api/sessions/${id}`);
    state.activeSessionId = id;
    renderMessages(session.messages);
    updateChatHeader();
    renderSessions();
    setNav(false); // 手机上选完会话自动收起抽屉
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
      <button class="item-del" data-del="${s.id}" title="删除">✕</button>
    </li>
  `).join('');
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
    renderMessages(session.messages);
    updateChatHeader();
    renderDirectSessions();
    enableComposer(true);
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
  const n = $('#know-text').value.length;
  $('#know-count').textContent = n;
}

// 直连模式：没有 characterId，走单独的 /api/direct/knowledge，资料存 `_direct.md`。
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
      ? await api('/api/direct/knowledge')
      : await api(`/api/knowledge?characterId=${encodeURIComponent(character.id)}`);
    $('#know-text').value = k.text || '';
    $('#know-budget').value = state.config?.knowledgeChars ?? 500;
    // 上限以服务端为准（v0.60.0 从 20000 提到 500000），别在前端写死
    if (k.max) $('#know-max').textContent = k.max;
    // v0.61.0 语义检索三个控件
    $('#know-semantic').checked = state.config?.knowledgeSemantic !== false;
    $('#know-threshold').value = state.config?.knowledgeThreshold ?? 0.5;
    $('#know-map').value = state.config?.knowledgeMap || '';
    $('#know-meta').innerHTML = direct
      ? '给<b>直连模式</b>的资料 —— 存成 <code>knowledge/_direct.md</code>，不挂在任何角色上，手机上也能看到同一份'
      : `给「<b>${escapeHtml(character.name)}</b>」的资料 —— 存在共享目录里，手机上也能看到同一份`;
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
    const text = $('#know-text').value;
    const budget = Number($('#know-budget').value);
    const r = direct
      ? await api('/api/direct/knowledge', { method: 'PUT', body: JSON.stringify({ text }) })
      : await api('/api/knowledge', {
        method: 'PUT',
        body: JSON.stringify({ characterId: character.id, text }),
      });
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
    toast(r.chars ? `资料已保存（${r.chars} 字），下一轮生成就会用上` : '资料已清空');
  } catch (err) {
    toast(err.message, true);
  }
}

async function previewKnowledge() {
  const direct = isDirectKnowledge();
  const character = state.characters.find((c) => c.id === state.activeCharacterId);
  if (!direct && !character) return;
  const text = $('#know-text').value;
  if (!text.trim()) { toast('资料还是空的', true); return; }
  // 用会话里最新一条我说的话当线索去试挑（不消耗模型）
  const lastUser = [...state.messages].reverse().find((m) => m.role === 'user')?.content || '';
  const q = lastUser || '（会话里还没有你说的话）';
  try {
    const enc = encodeURIComponent(q);
    const r = direct
      ? await api(`/api/direct/knowledge?query=${enc}`)
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
    const { wrap, meta } = createMessageEl(msg.role, msg.content);
    wrap.dataset.index = i;
    meta.textContent = metaText(msg);
    attachActions(wrap, i, msg, i === state.messages.length - 1);
    attachSources(wrap, msg);
    m.appendChild(wrap);
  });
  scrollBottom();
}

function metaText(msg) {
  const who = msg.role === 'assistant' ? '✦ 角色' : '我';
  return msg.editedAt ? `${who} · 已改写` : who;
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
  }
  // 有被否掉的版本时给个入口：能看到当时落选的几版，也能把任意一版换回来
  if (Array.isArray(msg.rejected) && msg.rejected.length) {
    const b = mk('veto', `已否决 ${msg.rejected.length}`, '看看这一条当时被否掉的其它版本');
    b.classList.add('msg-act-veto');
    bar.append(b);
  }
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
  // 等义词（全角色通用的一份）：每行「词 = 意思」，行尾可加 `#输出`
  $('#cfg-synonyms').value = cfg.synonyms || '';
  const synOut = $('#cfg-synonyms-output');
  if (synOut) synOut.checked = cfg.synonymsOutput === true;
  $('#cfg-dims-state').textContent = '';
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
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ dims, hint, synonyms, synonymsOutput }) });
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
      </div>
      <div class="ctx-text">${escapeHtml(r.text)}</div>
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

  bubble.replaceWith(box);
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

async function sendMessage(text) {
  if (state.mode === 'direct') return sendDirectMessage(text);
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
  appendMessageEl('user', content);
  state.messages = [...state.messages, { role: 'user', content }];
  $('#input').value = '';
  autoResize();
  if (image) clearPendingImage();

  await streamReply({ content, ...(image ? { image } : {}) });
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
  updateSendState();

  const { bubble } = appendMessageEl('assistant', '', true);
  const controller = new AbortController();
  state.abort = controller;
  let accumulated = '';

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
        if (ev === 'reset') {
          // 服务端判定上一版在拖延，正在重新生成：把气泡擦掉重打
          accumulated = '';
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
    : '说点什么…（Enter 发送，Shift+Enter 换行；cheats=1 让角色自己演下一句；quit 关闭本地AI对话工作台）';
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
  // 📷 识图 / 🖼 附图 跟输入框同进同退：锁了 / 正在生成 / 已关闭，都不该能点。
  // （附图两种模式都支持：直连模式会把这一轮临时换成视觉模型）
  const busy = state.shutDown || state.streaming || isLocked();
  const vbtn = $('#btn-vision');
  if (vbtn) vbtn.disabled = busy;
  const abtn = $('#btn-attach');
  if (abtn) abtn.disabled = busy;
  if (state.shutDown) {           // 已经 quit 了：输入和按钮都锁死，别再让人白点
    const btn = $('#btn-send');
    btn.disabled = true;
    btn.textContent = '已关闭';
    btn.classList.remove('is-stop');
    return;
  }
  // 直连模式：第一句话会自己建会话，所以"还没有会话"不该把发送键拦死
  const hasSession = state.mode === 'direct' ? true : Boolean(state.activeSessionId);
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
    $('#chat-avatar').textContent = '↯';
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
    $('#chat-avatar').textContent = '?';
    $('#chat-name').textContent = '选择一个角色开始';
    $('#chat-tagline').textContent = '从左侧角色列表里挑一个，或者新建一个';
    $('#btn-clear').hidden = true;
    $('#btn-edit-character').hidden = true;
    $('#btn-context').hidden = true;
    $('#btn-knowledge').hidden = true;
    $('#btn-autospeak').hidden = true;
    $('#btn-websearch').hidden = true;
    $('#btn-direct-phrases').hidden = true;
    updatePlaceholder();
    updateSendState();
    return;
  }
  $('#chat-avatar').textContent = character.avatar || '?';
  $('#chat-name').textContent = character.name;
  $('#chat-tagline').textContent = character.tagline || '开始聊天吧';
  $('#btn-clear').hidden = false;
  $('#btn-edit-character').hidden = false;
  $('#btn-context').hidden = false;
  $('#btn-knowledge').hidden = false;
  $('#btn-autospeak').hidden = false;
  $('#btn-websearch').hidden = false;
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

  // 应用内切模型：本机模型列表点「用这个」直接切；「切回云端」还原上次的云端配置
  $('#local-models').addEventListener('click', (e) => {
    const btn = e.target.closest('.lm-btn');
    if (btn && btn.dataset.model) switchToLocalModel(btn.dataset.model);
  });
  $('#local-models-refresh').addEventListener('click', loadLocalModels);
  $('#cloud-back-btn').addEventListener('click', switchToCloud);

  $('#btn-export').addEventListener('click', exportBackup);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) await importBackup(file);
    e.target.value = '';
  });

  $('#btn-new-character').addEventListener('click', () => openCharacterModal());
  $('#btn-character-cancel').addEventListener('click', () => ($('#character-modal').hidden = true));
  $('#character-form').addEventListener('submit', submitCharacter);

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`));
      // 切到「直连」就把主区域也切过去：接着上次那个直连会话，没有就先只准备输入框
      if (tab.dataset.tab === 'direct') enterDirectMode();
    });
  });

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
  $('#know-clear').addEventListener('click', () => { $('#know-text').value = ''; updateKnowCount(); });
  $('#know-preview').addEventListener('click', previewKnowledge);
  $('#know-text').addEventListener('input', updateKnowCount);
  $('#tts-test').addEventListener('click', testTts);
  $('#cfg-dims-save').addEventListener('click', saveGlobalDefaults);
  $('#cfg-hint').addEventListener('input', (e) => {
    $('#cfg-hint-count').textContent = `${e.target.value.length} / 500`;
  });
  $('#btn-autospeak').addEventListener('click', toggleAutoSpeak);
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
    else if (btn.dataset.act === 'veto') renderVeto(index);
    else if (btn.dataset.act === 'dims') openDims();
    else if (btn.dataset.act === 'speak') speakMessage(index, btn);
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
    const btn = e.target.closest('[data-adopt]');
    if (!btn) return;
    adoptRejected(Number(btn.dataset.index), Number(btn.dataset.adopt));
  });
  $('#veto-close').addEventListener('click', () => { $('#veto-modal').hidden = true; });

  const input = $('#input');
  attachAutoPair(input);
  input.addEventListener('input', () => { autoResize(); updateSendState(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!state.streaming) $('#composer').requestSubmit();
    }
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
