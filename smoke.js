// 冒烟测试：启动服务器，走一遍配置 / 角色 / 会话 的 CRUD，验证服务端逻辑。
// 用法：node smoke.js
// 用独立临时数据目录运行，绝不触碰真实的 data/ 目录；结束时自动清理。
//
// ⚠ 这一行必须放在**所有** import 之前：它把数据目录指到临时目录，
// 而 ESM 的 import 是提升的、按出现顺序求值 —— 放在后面，store.js 会先读到真实目录。
import { TMP_DATA } from './smoke-env.js';
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 前端里的纯逻辑（不碰 DOM），可以直接在这里测。
import { applyAutoPair, applyBackspacePair } from './public/autopair.js';
import { sendButtonState } from './public/uistate.js';
import { parseCheat, describeCheat } from './public/cheat.js';
import { slashTrigger, filterCharacters, conversationSpeakers } from './public/slashpick.js';
import { workState, humanLeft, isLocalEndpoint } from './lib/workguard.js';
import { previewContext, buildMessages, normalizeCastSpeaker, asNudge, applyAsIdentity, dropAsSpeaker, splitInlineSpeakers, regenerateNudge, antiStallNudge, personNudge, clicheNudge, continueNudge, openingPrefill, estimateTokens, CONTEXT_BUDGET, dimsBlock, hintBlock, normalizeHint, memoBlock, normalizeMemo, MEMO_MAX, limitBlock, normalizeMaxChars, phrasesLine, clampDimLevel, DIM_MAX, directMessages, directPhrasesBlock, parsePhrases, synonymsBlock, webSearchBlock, detailNudge, effectiveMaxChars } from './lib/prompt.js';
import { trimToLimit, describeTrim } from './lib/limit.js';
import { detectTailLoop, cutLoop, describeLoop, detectDuplicateSentence, cutDuplicate } from './lib/loopguard.js';
import { normalizeMarkup, normalizePerson, describeMarkup, thirdPersonSubjects } from './lib/markup.js';
import { MAX_OUTPUT_TOKENS, makePrefixJoiner, resolveModelId, cloudModelAliases } from './lib/openai.js';
import { sanitizeReply, findInventedEvents, describeCleaned, stallScore, describeStall, replyQuality, describeQuality, cleanHistoryText, cleanHistory, stripClicheActions, countClicheActions, stripUserActions, stripLeadingReasoning } from './lib/sanitize.js';
import { chunkText, pickChunks, knowledgeBlock } from './lib/knowledge.js';
import { speechText, ttsCacheKey } from './lib/tts.js';
import { normalizeTts, getConfig as storeConfig, normalizeSearchSite, normalizeSearchCount, normalizeSearchChars } from './lib/store.js';
import { describePreloadFailure, thinkControl, clearOllamaProbe, probeThinkCapability, clearThinkCapCache, isOllamaBase } from './lib/ollama.js';
import { residentKnowledgeFor } from './lib/server.js';
import { parseBing, decodeBingLink, cleanQuery, describeSearchFail } from './lib/search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// 安全闸：确认数据目录真的指向冒烟临时目录。
// 指向别处就立刻停下 —— 宁可不测，也不能往真实数据里写测试角色（踩过一次）。
{
  const { DATA_DIR } = await import('./lib/store.js');
  if (path.resolve(DATA_DIR) !== path.resolve(TMP_DATA)) {
    console.error(`\n✗ 拒绝对真实数据目录跑测试：DATA_DIR=${DATA_DIR}\n  期望 ${TMP_DATA}\n`);
    process.exit(1);
  }
}

// 预置一个「老格式」角色文件（全部角色挤在一个 JSON 里），
// 用来验证启动时会自动迁移成 characters/<id>.json。
await rm(TMP_DATA, { recursive: true, force: true });
await mkdir(TMP_DATA, { recursive: true });
await writeFile(
  path.join(TMP_DATA, 'characters.json'),
  JSON.stringify([{ id: 'legacychar00001', name: '旧格式角色', persona: '迁移测试', createdAt: 1, updatedAt: 1 }]),
  'utf8',
);

// 必须等环境变量设好后再加载 store/server，这样它们才指向临时目录。
const { startServer } = await import('./lib/server.js');
const { getConfig } = await import('./lib/store.js');
const { normalizeDims } = await import('./lib/store.js');
const { normalizeHintPresets, HINT_PRESET_MAX } = await import('./lib/store.js');
const { normalizeMessages } = await import('./lib/store.js');

// 起测试服务的端口：**动态挑一个空闲的**。
// 原来是写死的 5288，结果这台机器上 Windows 把它划进了保留区间
// （Hyper-V/WSL 会预留一段，落在里面就 EACCES —— 不是代码问题，但测试就永远起不来）。
const PORT = await new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures += 1; }
}

async function req(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  let r;
  // 让整套测试跟"什么时候跑"无关：这里先找一个"周六"的时刻当假时间，
  // 保证不会撞上工作时段锁。工作时段锁自己的用例会临时改成周一 10:00。
  const monday = (() => {
    const d = new Date(Date.UTC(2026, 8, 14, 2, 0, 0));
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  })();
  const H = 3600 * 1000;
  const FREE_ISO = new Date(monday.getTime() + 5 * 24 * H).toISOString(); // 周六
  process.env.WORKBENCH_WORKGUARD_NOW = FREE_ISO;

  const server = await startServer(PORT);
  console.log('服务已启动，开始冒烟测试（临时数据目录）…\n');

  // 启动时应当把老格式 characters.json 迁移成 characters/<id>.json
  const exists = async (p) => readFile(p, 'utf8').then(() => true).catch(() => false);
  r = await req('GET', '/api/characters');
  check('旧格式角色卡启动时自动迁移', r.data.characters.some((c) => c.id === 'legacychar00001'));
  check('迁移后生成一角色一文件', await exists(path.join(TMP_DATA, 'characters', 'legacychar00001.json')));
  check('迁移后老文件改名留底', await exists(path.join(TMP_DATA, 'characters.json.migrated')));
  check('已自动维护 .stignore（防止 Key 同步出去）', await exists(path.join(TMP_DATA, '.stignore')));

  // 静态页
  r = await fetch(`${BASE}/`);
  check('首页返回 200 且为 HTML', r.status === 200 && (r.headers.get('content-type') || '').includes('text/html'));

  // 配置
  r = await req('GET', '/api/config');
  check('GET /api/config 返回结构', r.status === 200 && 'model' in r.data && 'hasApiKey' in r.data);
  r = await req('PUT', '/api/config', { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', temperature: 0.9 });
  check('PUT /api/config 保存成功', r.status === 200 && r.data.ok === true);
  const cfg = await getConfig();
  check('配置已写入磁盘', cfg.model === 'deepseek-flash' && cfg.temperature === 0.9);

  // 版本号：必须和 package.json 一致，否则前端显示的和实际跑的对不上
  const pkgVersion = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  r = await req('GET', '/api/version');
  check('GET /api/version 与 package.json 一致', r.status === 200 && r.data.version === pkgVersion);
  r = await req('GET', '/api/config');
  check('config 响应里也带版本号', r.status === 200 && r.data.version === pkgVersion);

  // 角色
  r = await req('POST', '/api/characters', { name: '测试角色', persona: '测试人设', greeting: '你好呀', tagline: '一个测试', phrases: '在下\n罢了、少废话' });
  check('POST /api/characters 创建成功', r.status === 200 && r.data.character.id);
  check('常用词已保存', r.data.character.phrases === '在下\n罢了、少废话');
  const charId = r.data.character.id;
  r = await req('GET', '/api/characters');
  check('GET /api/characters 能列出角色', r.data.characters.some((c) => c.id === charId));

  // 二次编辑人设：带同一个 id 再 POST 应当是「原地更新」，不是新建一个
  const createdAt = r.data.characters.find((c) => c.id === charId).createdAt;
  r = await req('POST', '/api/characters', { id: charId, name: '测试角色', persona: '改写后的人设', tagline: '改过的简介', phrases: '哼' });
  check('二次编辑人设：原地更新（id 不变）', r.status === 200 && r.data.character.id === charId);
  check('二次编辑人设：新内容已生效', r.data.character.persona === '改写后的人设');
  check('二次编辑人设：createdAt 保留、updatedAt 前进', r.data.character.createdAt === createdAt && r.data.character.updatedAt >= createdAt);
  r = await req('GET', '/api/characters');
  check('二次编辑人设：没有产生重复角色', r.data.characters.filter((c) => c.id === charId).length === 1);
  // 局部更新不能把没传的字段抹掉（开场白就是这么丢的）
  check('局部更新不会清掉没传的字段（开场白 / 常用词保留）',
    r.data.characters.find((c) => c.id === charId).greeting === '你好呀',
    JSON.stringify(r.data.characters.find((c) => c.id === charId)?.greeting));
  r = await req('POST', '/api/characters', { id: charId, greeting: '' });
  check('显式传空字符串才能清空', r.data.character.greeting === '' && r.data.character.persona === '改写后的人设',
    JSON.stringify({ g: r.data.character.greeting, p: r.data.character.persona }));
  r = await req('POST', '/api/characters', { id: charId, greeting: '你好呀' });   // 复原，后面还要用

  // 会话
  r = await req('POST', '/api/sessions', { characterId: charId, greeting: '你好呀' });
  check('POST /api/sessions 创建会话并写入开场白', r.status === 200 && r.data.session.messages.length === 1);
  const sessId = r.data.session.id;
  // 请求里**不带** greeting 时，服务端要自己去角色卡上取（角色卡上写的是"你好呀"）
  r = await req('POST', '/api/sessions', { characterId: charId });
  check('不传开场白时服务端从角色卡兜底取',
    r.status === 200 && r.data.session.messages.length === 1
    && r.data.session.messages[0].role === 'assistant'
    && r.data.session.messages[0].content === '你好呀',
    JSON.stringify(r.data.session?.messages));
  check('开场白是第一条 assistant（角色先开口）', r.data.session.messages[0].at > 0);
  await req('DELETE', `/api/sessions/${r.data.session.id}`); // 清理：后面的导出测试按固定条数断言
  r = await req('GET', `/api/sessions/${sessId}`);
  check('GET /api/sessions/:id 返回完整记录', r.status === 200 && r.data.session.messages[0].content === '你好呀');
  r = await req('GET', '/api/sessions');
  check('GET /api/sessions 列表带摘要', r.data.sessions.some((s) => s.id === sessId && s.messageCount === 1));

  // chat 未配 key 时应优雅报错（不会真的发请求）
  r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sessId, content: '在吗' }),
  });
  const chatText = await r.text();
  check('/api/chat 未配 Key 时返回错误事件', r.status === 200 && chatText.includes('event: error'));

  // 同步：导出 / 合并导入
  const expRes = await fetch(`${BASE}/api/export`);
  const bundle = await expRes.json();
  check('导出包含角色与会话', expRes.status === 200 && bundle.characters.length === 2 && bundle.sessions.length === 1);
  check('导出不含 API Key', !JSON.stringify(bundle).includes('apiKey'));

  r = await req('POST', '/api/import', bundle);
  check('原样导回时全部跳过', r.status === 200 && r.data.characters.skipped === 2 && r.data.sessions.skipped === 1);

  const original = bundle.characters[0];
  const newer = { ...original, name: '改过的名字', updatedAt: (original.updatedAt || 0) + 60000 };
  const fresh = { id: 'brandnew00000001', name: '新角色', persona: 'x', createdAt: 1, updatedAt: 1 };
  r = await req('POST', '/api/import', { app: 'local-ai-workbench', version: 1, characters: [newer, fresh], sessions: [] });
  check('较新的角色会覆盖', r.data.characters.updated === 1);
  check('没见过的角色会新增', r.data.characters.added === 1);

  const after = await req('GET', '/api/characters');
  check('合并结果已落盘', after.data.characters.some((c) => c.id === original.id && c.name === '改过的名字')
    && after.data.characters.some((c) => c.id === 'brandnew00000001'));

  r = await req('POST', '/api/import', { characters: [{ ...original, name: '旧名字' }], sessions: [] });
  check('更旧的角色不会反向覆盖', r.data.characters.skipped === 1 && r.data.characters.updated === 0);

  r = await req('POST', '/api/import', { nope: true });
  check('非法备份被拒绝', r.status === 400);

  // 同步工具产生的冲突副本应被忽略
  await writeFile(
    path.join(TMP_DATA, 'sessions', `${sessId}.json.sync-conflict-20260101-120000-AAAA.json`),
    JSON.stringify({ id: 'conflict', characterId: charId, title: 'x', messages: [], createdAt: 1, updatedAt: 1 }),
  );
  r = await req('GET', '/api/sessions');
  check('同步冲突副本被忽略', !r.data.sessions.some((s) => s.id === 'conflict'));

  await req('DELETE', '/api/characters/brandnew00000001');

  // 撤回 / 人工改写 / 重新生成
  const rich = {
    id: 'smoketest0000001',
    characterId: charId,
    title: '撤回测试',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      { role: 'assistant', content: '开场白' },
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二句' },
      { role: 'assistant', content: '第二答' },
    ],
  };
  r = await req('POST', '/api/import', { characters: [], sessions: [rich] });
  check('导入多轮会话用于测试', r.status === 200 && r.data.sessions.added === 1);

  r = await req('PATCH', `/api/sessions/${rich.id}`, { action: 'edit', index: 2, content: '人工改写过的回答' });
  check('人工改写：内容被替换', r.status === 200 && r.data.session.messages[2].content === '人工改写过的回答');
  check('人工改写：打上 editedAt 标记', typeof r.data.session.messages[2].editedAt === 'number');
  check('人工改写：其他消息不受影响', r.data.session.messages.length === 5);

  r = await req('PATCH', `/api/sessions/${rich.id}`, { action: 'edit', index: 2, content: '   ' });
  check('改写空内容被拒绝', r.status === 400);

  r = await req('PATCH', `/api/sessions/${rich.id}`, { action: 'recall', index: 3 });
  check('撤回：删掉该条及其之后', r.status === 200 && r.data.session.messages.length === 3 && r.data.removed === 2);
  check('撤回：前面的人工改写保留', r.data.session.messages[2].content === '人工改写过的回答');

  r = await req('PATCH', `/api/sessions/${rich.id}`, { action: 'recall', index: 99 });
  check('撤回下标越界被拒绝', r.status === 400);

  // 重新生成：没有用户消息时应被拦下（不会真去调模型）
  r = await req('POST', '/api/sessions', { characterId: charId, greeting: '只有开场白' });
  const noUserSess = r.data.session.id;
  const regenRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: noUserSess, regenerate: true }),
  });
  check('重新生成：无用户消息时被拒绝', regenRes.status === 400);

  await req('DELETE', `/api/sessions/${noUserSess}`);
  await req('DELETE', `/api/sessions/${rich.id}`);

  // 删除
  r = await req('DELETE', `/api/sessions/${sessId}`);
  check('DELETE /api/sessions/:id', r.status === 200 && r.data.ok === true);
  check('DELETE 会话时回报被删的消息条数', typeof r.data.removed === 'number' && r.data.removed > 0);
  r = await req('DELETE', `/api/sessions/${sessId}`);
  check('重复删除同一个会话不会报错', r.status === 200 && r.data.removed === 0);
  r = await req('DELETE', `/api/characters/${charId}`);
  check('DELETE /api/characters/:id', r.status === 200 && r.data.ok === true);

  // 括号自动补全（纯逻辑，不用浏览器）
  const same = (r, value, cursor) => Boolean(r) && r.value === value && r.cursor === cursor;
  check('敲中文左括号自动补右括号', same(applyAutoPair('（', 1, '（'), '（）', 1));
  check('敲英文左括号自动补右括号', same(applyAutoPair('(', 1, '('), '()', 1));
  check('已经在括号里打字时不重复补', applyAutoPair('（）', 1, '（') === null);
  check('敲右括号时跳过右边已有的右括号', same(applyAutoPair('（））', 2, '）'), '（）', 2));
  check('普通字符不触发补全', applyAutoPair('a', 1, 'a') === null);
  check('Backspace 一次删掉空括号对', same(applyBackspacePair('（）', 1, 1), '', 0));
  check('Backspace 只删单个括号时不特殊处理', applyBackspacePair('（', 1, 1) === null);
  check('有选中内容时 Backspace 不特殊处理', applyBackspacePair('（）', 0, 2) === null);

  // 输入框「/ 选回答者」的触发与过滤（纯逻辑；DOM 那层由下面的静态检查兜）
  const trig = (v, c) => slashTrigger(v, c);
  check('行首打 / 触发', trig('/', 1)?.query === '');
  check('空格后打 / 触发', trig('你好 /', 5)?.start === 3);
  check('/陈 触发并带查询词', trig('/陈', 2)?.query === '陈');
  check('/陈 的 start 指向斜杠本身', trig('/陈', 2)?.start === 0);
  check('正文里的 and/or 不触发', trig('and/or', 7) === null);
  check('16/9 不触发', trig('16/9', 4) === null);
  check('查询词里带空格就不再是命令', trig('/陈 梦', 4) === null);
  check('光标在斜杠前面不触发', trig('/陈', 0) === null);
  check('不传光标时按末尾算', trig('/陈', undefined)?.query === '陈');
  const people = [
    { name: '陈梦', desc: '温柔，脸皮薄' },
    { name: '罗启', desc: '妈宝男，没主见' },
    { name: '时曼', desc: '女总裁' },
  ];
  check('空查询列全部人物', filterCharacters(people, '').length === 3);
  check('按人物名过滤', filterCharacters(people, '罗').length === 1 && filterCharacters(people, '罗')[0].name === '罗启');
  check('按人物描述过滤', filterCharacters(people, '妈宝')[0]?.name === '罗启');
  check('查不到返回空数组', filterCharacters(people, '不存在').length === 0);
  check('人物表不是数组时不会炸', filterCharacters(null, 'x').length === 0);

  // 「这个对话里有哪些人物」（/ 列表的数据源）：必须是本会话人物，不是所有角色卡
  const multiCard = {
    name: '陈梦和罗启',
    tagline: '两个人',
    cast: [{ name: '陈梦', desc: '温柔' }, { name: '罗启', desc: '妈宝' }],
  };
  const markerCard = {
    name: '旧卡',
    persona: '开头一段\n【人物】甲\n设定 A\n【人物】乙\n设定 B',
  };
  const singleCard = { name: '时曼', tagline: '女总裁' };
  check('多人卡取 cast 里的人物', conversationSpeakers(multiCard).map((x) => x.name).join(',') === '陈梦,罗启');
  check('老卡解析【人物】标记', conversationSpeakers(markerCard).map((x) => x.name).join(',') === '甲,乙');
  check('单角色卡只有自己一个人', conversationSpeakers(singleCard).length === 1 && conversationSpeakers(singleCard)[0].name === '时曼');
  check('没名字时返回空数组', conversationSpeakers({}).length === 0);
  check('只有 1 个 cast 不当多人（回落到 persona/单角色）',
    conversationSpeakers({ name: 'X', cast: [{ name: '甲' }] }).map((x) => x.name).join(',') === 'X');
  check('以身份发送的 nudge 指名道姓', asNudge('陈梦', ['罗启']).includes('用户在扮演「陈梦」')
    && asNudge('陈梦', ['罗启']).includes('只演「罗启」'));
  check('以身份发送：历史里的 as 消息标成「（陈梦说）…」',
    applyAsIdentity([{ role: 'user', content: '你好', as: '陈梦' }])[0].content === '（陈梦说）你好'
    && applyAsIdentity([{ role: 'user', content: '你好' }])[0].content === '你好');
  const asHist = [
    { role: 'assistant', content: '陈梦：你好。' },
    { role: 'user', content: '（陈梦说）我来了。', as: '陈梦' },
    { role: 'assistant', content: '罗启：嗯。' },
  ];
  const asFiltered = dropAsSpeaker(asHist, '陈梦', ['陈梦', '罗启']);
  check('以身份发送：历史里替用户角色写的话被摘掉',
    asFiltered.length === 2 && asFiltered[0].role === 'user' && asFiltered[1].content === '罗启：嗯。');
  check('云端模型别名：deepseek-v4-flash → deepseek-flash',
    resolveModelId('deepseek-v4-flash') === 'deepseek-flash' && resolveModelId('deepseek-flash') === 'deepseek-flash'
    && resolveModelId('some-model') === 'some-model');
  check('DeepSeek 的模型列表带别名', cloudModelAliases('https://api.deepseek.com/v1').includes('deepseek-v4-flash')
    && cloudModelAliases('http://127.0.0.1:11434/v1').length === 0);
  check('行内两人对话拆成多行（云端模型常见写法）',
    splitInlineSpeakers('罗启：好。 陈梦：嗯。', ['罗启', '陈梦']).split('\n').length === 2);
  check('删掉模型替用户写的动作（括号旁白）',
    stripUserActions('（你推开门，我抬起头）别急。').text === '（我抬起头）别急。');
  check('删掉替用户读心的话',
    stripUserActions('我看着你，确认了你的意图，我感觉到了').text === '我看着你，我感觉到了');
  check('引号里的台词不动', stripUserActions('「你坐下吧」我笑了笑').changed === false);
  check('正常旁白不动', stripUserActions('（门开了，我抬头）').changed === false);

  // 多人卡说话人前缀归位：（陈梦）→ 陈梦： （老卡开场白会带坏模型，见 v1.2.0）
  const cast2 = [{ name: '陈梦' }, { name: '罗启' }];
  check('（陈梦）前缀归位成 陈梦：', normalizeCastSpeaker('（陈梦）你好。', cast2) === '陈梦：你好。');
  check('半角括号也能归位', normalizeCastSpeaker('(罗启) 嗯', cast2) === '罗启：嗯');
  check('多行每行都归位', normalizeCastSpeaker('（陈梦）A\n（罗启）B', cast2) === '陈梦：A\n罗启：B');
  check('正文里的普通括号动作不动', normalizeCastSpeaker('（她笑了笑）好的', cast2) === '（她笑了笑）好的');
  check('不在行首的括号不动', normalizeCastSpeaker('他说（陈梦）走了', cast2) === '他说（陈梦）走了');
  check('没有人物表时原样返回', normalizeCastSpeaker('（陈梦）你好', []) === '（陈梦）你好');

  // 工作时段锁（纯逻辑：一律用 UTC 时刻构造，跟跑测试的机器时区无关）
  // monday = "周一 02:00 UTC" = 北京时间周一 10:00，正好在锁定时段里。
  const at = (ms, enabled = true) => workState(new Date(ms), enabled);

  check('工作日北京 10:00 被锁', at(monday.getTime()).blocked === true);
  check('被锁时给出正确的时段标签', at(monday.getTime()).label === '09:00 - 12:00');
  check('解锁时刻 = 北京时间 12:00', at(monday.getTime()).until === monday.getTime() + 2 * H);
  check('北京 12:00 整点解锁（边界不收）', at(monday.getTime() + 2 * H).blocked === false);
  check('北京 08:59 还没到点，不锁', at(monday.getTime() - 61 * 60 * 1000).blocked === false);
  check('北京 14:00 进入下午的锁', at(monday.getTime() + 4 * H).blocked === true);
  check('下午锁的标签正确', at(monday.getTime() + 4 * H).label === '14:00 - 18:00');
  check('北京 13:59 午休期间不锁', at(monday.getTime() + 4 * H - 60 * 1000).blocked === false);
  check('北京 17:59 仍锁', at(monday.getTime() + 8 * H - 60 * 1000).blocked === true);
  check('北京 18:00 解锁（边界不收）', at(monday.getTime() + 8 * H).blocked === false);
  check('周六不锁', at(monday.getTime() + 5 * 24 * H).blocked === false);
  check('周日不锁', at(monday.getTime() - 1 * 24 * H).blocked === false);
  check('关掉开关就不锁', at(monday.getTime(), false).blocked === false);
  check('剩余时长文案（1 小时 23 分）', humanLeft(H + 23 * 60 * 1000) === '1 小时 23 分');
  check('剩余时长文案（1 分 05 秒）', humanLeft(65 * 1000) === '1 分 05 秒');

  // 本地/内网判定：工作时段锁只管云端
  check('回环地址算本地', isLocalEndpoint('http://127.0.0.1:11434/v1') && isLocalEndpoint('http://localhost:11434/v1'));
  check('IPv6 回环算本地', isLocalEndpoint('http://[::1]:11434/v1'));
  check('内网段算本地', isLocalEndpoint('http://192.168.1.10:11434/v1')
    && isLocalEndpoint('http://10.0.0.5:11434/v1') && isLocalEndpoint('http://172.16.0.9/v1'));
  check('局域网域名算本地', isLocalEndpoint('http://ollama.local:11434/v1'));
  check('云端地址不算本地', !isLocalEndpoint('https://api.deepseek.com/v1')
    && !isLocalEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1'));
  check('172.32 不在内网段内', !isLocalEndpoint('http://172.32.0.1/v1'));
  check('空地址按云端处理（保守）', !isLocalEndpoint('') && !isLocalEndpoint(null));

  // 接口层：先把"现在"钉在北京时间周一 10:00，结果就是确定的
  const guardChar = (await req('POST', '/api/characters', { name: '锁测试角色', persona: '测试' })).data.character;
  const guardSess = (await req('POST', '/api/sessions', { characterId: guardChar.id, greeting: '在的' })).data.session;
  // 先明确钉成"云端 + 锁开着"，接口层的断言才是确定的
  const savedBase = (await req('GET', '/api/config')).data.baseUrl;
  await req('PUT', '/api/config', { baseUrl: 'https://api.deepseek.com/v1', workGuard: true });
  process.env.WORKBENCH_WORKGUARD_NOW = monday.toISOString();
  r = await req('GET', '/api/workguard');
  check('GET /api/workguard 上报被锁 + 时刻表', r.status === 200
    && r.data.blocked === true
    && typeof r.data.schedule === 'string'
    && r.data.until === monday.getTime() + 2 * H);

  const sessBefore = (await req('GET', `/api/sessions/${guardSess.id}`)).data.session;
  r = await req('POST', '/api/chat', { sessionId: guardSess.id, content: '上班时间偷偷聊一句' });
  check('工作时段发消息被服务端拦下（403）', r.status === 403 && r.data.blocked === true);
  const sessAfter = (await req('GET', `/api/sessions/${guardSess.id}`)).data.session;
  check('被拦下时不落库：消息数没变', sessBefore.messages.length > 0
    && sessAfter.messages.length === sessBefore.messages.length);

  // 锁只管云端：接口地址是本地/内网时，工作时段照样放行
  await req('PUT', '/api/config', { baseUrl: 'http://127.0.0.1:9/v1' });
  r = await req('GET', '/api/workguard');
  check('本地接口不锁（reason=local）', r.data.blocked === false && r.data.local === true && r.data.reason === 'local');
  r = await req('POST', '/api/chat', { sessionId: guardSess.id, content: '本地模型在工作时段也该放行' });
  check('本地接口在工作时段不发 403', r.status === 200);
  // 内网地址同理
  await req('PUT', '/api/config', { baseUrl: 'http://192.168.1.10:11434/v1' });
  r = await req('GET', '/api/workguard');
  check('内网接口也不锁', r.data.blocked === false && r.data.local === true);
  // 换回云端就恢复拦截
  await req('PUT', '/api/config', { baseUrl: 'https://api.deepseek.com/v1' });
  r = await req('GET', '/api/workguard');
  check('换回云端立刻恢复拦截', r.data.blocked === true && r.data.local === false);

  await req('PUT', '/api/config', { workGuard: false });
  r = await req('GET', '/api/workguard');
  check('设置里关掉开关后接口就不再锁', r.data.enabled === false && r.data.blocked === false);
  r = await req('POST', '/api/chat', { sessionId: guardSess.id, content: '关掉锁之后应该能进去' });
  check('关掉开关后不再返回 403', r.status === 200);

  await req('PUT', '/api/config', { workGuard: true });
  process.env.WORKBENCH_WORKGUARD_NOW = FREE_ISO;
  r = await req('GET', '/api/workguard');
  check('切回非工作时段（周六）就不锁', r.data.enabled === true && r.data.blocked === false);
  await req('PUT', '/api/config', { baseUrl: savedBase }); // 还原原来那个接口地址
  // 测试环境里数据目录是新建的，savedBase 就是**开箱默认值**。v2.3.36 起默认已经是
  // 本地 Ollama（127.0.0.1:11434），而下面「维度 / 备忘 / 字数上限 / 关思考」这些断言
  // cover 的是**完整 system** 才有的段落（精简版和极简版本来就不写这些），
  // 所以这里必须先把后端钉成"云端 + 完整提示词 + 非极简"，否则断言对象根本不对。
  // （这一行是 v2.4.1 补的：修复前这 21 条失败与业务逻辑无关，是测试没有把前提钉死。）
  await req('PUT', '/api/config', {
    baseUrl: 'https://api.deepseek.com/v1', workGuard: true,
    fullSystem: true, compactSystem: false, model: 'deepseek-flash', thinkOff: false,
  });

  // 描写幅度（维度图）：配置持久化 + 真的进了上下文
  r = await req('PUT', '/api/config', { dims: [{ name: '动作', level: 4 }, { name: '环境', level: 0 }] });
  check('维度设置能保存', r.status === 200);
  r = await req('GET', '/api/config');
  check('维度设置能读回且顺序不变', Array.isArray(r.data.dims) && r.data.dims.length === 2
    && r.data.dims[0].name === '动作' && r.data.dims[0].level === 4 && r.data.dims[1].level === 0);
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('维度进了上下文接口的系统提示词', r.data.system.includes('【描写幅度】') && r.data.stats.dimsChars > 0);
  await req('PUT', '/api/config', { dims: null });
  r = await req('GET', '/api/config');
  check('维度可以整个关掉', r.data.dims === null);
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('关掉后系统提示词里不再有它', !r.data.system.includes('【描写幅度】'));

  // 给 AI 的微调提示
  r = await req('PUT', '/api/config', { hint: '这次别提钱，也别问我想要什么' });
  check('微调提示能保存', r.status === 200);
  r = await req('GET', '/api/config');
  check('微调提示能读回', r.data.hint === '这次别提钱，也别问我想要什么');
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('提示进了上下文接口', r.data.system.includes('别提钱') && r.data.stats.hintChars > 0);
  await req('PUT', '/api/config', { hint: '' });
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('清空提示后不再注入', !r.data.system.includes('本次微调要求') && r.data.stats.hintChars === 0);

  // 提示预设：接口层读写 / 去重 / 清空
  r = await req('PUT', '/api/config', { hintPresets: ['别提钱', '让她主动点', '别提钱', '  '] });
  check('预设能保存', r.status === 200);
  r = await req('GET', '/api/config');
  check('预设去重去空后读回', Array.isArray(r.data.hintPresets) && r.data.hintPresets.length === 2
    && r.data.hintPresets[0] === '别提钱' && r.data.hintPresets[1] === '让她主动点');
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('预设不进提示词（只是小抄）', !r.data.system.includes('别提钱'));
  await req('PUT', '/api/config', { hintPresets: [] });
  r = await req('GET', '/api/config');
  check('预设可以清空', Array.isArray(r.data.hintPresets) && r.data.hintPresets.length === 0);

  // 场景备忘：接口层 + 真的排在最末尾
  r = await req('PUT', '/api/config', { memo: '现在在浴室，热水已放好；约定不加价' });
  check('备忘能保存', r.status === 200);
  r = await req('GET', '/api/config');
  check('备忘能读回', r.data.memo === '现在在浴室，热水已放好；约定不加价');
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  // v2.4.1：备忘已经**不再**是整个 system 的最后一段 —— 现在的顺序是
  //   备忘 → 【字数上限】→ 场景推进 → 【本轮暗号】，后面的都是"比备忘更硬"的要求
  //   （见 lib/prompt.js systemPrompt 末尾的注释：recency 最强的位置留给硬约束）。
  //   所以断言改成：备忘在系统提示词里、且排在【扮演要求】之后、字数上限之前。
  const sysNow = String(r.data.system || '');
  check('备忘进了上下文接口，且排在硬约束之前',
    sysNow.includes('约定不加价')
    && sysNow.indexOf('约定不加价') > sysNow.indexOf('扮演要求')
    && (!sysNow.includes('【字数上限】') || sysNow.indexOf('约定不加价') < sysNow.indexOf('【字数上限】'))
    && r.data.stats.memoChars > 0);
  await req('PUT', '/api/config', { memo: '' });
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('清空备忘后不再注入', !r.data.system.includes('场景备忘') && r.data.stats.memoChars === 0);

  // cheats=1 的服务端行为：不写入用户消息、只追加一条角色回复
  const beforeNext = (await req('GET', `/api/sessions/${guardSess.id}`)).data.session.messages.length;
  r = await req('POST', '/api/chat', { sessionId: guardSess.id, next: true });
  check('生成下一句不会报错', r.status === 200);
  const afterNext = (await req('GET', `/api/sessions/${guardSess.id}`)).data.session;
  const addedUsers = afterNext.messages.slice(beforeNext).filter((m) => m.role === 'user').length;
  check('生成下一句不会把指令当成你说的话', addedUsers === 0);
  r = await req('POST', '/api/chat', { sessionId: 'no-such-session', next: true });
  check('不存在的会话会被拒', r.status === 404);

  // 额外请求参数（本地模型关思考用）
  r = await req('PUT', '/api/config', { extraBody: '{"reasoning_effort":"none"}' });
  check('额外请求参数能保存', r.status === 200);
  r = await req('GET', '/api/config');
  check('额外请求参数能读回', r.data.extraBody === '{"reasoning_effort":"none"}');
  await req('PUT', '/api/config', { extraBody: '{不是合法 JSON' });
  r = await req('POST', '/api/chat', { sessionId: guardSess.id, content: '写错参数也不该崩' });
  check('额外参数写错时聊天不崩（仍走正常流程）', r.status === 200);
  await req('PUT', '/api/config', { extraBody: '' });

  // 上下文查看（纯逻辑 + 接口）
  const pvChar = { name: '测试角色', persona: '一句人设', scenario: '', greeting: '', phrases: '' };
  const pvHist = [
    { role: 'user', content: 'a'.repeat(9000) },
    { role: 'assistant', content: 'b'.repeat(9000) },
    { role: 'user', content: '最后一句' },
  ];
  const pv = previewContext(pvChar, pvHist, 9000);
  check('previewContext 第一条是系统提示词', pv.messages[0].role === 'system' && pv.messages[0].content.includes('测试角色'));
  check('previewContext 按预算裁掉早期历史', pv.stats.keptMessages === 1 && pv.stats.droppedMessages === 2);
  check('previewContext 字符统计正确', pv.stats.historyChars === 4
    && pv.stats.totalChars === pv.stats.systemChars + pv.stats.historyChars);
  check('previewContext 与 buildMessages 同源', JSON.stringify(previewContext(pvChar, pvHist).messages)
    === JSON.stringify(buildMessages(pvChar, pvHist)));

  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('GET /api/context 返回系统提示词+历史+统计', r.status === 200
    && r.data.system.includes('锁测试角色')
    && Array.isArray(r.data.history)
    && typeof r.data.stats?.estTokens === 'number'
    && r.data.stats.keptMessages >= 1);
  r = await req('GET', '/api/context?sessionId=不存在的会话');
  check('GET /api/context 会话不存在时 404', r.status === 404);

  // 叙事推进指令
  r = await req('GET', '/api/config');
  check('默认不带叙事推进指令（开箱不注入）', r.data.narrative === '');
  const pv2 = previewContext(pvChar, pvHist, 9000, '【叙事推进】测试指令');
  check('叙事推进指令会拼进系统提示词',
    pv2.messages[0].content.includes('测试指令')
    && pv2.stats.narrativeChars === '【叙事推进】测试指令'.length);
  check('不给指令时系统提示词里就没有它', !pv.messages[0].content.includes('测试指令'));
  await req('PUT', '/api/config', { narrative: '【叙事推进】冒烟测试' });
  r = await req('GET', '/api/context?sessionId=' + guardSess.id);
  check('叙事指令进了上下文接口的系统提示词',
    r.data.narrative === '【叙事推进】冒烟测试' && r.data.system.includes('冒烟测试'));
  // 第 8/9 条：人称 + 别写日记
  const sys = previewContext({ name: '林晚', persona: 'x' }, [{ role: 'user', content: '（进屋）' }], 12000, '', {}).messages[0].content;
  check('提示词有人称硬规则（我=角色、你=对方）',
    sys.includes('"我"永远指你自己') && sys.includes('不要写第三人称的旁白'));
  check('提示词要求每轮有台词、不写日记',
    sys.includes('至少说出两句台词') && sys.includes('不是写小说或写日记'));
  check('提示词禁止替对方行动/写心理',
    sys.includes('不要替对方行动') && sys.includes('你感到'));
  // v2.4.1：完整 system 的第 9 条禁止的是"旁白式的总结（就这样/接下来/几分钟后…）"，
  //   字面量「跳时间」只出现在 dimsBlock 和 lean 版里 —— 原来的断言找错了关键词。
  // v2.4.3：实测事故「用户发"奶包小"→ 模型没有产出内容」的三个根因，逐个钉住。
  {
    // ① 思考段和正文之间**没有空行**时，剥离必须生效（原来只按空行切段，整段泄漏留在正文里）
    const leak1 = '也可能是想让我以第一人称扮演「孟楚瑶」继续场景对话。需要接住这句话并推进剧情。'
      + '注意字数不超过140字好现在开始写正文：\n（指尖擦着礼服肩线）你来啦。';
    check('★ 思考泄漏：正文前没有空行也要剥掉', !stripLeadingReasoning(leak1).text.includes('也可能是想让我')
      && stripLeadingReasoning(leak1).text.startsWith('（指尖'));
    const leak2 = '我要分析一下用户的意思好现在开始写正文：（指尖擦着礼服肩线）你好呀。';
    check('★ 思考泄漏：连换行都没有也能剥掉', stripLeadingReasoning(leak2).text === '（指尖擦着礼服肩线）你好呀。');
    // ② 引号没闭合 = 写到一半断了，必须判废（原来给 0 分直接放行，残片被存进历史）
    const stub = '（指尖擦着礼服肩线，桃花眼湿漉漴望你）\n“';
    check('★ 质量门：引号没闭合要判废（残片不能当回复存下去）',
      replyQuality(stub, { contextText: '' }).score >= 4
      && replyQuality(stub, { contextText: '' }).reasons.some((r) => /引号没闭合/.test(r)));
    // ③ 截断不能留下没配对的括号/引号
    const longWithQ = '（她抬起头看你，眼里有点湿）你来啦，我等了你好久。“刚才一直在想你会不会来，外头风那么大，我怕你着凉，真的。';
    const tr = trimToLimit(longWithQ, 30);
    const oq = (tr.text.match(/[“「]/g) || []).length;
    const cq = (tr.text.match(/[”」]/g) || []).length;
    const op = (tr.text.match(/[（(]/g) || []).length;
    const cp = (tr.text.match(/[）)]/g) || []).length;
    check('★ 截断：不留没配对的引号/括号', oq === cq && op === cp);
  }
  check('提示词禁止旁白式跳时间',
    sys.includes('不要写旁白式的总结') && sys.includes('几分钟后'));
  check('维度段里也明确写了「不跳时间」',
    dimsBlock([{ name: '动作', level: 5 }]).includes('不跳时间'));
  check('维度段声明"只调比例、不改硬要求"',
    dimsBlock([{ name: '动作', level: 5 }]).includes('不改变其它硬性要求'));

  // 字数上限：按句子边界截断，不切断半句
  const long = '*我抬手把外套扔到椅子上，走到你面前停下。* 钱带来了吗？没带就直说，别在这儿耗着。要不要我先把灯关了你说了算反正我也不急这一会儿。';
  const t1 = trimToLimit(long, 30);
  check('超长会被截断', t1.trimmed.length > 0 && t1.text.length <= long.length);
  check('截断处落在句子边界（不会半句）', /[。！？…”」）\*]$/.test(t1.text));
  check('裁掉的内容留档（能进已否决）', long === t1.text + t1.trimmed);
  check('没超上限时原样返回', trimToLimit('*我点头* 行。', 100).trimmed === '');
  check('上限为 0 = 不限', trimToLimit(long, 0).trimmed === '');
  check('找不到句子边界时宁可不裁', trimToLimit('没有标点的一长串文字'.repeat(10), 20).trimmed === '');
  check('截得太靠前时会往后找到完整一句', (() => {
    const t = trimToLimit('*我抬手按在你的肩上，力道不轻* 钱呢？别磨蹭，我这人不喜欢等。', 5);
    return t.trimmed === '' || /[。！？…”」）\*]$/.test(t.text);
  })());
  check('字数上限会写进提示词', limitBlock(120).includes('不要超过 120 字'));
  check('上限为 0 时不写这一段', limitBlock(0) === '' && limitBlock(null) === '');
  check('上限会做范围收敛', normalizeMaxChars(-5) === 0 && normalizeMaxChars(99999) === 2000 && normalizeMaxChars('120') === 120);
  const limitCtx = previewContext({ name: '林晚', persona: 'x' }, [{ role: 'user', content: '（进屋）' }], 12000, '', { maxChars: 120 });
  check('字数上限排在提示词最后（上限+下限一起收尾）',
    (() => { const t = limitCtx.messages[0].content.trimEnd(); return t.includes('【字数上限】') && t.lastIndexOf('【字数上限】') > t.length - 600; })());
  // 预算必须按最差分词效率（实测 llama 底座中文 1.05 字/token）也不会撑爆 8192 窗口
  check('上下文预算不会超过模型窗口',
    estimateTokens('字'.repeat(CONTEXT_BUDGET)) + 400 <= 8192);

  // 发送 / 停止按钮（踩过的坑：生成中按钮被 disabled，"停止"点不动）
  const stopBtn = sendButtonState({ locked: false, streaming: true, hasText: false, hasSession: true });
  check('生成中「停止」按钮必须可点', stopBtn.disabled === false);
  check('生成中按钮文案是「停止」并带样式', stopBtn.label === '停止' && stopBtn.isStop === true);
  check('空闲且输入为空时禁用发送', sendButtonState({ locked: false, streaming: false, hasText: false, hasSession: true }).disabled === true);
  check('空闲且有内容时可发送', sendButtonState({ locked: false, streaming: false, hasText: true, hasSession: true }).disabled === false);
  check('没有会话时不能发送', sendButtonState({ locked: false, streaming: false, hasText: true, hasSession: false }).disabled === true);
  check('锁定时按钮显示已锁定', sendButtonState({ locked: true, streaming: true, hasText: true, hasSession: true }).label === '已锁定');

  // 标记规整（星号 / 括号混用）—— 用真实会话里抓到的样本
  check('动作块用 ) 收尾会被修回 *',
    normalizeMarkup('*测试角色的声音在房间里回荡，带着一丝颤抖和无助。她咬紧牙关忍住声音)') === '*测试角色的声音在房间里回荡，带着一丝颤抖和无助。她咬紧牙关忍住声音*');
  check('*) 混着收尾会被修掉',
    normalizeMarkup('*她的表情是一种难以言喻的惊讶与犹豫*)') === '*她的表情是一种难以言喻的惊讶与犹豫*');
  check('半角括号里的中文会转全角',
    normalizeMarkup('(听到我的话，眼神闪过一丝失望)') === '（听到我的话，眼神闪过一丝失望）');
  check('半角 ( 配全角 ）也会被统一',
    normalizeMarkup('(她用手撑起身子，准备站起来）') === '（她用手撑起身子，准备站起来）');
  check('孤立的右括号会被丢掉',
    normalizeMarkup('她抬起头看着你，眼神中闪烁着一丝挑战和渴望)来吧') === '她抬起头看着你，眼神中闪烁着一丝挑战和渴望来吧');
  check('有配对的括号不受影响',
    normalizeMarkup('（雨点敲着窗户，屋里只亮着一盏台灯）') === '（雨点敲着窗户，屋里只亮着一盏台灯）');
  check('不成对的星号（行首）会被补上收尾',
    normalizeMarkup('*她笑了笑，没说话') === '*她笑了笑，没说话*');
  check('不成对的星号（行中）会被去掉',
    normalizeMarkup('她点了点头*歪了歪头') === '她点了点头歪了歪头');
  check('空标记 * * 会被清掉', normalizeMarkup('伸手轻抚你的裆部,* *指尖探出*,') === '伸手轻抚你的裆部，指尖探出，');
  check('跨行的 * 换行 * 不会被吞并（踩过的坑）',
    normalizeMarkup('*动作一*\n\n*动作二*') === '*动作一*\n\n*动作二*');
  check('中文旁边的半角逗号/问号会转全角',
    normalizeMarkup('躺好,别乱动。你确定?') === '躺好，别乱动。你确定？');
  check('数字里的点号不会被误伤', normalizeMarkup('花了1.5万，v0.2 版本') === '花了1.5万，v0.2 版本');
  check('规整后标记一定成对', (() => {
    const samples = [
      '*动作开头，用括号结尾)', '(环境开头，用星号结尾*', '*一* *二* 台词', '*没闭合',
      '（没闭合', '*a*)b*', '正常（环境）*动作*台词',
    ];
    return samples.every((s) => {
      const t = normalizeMarkup(s);
      return (t.match(/\*/g) || []).length % 2 === 0
        && (t.match(/（/g) || []).length === (t.match(/）/g) || []).length;
    });
  })());
  check('规整提示可读', describeMarkup().includes('星号'));
  check('半角双引号统一成中文引号',
    normalizeMarkup('*我接过杯子* "你自己都不喝一杯？"') === '*我接过杯子* “你自己都不喝一杯？”'
    && normalizeMarkup('"快擦擦头发，别着凉了。"') === '“快擦擦头发，别着凉了。”');
  check('落单的引号也会成对（跨行折行的台词）',
    normalizeMarkup('"我话还没说完\n你就别问了"') === '“我话还没说完\n你就别问了”');
  check('引号后面的半角逗号会跟着转全角（不留空格）',
    normalizeMarkup('*动作* "台词", 结束') === '*动作* “台词”，结束');
  check('引号规整不会误伤撇号', normalizeMarkup("it's OK") === "it's OK");
  check('方括号旁白统一成星号',
    normalizeMarkup('[她转过身去] 你来了。') === '*她转过身去* 你来了。'
    && normalizeMarkup('【叙述继续】') === '*叙述继续*');
  check('方括号里不是中文就不动', normalizeMarkup('[ok] [1]') === '[ok] [1]');
  check('乱入的外文单词会被清掉',
    normalizeMarkup('денег 夸张了吗？') === '夸张了吗？'
    && normalizeMarkup('Ολα 她的表情变了。') === '她的表情变了。');
  check('元信息泄漏会被清掉（模型把要求写进正文）',
    normalizeMarkup('*我笑了* 好。（续写12字以内）') === '*我笑了* 好。'
    && normalizeMarkup('（字数控制在100）走吧。') === '走吧。');
  check('正常的环境描写不会被当成元信息',
    normalizeMarkup('（烟灰落了一截，屋里有股皂角味）') === '（烟灰落了一截，屋里有股皂角味）');
  check('中文为主时外语碎片会清掉',
    normalizeMarkup('денег 夸张了吗？') === '夸张了吗？');
  check('整段外语时不动它（交给重抽，别删成空白）',
    normalizeMarkup('Hello, how are you today?') === 'Hello, how are you today?'
    && normalizeMarkup('おはよう、今日はいい天気ですね') === 'おはよう、今日はいい天気ですね');
  // 实测漏判：中文里直接粘了个英文单词（"磨破皮了stripe"）
  check('粘在中文里的英文单词会被清掉',
    normalizeMarkup('想你这抠门脸都磨破皮了stripe') === '想你这抠门脸都磨破皮了'
    && normalizeMarkup('iphone手机挺好用') === '手机挺好用');
  check('正常英文不误伤（后面是标点或有空格）',
    normalizeMarkup('OK，那就按你说的来。') === 'OK，那就按你说的来。'
    && normalizeMarkup('*笑了* OK boss') === '*笑了* OK boss');
  // 实测：单个英文词放在**空格后面**（粘连规则抓不到）
  check('空格分隔的英文单词也会被清掉',
    normalizeMarkup('（楼道里的脚步声飘进你的 Mouth）') === '（楼道里的脚步声飘进你的）'
    && normalizeMarkup('*我笑了* 你的 face 真好看。') === '*我笑了* 你的 真好看。');
  check('口语外来词保留（OK/boss/wifi…）',
    normalizeMarkup('OK，boss，连 wifi 都断了。') === 'OK，boss，连 wifi 都断了。');
  check('角色名不会被当成英文碎片', (() => {
    const t = normalizeMarkup('*test笑了* 过来。', { keep: ['test'] });
    return t.includes('test');
  })());
  check('混英文会被扣分（按清理前的原文判）',
    replyQuality('（楼道里的脚步声飘进你的）', { contextText: '', characterName: '测试角色', originalText: '（楼道里的脚步声飘进你的 Mouth）' })
      .reasons.some((r) => r.includes('英文单词')));

  // 语言检测（多语言底座会整段换语言）
  check('整段英文会被重罚',
    replyQuality('Hello, how are you today? I want to see you.', { contextText: '' })
      .reasons.some((r) => r.includes('不是中文')));
  check('整段英文分数够高（会重抽）',
    replyQuality('Hello, how are you today? I want to see you.', { contextText: '' }).score >= 4);
  check('混进日文会被扣分',
    replyQuality('*歪头看你* おはよう、今日はいい天気ですね。', { contextText: '' })
      .reasons.some((r) => r.includes('日文')));
  check('中英夹杂会被扣分',
    replyQuality('*笑了* Oh my god, you are so funny, 我真的服了你这个 gentleman 了，行吧，你赢了这次。', { contextText: '' })
      .reasons.some((r) => r.includes('英文')));
  check('正常中文（含 OK）不误伤',
    !replyQuality('*点头* OK，那就按你说的来，别磨蹭了。', { contextText: '' })
      .reasons.some((r) => r.includes('中文') || r.includes('英文')));

  // 繁体字 / 括号里写动作
  check('整段繁体会被扣分',
    replyQuality('*掀開抽屜往兜底扯掏* 找錢！新票都泡水啦。', { contextName: '', contextText: '' })
      .reasons.some((r) => r.includes('繁体')));
  check('简体不扣繁体分',
    !replyQuality('*掀开抽屉往兜里掏* 找钱！新票都泡水了。', { contextText: '' })
      .reasons.some((r) => r.includes('繁体')));
  check('（）里写动作会被扣分（用户要求只写小变化）',
    replyQuality('*笑了一下* 来吧。（突然拽你手腕按跪在地毯上）', { contextText: '' })
      .reasons.some((r) => r.includes('（）里写了动作')));
  check('（）里写气味线索不扣分',
    !replyQuality('*笑了一下* 来吧。（闻到一股皂角味）', { contextText: '' })
      .reasons.some((r) => r.includes('（）里写了动作')));
  check('英文单词（非白名单）会被清掉，包括 WALL 这种',
    normalizeMarkup('*我抬头* WALL 发出吱呀声。') === '*我抬头* 发出吱呀声。');
  check('日文假名也会被清掉', normalizeMarkup('ありがとう 谢谢。') === '谢谢。');

  // cheats=1：生成下一句
  check('cheats=1 被识别成"生成下一句"', parseCheat('cheats=1') === 'next');
  check('允许空格和大小写', parseCheat('  Cheats = 1  ') === 'next' && parseCheat('CHEATS=1') === 'next');
  check('普通消息不会被当成作弊指令',
    parseCheat('cheats=2') === null && parseCheat('cheats=1 你好') === null
    && parseCheat('你好 cheats=1') === null && parseCheat('') === null && parseCheat('cheats') === null);
  check('作弊提示可读', describeCheat('next').includes('下一句'));

  // quit：在输入框里敲就关掉程序
  check('quit 被识别成"关闭"', parseCheat('quit') === 'quit' && parseCheat('QUIT') === 'quit' && parseCheat('  quit  ') === 'quit');
  check('quit 的中文别名也能用',
    parseCheat('退出') === 'quit' && parseCheat('关闭') === 'quit' && parseCheat('exit') === 'quit');
  check('含 quit 的正常聊天不会被误判',
    parseCheat('我要 quit 这段关系') === null && parseCheat('quit 吗') === null && parseCheat('quits') === null
    && parseCheat('别关了') === null);
  check('quit 的提示可读', describeCheat('quit').includes('关闭'));
  check('继续指令说明了"不要停下等对方"',
    continueNudge().includes('继续往下演') && continueNudge().includes('不要停下来等对方')
    && continueNudge().includes('不是台词'));

  // 连续两条 assistant 消息是非法历史（接口会 400），必须被合并
  const merged = normalizeMessages([
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '在', at: 1, rejected: [{ text: 'r1', reason: 'x' }] },
    { role: 'assistant', content: '又补了一句', at: 2, rejected: [{ text: 'r2', reason: 'y' }] },
    { role: 'user', content: '嗯' },
    { role: 'assistant', content: '好' },
    { role: 'assistant', content: '嗯嗯' },
    { role: 'assistant', content: '嗯嗯嗯' },
  ]);
  check('连续的角色回复会被合并成一条', merged.length === 4 && merged[1].content === '在\n\n又补了一句');
  check('合并时保留时间戳与已否决列表', merged[1].at === 2 && merged[1].rejected.length === 2);
  check('三段连续也会并成一条', merged[3].content === '好\n\n嗯嗯\n\n嗯嗯嗯');
  check('正常交替的历史不会被改动', (() => {
    const ok = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    return JSON.stringify(normalizeMessages(ok)) === JSON.stringify(ok);
  })());

  // 复读检测（"停不下来"那种死循环）
  const loopPrefix = '她把门关上，回头看了你一眼，什么也没说。';
  const loopUnit = '她笑了笑，把烟摁灭在烟灰缸里。';
  const loopText = loopPrefix + loopUnit.repeat(4);
  const lh = detectTailLoop(loopText);
  check('能检测到尾部复读', Boolean(lh) && lh.repeats >= 3);
  check('复读单元与句长一致', lh && lh.unit === loopUnit.length);
  check('起点指向第一遍循环处', lh && lh.at === loopPrefix.length);
  check('截断后只留下循环前的内容', cutLoop(loopText, lh) === loopPrefix);
  check('没复读的文本不误判', detectTailLoop(loopPrefix + '她把外套脱了搭在椅背上。') === null);
  check('纯标点重复不算复读', detectTailLoop('哈哈' + '。。。。。。'.repeat(4)) === null);
  check('太短的文本不判', detectTailLoop('她笑了。') === null);
  check('截剩太少就当废稿', cutLoop('好。' + loopUnit.repeat(4), detectTailLoop('好。' + loopUnit.repeat(4))) === '');
  check('复读提示可读', describeLoop(lh).includes('复读'));
  check('默认输出上限存在且宽松', MAX_OUTPUT_TOKENS >= 1200 && MAX_OUTPUT_TOKENS <= 4000);

  // 整句重复（用户实际遇到的那种：整段写两遍，中间夹一行旁白）
  const DUP = '*我微微侧过头，看着你。虽然脸上的表情依然保持着平静，但我却感到一种无法言喻的愉悦和满足*';
  const userCase = `${DUP}\n（内心有一丝期待）\n${DUP}\n（内心有一些迷茫`;
  const dupHit = detectDuplicateSentence(userCase);
  check('整句重复能被检测到', Boolean(dupHit));
  check('截断点是第二遍的起点', dupHit && userCase.slice(dupHit.at).trimStart().startsWith('*我微微侧过头'));
  check('截断后只留第一遍', cutDuplicate(userCase, dupHit).split('我微微侧过头').length === 2);
  check('截断后保留中间那行旁白', cutDuplicate(userCase, dupHit).includes('内心有一丝期待'));
  check('正常文本不会误判', detectDuplicateSentence('*我抬手按住你的肩* 别动。你今晚归我了。') === null);
  check('短句重复不算（"嗯。好。"这种）', detectDuplicateSentence('嗯。好。嗯。好。嗯。好。') === null);
  // 实测漏判：重复的句子只有 16 字
  const dup16 = '*脸还埋在手臂里，闷着声音骂了一句* 老子累了一整天。\n*脸还埋在手臂里，闷着声音骂了一句* 老子累了一整天。';
  check('16 字的重复句也能抓到', Boolean(detectDuplicateSentence(dup16)));
  check('"你他妈"不算凭空造人（骂词里的"他"）',
    !replyQuality('*喘了口气* 你他妈……放开我。', { characterName: '测试角色', contextText: '（屋里没别人）' })
      .reasons.some((r) => r.includes('凭空造人')));
  check('真正的第三人称仍然算凭空造人',
    replyQuality('*转头对那个店员摊手* 听他的，把模取了。', { characterName: '测试角色', contextText: '（屋里没别人）' })
      .reasons.some((r) => r.includes('凭空造人')));
  const qDup2 = replyQuality(userCase, { characterName: '测试角色' });
  check('整句重复会被扣分', qDup2.reasons.some((r) => r.includes('整句重复')));

  // 出戏：自编自演 / 日记体（用用户实际贴回来的那条当样本）
  const diary = '*我微微侧过头，看着你。虽然脸上的表情依然保持着平静，但我却感到一种无法言喻的愉悦和满足一丝无奈又是几分自豪地看着自己的身体……我决定继续配合你的动作吧……*\n（内心有一丝期待）';
  const qDiary = replyQuality(diary, { characterName: '测试角色' });
  check('整段自我描写（没台词）会被判日记体', qDiary.reasons.some((r) => r.includes('几乎没有台词')));
  check('心理活动扎堆会被扣分', qDiary.reasons.some((r) => r.includes('心理活动过多')));
  check('日记体总分偏高（会被重抽）', qDiary.score >= 4);

  const qAct = replyQuality('*我按住你的肩* 你走过来坐下，然后你转身看着我。', { characterName: '测试角色' });
  check('替对方行动会被扣分', qAct.reasons.some((r) => r.includes('替对方行动')));
  // 实测漏判过："你猛地顿了一下"（"猛地"是副词）；也验证引号里的台词不误伤
  const qAct2 = replyQuality('*眯着眼看你*（老剧里传来说客的声音变了调，你猛地顿了一下）', { characterName: '测试角色' });
  check('"你猛地/顿了一下"这类也会被抓到', qAct2.reasons.some((r) => r.includes('替对方行动')));
  const qTalk = replyQuality('*点头*“你说得对，我听你的。”', { characterName: '测试角色' });
  check('引号里的"你说得对"不算替对方行动', !qTalk.reasons.some((r) => r.includes('替对方行动')));
  const qMind = replyQuality('*我笑了一下* 你感到一阵紧张，你心里其实很清楚。', { characterName: '测试角色' });
  check('替对方写心理会被扣分', qMind.reasons.some((r) => r.includes('替对方写心理')));
  const qNarr = replyQuality('*我站起来* 就这样，接下来的几天你都来了，转眼一个月过去。', { characterName: '测试角色' });
  check('旁白式跳时间会被扣分', qNarr.reasons.some((r) => r.includes('旁白式推进')));

  const qGoodTalk = replyQuality('*我抬手按住你的肩* 今晚你归我了，别想跑。', { characterName: '测试角色' });
  check('正常动作+台词不误伤', !qGoodTalk.reasons.some((r) => /替对方|旁白式|几乎没有台词/.test(r)));
  // 1 对 1 场景里出现第三人称 = 凭空造人（历史里本来就有才按普通扣分）
  const qThird2 = replyQuality('*我接过冰淇淋* 他递给我，小宝在旁边看着。', { characterName: '测试角色', contextText: '（推门进来）' });
  check('凭空造人会被扣分', qThird2.reasons.some((r) => r.includes('凭空造人')));
  const qThird3 = replyQuality('*我接过冰淇淋* 他递给我。', { characterName: '测试角色', contextText: '（你提到隔壁老王）他刚走。' });
  check('历史里本来就有第三人称时不算凭空', !qThird3.reasons.some((r) => r.includes('凭空造人')));
  check('提示词的硬规定不会被"微调提示"顶掉', hintBlock('更加主动一点').includes('不要违反上面「扮演要求」里的硬性规定'));

  const qLong = replyQuality('*我把外套扔到椅子上，走到你面前停下* 东西带来了？没带就直说，别在这儿耗着。要不要先坐下说——你说了算。', { characterName: '测试角色' });
  check('长一点的正常回复也不误伤', !qLong.reasons.some((r) => /替对方|旁白式|几乎没有台词/.test(r)));

  // 描写幅度（维度图）
  check('没启用维度时不注入任何东西', dimsBlock(null) === '' && dimsBlock([]) === '' && dimsBlock('x') === '');

  const db = dimsBlock([{ name: '动作', level: 10 }, { name: '环境', level: 0 }]);
  check('维度块把档位翻译成人话（十分制）',
    db.includes('【描写幅度】') && db.includes('动作') && db.includes('10/10')
    && db.includes('环境') && db.includes('完全不要出现'));
  check('档位越界会被夹进 0~10',
    dimsBlock([{ name: '动作', level: 99 }]).includes('10/10') && dimsBlock([{ name: '动作', level: -3 }]).includes('0/10'));
  check('十分制中段档位说法正确（5/10 = 正常份量）',
    dimsBlock([{ name: '动作', level: 5 }]).includes('5/10') && dimsBlock([{ name: '动作', level: 5 }]).includes('正常份量'));
  check('常用词不在【描写幅度】里重复列',
    !dimsBlock([{ name: '常用词', level: 8 }]).includes('常用词'));

  // 常用词频率（滥用口头禅的源头：以前写死"每一两句至少带一个"）
  // v2.4.1：0 档的实际实现（v2.3.1 起）是**完全不列词表**、只给一句"别用直白生理名词"的约束
  //   （实测：只要词被看见模型就会用，所以 0 档必须不给清单）。原断言找的是
  //   已被删掉的旧文案「一次都不要用」。
  check('常用词 0 档 = 不给词表、只给约束',
    !phrasesLine(['姐姐'], 0).includes('姐姐') && phrasesLine(['姐姐'], 0).includes('不要'));
  check('常用词 0 档的措辞不是"一次都不要用"（那是会给词表的旧实现）',
    !phrasesLine(['姐姐'], 0).includes('一次都不要用'));
  check('常用词低档 = 最多一次', phrasesLine(['姐姐'], 2).includes('最多出现一次'));
  // v2.4.1：中档现在的文案是「整条回复**最多一次**；多数回合**一次都不用**」（v2.3.x 收紧过），
  //   不再是「一到两次」。断言改成看"频率是上限、不是指标"这个真正要保证的语义。
  check('常用词中档 = 是上限不是指标（默认也是这档）',
    phrasesLine(['姐姐'], 4).includes('最多一次')
    && phrasesLine(['姐姐'], null).includes('最多一次')
    && phrasesLine(['姐姐'], 4).includes('这是上限，不是指标'));
  check('常用词高档 = 可以频繁',
    phrasesLine(['姐姐'], 10).includes('频繁使用') && phrasesLine(['姐姐'], 7).includes('多用一些'));
  check('没有常用词就不生成这一段', phrasesLine([], 5) === '');

  // v2.4.1 审计修复：极简 system（compactSystem）原来把用户的开关**静默吞掉** ——
  //   维度、场景推进、关键词暗号全都不生效（实测线上 compactSystem=true，等于设置白调）。
  //   这里钉住"极简模式也要遵守这些设置"，同时钉住它仍然保持精简。
  {
    const cChar = { name: '林晚', persona: 'x', scenario: 'y' };
    const cSys = (o) => previewContext(cChar, [{ role: 'user', content: '你好' }], 7200, '',
      { compactSystem: true, localBackend: true, maxChars: 140, ...o }).messages[0].content;
    // v2.4.2：常驻知识（L1）相关 —— 之前 l1TopicPick 在 getConfig 里压根不存在（功能从未执行），
  //   而且「查看上下文」预览**完全不显示**常驻知识（真实聊天却会注入 → 典型的"预览撒谎"）。
  {
    // 注意：样例必须有**足够多**的段，否则"全选 == 全文"看不出分段生效（第一次就是这么写错的）
    const rk = '【称谓：台词里怎么说自慰】\n叫「那里」就行\n\n【敏感点与刺激方式】\n脖子、耳朵\n\n'
      + '【性交体位（写姿势时带上名字）】\n观音坐莲式\n\n【自慰：女性】\n自己弄\n\n'
      + '【口交收尾的说法】\n咽下去\n\n【女性外阴】\n耻骨联合';
    const r1 = residentKnowledgeFor({ residentKnowledge: rk, l1TopicPick: false }, '你好');
    check('★ 常驻知识：关着分段 = 整段全注入', r1.chars === rk.length && r1.block.includes('【常识参考'));
    const r2 = residentKnowledgeFor({ residentKnowledge: rk, l1TopicPick: true }, '你摸摸我的脖子');
    check('★ 常驻知识：开了分段 = 只挑相关段', r2.chars > 0 && r2.chars < rk.length && r2.picked >= 1);
    const r0 = residentKnowledgeFor({ residentKnowledge: '' }, '你好');
    check('常驻知识：没填 = 零注入', r0.chars === 0 && r0.block === '');
  }
  check('★ 极简模式：维度设置照样生效', cSys({ dims: [{ name: '环境', level: 0 }] }).includes('【描写幅度】'));
    check('★ 极简模式：场景推进照样注入', cSys({ timeNudge: '【场景推进】时间往前走一点' }).includes('时间往前走一点'));
    check('★ 极简模式：关键词暗号照样注入',
      cSys({ keywordActions: [{ kw: '雨', action: '看向窗外' }] }).includes('看向窗外'));
    const all = cSys({
      dims: [{ name: '环境', level: 0 }, { name: '动作', level: 5 }],
      timeNudge: '【场景推进】x', keywordActions: [{ kw: '雨', action: '看向窗外' }], noKnowledge: true,
    });
    check('★ 极简模式：全开也仍然精简（< 1500 字）', all.length < 1500);
  }
  const phraseCtx = previewContext({ name: '林晚', persona: 'x', phrases: '姐姐\n别急' }, [{ role: 'user', content: '（进屋）' }], 12000, '', { dims: [{ name: '常用词', level: 0 }] });
  // v2.4.1：0 档不进词表 → 系统提示词里**不能**出现这个词，改断言这一点
  check('常用词维度 0 档 = 系统提示词里不出现这个词',
    !phraseCtx.messages[0].content.includes('姐姐')
    && phraseCtx.messages[0].content.includes('不要**使用过于直白'));
  const phraseDefault = previewContext({ name: '林晚', persona: 'x', phrases: '姐姐' }, [{ role: 'user', content: '（进屋）' }], 12000, '', {});
  check('没设过常用词维度时用克制默认值', phraseDefault.messages[0].content.includes('最多一次'));
  check('自定义维度也进提示词（没有解释也不硬编）', dimsBlock([{ name: '心理', level: 4 }]).includes('心理') && dimsBlock([{ name: '心理', level: 4 }]).includes('4/10'));
  const dimsCtx = previewContext({ name: '林晚', persona: 'x' }, [{ role: 'user', content: '（进屋）' }], 12000, '', { dims: [{ name: '环境', level: 0 }] });
  const plainCtx = previewContext({ name: '林晚', persona: 'x' }, [{ role: 'user', content: '（进屋）' }], 12000, '', {});
  check('维度进了系统提示词', dimsCtx.messages[0].content.includes('【描写幅度】')
    && !plainCtx.messages[0].content.includes('【描写幅度】'));
  check('统计里给出维度字符数', dimsCtx.stats.dimsChars > 0 && plainCtx.stats.dimsChars === 0);
  // 环境按到 0 时，基础提示词里"鼓励写环境"的那条要反过来，否则模型听前半段（实测会写"（音乐声响起）"）
  const envOff = previewContext({ name: '林晚', persona: 'x' }, [{ role: 'user', content: '（进屋）' }], 12000, '', { dims: [{ name: '环境', level: 0 }] });
  check('环境=0 时基础规则被改成"不要写环境"', envOff.messages[0].content.includes('这一次不要写环境描写'));
  check('环境不为 0 时保留原来的环境规则', plainCtx.messages[0].content.includes('专门用来做环境/场景描写'));
  const envOn = previewContext({ name: '林晚', persona: 'x' }, [{ role: 'user', content: '（进屋）' }], 12000, '', { dims: [{ name: '环境', level: 3 }] });
  check('环境=3 不触发反向规则', envOn.messages[0].content.includes('专门用来做环境/场景描写'));
  check('normalizeDims 去重 / 去空 / 取整 / 夹范围', (() => {
    const n = normalizeDims([{ name: ' 动作 ', level: 3.7 }, { name: '', level: 2 }, { name: '动作', level: 1 }, null, { name: '环境', level: -9 }]);
    return Array.isArray(n) && n.length === 2 && n[0].name === '动作' && n[0].level === 4 && n[1].name === '环境' && n[1].level === 0;
  })());
  check('normalizeDims 空/非法输入当没启用', normalizeDims([]) === null && normalizeDims('x') === null && normalizeDims(null) === null);

  // 给 AI 的微调提示
  check('没写提示就不注入', hintBlock('') === '' && hintBlock('   ') === '' && hintBlock(null) === '');
  const hb = hintBlock('这次让她主动一点，别提钱');
  check('提示块带原文', hb.includes('本次微调要求') && hb.includes('别提钱'));
  check('提示块声明"不是台词"（否则模型会照抄）', hb.includes('不是角色台词') && hb.includes('不要照抄'));
  check('历史里本来就有第三人称时不算凭空（回测用）',
    !replyQuality('*我点头* 他刚走。', { characterName: '测试角色', contextText: '他昨天来过。' }).reasons.some((r) => r.includes('凭空造人')));
  check('提示超长会被截断', normalizeHint('字'.repeat(600)).length === 500 && normalizeHint('  短  ').length === '短'.length);
  const hintCtx = previewContext({ name: '林晚', persona: 'x' }, [{ role: 'user', content: '（进屋）' }], 12000, '', { hint: '别提钱' });
  check('提示进了系统提示词', hintCtx.messages[0].content.includes('别提钱'));
  check('统计里给出提示字符数', hintCtx.stats.hintChars > 0 && plainCtx.stats.hintChars === 0);

  // 提示预设（纯 UI 便利：去空 / 去重 / 限量 / 截断）
  check('预设只留合法项', (() => {
    const p = normalizeHintPresets([' 别提钱 ', '', '别提钱', '让她主动点', null, '  ']);
    return p.length === 2 && p[0] === '别提钱' && p[1] === '让她主动点';
  })());
  check('预设不是数组就当空', normalizeHintPresets('x') .length === 0 && normalizeHintPresets(null).length === 0);
  check('预设单条超长会被截断', normalizeHintPresets(['字'.repeat(600)])[0].length === 500);
  check('预设数量有上限', normalizeHintPresets(Array.from({ length: 50 }, (_, i) => `第${i}条`)).length === HINT_PRESET_MAX);

  // 场景备忘（治"忘记在干什么"）
  check('没写备忘就不注入', memoBlock('') === '' && memoBlock('  ') === '' && memoBlock(null) === '');
  const mb = memoBlock('现在在浴室，热水已经放好；她还跪着');
  check('备忘块带原文并说明是既成事实', mb.includes('场景备忘') && mb.includes('既成事实') && mb.includes('她还跪着'));
  check('备忘块声明"不是台词"', mb.includes('不是角色台词'));
  check('备忘超长会被截断', normalizeMemo('字'.repeat(1000)).length === MEMO_MAX);
  const memoCtx = previewContext({ name: '林晚', persona: 'x' }, [{ role: 'user', content: '（进屋）' }], 12000, '', { memo: '她在浴室' });
  check('备忘进了系统提示词', memoCtx.messages[0].content.includes('她在浴室'));
  check('备忘排在最后（recency 最强）',
    memoCtx.messages[0].content.indexOf('场景备忘') > memoCtx.messages[0].content.indexOf('扮演要求'));
  check('统计里给出备忘字符数', memoCtx.stats.memoChars > 0 && plainCtx.stats.memoChars === 0);

  // 重新生成：换走向的提示
  const nudge = regenerateNudge('上一版我说：进来喝杯茶吧');
  check('regenerateNudge 带回上一版内容', nudge.includes('进来喝杯茶吧'));
  check('regenerateNudge 明确要求换走向', nudge.includes('换一个') && nudge.includes('不要重复'));
  check('regenerateNudge 没有上一版时为空', regenerateNudge('') === '' && regenerateNudge(null) === '');
  check('regenerateNudge 会截断过长的上一版', regenerateNudge('啊'.repeat(500)).length < 400);

  // 后处理：剔除凭空造出来的动静
  const ctxNormal = '你是测试角色。\n（屋里的电视开着，声音不大）\n就这样吧';
  const replyBad = '*靠在床头看你*\n（门外的脚步声越发急促）\n你自己也换衣服，快点！';
  const r1 = sanitizeReply(replyBad, ctxNormal);
  check('凭空造的门外动静会被删掉', !r1.text.includes('脚步声') && r1.cleaned.length === 1);
  check('正常台词不受影响', r1.text.includes('靠在床头') && r1.text.includes('快点'));
  check('描述里有可读提示', describeCleaned(r1.cleaned).includes('脚步'));

  const ctxWithDoor = '（门外的脚步声越来越近，她皱了皱眉）\n你还愣着干什么';
  check('上文本来就有的动静不算凭空', findInventedEvents('（门外的脚步声停了）', ctxWithDoor).length === 0);
  check('上下文里的雨声不误伤', findInventedEvents('（窗外的雨声更密了）', '（外面在下雨）').length === 0);
  check('干净回复不会被改动', sanitizeReply('*笑了一下* 过来吧。', ctxNormal).cleaned.length === 0);
  check('"电视里传来敲门声"这类钻空子也要抓',
    findInventedEvents('（电视里传来敲门声，突然而急促）', '（屋里的电视开着，声音不大）').length === 1);
  check('很久以前提过的词不再放行',
    findInventedEvents('（门外传来脚步声）', '敲\n' + 'x'.repeat(1500)).length === 1);
  const rTv = sanitizeReply(
    '*手慢慢往下探* 放心，这一步给你到位。\n（电视里传来敲门声，突然而急促）\n*声音一紧* 哎呀，咋这时候还敲门？',
    '（屋里的电视开着，声音不大）',
  );
  check('造事的行和跟着演的行一起被清掉',
    rTv.cleaned.length === 2 && rTv.text.includes('给你到位') && !rTv.text.includes('敲门'));
  check('凭空造的警笛/开锁都会被清',
    sanitizeReply('（远处传来警笛声）\n（隔壁有人在开锁）\n行吧，你自己慢慢来，我先歇一会儿。', ctxNormal).cleaned.length === 2);
  check('整条几乎被删空时保留原文（安全阀）',
    sanitizeReply('（门外传来急促的脚步声）', ctxNormal).cleaned.length === 0);

  // 误删回归（真实历史里踩到的）：角色自己的动作、环境描写不能被当成凭空事件
  check('角色自己的脚步不算凭空', findInventedEvents('*脚步顿了一下，没回头*', '').length === 0);
  check('环境里的敲键盘不算凭空', findInventedEvents('（大厅很安静，只有柜员敲键盘的声音）', '').length === 0);
  check('*她敲了敲门* 是角色自己的动作', findInventedEvents('*她敲了敲门，等了两秒*', '').length === 0);
  check('没有外部来源的警笛不算入侵', findInventedEvents('*她把警笛模型摆到桌上*', '').length === 0);
  check('但"门外有人敲门"仍算凭空', findInventedEvents('（门外有人敲门）', '').length === 1);
  check('"楼道里传来脚步"仍算凭空', findInventedEvents('（楼道里传来脚步声）', '').length === 1);

  // 拖延检测（用户实际遇到的那条）
  const stallReal = '（空气中弥漫着有些压抑的气息，灯光昏暗，房间里的摆设给人一种局促的感觉）*叹了口气* 好吧，既然这样，那你先让我喝点水解渴，咱们再聊。别这么急躁嘛。';
  const sc = stallScore(stallReal);
  check('真实拖延样本能被识别（≥2 个说法）', sc.score >= 2);
  check('拖延提示可读', describeStall(sc.words).includes('拖延'));
  check('正常回复不误判', stallScore('*抓住你的手腕按在墙上* 少废话，过来。').score < 2);
  check('空回复不误判', stallScore('').score === 0);

  // 综合质量分（择优用）
  const qGood = replyQuality('*伸手把你按在墙上，低头咬了下你的肩膀，另一只手顺着腰往下滑* 别问了，姐现在只想让你说不出话。你要是还有力气说话，那说明我做得还不够。', { contextText: '（屋里灯很暗）' });
  const qBad = replyQuality(stallReal, { contextText: '（屋里灯很暗）' });
  check('好回复分数低', qGood.score <= 1);
  check('拖延回复分数高', qBad.score >= 4);
  check('质量提示可读', describeQuality(qBad.reasons).includes('质量'));
  const qRepeat = replyQuality('*抓住你的手腕按在墙上* 少废话，过来。', { previousReply: '*抓住你的手腕按在墙上* 少废话，过来。' });
  check('复读会被识别', qRepeat.reasons.some((r) => r.includes('雷同')));
  const qAsk = replyQuality('*看了你一眼* 你想怎么样呢？', { contextText: '' });
  check('以问句收尾会被扣分', qAsk.reasons.includes('以问句收尾'));
  // 实测漏判样本（用户贴回来的那条）
  const realOne = '*我翻身抵住你背脊，手指勾起你的衣角往下撩*\n\n来嘛，让你看看姐姐的套路。\n\n手指边搓边往下滑，轻啧一声——够用了？还没完呢，\n想不想看我亲口说？\n（窗外传来轻微雷响';
  const cleanedReal = sanitizeReply(normalizeMarkup(realOne), '（我推门进来，屋里没别人）');
  check('凭空造的雷响会被清掉', cleanedReal.cleaned.length === 1 && !cleanedReal.text.includes('雷响'));
  check('没带"你"的"想不想"也算征询许可',
    replyQuality(cleanedReal.text, { contextText: '' }).reasons.some((r) => r.includes('征询许可')));
  check('这条最终会被重抽',
    replyQuality(cleanedReal.text, { contextText: '' }).score >= 4);
  check('重复的征询说法不重复计数（想不想 / 你想不想）',
    replyQuality('*点头* 你想不想试试？', { contextText: '' }).reasons.filter((r) => r.includes('征询许可')).length === 1);

  // 征询许可 / 具身推进 / 空回复
  const qConsult = replyQuality('*看了你一眼* 要不要先坐下？我给你倒杯水，咱们慢慢聊，好吗？', { contextText: '' });
  check('征询许可会被识别', qConsult.reasons.some((r) => r.includes('征询许可')));
  check('征询许可分数偏高', qConsult.score >= 4);
  const qMove = replyQuality('*没答话，直接俯身把你压在沙发靠背上，手指扣住你的手腕* 别出声。', { contextText: '' });  const qIdle = replyQuality('*她站着，没答话。*', { contextText: '' });
  check('具身推进会减分', qMove.score < qIdle.score);
  check('空回复被重罚', replyQuality('*林晚', {}).reasons.includes('几乎是空的'));
  check('分数不为负', qMove.score >= 0);

  // 真实漏判样本：*歪着头挑眉* 你说呢？你想怎么玩儿？我们可以试试不一样的。
  const qBall = replyQuality('*歪着头挑眉，眼神带着笑* 你说呢？你想怎么玩儿？我们可以试试不一样的。', { contextText: '' });
  check('把球踢回对方的回复会被重抽', qBall.score >= 4);
  check('连问两次会被识别', qBall.reasons.some((r) => r.includes('连问')));
  check('"你说呢/你想怎么"会被算作征询许可', qBall.reasons.some((r) => r.includes('征询许可')));
  check('历史清洗会删掉征求意见的问句',
    !cleanHistoryText('*歪着头挑眉* 你说呢？你想怎么玩儿？过来。', '').text.includes('你说呢'));
  check('历史清洗保留真正有动作的那句',
    cleanHistoryText('*歪着头挑眉* 你说呢？你想怎么玩儿？过来。', '').text.includes('过来'));

  // "您"要和"你"一样被识别（实测 zh-rp8b 满嘴"您"，把整套模式全漏掉了）
  const qNin = replyQuality('*微微欠身* 您有什么需要吗？您想怎么安排，我都听您的。', { contextText: '' });
  check('"您"会被当作"你"匹配', qNin.reasons.some((r) => r.includes('征询许可')));
  check('"您"版本也会被判重抽', qNin.score >= 4);
  // 真实样本：整轮都在请示，自己一个动作都没有
  const qAsk2 = replyQuality('*测试角色静静地注视着你，眼中闪过一丝好奇的光芒*您想要我做些什么呢？(她优雅地转身坐在你的面前)请告诉我您的要求。', { contextText: '' });
  check('只请示不推进会被判废', qAsk2.reasons.includes('只请示不推进') && qAsk2.score >= 4);
  check('真推进不会被判废',
    replyQuality('*她没答话，直接俯身把你压在沙发靠背上，手指扣住你的手腕* 别出声。', { contextText: '' }).reasons.includes('只请示不推进') === false);
  check('问了话但零推进会被判废（结构化判定，不靠词表）',
    replyQuality('*微微一笑* 请问有什么我可以为您做的吗？', { contextText: '' }).reasons.includes('只问不做'));

  // 整句复读：连着两轮写同一句环境描写
  const ctxRepeat = '*她笑了笑* 嗯，是的。\n（空气中弥漫着淡淡的花香和薄荷味）';
  const qDup = replyQuality('*她走到你身边坐下* （空气中弥漫着淡淡的花香和薄荷味）', { contextText: ctxRepeat });
  check('整句照抄历史会被扣分', qDup.reasons.some((r) => r.includes('整句复读')));
  check('整句复读分数会超阈值', qDup.score >= 3);
  check('短句回调不算复读',
    !replyQuality('*她看了你一眼* 你又来了。', { contextText: '（我推门进来）你又来了。' }).reasons.some((r) => r.includes('复读')));

  // 「动作开头」前缀
  // 注意：**不能用角色名** —— 那等于教模型用第三人称起手（实测回复里会冒出
  // "*林晚的声音更低沉了一些*"这种旁白），本程序的约定是第一人称。
  check('前缀用第一人称', openingPrefill({ name: '林晚' }) === '*我');
  check('换一版时用省略主语的开头', openingPrefill({ name: '林晚' }, 1) === '*');
  check('没名字也是第一人称', openingPrefill({}) === '*我');
  check('重试会换一种前缀写法', openingPrefill({ name: '林晚' }, 1) !== openingPrefill({ name: '林晚' }, 0));

  // 人称规整（出戏的第三人称）
  check('动作段里的角色名会改成"我"',
    normalizePerson('*测试角色的声音更低沉了一些*', '测试角色') === '*我的声音更低沉了一些*');
  check('引号外的旁白式自称也会改成"我"',
    normalizePerson('测试角色抬手揉了揉我的肩膀。', '测试角色') === '我抬手揉了揉我的肩膀。');
  check('引号里的名字不动（台词里可能是有意说的）',
    normalizePerson('她说：“测试角色不干了。”', '测试角色') === '我说：“测试角色不干了。”');
  check('动作段开头的他/她会改成"我"',
    normalizePerson('*她的表情却是一种惊讶与犹豫*', '测试角色') === '*我的表情却是一种惊讶与犹豫*');
  check('"她的"也会变成"我的"',
    normalizePerson('*她用手撑起身子*', '测试角色') === '*我用手撑起身子*');
  check('台词里的名字不动（只有引号内才保留）',
    normalizePerson('“测试角色不干了。”', '测试角色') === '“测试角色不干了。”');
  check('旁白里的说话人标签也会改成"我"',
    normalizePerson('测试角色说：你好。', '测试角色') === '我说：你好。');
  check('环境描写里的名字也改成"我"（也是自称）',
    normalizePerson('（测试角色站在窗边）', '测试角色') === '（我站在窗边）');
  check('台词中间的他/她不动（可能指第三方）',
    normalizePerson('*点头* 他刚才来过吗？', '测试角色') === '*点头* 他刚才来过吗？');
  check('第一人称的动作不会被改',
    normalizePerson('*我抬手按住你的肩*', '测试角色') === '*我抬手按住你的肩*');
  check('"他们/她们"不能被改成"我们"',
    normalizePerson('*我看了他们一眼*', '测试角色') === '*我看了他们一眼*'
    && normalizePerson('*她们都走了*', '测试角色') === '*她们都走了*');

  // —— v0.39：把"第三人称"堵彻底（用户反馈"还是会有"之后加的）——
  check('光秃秃的旁白：标了台词的回复里，引号外一律算旁白',
    normalizePerson('她抬起头，看了你一眼。"嗯。"', '测试角色') === '我抬起头，看了你一眼。"嗯。"');
  check('环境括号里的他/她也会改（旧版只改 *…* 段）',
    normalizePerson('（她的呼吸有点乱）', '测试角色') === '（我的呼吸有点乱）');
  check('星号块之后紧跟着的旁白也会改（旧版漏）',
    normalizePerson('*笑了一下*她转过身。"你要走了？"', '测试角色') === '*笑了一下*我转过身。"你要走了？"');
  check('连接词后面的人称也会改（虽然她…）',
    normalizePerson('虽然她嘴上这么说，手却更用力了。"别动。"', '测试角色') === '虽然我嘴上这么说，手却更用力了。"别动。"');
  check('同一小句里已有"我"时，他/她只能是别人（不改）',
    normalizePerson('*我接过冰淇淋* 他递给我。', '测试角色') === '*我接过冰淇淋* 他递给我。');
  check('"我拉住她的手" → 对方就是"你"',
    normalizePerson('*我拉住她的手*', '测试角色') === '*我拉住你的手*');
  check('旁白里"他的/她的"→"你的"（角色一律自称"我"）',
    normalizePerson('*我看了一眼他的神态*', '测试角色') === '*我看了一眼你的神态*'
    && normalizePerson('（小床挨着他的床摆在墙角）', '测试角色') === '（小床挨着你的床摆在墙角）');
  check('没标台词的回复里，光秃秃的文字当台词，不改人称（避免改坏台词）',
    normalizePerson('*点头* 他刚才来过吗？', '测试角色') === '*点头* 他刚才来过吗？');
  check('台词（引号内）的人称一个字都不动',
    normalizePerson('“他昨天来过。”她说。', '测试角色') === '“他昨天来过。”我说。');
  check('角色名在任何位置都改（和有没有引号无关）',
    normalizePerson('测试角色抬起头。', '测试角色') === '我抬起头。');
  // 判定（决定要不要重抽）要比改写激进：改不掉的必须能被抓到
  check('改写不掉的主语第三人称会被判定抓到（→ 重抽）',
    thirdPersonSubjects('她抬起头，看了你一眼。').length > 0
    && thirdPersonSubjects('*笑了一下*她转过身。').length > 0);
  check('台词里的他/她不会被误判',
    thirdPersonSubjects('“他昨天来过。”').length === 0);
  check('宾语位置的他/她不会被误判（听他的）',
    thirdPersonSubjects('听他的，把模取了。').length === 0);
  check('同一小句里有"我"时不算自称（他递给我）',
    thirdPersonSubjects('*我接过冰淇淋* 他递给我。').length === 0);
  check('主语第三人称会触发重抽（分数够门槛）',
    replyQuality('她抬起头，看了你一眼。', { characterName: '测试角色', contextText: '（你提到隔壁老王）他刚走。' })
      .reasons.some((r) => r.includes('用他/她写自己')));
  check('人称重抽提示用得上', personNudge().includes('第三人称') && personNudge().includes('我'));

  // —— v0.42：万能小动作（低头一笑这类空动作）——
  check('空动作会被删掉，同块里具体的动作留下',
    stripClicheActions('*我低头一笑，手指蘸了蘸大腿间的爱液*') === '*手指蘸了蘸大腿间的爱液*');
  check('整块都是空动作就整块删掉',
    stripClicheActions('*微微一笑*') === '' && stripClicheActions('*我叹了口气* 行吧。') === '行吧。');
  check('只删空动作，不碰同一块里别的动作',
    stripClicheActions('*伸手接过杯子，低头一笑，抿了一口*') === '*伸手接过杯子，抿了一口*');
  check('不是空动作的描写一个字不动',
    stripClicheActions('*我轻轻碰了碰你的手背，眼神带着满足*') === '*我轻轻碰了碰你的手背，眼神带着满足*'
    && stripClicheActions('*我抬手拍了拍你的肩膀，眼神里带着慵懒笑意*') === '*我抬手拍了拍你的肩膀，眼神里带着慵懒笑意*');
  check('星号块之外（台词）不动', stripClicheActions('低头一笑，然后坐下了。') === '低头一笑，然后坐下了。');
  check('空动作能数出来', countClicheActions('*我低头一笑，手指蘸了蘸*') === 1
    && countClicheActions('*微微一笑*') === 1
    && countClicheActions('*我抬手拍了拍你的肩膀*') === 0);
  check('空动作会被扣分（让重抽偏向没写的那版）',
    replyQuality('*我低头一笑* 够多…再来点咋样？', { characterName: '小满', originalText: '*我低头一笑* 够多…再来点咋样？' })
      .reasons.some((r) => r.includes('空动作')));
  check('空动作重抽提示用得上', clicheNudge().includes('空动作') && clicheNudge().includes('台词'));

  // —— v0.45：资料库（检索式"喂知识"）——
  const kbText = [
    '[常驻] 她左手腕上有一道旧疤，从不让人碰。',
    '',
    '她在城南的小旅馆做了三年，老板姓周，工钱月结从不拖欠。',
    '',
    '她怕烫，喝水前一定先吹两口。',
    '',
    '她 seventeen 岁那年离开老家，之后再没回去过。',
  ].join('\n');
  check('资料按空行切块', chunkText(kbText).length === 4);
  check('长段落会按句切开、按上限合并',
    chunkText('一。'.repeat(200), 100).every((c) => c.length <= 100));
  check('常驻块每轮都带上',
    pickChunks(kbText, '随便说点什么').some((c) => c.includes('旧疤')));
  check('相关的那块会被挑中（不是按顺序硬塞）', (() => {
    const got = pickChunks(kbText, '你喝水的时候小心点，刚烧开的');
    return got.some((c) => c.includes('怕烫'));
  })());
  check('不相关的内容不会被塞进来', (() => {
    const got = pickChunks(kbText, '你喝水的时候小心点，刚烧开的');
    return !got.some((c) => c.includes('老板姓周'));
  })());
  check('挑不中就不注入（不浪费上下文）',
    pickChunks('完全无关的内容。', '今天天气不错').length === 0
    && pickChunks(kbText, '').every((c) => c.includes('常驻') || c.includes('旧疤')));
  check('注入上限会截断',
    pickChunks(kbText, '小旅馆 老板 周 工钱', { maxChars: 30 }).every((c) => c.length <= 30));
  check('资料块声明了"不是台词、别照抄"', (() => {
    const b = knowledgeBlock(['她怕烫。']);
    return b.includes('资料') && b.includes('不是台词') && b.includes('不要照抄') && b.includes('她怕烫');
  })());
  check('没有资料时不注入', knowledgeBlock([]) === '' && knowledgeBlock(null) === '');

  // —— 共享资料库：直连 + 所有角色读同一份 ——
  await req('PUT', '/api/knowledge/shared', { text: '[常驻] 共享暗号：海豚。' });
  await req('PUT', '/api/knowledge', { characterId: guardChar.id, text: '[常驻] 角色暗号：山猫。' });
  r = await req('GET', `/api/knowledge?characterId=${guardChar.id}`);
  check('共享资料能存能读，角色资料也还在',
    String(r.data.sharedText || '').includes('海豚') && String(r.data.text || '').includes('山猫'));
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('★ 角色模式同时注入「共享 + 这个角色」两份资料',
    String(r.data.system || '').includes('海豚') && String(r.data.system || '').includes('山猫'));
  const sharedD = (await req('POST', '/api/direct/sessions', {})).data.session;
  r = await req('GET', `/api/direct/context?sessionId=${sharedD.id}`);
  check('★ 直连模式读的是同一份共享资料（不读角色那份）',
    String(r.data.system || '').includes('海豚') && !String(r.data.system || '').includes('山猫'));
  r = await req('GET', '/api/knowledge/shared');
  check('共享资料库有独立接口，scope=shared', r.data.scope === 'shared' && r.data.text.includes('海豚'));
  r = await req('GET', '/api/direct/knowledge');
  check('旧接口 /api/direct/knowledge 仍可用（向下兼容）', r.status === 200 && r.data.text.includes('海豚'));
  // 收尾：清空，避免影响后面的用例
  await req('PUT', '/api/knowledge/shared', { text: '' });
  await req('PUT', '/api/knowledge', { characterId: guardChar.id, text: '' });

  // —— v0.46：朗读（TTS）——
  check('朗读只读台词，不读 *动作* 和（环境）', (() => {
    const t = speechText('*抬起手* 你到底想干什么？（屋里安静下来）别装了。');
    return t.includes('你到底想干什么') && t.includes('别装了') && !t.includes('抬起手') && !t.includes('安静');
  })());
  check('全是动作/环境时退回读原文（不至于点了没声音）',
    speechText('*他笑了笑*').includes('他笑了笑'));
  check('换行会连成一句，不读成停顿', speechText('第一句。\n第二句。') === '第一句。第二句。');
  check('空回复返回空串', speechText('') === '' && speechText('   ') === '');
  check('朗读文本有长度上限', speechText('字'.repeat(5000), 100).length === 100);
  check('同样的文本+参数 → 同样的缓存键',
    ttsCacheKey({ text: '你好', voice: 'a' }) === ttsCacheKey({ text: '你好', voice: 'a' })
    && ttsCacheKey({ text: '你好', voice: 'a' }) !== ttsCacheKey({ text: '你好', voice: 'b' }));
  check('TTS 默认值补齐（地址留空 = 没配）', (() => {
    const t = normalizeTts(null);
    return t.baseUrl === '' && t.model === 'tts-1' && t.voice === 'alloy' && t.speed === 1 && t.format === 'mp3';
  })());
  check('TTS 非法参数会被收进合法范围',
    (() => { const t = normalizeTts({ speed: 99, format: 'rmvb', model: '' }); return t.speed === 2 && t.format === 'mp3' && t.model === 'tts-1'; })());
  check('TTS 音色名不受限制（只是转发给本地服务）', normalizeTts({ voice: '中文-小满' }).voice === '中文-小满');
  check('语言自动触发默认关，勾了才开',
    normalizeTts(null).auto === false && normalizeTts({ auto: true }).auto === true
    && normalizeTts({ auto: 'yes' }).auto === false);
  check('"他们"不算第三人称自称（不扣分）',
    !replyQuality('*我看着他们* 你们一起上吧。', { characterName: '测试角色' }).reasons.some((r) => r.includes('他/她')));
  check('"其他/他人"也不算',
    !replyQuality('*我不管其他人* 你说了算。', { characterName: '测试角色' }).reasons.some((r) => r.includes('他/她')));

  // 第三人称要扣分（这样重抽才会偏向第一人称的那一版）
  const qThird = replyQuality('*测试角色的声音更低沉了一些* 好，这回听话。', { characterName: '测试角色' });
  check('写角色名字会被扣分', qThird.reasons.some((r) => r.includes('名字')));
  const qPron = replyQuality('*她的表情却是一种犹豫* 别动。', { characterName: '测试角色' });
  check('用他/她指代自己会被扣分', qPron.reasons.some((r) => r.includes('他/她')));
  const qFirst = replyQuality('*我抬手按住你的肩* 别动。', { characterName: '测试角色' });
  check('第一人称不扣分', !qFirst.reasons.some((r) => r.includes('名字') || r.includes('他/她')));


  // 前缀拼接：保证前缀在文本里不多不少出现一次，*动作* 的星号保持配对
  const collect = () => { const out = []; return { out, onDelta: (t) => out.push(t) }; };
  const c1 = collect();
  const s1 = makePrefixJoiner('*林晚', c1.onDelta);
  s1.push('*林');
  check('前缀没收完之前先扣住', c1.out.join('') === '');
  s1.push('晚');
  check('前缀收完立刻吐出（星号保留）', c1.out.join('') === '*林晚');
  s1.push('没有回答，');
  s1.push('只是走过来。');
  s1.flush();
  check('续写内容接在前缀后面', c1.out.join('') === '*林晚没有回答，只是走过来。');
  check('拼接后的全文正确', s1.text === '*林晚没有回答，只是走过来。');
  const c2 = collect();
  const s2 = makePrefixJoiner('*林晚', c2.onDelta);
  s2.push('她没回话');
  s2.flush();
  check('服务端不回显前缀时自己补上', c2.out.join('') === '*林晚她没回话');
  const c3 = collect();
  const s3 = makePrefixJoiner('', c3.onDelta);
  s3.push('直接放行');
  check('没有前缀时不影响流式', c3.out.join('') === '直接放行' && s3.text === '直接放行');
  check('重试会换一种前缀写法', openingPrefill({ name: '林晚' }, 1) === '*');

  // 发送前清洗历史（只影响这次请求，存档不动）
  const dirty = '*倒了两杯水放在桌上* 你先喝点水，咱们别急，慢慢来，准备好再说。';
  const cleanedOne = cleanHistoryText(dirty, '');
  check('历史清洗会去掉成句的拖延台词', !cleanedOne.text.includes('慢慢来'));
  check('历史清洗保留了动作段', cleanedOne.text.includes('*倒了两杯水放在桌上*'));
  check('历史清洗报告了改动', cleanedOne.changed === true);
  check('干净的历史不会被改', cleanHistoryText('*我靠近一步，手搭在你肩上* 别动。', '').changed === false);
  check('一句话里的重叠说法不重复计数',
    cleanHistoryText('*她把门带上* 你先坐，我去倒杯水。', '').changed === false);
  check('立规矩式的短句会被清', cleanHistoryText('*活动了下脖子* 先说好啊。接下来听我的。', '').text.includes('先说好') === false);
  check('历史清洗不会把整条删空', cleanHistoryText('别急。慢慢来。', '').text.trim().length > 0);
  const hist = [
    { role: 'user', content: '（进屋）' },
    { role: 'assistant', content: '（门外传来敲门声）\n别急，咱们慢慢来。\n*她把杯子推过来*' },
    { role: 'user', content: '（坐下）' },
    { role: 'assistant', content: '*我走近，低头看你* 说吧。' },
  ];
  const cleanedHist = cleanHistory(hist);
  check('整段历史清洗统计正确', cleanedHist.cleanedCount === 1);
  check('历史清洗报告删掉了多少字', cleanedHist.removedChars > 0);

  // 历史清洗必须"宁可留套路，不丢剧情"（实测踩过的坑）
  check('只含一个信号的问题句不再被删（用户回答过的问题）',
    cleanHistoryText('*看了你一眼* 衣服，你自己脱还是我帮你？', '').text.includes('还是我帮你'));
  check('两个以上信号才删（纯拖延套话照样清掉）',
    !cleanHistoryText('*叹了口气，把杯子轻轻放在桌角上* 别急，慢慢来，我们再说。', '').text.includes('慢慢来'));
  check('只剩动作块时触发安全阀（不把整条删空）',
    cleanHistoryText('*叹了口气* 别急，慢慢来。', '').changed === false);
  check('口语短句不再被误删',
    cleanHistoryText('*把灯关了* 行，随你。', '').text.includes('随你'));
  check('早就确立的场景细节不会被当成凭空动静',
    cleanHistoryText('（电视里换了个场景，正好盖住隔壁的动静）', '（屋里很黑，你把灯关了）').text.includes('隔壁'));
  check('被清洗的那条去掉了凭空动静', !cleanedHist.messages[1].content.includes('敲门声'));
  check('干净的那条原样不动', cleanedHist.messages[3].content === hist[3].content);
  const withClean = previewContext({ name: '林晚', persona: 'x' }, hist, 12000, '', { cleanHistory: true });
  const withoutClean = previewContext({ name: '林晚', persona: 'x' }, hist, 12000, '', { cleanHistory: false });
  check('上下文接口反映清洗结果', withClean.stats.historyCleaned === 1 && withoutClean.stats.historyCleaned === 0);
  check('清洗后的上下文不含被删的套路', !withClean.messages.map((m) => m.content).join('').includes('慢慢来'));
  check('不清洗时上下文保留原文', withoutClean.messages.map((m) => m.content).join('').includes('慢慢来'));

  r = await req('GET', '/api/config');
  check('默认开启历史清洗', r.data.cleanHistory === true);
  await req('PUT', '/api/config', { cleanHistory: false });
  r = await req('GET', '/api/config');
  check('历史清洗可以关掉', r.data.cleanHistory === false);
  await req('PUT', '/api/config', { cleanHistory: true });

  r = await req('GET', '/api/config');
  check('默认开启动作开头', r.data.forceAction === true);
  await req('PUT', '/api/config', { forceAction: false });
  r = await req('GET', '/api/config');
  check('动作开头可以关掉', r.data.forceAction === false);
  await req('PUT', '/api/config', { forceAction: true });

  // 「已否决的版本」：采用接口 / 换回来 / 各种非法输入
  const vetoChars = (await req('GET', '/api/characters')).data.characters;
  const vetoSess = (await req('POST', '/api/sessions', { characterId: vetoChars[0].id })).data.session;
  const vetoFile = path.join(TMP_DATA, 'sessions', `${vetoSess.id}.json`);
  const vetoDoc = JSON.parse(await readFile(vetoFile, 'utf8'));
  vetoDoc.messages = [
    { role: 'user', content: '（进去）', at: 1 },
    {
      role: 'assistant',
      content: '当选中的这一版',
      at: 2,
      rejected: [
        { text: '被否决的第一版', reason: '质量分偏低', source: 'quality', at: 3 },
        { text: '被否决的第二版', reason: '清理前：含凭空动静', source: 'cleaned', at: 4 },
      ],
    },
  ];
  await writeFile(vetoFile, JSON.stringify(vetoDoc), 'utf8');

  r = await req('PATCH', `/api/sessions/${vetoSess.id}`, { action: 'adopt', index: 1, rejectedIndex: 0 });
  check('采用已否决的版本', r.status === 200 && r.data.session.messages[1].content === '被否决的第一版');
  check('被换下的那版进入否决列表', r.data.session.messages[1].rejected[0].text === '当选中的这一版');
  r = await req('PATCH', `/api/sessions/${vetoSess.id}`, { action: 'adopt', index: 1, rejectedIndex: 0 });
  check('可以再换回来（可逆）', r.data.session.messages[1].content === '当选中的这一版');
  r = await req('PATCH', `/api/sessions/${vetoSess.id}`, { action: 'adopt', index: 1, rejectedIndex: 99 });
  check('版本下标越界会被拒', r.status === 400);
  r = await req('PATCH', `/api/sessions/${vetoSess.id}`, { action: 'adopt', index: 0, rejectedIndex: 0 });
  check('没有否决版本的消息会被拒', r.status === 400);

  r = await req('GET', '/api/config');
  check('默认开启自动清理', r.data.autoClean === true);
  check('括号补齐默认开启', r.data.autoPair === true);
  await req('PUT', '/api/config', { autoPair: false });
  r = await req('GET', '/api/config');
  check('括号补齐可以关掉', r.data.autoPair === false);
  await req('PUT', '/api/config', { autoPair: true });
  r = await req('GET', '/api/config');
  check('括号补齐可以再打开', r.data.autoPair === true);

  // 字数上限：接口层读写
  r = await req('PUT', '/api/config', { maxChars: 150 });
  check('字数上限能保存', r.status === 200);
  r = await req('GET', '/api/config');
  check('字数上限能读回', r.data.maxChars === 150);
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  // v2.4.2：**字数下限整体删除**，字数只保留用户自己设的那一个上限。
  //   历史 bug：重抽会要求"至少写 440 字"而上限是"不超过 420 字"，同一轮自相矛盾。
  {
    const wcPat = /\d+\s*~\s*\d+\s*字|\d+\s*字是硬下限|至少写 \d+ 字|每轮 \d+/;
    const wcSys = (o) => previewContext({ name: '林晚', persona: 'x' }, [{ role: 'user', content: '你好' }], 7200, '', o).messages[0].content;
    check('★ 字数限制：没设上限时提示词里一个字都不提字数',
      !wcSys({ localBackend: true }).match(wcPat)
      && !wcSys({ compactSystem: true, localBackend: true }).match(wcPat)
      && !wcSys({ localBackend: false, fullSystem: true }).match(wcPat));
    check('★ 字数限制：设了上限就只出现那一个上限（不再有区间/硬下限）',
      wcSys({ localBackend: true, maxChars: 140 }).includes('不要超过 140 字')
      && !wcSys({ localBackend: true, maxChars: 140 }).match(wcPat));
    check('★ 字数限制：「上一版太单薄」提示里不再带任何字数数字',
      !/\d+\s*字/.test(detailNudge(440, 100)) && detailNudge().includes('补 2 个'));
    check('★ 字数限制：本地后端不再有 420 字兜底上限',
      effectiveMaxChars(0, { localBackend: true }) === 0);
  }
  check('字数上限进了上下文接口',
    r.data.stats.maxChars === 150 && r.data.system.includes('不要超过 150 字'));
  await req('PUT', '/api/config', { maxChars: 0 });
  r = await req('GET', '/api/config');
  check('字数上限可以关掉', r.data.maxChars === 0);

  // ★「查看上下文」必须和真发出去的那份一致 —— v0.53.0 这里漏传过 thinkOff，
  //   于是开关开着、预览里却看不到 /no_think（预览撒谎是这类功能最致命的 bug）。
  await req('PUT', '/api/config', { thinkOff: true });
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  // v2.4.1：/no_think 是拼在 system 里的（previewContext 追加），但**不保证是最后一段**
  //   （等义词块在它之前拼接、后续还可能追加别的块）。断言改成"确实在 system 里"。
  // v2.4.1：这条曾经是"预览撒谎"的看门断言（v0.53.0 漏传 thinkOff），
  //   但现在**关思考的入口按模型分派**（见 lib/ollama.js thinkControl）：
  //   认识的模型一律走请求体 think:false，system 里写 /no_think 反而会污染提示词。
  //   所以断言改成两件事：① 认识的模型 → 请求体路径、system 里**没有** /no_think；
  //   ② 认不出的模型 → 才回落到 system 里的 /no_think。
  // v2.4.1：关思考改为「问服务端能力再决定」（见 thinkPlan），system 里**一律不写** /no_think；
  //   这里只保证：开关打开后预览不会骗人（thinkControl 有说法、system 没被污染）。
  check('★ 关掉思考：预览如实说明走哪种方式，且 system 里不写 /no_think',
    r.status === 200
    && String(r.data.thinkControl || '').length > 0
    && !String(r.data.system || '').includes('/no_think'));
  // 顺带钉住一个事实：thinkControl() 目前**任何模型名都返回 think_false**
  //   （v2.3.x 起所有分支都改成了请求体，最后一行的兜底也是 think_false）。
  //   也就是说 thinkPlan().systemInject 现在是**不可达的**，system 里永远不会出现 /no_think ——
  //   previewContext 里那条 `if (opts.thinkOff) system += NO_THINK` 目前是死分支。
  //   这是 v2.4.1 审计记录在案的现状，这里只做回归保护，不改行为。
  const unknownControl = thinkControl('model-with-unknown-thinking');
  check('关掉思考：thinkControl 对所有模型都走请求体（system 注入路径目前不可达）',
    unknownControl === 'think_false');
  await req('PUT', '/api/config', { thinkOff: false });
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('★ 关掉思考：关回去后「查看上下文」里没有 /no_think',
    r.status === 200 && !String(r.data.system || '').includes('/no_think'));

  // ── 等义词「输出侧」（v0.56.0）：默认只教"听懂"，标记/开关才要求"回答也这么说" ──
  check('等义词：默认只教"听懂"，不要求"这么说"',
    !synonymsBlock('码农 = 程序员').includes('回答时也用') && synonymsBlock('码农 = 程序员').includes('理解'));
  const synMark = synonymsBlock('码农 = 程序员 #输出\n搬砖 = 上班');
  check('等义词：标了 #输出 的条目进输出侧（标记不混进词条、没标的仍只在理解侧）',
    synMark.includes('回答时也用') && synMark.includes('说「码农」') && !synMark.includes('#输出')
    && !synMark.includes('说「搬砖」'));
  const synAll = synonymsBlock('码农 = 程序员\n搬砖 = 上班', { output: true });
  check('等义词：总开关打开 → 整张表都进输出侧',
    synAll.includes('说「码农」') && synAll.includes('说「搬砖」'));
  check('等义词：空表 / 只有注释 → 空串（零注入）',
    synonymsBlock('') === '' && synonymsBlock('# 注释') === '' && synonymsBlock('没有等号的一行') === '');
  check('等义词：输出侧那句声明了"不要把要求本身复述出来"',
    synMark.includes('不要把这段要求本身复述出来'));

  // 接口层：两处注入都得跟着开关/标记走（预览撒谎是这类功能最致命的 bug）
  await req('PUT', '/api/config', { synonyms: '码农 = 程序员 #输出', synonymsOutput: false });
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('★ 等义词：标了 #输出 → 角色模式的「查看上下文」里出现"回答时也用"',
    r.status === 200 && /回答时也用/.test(String(r.data.system || '')));
  await req('PUT', '/api/config', { synonyms: '码农 = 程序员', synonymsOutput: true });
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('★ 等义词：总开关打开 → 没标记的也进输出侧', /说「码农」/.test(String(r.data.system || '')));
  r = await req('GET', '/api/config');
  check('等义词：开关能存能读', r.data.synonymsOutput === true);
  await req('PUT', '/api/config', { synonyms: '', synonymsOutput: false });
  r = await req('GET', `/api/context?sessionId=${guardSess.id}`);
  check('等义词：清空后回到零注入（system 里没有"回答时也用"）',
    !String(r.data.system || '').includes('回答时也用') && (await req('GET', '/api/config')).data.synonymsOutput === false);

  // 接口地址写坏了要在保存时就报错（而不是等到聊天时报 ECONNREFUSED）
  const goodBase = (await req('GET', '/api/config')).data.baseUrl;
  r = await req('PUT', '/api/config', { baseUrl: 'http://127.0.0.1' });
  check('本地地址漏端口会被拦下', r.status === 400 && /端口/.test(r.data.error));
  r = await req('PUT', '/api/config', { baseUrl: '不是网址' });
  check('完全不成形的地址会被拦下', r.status === 400 && /网址/.test(r.data.error));
  r = await req('PUT', '/api/config', { baseUrl: 'ftp://127.0.0.1:11434/v1' });
  check('非 http(s) 协议会被拦下', r.status === 400);
  r = await req('GET', '/api/config');
  check('被拦下时配置没被改坏', r.data.baseUrl === goodBase);
  r = await req('PUT', '/api/config', { baseUrl: 'http://192.168.1.10:11434/v1' });
  check('内网带端口可以保存', r.status === 200);
  await req('PUT', '/api/config', { baseUrl: goodBase });  await req('PUT', '/api/config', { autoClean: false });
  r = await req('GET', '/api/config');
  check('自动清理可以关掉', r.data.autoClean === false);
  await req('PUT', '/api/config', { autoClean: true });

  // ── 预热失败要说人话（v0.58.0）：装不进显存时 Ollama 不是干净 OOM，而是 llama-server 崩掉 ──
  const vramErr = describePreloadFailure(500, '{"error":"llama-server process has terminated: exit status 0xc0000409: The system detected an overrun of a stack-based buffer in this application.: CUDA error\\nCUDA error: shared object initialization failed"}');
  check('★ 预热失败：CUDA 崩掉那类会被翻译成"装不进显存"+ 怎么救',
    /装不进显存/.test(vramErr) && /num_ctx/.test(vramErr) && /换个小一点的模型/.test(vramErr));
  check('预热失败：不是 CUDA 那类就照原样报（带 HTTP 码）',
    describePreloadFailure(404, 'model not found').startsWith('预热失败（HTTP 404）'));
  check('预热失败：原始错误仍然保留（方便排查）',
    vramErr.includes('shared object initialization failed'));

  // ================= 应用内「切模型」（v0.55.0：不用再敲命令行） =================
  // ① 列本机模型：本机 Ollama 起没起都得 200 且结构稳定（前端据此渲染列表）
  r = await req('GET', '/api/local-models');
  check('切模型：/api/local-models 结构稳定（200 + ok + models）',
    r.status === 200 && typeof r.data.ok === 'boolean' && Array.isArray(r.data.models)
    && typeof r.data.current === 'string'
    && (r.data.ok
      ? r.data.models.every((m) => m.name && typeof m.sizeBytes === 'number' && typeof m.thinking === 'boolean')
      : typeof r.data.error === 'string'));
  check('切模型：列表里不泄漏 API Key', !/sk-/.test(JSON.stringify(r.data)));

  // ② 不给模型名 → 400
  r = await req('POST', '/api/switch-model', {});
  check('切模型：没给模型名会被拒绝（400）', r.status === 400);

  // ③ 从云端切到本机模型：baseUrl / Key / 模型名 一次配好，云端那套自动存下来
  const keyBefore = (await storeConfig()).apiKey;   // PUT 空串 = 不改，所以收尾要显式传回原值
  await req('PUT', '/api/config', { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-cloud-test', thinkOff: false });
  r = await req('POST', '/api/switch-model', { model: 'qwen3-14b-abl-q8' });
  check('切模型：一键切到本机（Base URL 指回 Ollama、Key 变 ollama、模型名对）',
    r.status === 200 && r.data.mode === 'local'
    && r.data.config.baseUrl === 'http://127.0.0.1:11434/v1'
    && r.data.config.model === 'qwen3-14b-abl-q8'
    && r.data.config.apiKey === '');
  check('★ 切模型：不再自动开「关掉思考」（默认保持关）', r.data.thinkOff === false && r.data.config.thinkOff === false);
  // 手动打开之后再切一次：既不能被自动关掉，也不能被自动打开
  await req('PUT', '/api/config', { thinkOff: true });
  r = await req('POST', '/api/switch-model', { model: 'qwen3-14b-abl-q8' });
  check('★ 切模型：「关掉思考」保持用户手动的选择', r.data.thinkOff === true && r.data.config.thinkOff === true);
  await req('PUT', '/api/config', { thinkOff: false });   // 还原，别影响后面的用例
  check('切模型：返回体里没有明文 Key', !JSON.stringify(r.data).includes('sk-cloud-test'));
  r = await req('GET', '/api/config');
  check('切模型：原来那套云端配置被自动存下来了',
    r.data.savedCloud?.baseUrl === 'https://api.deepseek.com/v1'
    && r.data.savedCloud?.model === 'deepseek-flash' && r.data.savedCloud?.hasApiKey === true);
  check('切模型：savedCloud 里也不带明文 Key', !JSON.stringify(r.data.savedCloud).includes('sk-cloud-test'));

  // ④ 一键切回云端：Base URL / 模型 / Key 都还原，并自动关掉「关思考」
  r = await req('POST', '/api/switch-model', { cloud: true });
  check('切模型：一键切回云端（还原 Base URL / 模型）',
    r.status === 200 && r.data.mode === 'cloud'
    && r.data.config.baseUrl === 'https://api.deepseek.com/v1' && r.data.config.model === 'deepseek-flash');
  r = await req('GET', '/api/config');
  check('切模型：切回云端后 Key 没丢（尾号对得上）', r.data.apiKeyHint === '••••test');
  check('切模型：切回云端后「关思考」自动关掉', r.data.thinkOff === false);
  // 还原现场：Base URL、Key（PUT 空串 = 不改，所以显式传回原值）
  await req('PUT', '/api/config', { baseUrl: goodBase, model: 'mock-model', apiKey: keyBefore, extraBody: '{"seed":-1}' });

  // ================= 「直连模式」（不注入任何提示词的无提示词对话） =================
  // 纯函数：原始消息的构造与裁剪
  const dm = directMessages([
    { role: 'assistant', content: '（不该出现在开头的）' },
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '回第一句' },
    { role: 'system', content: '（不该被带上）' },
  ]);
  check('directMessages：不加任何 system 提示词', dm.every((m) => m.role !== 'system'));
  check('directMessages：开头的 assistant 被去掉', dm.length === 2 && dm[0].role === 'user' && dm[0].content === '第一句');

  const longHistory = [];
  for (let i = 0; i < 40; i += 1) longHistory.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(500) });
  const trimmedDm = directMessages(longHistory, 2000);
  check('directMessages：超出预算时只留最近的几条', trimmedDm.length > 0 && trimmedDm.length < longHistory.length);
  check('directMessages：留下的是最近的内容', trimmedDm.at(-1).content === 'x'.repeat(500) && trimmedDm.at(-1).role === 'assistant');

  // 「关掉思考」（v0.52.0）：角色模式也是加在 system **末尾**（Qwen3 只认 system 里的 /no_think）
  const fakeChar = { name: '测试角色', persona: '随便写点设定' };
  const ctxThinkOn = previewContext(fakeChar, [{ role: 'user', content: '你好' }], 7200, '', { thinkOff: true });
  const ctxThinkOff = previewContext(fakeChar, [{ role: 'user', content: '你好' }], 7200, '', { thinkOff: false });
  check('关掉思考：角色模式的 system 末尾加上 /no_think', ctxThinkOn.messages[0].content.trimEnd().endsWith('/no_think'));
  check('关掉思考：关着的时候 system 里没有 /no_think', !ctxThinkOff.messages[0].content.includes('/no_think'));
  check('关掉思考：只动 system，历史原样',
    ctxThinkOn.messages.length === 2 && ctxThinkOn.messages[1].content === '你好');

  // 接口层：直连会话的创建 / 列表 / 共用读取
  const direct = (await req('POST', '/api/direct/sessions')).data.session;
  check('直连会话：无角色卡、kind=direct、没有消息',
    direct.kind === 'direct' && direct.characterId === null && direct.messages.length === 0);
  r = await req('GET', '/api/direct/sessions');
  check('直连会话出现在直连列表里', r.status === 200 && r.data.sessions.some((s) => s.id === direct.id));
  r = await req('GET', '/api/sessions');
  check('直连会话也带 kind 标记（前端靠它分开显示）', r.data.sessions.find((s) => s.id === direct.id)?.kind === 'direct');
  check('角色会话没有 kind 标记（老文件格式不变）', r.data.sessions.some((s) => s.characterId && s.kind === ''));
  r = await req('GET', `/api/sessions/${direct.id}`);
  check('直连会话能用共用的读取接口', r.status === 200 && r.data.session.kind === 'direct');

  // 两种模式不能互相串：角色会话不许走直连接口，直连会话也走不了角色接口
  const anyChar = (await req('GET', '/api/characters')).data.characters[0];
  const charSess = (await req('POST', '/api/sessions', { characterId: anyChar.id })).data.session;
  r = await req('POST', '/api/direct/chat', { sessionId: charSess.id, content: '你好' });
  check('角色会话不能用直连接口发（400）', r.status === 400);
  r = await req('POST', '/api/chat', { sessionId: direct.id, content: '你好' });
  check('直连会话不会被角色接口接管（角色不存在 → 404）', r.status === 404);

  // 用一个假的模型端把"到底发出去了什么"录下来 —— 这是"直连"最核心的验证
  let seen = null;
  const mockSse = (chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
  const mock = createServer((mreq, mres) => {
    let raw = '';
    mreq.on('data', (c) => { raw += c; });
    mreq.on('end', () => {
      try { seen = { url: mreq.url, body: JSON.parse(raw || '{}') }; } catch { seen = { url: mreq.url, body: null }; }
      // v2.4.1：这个 mock 是 **OpenAI 兼容**服务，不是 Ollama —— 必须自己声明清楚。
      //   客户端的规则是"baseUrl 是 127.0.0.1 → 一律先探活 /api/tags，成功就走 Ollama 原生"，
      //   而 mock 原来对任何路径都回 200 的 SSE，于是被当成 Ollama，
      //   请求打到了 /api/chat 而不是 /v1/chat/completions（下面那组断言全挂）。
      //   （这一组在修复前的仓库里也是红的，原因同样是这个。）
      if (mreq.url === '/api/tags') { mres.writeHead(404).end(); return; }
      // v2.4.1：只把 /chat/completions 当成模型调用（/api/show 之类是能力探测）
      if (!/\/chat\/completions$/.test(mreq.url)) { mres.writeHead(404).end(); return; }
      mres.writeHead(200, { 'Content-Type': 'text/event-stream' });
      mres.write(mockSse('好的，'));
      mres.write(mockSse('我记住了。'));
      mres.write('data: [DONE]\n\n');
      mres.end();
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const MOCK_PORT = mock.address().port;
  const baseBeforeDirect = (await req('GET', '/api/config')).data.baseUrl;
  // 探活缓存按 host:port 记 60 秒，换服务前先清掉，否则会被旧结论带偏
  clearOllamaProbe();
  await req('PUT', '/api/config', {
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock-model', apiKey: 'mock-key',
    temperature: 0.5, extraBody: '{"seed":-1}',
  });

  const directChat = (body) => fetch(`${BASE}/api/direct/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: direct.id, ...body }),
  }).then((res) => res.text());

  const sse = await directChat({ content: '记住 47' });
  check('直连聊天是 SSE 流（有 text 也有 done）', /event: text/.test(sse) && /event: done/.test(sse));
  check('模型端收到了 chat/completions 请求', Boolean(seen) && seen.url === '/v1/chat/completions');
  check('★ 请求里**没有 system 提示词**', Array.isArray(seen.body.messages) && seen.body.messages.every((m) => m.role !== 'system'));
  check('★ 请求里只有这个会话本身的消息', seen.body.messages.length === 1 && seen.body.messages[0].content === '记住 47');
  check('直连也是流式，且消息角色合法', seen.body.stream === true && seen.body.messages[0].role === 'user');
  // v2.4.1：「额外请求参数」原样透传，但有一个**故意的例外** ——
  //   `seed: -1`（Ollama 的"随机"写法）对云端 API 是非法值（DeepSeek 直接 422），
  //   lib/openai.js parseExtraBody 会把它删掉。原来这条断言写死 seed === -1，
  //   等于要求实现保留一个已知会打爆云端请求的字段。
  check('模型名 / 温度 / 额外参数按设置原样发出',
    seen.body.model === 'mock-model' && seen.body.temperature === 0.5
    && seen.body.seed === undefined);
  // 正向用例放在直连这一整段**最后**再做：它会往会话里追加一条消息，
  // 现在插在中间会把后面「多轮历史顺序 / 重新生成」那些断言的预期消息数全打乱。
  // （v2.4.1 第一次改这里时就是这么把 4 条无关断言弄红的。）

  const afterOne = (await req('GET', `/api/sessions/${direct.id}`)).data.session;
  check('模型回复原样入库（没经过任何后处理）',
    afterOne.messages.at(-1).role === 'assistant' && afterOne.messages.at(-1).content === '好的，我记住了。');
  check('第一句话成了会话标题', afterOne.title === '记住 47');
  check('直连的消息不带「已否决」这类角色模式的产物',
    afterOne.messages.every((m) => m.rejected === undefined));

  r = await req('GET', `/api/direct/context?sessionId=${direct.id}`);
  check('直连上下文：system 为空', r.status === 200 && r.data.system === '' && r.data.stats.systemChars === 0);
  check('直连上下文：只有 user/assistant', r.data.history.length === 2 && r.data.history.every((m) => m.role === 'user' || m.role === 'assistant'));

  // 直连模式**自己**那套（微调提示 / 场景备忘）—— 填了才注入；
  // 用的是 direct* 那份，绝不能串到角色模式的 dims/hint/memo 上。
  await req('PUT', '/api/config', { dims: [{ name: '动作', level: 1 }], hint: '角色那份提示' });
  await req('PUT', '/api/config', {
    directDims: [{ name: '心理', level: 6 }],
    directHint: '直连那份提示',
    directMemo: '直连那份备忘',
  });
  r = await req('GET', `/api/direct/context?sessionId=${direct.id}`);
  // 判据用维度块自己的标题（别用"心理/动作"这类词：提示词里本来就有"不替对方行动或写心理"，
  // 会误判 —— 第一版断言就踩了这个坑）
  check('★ 直连：维度**不再**注入（v0.54.0 删掉「维度」那一栏）',
    !r.data.system.includes('【描写幅度】') && !r.data.system.includes('6/10'));
  check('直连：填了提示/备忘就注入',
    r.data.system.includes('直连那份提示') && r.data.system.includes('直连那份备忘'));
  check('直连：不串角色模式那份（角色 hint 不该出现）', !r.data.system.includes('角色那份提示'));
  // 等义词的「输出侧」在直连里也得生效（v0.56.0）：直连有自己那份 directSynonyms
  await req('PUT', '/api/config', { directSynonyms: '码农 = 程序员 #输出' });
  r = await req('GET', `/api/direct/context?sessionId=${direct.id}`);
  check('★ 等义词：直连模式的 #输出 标记也生效',
    /回答时也用/.test(String(r.data.system || '')) && /说「码农」/.test(String(r.data.system || '')));
  await req('PUT', '/api/config', { directSynonyms: '' });
  const charCtx2 = await req('GET', `/api/context?sessionId=${charSess.id}`);
  check('角色模式不受直连那份影响',
    !JSON.stringify(charCtx2.data).includes('直连那份提示') && !JSON.stringify(charCtx2.data).includes('直连那份备忘'));
  await req('PUT', '/api/config', { directDims: null, directHint: '', directMemo: '', dims: null, hint: '' });
  r = await req('GET', `/api/direct/context?sessionId=${direct.id}`);
  check('直连：清空后又回到零注入', r.data.system === '');
  check('directMaxChars 默认 0（不限）', (await req('GET', '/api/config')).data.directMaxChars === 0);
  await req('PUT', '/api/config', { directMaxChars: 80 });
  check('directMaxChars 能存能读（跟 maxChars 互不干扰）', (await req('GET', '/api/config')).data.directMaxChars === 80);
  await req('PUT', '/api/config', { directMaxChars: 0 });

  seen = null;
  await directChat({ content: '几号？' });
  check('多轮直连仍然不带 system', Array.isArray(seen.body.messages) && seen.body.messages.length === 3 && seen.body.messages.every((m) => m.role !== 'system'));
  check('多轮的历史顺序正确', seen.body.messages.map((m) => m.role).join(',') === 'user,assistant,user');

  seen = null;
  await directChat({ regenerate: true });
  // 历史是「我 → 模型 → 我」：重新生成要把末尾那条模型回复丢掉，再原样重发这 3 条；
  // 另外把上一版喂回去要求换个走向（直连也接了角色模式那套 regenerateNudge）。
  const regenMsgs = seen.body.messages || [];
  check('重新生成：丢掉末尾回复后重发同一段历史',
    regenMsgs.length === 4
    && regenMsgs.slice(1).map((m) => m.role).join(',') === 'user,assistant,user'
    && regenMsgs.at(-1).content === '几号？');
  check('重新生成：上一版被喂回去要求换走向（拼在 system 里，不是 user 消息）',
    regenMsgs[0].role === 'system'
    && regenMsgs[0].content.includes('换一个走向')
    && regenMsgs[0].content.includes('好的，我记住了。'));
  check('重新生成：温度只在这一轮上调 0.1（跟角色模式同一套）',
    Math.abs(seen.body.temperature - 0.6) < 1e-9);
  const afterRegen = (await req('GET', `/api/sessions/${direct.id}`)).data.session;
  const regenMsg = afterRegen.messages.at(-1);
  check('重新生成：被丢掉的那一版进了「已否决」',
    regenMsg.role === 'assistant'
    && Array.isArray(regenMsg.rejected) && regenMsg.rejected.length === 1
    && regenMsg.rejected[0].text === '好的，我记住了。'
    && regenMsg.rejected[0].source === 'regen'
    && regenMsg.rejected[0].reason === '重新生成前的一版');
  seen = null;
  await directChat({ regenerate: true, rejectedReason: '调维度之前的那一版' });
  const regenMsg2 = (await req('GET', `/api/sessions/${direct.id}`)).data.session.messages.at(-1);
  check('重新生成：理由可以自定（请求里的 rejectedReason 优先）',
    regenMsg2.rejected.length === 1 && regenMsg2.rejected[0].reason === '调维度之前的那一版');
  seen = null;
  await directChat({ content: '再确认一次' });
  check('★ 换走向提示只出现在「重新生成」那一轮，普通一轮仍然是零 system',
    (seen.body.messages || []).every((m) => m.role !== 'system'));

  // 直连模式的「常用语 / 口头禅 + 出现频率」：不填 = 零注入；填了 = 只多这一段
  check('directPhrasesBlock：没填常用语时返回空串（零注入）', directPhrasesBlock('', 5) === '');
  check('common phrases: 一行一个 / 逗号 / 顿号都认', parsePhrases('罢了\n少废话，别闹、哼').length === 4);
  const phMid = directPhrasesBlock('罢了\n少废话', 5);
  check('directPhrasesBlock：带上词表和频率说明', phMid.includes('罢了') && phMid.includes('少废话') && phMid.includes('三四个回合'));
  // v2.4.1：0 档的现行实现是**不给词表、只给一句别用直白生理名词的约束**
  //   （v2.3.1 起；理由是"只要词被看见模型就会用"）。旧断言找的是已删掉的旧文案。
  check('directPhrasesBlock：档位 0 = 不给词表',
    !directPhrasesBlock('罢了', 0).includes('罢了') && directPhrasesBlock('罢了', 0).includes('不要'));
  check('directPhrasesBlock：档位 10 = 频繁使用', directPhrasesBlock('罢了', 10).includes('频繁'));
  check('directPhrasesBlock：档位超出范围会被收敛到 0~10', directPhrasesBlock('罢了', 99).includes('频繁'));

  r = await req('PUT', '/api/config', { directPhrases: '罢了\n少废话', directPhraseLevel: 5 });
  check('常用语能保存', r.status === 200);
  r = await req('GET', '/api/config');
  check('常用语能读回（词表 + 档位）', r.data.directPhrases === '罢了\n少废话' && r.data.directPhraseLevel === 5);
  await req('PUT', '/api/config', { directPhraseLevel: 99 });
  r = await req('GET', '/api/config');
  check('频率档位会被收敛到 10', r.data.directPhraseLevel === 10);
  await req('PUT', '/api/config', { directPhraseLevel: 5 });

  r = await req('POST', '/api/direct/phrases', { text: '罢了，少废话', level: 3 });
  check('常用语预览接口：给出条数 / 档位 / 会发出去的那段',
    r.status === 200 && r.data.count === 2 && r.data.level === 3
    && r.data.block.includes('罢了') && r.data.how.includes('最多一次'));
  // v2.4.1：档位 3 的现行文案是「整条回复最多一次；多数回合一次都不用」
  //   （phrasesLine 在 v2.3.x 收紧过措辞），旧断言找的是「一到两次」。
  r = await req('POST', '/api/direct/phrases', { text: '', level: 5 });
  check('常用语预览接口：空词表 = 空段（零注入）', r.data.count === 0 && r.data.block === '' && r.data.how === '');

  // 「额外请求参数」正向用例（放在段尾，不影响上面按消息条数的断言）
  await req('PUT', '/api/config', { extraBody: '{"seed":42,"top_p":0.9}' });
  seen = null;
  await directChat({ content: '额外参数测试' });
  check('额外请求参数：合法字段原样透传到请求体',
    seen.body.seed === 42 && seen.body.top_p === 0.9);
  await req('PUT', '/api/config', { extraBody: '{"seed":-1}' });

  seen = null;
  await directChat({ content: '在吗？' });
  const sysMsgs = (seen.body.messages || []).filter((m) => m.role === 'system');
  check('★ 填了常用语：请求里正好多一段 system（而且只有一段）', sysMsgs.length === 1);
  check('★ 那一段就是常用语 + 频率，别的设定一概不掺',
    sysMsgs[0].content.includes('罢了') && sysMsgs[0].content.includes('少废话') && sysMsgs[0].content.includes('三四个回合'));
  check('常用语排在历史前面', seen.body.messages[0].role === 'system' && seen.body.messages.at(-1).content === '在吗？');
  r = await req('GET', `/api/direct/context?sessionId=${direct.id}`);
  check('上下文接口：标明注入了常用语（几条 / 频率）',
    r.data.stats.phrasesCount === 2 && r.data.stats.phrasesLevel === 5 && r.data.stats.systemChars > 0);
  check('上下文接口：system 片段独立给出，历史里没有 system', r.data.system.includes('罢了') && r.data.history.every((m) => m.role !== 'system'));

  // 清空之后必须回到"一条提示词都没有"
  await req('PUT', '/api/config', { directPhrases: '', directPhraseLevel: 4 });
  seen = null;
  await directChat({ content: '清空之后呢？' });
  check('★ 清空常用语后又回到零 system 提示词',
    (seen.body.messages || []).every((m) => m.role !== 'system'));
  r = await req('GET', `/api/direct/context?sessionId=${direct.id}`);
  check('上下文接口：清空后 system 为空', r.data.stats.systemChars === 0 && r.data.stats.phrasesCount === 0);

  // 直连模式的工作时段锁：和角色模式同一套规则（云端受限、本地不受限）
  const cfgNow = (await req('GET', '/api/config')).data;
  check('直连也会应用工作时段锁（当前是可用时段）', cfgNow.workGuard === true);

  // ── 「关掉思考」开关（v0.52.0）：Qwen3 这代只有 system 里的 /no_think 有效 ──────
  // 实测 Ollama 0.34：think:false / reasoning_effort:none 全被忽略，思考照吐、还慢 10 倍。
  check('关掉思考：默认是关的', cfgNow.thinkOff === false);
  await req('PUT', '/api/config', { thinkOff: true });
  check('关掉思考：能存能读', (await req('GET', '/api/config')).data.thinkOff === true);

  r = await req('GET', `/api/direct/context?sessionId=${direct.id}`);
  // v2.4.1：直连模式**不再**为关思考注入 system —— 关思考走请求体 think:false，
  //   而 /no_think 实测多数模板不读、还会把提示词搅浑。"直连零 system"这个设计保持不变。
  check('★ 关掉思考：直连模式不为关思考注入 system（零注入原则不变）',
    r.status === 200 && !String(r.data.system || '').includes('/no_think'));
  seen = null;
  await directChat({ content: '开了关思考之后呢？' });
  const thinkSys = (seen.body.messages || []).filter((m) => m.role === 'system');
  check('★ 关掉思考：请求里没有塞 /no_think 的 system（关思考走请求体）',
    thinkSys.every((m) => !m.content.includes('/no_think')));

  await req('PUT', '/api/config', { thinkOff: false });
  seen = null;
  await directChat({ content: '关掉之后再问一次' });
  check('★ 关掉思考：关回去之后直连又回到零 system',
    (seen.body.messages || []).every((m) => m.role !== 'system'));

  await req('PUT', '/api/config', { baseUrl: baseBeforeDirect });
  await new Promise((resolve) => mock.close(resolve));

  // ================= 硬凑常用词 → 自动重抽（v0.57.0） =================
  // 症状：这一轮明明在问问题/说事情，回复里却硬塞了常用词（"问的我都要潮吹液喷出来了"）。
  // 这里用两个脚本化的假上游把两条路都走一遍：
  //   ① 提问那一轮塞了词 → 必须重抽一次，且重抽那次**不再注入常用语**，落选那版进「已否决」
  //   ② 在戏里那一轮塞了词 → **不许**重抽（否则正常的 RP 会被反复重来）
  const scripted = (replies) => {
    const calls = [];
    const s = createServer((mreq, mres) => {
      // v2.4.1：同前面那个 mock —— 这是 OpenAI 兼容服务，必须对 /api/tags 回 404，
      //   否则会被 isOllamaBase 当成 Ollama，请求改走原生 /api/chat（没有 system 段），
      //   下面"重抽那次不再注入常用语"这类断言就全对不上。
      if (mreq.url === '/api/tags') { mres.writeHead(404).end(); return; }
      // v2.4.1：探活/能力探测的请求（/api/show、/api/ps…）**不是**模型调用，
      //   不能记进 calls —— 否则 calls[0] 变成探测请求，后面按 calls[0] 写的断言全错位。
      if (!/\/chat\/completions$/.test(mreq.url)) { mres.writeHead(404).end(); return; }
      let raw = '';
      mreq.on('data', (c) => { raw += c; });
      mreq.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
        calls.push(body);
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
        mres.writeHead(200, { 'Content-Type': 'text/event-stream' });
        mres.write(mockSse(reply));
        mres.write('data: [DONE]\n\n');
        mres.end();
      });
    });
    return { s, calls };
  };
  const sysOf = (body) => ((body?.messages || []).find((m) => m.role === 'system')?.content || '');
  const baseBeforeStuffed = (await req('GET', '/api/config')).data.baseUrl;
  const STUFFED = '嗯……*我把手里的杯子放到桌上* 这个我还真没听过，不过没关系，我都要潮吹液喷出来了。';
  const CLEAN = '*我把手里的杯子放到桌上* 这个说法我还真没听过，改天你教教我。';

  // 角色模式：先给角色配上常用词（档位 7 = "多用一些"）
  const stuffedChar = (await req('POST', '/api/characters', {
    name: '硬塞测试', persona: '测试用', phrases: '潮吹液\n爱液',
  })).data.character;
  await req('PUT', '/api/config', { dims: [{ name: '常用词', level: 7 }] });
  const stuffedSess = (await req('POST', '/api/sessions', { characterId: stuffedChar.id })).data.session;

  // ① 提问那一轮
  let mockSc = scripted([STUFFED, CLEAN]);
  await new Promise((resolve) => mockSc.s.listen(0, '127.0.0.1', resolve));
  // v2.4.1：清探活缓存，并让它**真的**探一遍（否则同端口上先前那个 mock 的"是 Ollama"
  //   结论会被沿用，请求打到 /api/chat，下面按 OpenAI 请求体写的断言就全对不上）。
  clearOllamaProbe(); clearThinkCapCache();
  await isOllamaBase({ baseUrl: `http://127.0.0.1:${mockSc.s.address().port}/v1` });
  await req('PUT', '/api/config', { baseUrl: `http://127.0.0.1:${mockSc.s.address().port}/v1`, model: 'mock-model', apiKey: 'mock-key' });
  const askRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: stuffedSess.id, content: '你知道什么是馒头逼吗？' }),
  });
  await askRes.text();
  const stuffedAfter = (await req('GET', `/api/sessions/${stuffedSess.id}`)).data.session;
  const stuffedReply = stuffedAfter.messages.at(-1);
  check('★ 硬凑常用词：提问那一轮塞了词 → 自动重抽（发生了两次请求）', mockSc.calls.length >= 2, `调了 ${mockSc.calls.length} 次`);
  // ⚠ 判据不能用"system 里有没有那几个词" —— 重抽时那句提示本身就会点名（"硬塞了这些词：潮吹液"）。
  //   要用**常用语块自己的措辞**判断它到底有没有被注入。
  check('★ 硬凑常用词：重抽那次**不再注入常用语**（改成"这一版不要用常用词"的提示）',
    mockSc.calls.slice(1).every((c) => !sysOf(c).includes('自然融进台词里'))
    && sysOf(mockSc.calls[0]).includes('自然融进台词里')
    && sysOf(mockSc.calls[1]).includes('这一版不要用常用词'));
  check('★ 硬凑常用词：屏幕上留下的是干净那一版',
    stuffedReply.content.includes('改天你教教我') && !stuffedReply.content.includes('潮吹液'));
  const stuffedRej = (stuffedReply.rejected || []).find((j) => /硬凑常用词/.test(j.reason || ''));
  check('★ 硬凑常用词：塞词那一版进了「已否决」（理由写明白）', Boolean(stuffedRej) && stuffedRej.text.includes('潮吹液'));

  // ② 在戏里那一轮：不许重抽
  mockSc = scripted([STUFFED]);
  await new Promise((resolve) => mockSc.s.listen(0, '127.0.0.1', resolve));
  await req('PUT', '/api/config', { baseUrl: `http://127.0.0.1:${mockSc.s.address().port}/v1` });
  const inScene = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: stuffedSess.id, content: '嗯…再深一点' }),
  });
  await inScene.text();
  const inSceneAfter = (await req('GET', `/api/sessions/${stuffedSess.id}`)).data.session;
  check('★ 硬凑常用词：在戏里（不是提问）**不重抽**，回复原样留下',
    inSceneAfter.messages.at(-1).content.includes('潮吹液')
    && !(inSceneAfter.messages.at(-1).rejected || []).some((j) => /硬凑常用词/.test(j.reason || '')));
  await new Promise((resolve) => mockSc.s.close(resolve));

  // ③ 直连模式：同样只在那三条同时成立时才动手
  mockSc = scripted([STUFFED, CLEAN]);
  await new Promise((resolve) => mockSc.s.listen(0, '127.0.0.1', resolve));
  clearOllamaProbe(); clearThinkCapCache();
  await isOllamaBase({ baseUrl: `http://127.0.0.1:${mockSc.s.address().port}/v1` });
  await req('PUT', '/api/config', {
    baseUrl: `http://127.0.0.1:${mockSc.s.address().port}/v1`,
    directPhrases: '潮吹液\n爱液', directPhraseLevel: 7, dims: null, hint: '',
  });
  const dSess = (await req('POST', '/api/direct/sessions')).data.session;
  await fetch(`${BASE}/api/direct/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: dSess.id, content: '你知道什么是馒头逼吗？' }),
  }).then((x) => x.text());
  const dAfter = (await req('GET', `/api/sessions/${dSess.id}`)).data.session;
  const dReply = dAfter.messages.at(-1);
  // v2.4.1：**直连模式不再为"硬凑常用词"重抽**（v2.3.20 起有意去掉）。
  //   约定变成"直连就是看模型原话的地方，一个字都不动"，只有角色模式才做这类后处理/重抽。
  //   原来这两条断言的是已被删除的行为，这里改成钉住现行约定（防止有人又把它加回来）。
  check('★ 硬凑常用词（直连）：不重抽，只请求一次（直连是看模型原话的地方）',
    mockSc.calls.length === 1);
  check('★ 硬凑常用词（直连）：模型原话原样入库，不被改写也不进「已否决」',
    dReply.content === STUFFED
    && !(dReply.rejected || []).some((j) => /硬凑常用词/.test(j.reason || '')));
  await new Promise((resolve) => mockSc.s.close(resolve));

  // 收尾：把这一节改过的配置还原
  await req('PUT', '/api/config', {
    baseUrl: baseBeforeStuffed, model: 'mock-model', dims: null, directPhrases: '', directPhraseLevel: 3,
  });
  await req('DELETE', `/api/characters/${stuffedChar.id}`);

  // ================= 「关掉思考」按模型分派（v0.59.0） =================
  // 实测：Qwen3 只认 system 里的 /no_think；R1 那代 /no_think **完全无效**，得发请求体的 think:false。
  // 所以"支持思考"这个 capability 不能直接等价于"该注入 /no_think"。
  // v2.4.1 重写：关思考**不再按模型名分派**，而是问服务端"这个模型到底支持什么"。
  //   旧断言（Qwen3 → system 里的 /no_think）描述的那条路径现在已不可达：
  //   thinkControl() 永远返回 think_false，system 注入分支是死的。
  check('关思考分派：thinkControl 是保守兜底（不再按模型名猜）',
    thinkControl('qwen3-14b-abl-q8') === 'think_false'
    && thinkControl('qwen2.5-14b') === 'think_false'
    && thinkControl('mock-model') === 'think_false');

  // 能力探测：用一个会回答 /api/show 的假 Ollama
  const fakeOllama = (showBody) => {
    const calls = [];
    const srv = createServer((mreq, mres) => {
      let raw = '';
      mreq.on('data', (c) => { raw += c; });
      mreq.on('end', () => {
        calls.push({ url: mreq.url, body: raw });
        if (mreq.url === '/api/tags') { mres.writeHead(200).end('{"models":[]}'); return; }
        if (mreq.url === '/api/show') { mres.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(showBody)); return; }
        mres.writeHead(404).end();
      });
    });
    return { srv, calls };
  };
  const withThinking = fakeOllama({ capabilities: ['completion', 'thinking'], template: '{{ if .EnableThinking }}…{{ end }}' });
  await new Promise((r) => withThinking.srv.listen(0, '127.0.0.1', r));
  clearOllamaProbe(); clearThinkCapCache();
  const capYes = await probeThinkCapability({ baseUrl: `http://127.0.0.1:${withThinking.srv.address().port}/v1`, model: 'any-model' });
  check('★ 能力探测：服务端说有 thinking → 支持思考、可走 think:false',
    capYes.supportsThinking === true && capYes.thinkField === true
    && capYes.source === 'api-show:capabilities');
  await new Promise((r) => withThinking.srv.close(r));

  const noThinking = fakeOllama({ capabilities: ['completion'], template: '{{ .Prompt }}' });
  await new Promise((r) => noThinking.srv.listen(0, '127.0.0.1', r));
  clearOllamaProbe(); clearThinkCapCache();
  const capNo = await probeThinkCapability({ baseUrl: `http://127.0.0.1:${noThinking.srv.address().port}/v1`, model: 'any-model' });
  check('★ 能力探测：服务端说没有 thinking → 不需要关，也不会硬塞字段',
    capNo.supportsThinking === false && capNo.thinkField === false);
  await new Promise((r) => noThinking.srv.close(r));
  clearOllamaProbe(); clearThinkCapCache();

  // 端到端：假 Ollama 声明支持思考 → 强制关思考时请求体带 think:false、system 里没有 /no_think
  const thinkChar = (await req('POST', '/api/characters', { name: '思考分派测试', persona: '测试用' })).data.character;
  const thinkSess = (await req('POST', '/api/sessions', { characterId: thinkChar.id })).data.session;
  const nativeSeen = [];
  const fakeNative = createServer((mreq, mres) => {
    let raw = '';
    mreq.on('data', (c) => { raw += c; });
    mreq.on('end', () => {
      if (mreq.url === '/api/tags') { mres.writeHead(200).end('{"models":[]}'); return; }
      if (mreq.url === '/api/show') {
        mres.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ capabilities: ['completion', 'thinking'], template: '{{ if .EnableThinking }}x{{ end }}' }));
        return;
      }
      try { nativeSeen.push(JSON.parse(raw || '{}')); } catch { nativeSeen.push(null); }
      mres.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      mres.write(JSON.stringify({ message: { role: 'assistant', content: '*我把杯子放到桌上* 好，我记住了。' }, done: false }) + '\n');
      mres.write(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, eval_count: 10, prompt_eval_count: 20 }) + '\n');
      mres.end();
    });
  });
  await new Promise((r) => fakeNative.listen(0, '127.0.0.1', r));
  clearOllamaProbe(); clearThinkCapCache();
  await req('PUT', '/api/config', {
    baseUrl: `http://127.0.0.1:${fakeNative.address().port}/v1`, model: 'any-thinking-model',
    apiKey: 'mock-key', thinkOff: true, autoClean: false,
  });
  await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: thinkSess.id, content: '记住 47' }),
  }).then((x) => x.text());
  check('★ 关思考（服务端说支持思考）：请求体里带 think:false',
    nativeSeen[0]?.think === false, JSON.stringify(nativeSeen[0]?.think));
  check('★ 关思考：system 里**不再**塞 /no_think（实测污染提示词且照样思考）',
    !sysOf(nativeSeen[0]).includes('/no_think'));
  r = await req('GET', `/api/context?sessionId=${thinkSess.id}`);
  check('★ 关思考：「查看上下文」如实报出用的是 think:false',
    r.data.thinkControl === 'think:false（请求体）' && !String(r.data.system || '').includes('/no_think'));

  // 思考强度：本地后端必须明确"不可用"（以前填了悄无声息不生效）
  r = await req('GET', '/api/config');
  check('★ 思考强度：本地 Ollama 上明确标记为不可用（不再假装生效）',
    r.data.thinkStrength && r.data.thinkStrength.usable === false
    && /reasoning_effort/.test(r.data.thinkStrength.reason));
  await req('PUT', '/api/config', { baseUrl: 'https://api.deepseek.com/v1', reasoningEffort: 'high' });
  r = await req('GET', '/api/config');
  check('思考强度：云端后端标记为可用', r.data.thinkStrength && r.data.thinkStrength.usable === true);
  await new Promise((resolve) => fakeNative.close(resolve));
  await req('PUT', '/api/config', { model: 'mock-model', thinkOff: false, autoClean: true });
  await req('DELETE', `/api/characters/${thinkChar.id}`);

  // ================= 联网搜索（v0.62.0，必应） =================
  // 全程离线：假必应（本地 HTTP）+ 假模型上游。真必应留给 tools/test-websearch.mjs。
  {
    // ---- ① 纯函数：解析 / 解码 / 清洗 / 注入块 ----
    const REAL = 'https://example.com/a?b=1&c=2';
    const wrapped = `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(REAL).toString('base64url')}&ntb=1`;
    check('联网：解码 /ck/a 的 u=a1<base64url> 还原真实链接',
      decodeBingLink(wrapped) === REAL, decodeBingLink(wrapped));
    check('联网：正常外链原样返回', decodeBingLink('https://huggingface.co/foo') === 'https://huggingface.co/foo');
    check('联网：必应站内链接（/search）不算来源，返回空', decodeBingLink('https://www.bing.com/search?q=x') === '');
    check('联网：非 http(s) 链接返回空', decodeBingLink('javascript:alert(1)') === '');

    const FIXTURE = [
      '<html><body><ol id="b_results">',
      '<li class="b_algo"><h2><a href="https://huggingface.co/Qwen/Qwen2.5-14B-Instruct">',
      'Qwen/Qwen2.5-14B-Instruct &amp; 说明</a></h2>',
      '<div class="b_caption"><p class="b_lineclamp3">蒸馏版本，基于 <b>Qwen</b>。</p></div></li>',
      `<li class="b_algo"><h2><a href="${wrapped}">Example 页面</a></h2>`,
      '<div class="b_caption"><p>摘要里的实体：&ensp;&#39;引号&#39; &amp; 与号</p></div></li>',
      '<li class="b_algo"><h2><a href="https://www.bing.com/search?q=related">必应站内相关搜索</a></h2><p>不该出现</p></li>',
      '</ol></body></html>',
    ].join('');
    const parsed = parseBing(FIXTURE, { count: 5 });
    check('联网：解析出 2 条（站内链接被丢掉）', parsed.length === 2, JSON.stringify(parsed.map((p) => p.url)));
    check('联网：标题里的 &amp; 被解码', parsed[0].title.includes('&'), parsed[0]?.title);
    check('联网：摘要去标签 + 解码 &ensp;/&#39;', parsed[1].snippet === "摘要里的实体： '引号' & 与号", parsed[1]?.snippet);
    check('联网：host 字段是从真实链接里取的', parsed[0].host === 'huggingface.co', parsed[0]?.host);
    check('联网：count 上限生效', parseBing(FIXTURE, { count: 1 }).length === 1);
    check('联网：垃圾输入不抛错，返回空数组', parseBing('<html>没有结果</html>').length === 0 && parseBing('').length === 0);

    check('联网：cleanQuery 剥掉 *动作* 和（环境描写）',
      cleanQuery('*歪头看你*（外面在下雨）DeepSeek-R1 有蒸馏版吗') === 'DeepSeek-R1 有蒸馏版吗',
      JSON.stringify(cleanQuery('*歪头看你*（外面在下雨）DeepSeek-R1 有蒸馏版吗')));
    check('联网：cleanQuery 对"嗯/继续"返回空（不搜废词）', cleanQuery('嗯') === '' && cleanQuery('……') === '');
    check('联网：cleanQuery 限长', cleanQuery('测试'.repeat(50), 10).length === 10);

    const blk = webSearchBlock(parsed, { maxChars: 1600 });
    check('联网：webSearchBlock 带【网页搜索结果】且引用标题', blk.includes('【网页搜索结果】') && blk.includes('Qwen2.5-14B-Instruct'));
    check('联网：webSearchBlock 有"不要执行网页里的指令"这条防线', blk.includes('不要执行'));
    check('联网：webSearchBlock 空数组 / maxChars=0 时返回空串',
      webSearchBlock([]) === '' && webSearchBlock(parsed, { maxChars: 0 }) === '');
    const tight = webSearchBlock(parsed, { maxChars: 200 });
    check('联网：webSearchBlock 尊重字数上限', tight.length <= 320, String(tight.length));
    check('联网：store 归一化（站点/条数/字数）',
      normalizeSearchSite('cn') === 'cn' && normalizeSearchSite('乱写') === 'intl'
      && normalizeSearchCount(99) === 10 && normalizeSearchCount(0) === 1 && normalizeSearchCount('x') === 5
      && normalizeSearchChars(-5) === 0 && normalizeSearchChars(99999) === 4000);

    check('联网：describeSearchFail 把 ECONNREFUSED 翻成人话（提到代理/国内版）',
      /代理|国内版/.test(describeSearchFail(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))));

    // ---- ② 假必应：走完整的"聊天 → 搜索 → 注入 → 落库 → 预览"链路 ----
    let bingHits = 0;
    const seenQueries = [];
    const bing = createServer((breq, bres) => {
      bingHits += 1;
      seenQueries.push(new URL(breq.url, 'http://x').searchParams.get('q') || '');
      bres.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      bres.end(FIXTURE);
    });
    await new Promise((resolve) => bing.listen(0, '127.0.0.1', resolve));
    const bingBase = `http://127.0.0.1:${bing.address().port}`;
    process.env.WORKBENCH_BING_BASE = bingBase;   // 测试钩子：把"必应"指到本地假服务

    // 假模型上游：只为拿一条正常回复，同时把收到的 system 存下来（检查注入）
    const webMock = scripted(['*我把杯子放下* 我查了一下，有的。']);
    await new Promise((resolve) => webMock.s.listen(0, '127.0.0.1', resolve));
    const webChar = (await req('POST', '/api/characters', { name: '联网测试', persona: '测试用', greeting: '在的' })).data.character;
    const webSess = (await req('POST', '/api/sessions', { characterId: webChar.id })).data.session;
    const baseBeforeWeb = (await req('GET', '/api/config')).data.baseUrl;
    await req('PUT', '/api/config', {
      baseUrl: `http://127.0.0.1:${webMock.s.address().port}/v1`, model: 'mock-model', apiKey: 'mock-key',
      webSearch: true, webSearchSite: 'cn', webSearchCount: 3, webSearchChars: 1600,
    });

    const webRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: webSess.id, content: '*我凑近*（翻了下手机）DeepSeek-R1 有蒸馏版吗' }),
    });
    const webText = await webRes.text();
    check('联网：聊天流里有 web 事件（先 start 后 done）',
      webText.includes('event: web') && webText.includes('"phase":"start"') && webText.includes('"phase":"done"'));
    check('联网：web 事件报出搜到 2 条、站点国内版、无错误',
      /"count":2/.test(webText) && webText.includes('"site":"cn"') && !/"error":"[^"]/.test(webText), webText.slice(0, 400));
    check('联网：搜索词是 cleanQuery 洗过的（去掉了 *动作* 和（环境））',
      seenQueries[0] === 'DeepSeek-R1 有蒸馏版吗', JSON.stringify(seenQueries));
    check('联网：那一轮的 system 里真的有【网页搜索结果】+ 网页标题',
      sysOf(webMock.calls[0]).includes('【网页搜索结果】') && sysOf(webMock.calls[0]).includes('Qwen2.5-14B-Instruct'));

    const webAfter = (await req('GET', `/api/sessions/${webSess.id}`)).data.session;
    const lastMsg = webAfter.messages.at(-1);
    check('联网：来源落进了那条回复（2 条，链接已解码）',
      Array.isArray(lastMsg.sources) && lastMsg.sources.length === 2
      && lastMsg.sources.some((s) => s.url === REAL), JSON.stringify(lastMsg.sources || []));
    check('联网：来源不含必应内链', !(lastMsg.sources || []).some((s) => /bing\.com/.test(s.url)));

    const ctxHitBefore = bingHits;
    r = await req('GET', `/api/context?sessionId=${webSess.id}`);
    check('联网：预览里的 system 和真发出去的一致（含搜索块）',
      r.data.system.includes('【网页搜索结果】') && r.data.system.includes('Qwen2.5-14B-Instruct'));
    check('联网：预览如实报出搜到几条/走哪条路',
      r.data.webSearch?.enabled === true && r.data.webSearch.count === 2 && r.data.webSearch.site === 'cn');
    check('联网：stats 里能看到注入字数', (r.data.stats.searchChars || 0) > 0 && r.data.stats.searchCount === 2);
    check('联网：预览复用缓存，没有再打一次必应', bingHits === ctxHitBefore, `hits=${bingHits} before=${ctxHitBefore}`);

    // 关掉：一次网络都不该有
    await req('PUT', '/api/config', { webSearch: false });
    const hitsOffBefore = bingHits;
    r = await req('GET', `/api/context?sessionId=${webSess.id}`);
    check('联网：关掉后 system 里没有搜索块（回到原样）', !r.data.system.includes('【网页搜索结果】'));
    check('联网：关掉后一次网络请求都不发', bingHits === hitsOffBefore, `hits=${bingHits}`);

    // ---- ③ POST /api/search（设置页「试搜一次」用的接口）----
    r = await req('POST', '/api/search', { query: '蒸馏版本', site: 'cn', count: 2 });
    check('POST /api/search 返回结果 + via/finalHost', r.status === 200 && r.data.results.length === 2 && r.data.via === 'direct');
    check('POST /api/search 回显站点与查询', r.data.site === 'cn' && r.data.query === '蒸馏版本');
    r = await req('POST', '/api/search', { query: '  ' });
    check('POST /api/search 空查询返回 400', r.status === 400);
    r = await req('POST', '/api/search', { query: 'x', proxy: '127.0.0.1:1' });
    check('POST /api/search http 目标 + 代理 → 502（不静默忽略代理）', r.status === 502 && /代理/.test(r.data.error || ''), JSON.stringify(r.data));

    // 真生产路径的失败：https 目标 + 一个没人在听的代理端口 → CONNECT 直接被拒。
    // （先撤掉测试钩子，否则目标又变回本地 http 假必应。）
    delete process.env.WORKBENCH_BING_BASE;
    r = await req('POST', '/api/search', { query: 'x', site: 'intl', proxy: '127.0.0.1:1' });
    check('POST /api/search 代理连不上 → 502 + 人话（提到代理/国内版）',
      r.status === 502 && /代理|必应/.test(r.data.error || ''), JSON.stringify(r.data));

    // 收尾：把配置和测试钩子恢复原样（后面的用例还在同一个进程里跑）
    await req('PUT', '/api/config', { baseUrl: baseBeforeWeb, webSearch: false, webSearchSite: 'intl' });
    delete process.env.WORKBENCH_BING_BASE;
    await new Promise((resolve) => bing.close(resolve));
    await new Promise((resolve) => webMock.s.close(resolve));
    await req('DELETE', `/api/characters/${webChar.id}`);
    await req('DELETE', `/api/sessions/${webSess.id}`);
  }

  // ---- ④ 前端接线（静态交叉检查）----
  // 沙箱里点不了按钮（无头浏览器在本机沙箱下读不到输出、也写不出截图），所以至少要把
  // "app.js 引用的 id / 表单字段名在 index.html 里真的存在"钉住 ——
  // 少一个就是打开设置页当场 TypeError（`form.webSearch is undefined`），
  // 而且这种事故在服务端测试里**完全看不出来**。
  {
    const indexHtml = await readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const appJs = await readFile(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const serverJs = await readFile(path.join(ROOT, 'lib', 'server.js'), 'utf8');
    const consoleTui = await readFile(path.join(ROOT, 'tools', 'train-console.mjs'), 'utf8');
    const trainerJs = await readFile(path.join(ROOT, 'lib', 'trainer.js'), 'utf8');
    const trainHtml = await readFile(path.join(ROOT, 'public', 'train.html'), 'utf8');
    const openaiSrc = await readFile(path.join(ROOT, 'lib', 'openai.js'), 'utf8');
    const settingsHtml = await readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
    for (const name of ['webSearch', 'webSearchSite', 'webSearchCount', 'webSearchChars', 'webSearchQuery']) {
      check(`前端：表单字段 name="${name}" 存在`, indexHtml.includes(`name="${name}"`));
    }
    for (const id of ['btn-websearch', 'websearch-box', 'websearch-test', 'websearch-result', 'websearch-state']) {
      check(`前端：元素 id="${id}" 存在`, indexHtml.includes(`id="${id}"`));
    }
    for (const fn of ['toggleWebSearch', 'updateWebSearchButton', 'attachSources', 'testWebSearch']) {
      check(`前端：app.js 里有 ${fn}()`, appJs.includes(`function ${fn}(`));
    }
    check('前端：🌐 / 试搜按钮都挂了监听', appJs.includes("$('#btn-websearch')?.addEventListener('click', toggleWebSearch)")
      && appJs.includes("$('#websearch-test')?.addEventListener('click', testWebSearch)"));
    // app.js 里所有 form.webSearchXxx 都要有同名 name 字段对应（漏一个就是运行时报错）
    const used = [...new Set([...appJs.matchAll(/form\.(webSearch[A-Za-z]*)/g)].map((m) => m[1]))];
    check('前端：app.js 用到的 webSearch* 字段全部有 name 对应',
      used.length >= 4 && used.every((f) => indexHtml.includes(`name="${f}"`)), used.join(','));
    // 来源列表必须是 DOM 拼的（不能用 innerHTML 拼网页标题/链接 —— 那是 XSS 口子）
    check('前端：来源渲染不用 innerHTML（只用 textContent）',
      /function attachSources[\s\S]*?\n}/.test(appJs) && !/attachSources[\s\S]{0,1200}innerHTML/.test(appJs));

    // v1.2.0：输入框打 / 选这一条由谁回答（弹窗 → 胶囊）
    check('前端：输入框右侧有胶囊容器', indexHtml.includes('id="composer-chips"'));
    check('前端：有 / 弹出的角色列表容器', indexHtml.includes('id="slash-pop"'));
    check('前端：app.js 复用了纯逻辑模块', appJs.includes("from './slashpick.js'"));
    for (const fn of ['refreshAsChip', 'applySlash', 'renderSlashPop', 'syncSlashPop', 'moveSlash']) {
      check(`前端：app.js 里有 ${fn}()`, appJs.includes(`function ${fn}(`));
    }
    check('思考过程：后端抓 reasoning_content + 发 reasoning_effort',
      openaiSrc.includes('reasoning_content') && openaiSrc.includes('reasoning_effort')
      && serverJs.includes("send('reasoning'") && serverJs.includes('replyReasoning'));
    check('token 用量：后端拿 usage + SSE 推送 + 落盘',
      openaiSrc.includes('include_usage') && openaiSrc.includes('json.usage')
      && serverJs.includes('normUsage') && serverJs.includes("send('usage'") && serverJs.includes('usageEstimated'));
    check('token 用量：操作栏胶囊 + 聊天下方状态条', appJs.includes('msg-usage')
      && appJs.includes('usage-bar') && appJs.includes('fmtTok') && settingsHtml.includes('id="usage-bar"'));
    check('思考过程：常驻展开 + 收起按钮 + 实时推流',
      appJs.includes('reasoning-box') && appJs.includes("mk('think'") && appJs.includes("ev === 'reasoning'")
      && appJs.includes("reasoning-box open") && appJs.includes('收起思考'));
    check('思考过程：设置页有推理强度选项', settingsHtml.includes('name="reasoningEffort"')
      && ['none', 'low', 'high', 'max'].every((v) => settingsHtml.includes(`value="${v}"`)));
    check('训练控制台：TUI 脚本在、含显存/数据/日志',
      fsSync.existsSync('tools/train-console.mjs')
      && consoleTui.includes('余量') && consoleTui.includes('数据 ') && consoleTui.includes('日志'));
    check('训练控制台：训练启动时自动弹（trainer 调用 + 接口 + 按钮）',
      trainerJs.includes('openTrainConsole') && serverJs.includes("'/api/train/console'")
      && trainHtml.includes('open-console'));
    check('前端：模型列表里渲染云端条目并带 baseUrl', appJs.includes("m.backend === 'cloud'")
      && appJs.includes('data-baseurl=') && appJs.includes('lm-badge cloud'));
    check('后端：/api/local-models 并入云端模型', serverJs.includes('cloudProviders')
      && serverJs.includes("backend: 'cloud'"));
    check('后端：/api/switch-model 支持 backend=cloud', serverJs.includes("String(body.backend || '') === 'cloud'"));
    check('前端：/ 列表用本会话人物表', appJs.includes('conversationSpeakers(chr)'));
    check('前端：发送时带 as 身份', appJs.includes('as: { name: asPerson.name }'));
    check('后端：as 只认本会话人物表', serverJs.includes('cast.some((c) => c.name === asName)'));
    check('后端：以身份发送时拼 asNudge', serverJs.includes('withNudge(asNudge(asForTurn, asOthers))'));
    check('后端：历史里的 as 消息会标成「（X说）」', serverJs.includes('applyAsIdentity('));
    check('后端：以身份发送时摘掉历史里模型替用户角色写的话', serverJs.includes('dropAsSpeaker(historyForModel, asForTurn, castNames)'));
    check('后端：模型替用户演的角色台词会被去掉', serverJs.includes('x.speaker !== asForTurn'));
    check('后端：回复后处理会删「替用户写动作」', serverJs.includes('stripUserActions(text)'));
    check('后端：解析说话人时传人物表', serverJs.includes('parseReplyLines(reply, castNames)'));
  }

  // 全新数据目录（还没建过任何角色）时不能把 /api/characters 打成 500 ——
  // 前端的 boot() 是"一步失败就整段中断"，首屏会跟着一起挂。
  await rm(path.join(TMP_DATA, 'characters'), { recursive: true, force: true });
  r = await req('GET', '/api/characters');
  check('全新数据目录里 /api/characters 返回空列表（不是 500）', r.status === 200 && Array.isArray(r.data.characters) && r.data.characters.length === 0);

  server.close();
  await rm(TMP_DATA, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? '全部通过 ✅' : `有 ${failures} 项失败 ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('冒烟测试异常:', err);
  await rm(TMP_DATA, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
