// 输出后处理：剔除模型「凭空造出来」的外部事件。
//
// 典型症状（都是模型自己加的，场景里根本没有）：
//   （门外的脚步声越发急促）  （隔壁传来门锁转动的声音）  *听见有人敲门*  外面有警笛声
//
// 判定规则：这一行里出现了"侵入性事件"词，而**最近的上文里从没出现过这个词** → 判为凭空捏造。
// 只做纯字符串判断，不碰 DOM、不读配置，方便单测。
import { normalizeMarkup, normalizePerson, strayLatinWords, thirdPersonSubjects } from './markup.js';

// 这些词代表"场面之外闯进来的东西"。
const EVENT_WORDS = [
  '敲', '脚步', '门铃', '电话', '警笛', '喇叭', '有人来', '来人', '隔壁',
  '门外', '楼道', '闯', '撞门', '开锁', '钥匙', '叫门', '拍门', '按铃',
  // 天气/天象类：实测会被凭空加进来当"氛围"（"（窗外传来轻微雷响）"）
  '雷声', '雷响', '打雷', '闪电', '刮风', '风声', '暴雨', '下雨',
];

// 光有上面那些词还不够 —— 必须能看出它是"从场面外闯进来"的。
// 在真实历史里踩到的误删：`*脚步顿了一下，没回头*`（角色自己的动作）、
// 「（大厅很安静，只有柜员敲键盘的声音）」（环境描写）都被当成凭空事件删掉了。
// 所以再加一道"外部来源"判定：位置词或"传来/响起"这类动词。
const EXTERNAL_MARKERS = [
  '门外', '门口外', '隔壁', '远处', '楼下', '楼上', '外面', '窗外', '屋外', '身后',
  '楼道', '走廊', '过道', '有人', '传来', '响起', '响了', '来电', '打来',
  '广播', '电视里', '收音机', '手机响', '对讲', '铃声',
];
// 「敲门声」这种没有位置词也是明确的入侵（但 `*她敲了敲门*` 属于角色自己的动作，见下）
const EXTERNAL_RE = /[敲拍按撞砸]门|门铃|门锁/;

// 背景音/常驻电器：提到它们**且没有"闯入动作"**时不算凭空事件。
// 实测误删：`（电视里换了个场景，音量还是不大，正好盖住隔壁的动静）`
// —— 它只是描述背景音，不打断任何事，删掉反而让模型忘了屋里的状态。
// 但 `（电视里传来敲门声）` 有"传来"，照样会被抓（那是真入侵）。
const AMBIENT_WORDS = ['电视', '收音机', '音乐', '空调', '风扇', '雨声', '雨点', '雷声', '洗衣机', '冰箱', '楼下', '窗外'];
const INTRUSION_RE = /传来|响起|响了|有人|[敲拍按撞砸]门|门铃|门锁|开锁|来电|打来|手机响|铃声/;

// 只看"最近这么多字"的上文来判断某个动静是不是已经存在。
// 用全文判断会被钻空子：很久以前提过一次"敲"，之后每轮加敲门都算"不凭空"了。
// 注意：这是**新回复**用的窗口；清洗历史时用 HISTORY_WINDOW（见下）。
const CONTEXT_WINDOW = 1200;
// 清洗历史时判断"上文提过没有"的窗口要宽得多：历史里的事都是既成事实，
// 窗口太小会把早就确立的场景细节误判成凭空造出来的。
const HISTORY_WINDOW = 100000;

/**
 * 找出回复里"凭空造事件"的行。
 * @param {string} reply   模型这次生成的内容
 * @param {string} context 这次发出去的上文（系统提示词 + 历史）
 * @param {{window?: number}} [opts] window = 只看最近多少字来判断"上文提过没有"
 * @returns {{line: string, words: string[]}[]}
 */
export function findInventedEvents(reply, context, opts = {}) {
  const win = Number(opts.window) > 0 ? Number(opts.window) : CONTEXT_WINDOW;
  const ctx = String(context || '').slice(-win);
  const out = [];
  for (const raw of String(reply || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const words = EVENT_WORDS.filter((w) => line.includes(w));
    if (!words.length) continue;
    // 先看是不是"外部闯进来"的：位置词 / 传来响起 / 敲门门铃
    const external = EXTERNAL_MARKERS.some((m) => line.includes(m)) || EXTERNAL_RE.test(line);
    if (!external) continue; // 角色自己的动作、环境描写 → 不动
    // 动作块里、主语是角色自己（*她…*）→ 是角色在动，不是外面闯进来
    if (/^\*[^*\n]*(她|他|我|你)[^*\n]*\*/.test(line) && !EXTERNAL_MARKERS.some((m) => line.includes(m))) continue;
    // 只是描述背景音（电视/空调/雨…）且没有闯入动作 → 不是凭空事件
    if (AMBIENT_WORDS.some((w) => line.includes(w)) && !INTRUSION_RE.test(line)) continue;
    // 上文最近就提过同样的词 → 场景里本来就有，不算凭空
    // （注意：不因为"上文提到过电视/音乐"就放行 —— 模型会写"电视里传来敲门声"来钻空子）
    if (words.some((w) => ctx.includes(w))) continue;
    out.push({ line, words });
  }
  return out;
}

/**
 * 清洗回复：删掉凭空造事件的行，并整理多余空行。
 * @returns {{text: string, cleaned: {line: string, words: string[]}[]}}
 */
export function sanitizeReply(reply, context, opts = {}) {
  const invented = findInventedEvents(reply, context, opts);
  if (!invented.length) return { text: String(reply || ''), cleaned: [] };
  const drop = new Set(invented.map((x) => x.line));
  const kept = String(reply || '')
    .split('\n')
    .filter((line) => !drop.has(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 安全阀：整条几乎被删空时，宁可不删（免得界面上冒出"（没有内容）"）
  if (kept.length < 8) return { text: String(reply || ''), cleaned: [] };
  return { text: kept, cleaned: invented };
}

/* ---------- 角色标记漏进正文 ---------- */

// 模型偶尔会在回复里自己接着往下写对话轮次标记（"我user\n..." / "<user>"），
// 这是它把自己当成了两个人在对话。Ollama 侧已经用 stop 词挡了大部分，
// 但 token 边界上偶尔会漏，这里兜最后一道。
// 两种形态都要抓：
//   ① 尖括号标记：<user> / <|user|> / <start_of_turn>
//   ② 裸词紧跟着换行或标点：`我user\n…` —— 前面**不需要**分隔符，
//      因为中英混排时 `我user` 是连着的（踩过：只在前面要求分隔符会漏掉这种）。
const ROLE_LEAK = /<\|?\/?\s*(?:user|assistant|system|model|start_of_turn|end_of_turn)\s*\|?>|\b(?:user|assistant)(?=[\s*（(、，,。\n]|$)/gi;

/**
 * 去掉漏进来的对话轮次标记。只在**命中位置往后**全丢：
 * 标记一出现，后面的内容就是模型自己编的另一轮了，留着只会更乱。
 * @returns {{text: string, cut: boolean}}
 */
/**
 * v1.9.5：把角色回复里用来指代「对方」的「他/她」改成「你」。
 *
 * 单人卡里只有两个人：角色（我）和用户（你）。模型偶尔会退回第三人称，
 * 写出「把纸往他那边推了推」这种 —— 直接替换成「你」最省事，
 * 也不会误伤：只有**没提到任何第三方人名**时才做替换。
 *
 * @param {string} reply 角色回复
 * @param {object} opts  { castNames: 多人卡的人物名, characterName: 角色自己的名字 }
 */
/**
 * v2.0.1：「您」→「你」。
 *
 * 角色扮演里「您」显得过于生分（除非角色设定就是要敬称——这种情况通过
 * 常驻知识/角色卡里自己写清楚；默认统一改成「你」）。
 * 只换代词本身，不碰「您们」（中文里极少见，出现了也保留）。
 */
/**
 * v2.1.4：把解剖术语换成口语（兜底）。
 *
 * 提示词和常驻知识里都写了"用口语别用术语"，但 8B 模型看到知识库里 30 多处方言式的
 * 解剖描述，还是会冒出"小阴唇底下泛红"这种（而且会叠加成"小阴唇底下"，绕过术语表）。
 * 这里做最后一道替换。
 *
 * 只在**单人卡**里替换（多人卡可能有医生角色，术语是合理的）；
 * 且角色卡没标明"医生/护士"这类职业时才换。
 */
const TERM_TO_PLAIN = [
  [/小阴唇底下|大阴唇底下|阴唇底下/g, '底下'],
  [/小阴唇|大阴唇|阴唇/g, '那里'],
  [/阴蒂头|阴蒂/g, '那一点'],
  [/阴道口/g, '入口'],
  [/阴道里面|阴道里头|阴道内/g, '里面'],
  [/阴道/g, '里面'],
  [/龟头冠状沟|冠状沟|龟头/g, '顶端'],
  [/包皮系带|包皮/g, '那层皮'],
  [/阴囊/g, '底下'],
  [/前列腺/g, '里面那个点'],
  [/会阴部|会阴/g, '底下'],
  [/阴阜/g, '上面那块'],
  [/前庭大腺|前庭/g, '那一片'],
];

export function fixAnatomyTerms(reply, opts = {}) {
  const t = String(reply || '');
  if (!t) return { text: t, changed: false, hits: [] };
  // 角色是医生/护士这类，术语是合理的，不替换
  const who = String(opts.characterName || '') + String(opts.persona || '');
  if (/(医生|医师|护士|大夫|外科|妇科|医学)/.test(who)) return { text: t, changed: false, hits: [] };
  let out = t;
  const hits = [];
  for (const [re, plain] of TERM_TO_PLAIN) {
    if (re.test(out)) {
      const m = out.match(re);
      if (m) hits.push(m[0]);
      out = out.replace(re, plain);
    }
  }
  return { text: out, changed: out !== t, hits };
}

export function fixFormalYou(reply) {
  const t = String(reply || '');
  if (!t || !t.includes('您')) return { text: t, changed: false };
  // 「您老」「您二位」这类固定说法也一并简化成「你」
  const out = t.replace(/您(?![们])/g, '你');
  return { text: out, changed: out !== t };
}

export function fixThirdPersonForUser(reply, opts = {}) {
  const t = String(reply || '');
  if (!t) return { text: t, changed: false };
  const names = [opts.characterName, ...(Array.isArray(opts.castNames) ? opts.castNames : [])]
    .filter(Boolean).map((x) => String(x));
  // 提到了第三方人名/称谓 → 不敢乱换（他/她可能真的指那个人）
  // 「哥/姐/爸/妈」这类多半是在称呼对方（"哥，你…"），不算第三方；
  // 只有明确指别人时才算：老板/同事/店员/服务员/邻居/医生/护士/老师
  const hasThirdParty = names.some((n) => n && t.includes(n))
    || /(老板|同事|店员|服务员|邻居|医生|护士|老师|司机|保安|阿姨|师傅)/.test(t);
  if (hasThirdParty) return { text: t, changed: false };
  // 只换「他/她」，不碰「他们/她们/其他/她俩」
  const before = t;
  const out = t.replace(/(?<![其他们她])他(?!们)/g, '你').replace(/(?<![其他们她])她(?!们)/g, '你');
  return { text: out, changed: out !== before, count: (before.match(/[他她]/g) || []).length };
}

export function stripLeadingReasoning(reply) {
  const t = String(reply || '');
  const blank = { text: t, cut: false };
  if (!t.trim()) return blank;
  // 1) 有 </think> 标记：直接切到标记之后（最可靠）
  const m = t.match(/<\/think>\s*/i);
  if (m && m.index !== undefined) {
    const after = t.slice(m.index + m[0].length).trim();
    if (after.length >= 8) return { text: after, cut: true };
  }
  // 2) v1.9.1：正文**前面单独一行**的思考标记残留（测试出现次数最多的一种）。
  //    实测样例：输出以 "</think>" 或 "<think>" 开头，紧接着就是正常回复 ——
  //    原来整段带回界面，用户看到的就是多出来一行 </think>。
  const lead = t.match(/^\s*(?:<\/?think>\s*>?|\/?think>?|<\/?thought>\s*>?)[\s:：]*/i);
  if (lead) {
    const after = t.slice(lead[0].length).replace(/^[\s,，。:：]+/, '').trim();
    if (after.length >= 6) return { text: after, cut: true };
  }
  // 3) 没标记：按空行分段，看**前面几段**是不是在讲"我要怎么回答"。
  //    只有「明显元话术」且「没有任何动作括号（）」才丢前面；
  //    正常角色回复几乎一定带（）动作，所以这条规则不会误删正文。
  const paras = t.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (paras.length < 2) return blank;
  const head = paras.slice(0, -1).join('\n');
  const looksMeta = /(我要|我需要|首先|其次|根据规则|用户(的)?输入|用户的这句话|分析一下|这个数字|让我(想|看)|\banswer\b)/.test(head.slice(0, 240));
  if (!looksMeta) return blank;
  // 前面段落里已经有（）动作 → 那是正文，不动
  if (/（[^）]{2,}）/.test(head)) return blank;
  const last = paras[paras.length - 1];
  if (last.length < 6) return blank;
  return { text: last, cut: true };
}

export function stripRoleLeak(reply) {
  const t = String(reply || '');
  let first = -1;
  ROLE_LEAK.lastIndex = 0;
  let m;
  while ((m = ROLE_LEAK.exec(t))) { first = m.index; break; }
  if (first < 0) return { text: t, cut: false };
  const kept = t.slice(0, first).trim();
  // 砍完剩太少 → 整条作废（返回空，让上层重抽）
  if (kept.length < 12) return { text: '', cut: true };
  return { text: kept, cut: true };
}

// 供设置页提示用：给一句人话说明删了什么。
export function describeCleaned(cleaned) {
  if (!cleaned?.length) return '';
  const words = [...new Set(cleaned.flatMap((c) => c.words))].join('、');
  return `已清掉 ${cleaned.length} 处凭空出现的动静（${words}）`;
}

/* ---------- 万能小动作（空动作） ---------- */

// 用户反馈：「*我低头一笑* 这种描写」——它跟角色、跟眼前处境都无关，谁都能用，
// 不说明任何事却占着"动作"的位置，整条回复就像套模板。
// 光靠提示词管不住（提示词里只要给一个具体动作样例，模型就照抄那个句式），
// 所以这里**直接删掉**这些片段，并把同一动作块里真正具体的那半句留下来。
const CLICHE_ACTIONS = [
  '低头一笑', '微微一笑', '轻轻一笑', '淡淡一笑', '浅浅一笑', '笑了笑', '笑了笑下', '笑了下', '笑了一下', '轻笑一声', '轻笑',
  '挑了挑眉', '挑挑眉', '挑了挑眉毛', '挑眉', '扬了扬眉',
  '撇了撇嘴', '撇撇嘴', '撇嘴', '嘟了嘟嘴', '嘟嘴',
  '耸了耸肩', '耸耸肩', '耸肩',
  '歪了歪头', '歪歪头', '歪头', '偏了偏头',
  '抬眼看你', '抬眸', '抬眼', '垂眸', '垂下眼', '垂下眼帘', '低了低眼',
  '眯了眯眼', '眯起眼', '眯眼', '眨了眨眼', '眨眼',
  '勾了勾嘴角', '勾起嘴角', '扯了扯嘴角',
  '抿了抿嘴', '抿了抿唇', '抿嘴', '咬了咬唇', '咬唇', '舔了舔唇',
  '叹了口气', '轻叹一声', '叹气', '呼出一口气',
  '皱了皱眉', '皱了皱眉头', '皱眉', '蹙眉',
  '顿了顿', '愣了一下', '怔了怔', '顿了顿脚',
  '搓了搓手', '搓搓手', '搓手', '搓了搓脸', '挠了挠头', '挠挠头', '挠头',
  '摸了摸鼻子', '摸摸鼻子', '摸了摸后颈', '捏了捏眉心', '捏眉心', '扶了扶额', '扶额',
  '揉了揉太阳穴', '揉了揉眉心', '清了清嗓子', '干咳一声',
];
// 「我/她 + 轻轻/微微… + 空动作」这种整段就是空动作的，删；
// 后面还挂着具体动作的（"微微一笑，把烟掐了"），只删前面那半句。
const CLICHE_SEG = new RegExp(
  `^(?:我|他|她)?\\s*(?:轻轻|微微|淡淡|浅浅|慢慢|稍稍|略微)?\\s*(?:地)?\\s*(?:${CLICHE_ACTIONS.join('|')})\\s*(?:了|着|下|一下)?$`,
);

/** 数一数这条回复里有多少处"万能小动作"（给质量分用；在**规整前**的原文上数）。 */
export function countClicheActions(text) {
  return countClicheIn(String(text || ''));
}

function countClicheIn(s) {
  let n = 0;
  const blocks = [...s.matchAll(/\*([^*\n]+)\*/g), ...s.matchAll(/[（(]([^）)\n]+)[）)]/g)];
  for (const m of blocks) {
    for (const seg of m[1].split(/[，,、；;]/)) {
      if (CLICHE_SEG.test(seg.trim())) n += 1;
    }
  }
  return n;
}

/**
 * 删掉动作块里的"万能小动作"片段。
 *   *我低头一笑，手指蘸了蘸大腿间的爱液*  → *手指蘸了蘸大腿间的爱液*
 *   *微微一笑*                            → 整块删掉（只剩空动作就没什么可留的）
 * 只动 *…* 块，台词一个字不碰。@returns {string}
 */
export function stripClicheActions(text) {
  const raw = String(text || '');
  // 粗筛用的是"含不含这些词"，**不能**拿上面那个带 ^…$ 的正则去测整段文本
  // （锚定后永远匹配不上，函数会次次提前返回 —— 踩过）。
  if (!raw || !CLICHE_ACTIONS.some((w) => raw.includes(w))) return raw;
  const cleanBlock = (whole, open, inner, close) => {
    const segs = inner.split(/[，,、；;]/).map((s) => s.trim()).filter(Boolean);
    if (!segs.length) return whole;
    const kept = segs.filter((s) => !CLICHE_SEG.test(s));
    if (kept.length === segs.length) return whole;         // 没有空动作，原样
    if (!kept.length) return '';                          // 整块都是空动作 → 删掉
    return `${open}${kept.join('，')}${close}`;
  };
  // v1.3.0：动作记号统一成（）之后，星号和括号两种都要清
  let out = raw.replace(/\*([^*\n]+)\*/g, (w, inner) => cleanBlock(w, '*', inner, '*'));
  out = out.replace(/[（(]([^）)\n]+)[）)]/g, (w, inner) => cleanBlock(w, w[0], inner, w[w.length - 1]));
  // 删块之后可能留下空行 / 行首多余标点，收拾一下
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^\s*[，,、]\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 给设置页的一句人话。 */
export function describeCliche(n) {
  return n ? `已删掉 ${n} 处空动作（低头一笑 / 挑眉 这类）` : '';
}

/* ---------- 拖延 / 回避检测 ---------- */

// 这些说法本身不算错，但**扎堆出现**基本就等于"这轮什么都没推进"。
const STALL_WORDS = [
  '别急', '不要急', '性急', '急躁', '慢慢来', '慢慢', '不急',
  '再聊', '先聊', '说说', '聊聊', '谈心', '谈谈心',
  '喝口水', '喝点水', '喝水', '歇口气', '歇会儿', '歇一歇', '休息一下',
  '待会儿', '等一会儿', '等一下', '稍等', '再等等',
  '先说说', '先说好', '说好', '规矩', '互相尊重', '尊重我',
  '准备好了吗', '你准备好了', '准备好了没',
  '换个话题', '换个方式', '放轻松', '放松点', '别紧张', '深呼吸',
  '好不好', '行不', '行不行', '你说是不是',
  '着急', '别着急', '先坐', '先坐下', '坐下聊', '先喝', '倒杯',
];

// 把球踢回对方 / 征求许可：这类句式出现，基本等于"这一轮由你来推进"。
// 真实样本（漏判过）：*歪着头挑眉* 你说呢？你想怎么玩儿？我们可以试试不一样的。
const CONSULT_WORDS = [
  '要不要', '好吗', '可以吗', '行吗', '你想不想', '你希望', '你愿意', '你觉得',
  '我帮你', '给你倒', '需要我', '想要我', '是不是想', '你想先',
  '你说呢', '你想怎么', '你想怎样', '想怎么玩', '怎么玩儿', '你想我',
  '你来决定', '你决定', '听你的', '随你', '你说吧', '试试不一样',
  // 实测漏判：「想不想看我亲口说？」—— 没带"你"就把球踢回来了
  '想不想',
  '需要吗', '有什么需要', '还需要', '有什么事', '想让我', '要我做', '请告诉我', '告诉我你',
  '请问', '有什么我可以', '我可以为你', '为你做',
];

// 整句复读检测用：把标点空白都去掉再比
const SKELETON_RE = /[\s*（）()【】「」，。！？、…—~～"“”'']/g;

// 找出"整句照抄上文"的句子（同一句在最近的历史里已经出现过）。
// 小模型很爱反复用同一句环境/动作描写凑字数（实测：连着两轮都写"空气中弥漫着淡淡的花香"）。
function repeatedSentences(reply, contextText) {
  const ctx = String(contextText || '').replace(SKELETON_RE, '');
  if (!ctx) return [];
  const seen = new Set();
  const out = [];
  // 先按 *动作* 段和（环境）段切开，再按句号切 —— 否则动作和括号会跟台词粘成一整句，
  // 复读的那半句永远匹配不上。
  const segments = String(reply || '').split(/(\*[^*\n]*\*|（[^）\n]*）|\([^)\n]*\))/g);
  for (const segment of segments) {
    for (const raw of segment.split(/[。！？!?\n]/)) {
      const skeleton = raw.replace(SKELETON_RE, '');
      if (skeleton.length < 8 || seen.has(skeleton)) continue;
      seen.add(skeleton);
      if (ctx.includes(skeleton)) out.push(raw.trim());
    }
  }
  return out;
}

// 具身推进：角色真的在做动作/拉近距离，而不是站着说话。这类回复应该加分。
const PROGRESS_WORDS = [
  '靠近', '走近', '贴近', '凑近', '俯身', '低头', '蹲下', '跨坐', '坐上',
  '吻', '亲', '抱', '搂', '牵', '拉住', '握住', '扣住', '按住', '压在', '贴上', '缠',
  '褪', '解', '掀起', '扯', '拽', '推倒', '抵在', '咬', '舔', '喘息', '颤抖', '收紧',
];

// 有的模型满嘴"您"（比"你"更客气）。匹配前统一成"你"，否则整套征询/拖延模式全部漏判。
function normalize(text) {
  return String(text || '').replace(/您/g, '你');
}

// 找出"同一条回复里把整句又写一遍"（不是紧挨着重复，而是前面写过、后面又写）。
// 实测有过这种：整段角色描写写两遍，中间夹一行"（内心有一丝期待）"。
function duplicatesInReply(text) {
  const seen = new Set();
  const out = [];
  for (const part of String(text || '').split(/(?<=[。！？!?\n])/)) {
    const key = part.replace(SKELETON_RE, '');
    if (key.length < 16) continue; // 和 loopguard 保持一致（实测重复句只有 16 字）
    if (seen.has(key)) { out.push(part.trim()); continue; }
    seen.add(key);
  }
  return out;
}

/* ---------- 出戏检测：自编自演 / 日记体 ---------- */

// 替对方（用户）做动作：这些跟在"你"后面，基本就是"AI 替用户演"了。
// 实测漏判过："你猛地顿了一下"（"猛地"是副词，也要算进去）。
const USER_ACTION_RE = /你(走过来|走近|走到|坐下|坐下来|站起身|站起来|翻身|转身|侧身|侧过头|低头|抬头|回头|转过头|闭上|睁开|伸手|点头|摇头|拿起|放下|脱下|穿上|躺下|靠在|抱住|拉住|推开|按下|摁下|按了|摁了|按住|压在|移开|跨|跪|猛地|忽然|突然|愣了一下|顿了一下|顿住|怔|僵|皱眉|笑了|喘|颤|抖|张嘴|张开嘴|停下|后退|凑近|靠过来|别过脸|松开|低下头|看了我|盯着|瞥|\w{0,4}了一眼)/;
// 替对方写心理
const USER_MIND_RE = /你(感到|觉得|似乎|心里|内心|明白|意识到|发觉|发现|打算|决定|想要|知道自己)/;

// 只在**叙述部分**检查：引号里是台词，"你说得对"这种不该算"替对方行动"
function narrationOnly(text) {
  return String(text || '')
    .split(/("[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』)/g)
    .filter((_, i) => i % 2 === 0)
    .join('');
}
// 明确的"替用户写动作"动词：只挑不可能被误当成台词的（笑/看/说/问 这类不列入，
// 因为「你笑了」「你看」在台词里太常见了）。
const USER_ACT_VERB = '(?:按|摁|推|拉|握|抓|抱|亲|吻|摸|碰|抚|拍|打|踢|走|坐|站|转|抬|低|伸|缩|拿|放|递|接|脱|穿|解|掀|扣|拽|扯|压|跪|趴|躺|靠|凑|翻)';
// 括号/星号里的旁白：以「你」为主语的动作或心理分句
const USER_ACT_CLAUSE_RE = new RegExp(
  // 字符类里排除括号/星号：不然「（你按下按钮）我听见…」会连括号后面的台词一起吃掉
  '你(?![们])[^，。！？!?（）()\\n*]{0,10}'
  + `(?:${USER_ACT_VERB}|没有一丝|毫不犹豫|毫不迟疑|确认|感到|觉得|心里|内心|明白|意识到|发觉|发现|打算|决定)`
  + '[^，。！？!?（）()\\n*]{0,10}',
);
// 「你的意图/想法/心理」—— 替对方读心
const USER_MIND_CLAUSE_RE = /你的(?:意图|想法|心思|心理|内心|情绪|感受|意思)/;

/**
 * 把「替用户演」的部分删掉（v1.2.2 用户要求）。
 *
 * 模型爱写「你按下了按钮」这种句子 —— 等于替玩家演。这里只删**旁白里的那一小段**：
 *   ① 括号（）/ 星号 *…* 里以「你」为主语的动作（"你推开门"）
 *   ② 读心短语（"你的意图""确认了你的想法"）
 * 引号里的台词一个字都不动（"你说得对"不能被当成替用户行动）；
 * 同一句里"我"的动作会留下（"（你推开门，我抬头）" → "（我抬头）"）。
 *
 * @returns {{text:string, changed:boolean, note:string, removed:number}}
 */
export function stripUserActions(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { text: raw, changed: false, note: '', removed: 0 };
  const quoted = /("[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』)/g;
  const blockRe = /（[^）\n]*）|\([^)\n]*\)/g;
  // 只删**句首**的「你+动作」（旁白语气），不删台词里的"你推我/你走了以后"——
  // 台词里第二人称太常见，全删会把对话剪烂（实测「可你叫我停下」被剪成「可。」）。
  const actRe = new RegExp(`(^|[。！？!?\\n])\\s*(?:${USER_ACT_CLAUSE_RE.source})`, 'g');
  let removed = 0;
  // 只在「纯叙述」片段里删「你+动作」；（）动作块**整块保留**，
  // 否则会把「（把杯子往你那边推了推）」剪成「（把杯子往）」（实测踩过）。
  const cleanPart = (part) => part
    .replace(/(?:确认|明白|猜到|看穿|读懂|察觉到)?了?你的(?:意图|想法|心思|心理|内心|情绪|感受|意思)/g,
      () => { removed += 1; return ''; })
    .replace(actRe, (m, prefix) => { removed += 1; return prefix; })
    .replace(/([（(])[ \t]*[，,、；;]+/g, '$1')
    .replace(/([，,])[ \t]*[，,]+/g, '$1')
    .replace(/[（(][ \t]*[）)]/g, '')
    .replace(/\*[ \t]*\*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([。！？!?])[，,、；;]+/g, '$1')
    .replace(/[，,]{2,}/g, '，')
    .replace(/[，,]([。！？!?])/g, '$1')
    .replace(/^[，,、；;：:\s]+/, '');
  // 动作块：按「，」拆成小句，只删**以「你」开头**的小句（用户在做的事），
  // 保留同一括号里属于角色自己的动作。「（你推开门，我抬起头）」→「（我抬起头）」。
  const cleanBlock = (block) => {
    const inner = block.slice(1, -1).trim();
    const clauses = inner.split(/(?<=[，,])/).map((x) => x.trim()).filter(Boolean);
    const kept = [];
    for (const clause of clauses) {
      if (/^(你|您)(?![们])/.test(clause)) { removed += 1; continue; }
      const fixed = clause
        .replace(/(?:确认|明白|猜到|看穿|读懂|察觉到)?了?你的(?:意图|想法|心思|心理|内心|情绪|感受|意思)/g,
          () => { removed += 1; return ''; })
        .replace(/[，,]+$/, '')
        .trim();
      if (fixed) kept.push(fixed);
    }
    if (!kept.length) return '';
    return `${block[0]}${kept.join('，')}${block.slice(-1)}`;
  };
  let out = '';
  let last = 0;
  const tokens = [];
  for (const m of raw.matchAll(quoted)) tokens.push({ type: 'quote', index: m.index, text: m[0] });
  for (const m of raw.matchAll(blockRe)) {
    if (tokens.some((t) => t.index < m.index && m.index < t.index + t.text.length)) continue;
    tokens.push({ type: 'block', index: m.index, text: m[0] });
  }
  tokens.sort((a, b) => a.index - b.index);
  for (const t of tokens) {
    if (t.index < last) continue;
    out += cleanPart(raw.slice(last, t.index));
    out += t.type === 'quote' ? t.text : cleanBlock(t.text);
    last = t.index + t.text.length;
  }
  out += cleanPart(raw.slice(last));
  out = out.trim();
  const changed = removed > 0 && out !== raw.trim();
  return {
    text: changed ? out : raw,
    changed,
    note: changed ? `删掉了模型替你写的 ${removed} 处动作/心理` : '',
    removed,
  };
}

// 旁白式推进：跳时间、做总结
const NARRATOR_RE = /(就这样|接下来|之后就|转眼|几分钟后|过了?一会儿你|不知过了多久|时间(一点点)?过去|再后来|从那天起|从此以?后)/;
// 心理活动词：扎堆出现 = 日记体
const MIND_WORDS = ['感到', '觉得', '内心', '心里', '似乎', '愉悦', '满足', '无奈', '自豪', '期待', '迷茫', '紧张', '羞涩', '羞耻', '渴望', '思绪', '情绪', '回忆'];

// 去掉 *动作* 和（环境）之后，剩下多少"台词"
function dialogueRatio(text) {
  const t = String(text || '').replace(/\s/g, '');
  if (!t.length) return 1;
  const plain = t
    .replace(/\*[^*\n]*\*/g, '')
    .replace(/（[^）\n]*）/g, '')
    .replace(/\([^)\n]*\)/g, '');
  return plain.length / t.length;
}

// 「他们/她们/其他/他人」是正常词，不算第三人称自称
// 繁体字：这些字只在繁体里用，简体文本里出现就说明模型串了
const TRAD_ONLY = /[開還們這說來時過個沒為麼車東頭見長門問聽買賣錢幾給對後裏裡兒兩從會實當學覺讓無舊處號語話誰應該體發變樣點數隻雙邊關係願聲與這個們嗎麼]/g;
// 环境括号（）里写了动作（"（拽你手腕按跪）"），不符合"只写小变化/气味线索"
const ENV_ACTION_RE = /（[^）\n]*(你|自己)?(拽|拉|推|按|压|抱|亲|吻|扯|扯下|脱|褪|解|跪|坐|站|靠|凑|贴|蹭|抬|低|转|伸|抓|握|扣|掀|翻|跨)[^）\n]*）/;

// 语言检测：模型（多语言底座）偶尔整段换成英文/日文/韩文，或者中英夹杂
function langStats(text) {
  const t = String(text || '');
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]+/g) || []).length; // 按"单词"数算，避免按字母数放大
  const kana = (t.match(/[\u3040-\u30ff]/g) || []).length;
  const other = (t.match(/[\u0400-\u04ff\u0370-\u03ff\u0600-\u06ff\uac00-\ud7af\u0e00-\u0e7f]/g) || []).length;
  return { cjk, latin, kana, other };
}

/**
 * 数一数这条回复里"拖延/回避"的痕迹有多重。
 * 单次出现很可能是正常台词，所以调用方用「≥2 个不同说法」当阈值。
 * @returns {{score: number, words: string[]}}
 */
export function stallScore(reply) {
  const text = normalize(reply);
  const words = STALL_WORDS.filter((w) => text.includes(w));
  return { score: words.length, words };
}

/** 给设置页/提示用的说明。 */
export function describeStall(words) {
  return `这轮像在拖延（${words.slice(0, 4).join('、')}），已重新生成一版`;
}

/* ---------- 综合质量分：挑最不像"回避/复读/灌水"的那一版 ---------- */

// 字符二元组相似度（0~1），用来发现"换了个说法但其实是同一句"。
function similarity(a, b) {
  const grams = (s) => {
    const t = String(s).replace(/[\s*（）()【】「」，。！？、…—]/g, '');
    const out = new Set();
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * 给一条候选回复打分：分越高越"该被淘汰"。
 * 只看可计算的信号，不依赖模型听话。
 * @param {string} reply
 * @param {{previousReply?: string, contextText?: string}} opts
 * @returns {{score: number, reasons: string[]}}
 */
export function replyQuality(reply, { previousReply = '', contextText = '', characterName = '', originalText = '' } = {}) {
  const text = normalize(reply);
  const reasons = [];
  let score = 0;

  // 混进来的英文单词（按**清理前**的原文判：清理会把它们删掉，
  // 但删掉之后这句中文往往还是读不通，所以还要扣分让服务端重抽一版）
  const stray = strayLatinWords(originalText || text, [characterName]);
  if (stray.length) { score += 3; reasons.push(`混了英文单词（${stray.slice(0, 2).join('、')}）`); }

  // 万能小动作（低头一笑 / 挑了挑眉…）：不承载信息，却占着"动作"的位置。
  // 服务端会把它们删掉（stripClicheActions），这里扣分是**让重抽偏向没写空动作的那一版** ——
  // 判据用清理前的原文（清理后已经数不到了）。
  const cliche = countClicheActions(originalText || text);
  if (cliche) { score += Math.min(4, 2 * cliche); reasons.push(`空动作×${cliche}（低头一笑这类）`); }

  // 写了角色自己的名字 = 第三人称旁白（normPerson 会把它换成"我"，
  // 走到这里还留着名字，说明是在引号里的台词里自称 —— 同样出戏）
  const name = String(characterName || '').trim();
  if (name && text.includes(name)) { score += 3; reasons.push('写了角色自己的名字（第三人称）'); }

  // 第三人称旁白 = 出戏。分两种形态罚，口径和 normalizePerson 对齐：
  //   ① **主语位置**的"他/她" = 角色在用第三人称写自己（`她抬起头` / `*她笑了*`）。
  //      这里判定是**激进**的（连光秃秃的文字一起算）：历史里出现过他/她就放行的旧逻辑
  //      是真正的漏网口 —— 只要台词里提过一次"店员"，后面所有第三人称都只罚 1~2 分，
  //      够不上重抽门槛 4，于是"她"就留在屏幕上了。
  //   ② 其它位置（宾语/定语，如台词"听他的"）：可能真在说别人，轻罚。
  const subjPron = thirdPersonSubjects(text);
  const ctxHasThird = /(?<!其)[他她](?!们|妈)/.test(String(contextText || ''));
  if (subjPron.length) {
    const list = subjPron.slice(0, 2).join('、');
    if (!ctxHasThird) { score += 4; reasons.push(`用他/她写自己（${list}）`); }
    else { score += 2; reasons.push(`用他/她写自己（${list}，但场景里有别人）`); }
  }
  const pronAll = (text.match(/(?<!其)[他她](?!们|妈)/g) || []).length;
  const pron = Math.max(0, pronAll - subjPron.length);
  if (pron) {
    if (!ctxHasThird) { score += 3; reasons.push(`凭空造人（他/她 ×${pron}）`); }
    else { score += Math.min(2, pron); reasons.push(`他/她 ×${pron}`); }
  }

  const invented = findInventedEvents(text, contextText);
  if (invented.length) { score += 4 * invented.length; reasons.push(`凭空动静×${invented.length}`); }

  const stall = stallScore(text);
  if (stall.score >= 2) { score += 2 * stall.score; reasons.push(`拖延×${stall.score}`); }

  // 征询许可（要不要 / 好吗 / 想不想…）：出现就说明这轮在等对方拿主意
  // 用去重后的命中数：'想不想' 和 '你想不想' 同时命中时只算一个
  const consult = distinctHits(normalize(text), CONSULT_WORDS).length;
  if (consult >= 1) { score += 2 * Math.min(3, consult); reasons.push(`征询许可×${consult}`); }

  // 具身推进（靠近 / 吻 / 抱 / 扣住…）：真的在动，减分
  const progress = PROGRESS_WORDS.filter((w) => text.includes(w)).length;
  if (progress >= 1) score -= Math.min(3, progress);

  // 只请示不推进：整轮都在问对方要主意，自己一个动作都没有 → 这一轮等于没演
  // （实测 zh-rp8b：「您想要我做些什么呢？请告诉我您的要求。」）
  if (consult >= 1 && progress === 0) { score += 2; reasons.push('只请示不推进'); }

  // 以提问/征求许可收尾 = 把球踢回给对方
  if (/[?？]\s*$/.test(text) || /(好不好|行不行|你说呢|你说是不是|准备好了吗)[。！？!]*$/.test(text.trim())) {
    score += 2;
    reasons.push('以问句收尾');
  }

  // 连问两次以上 = 一整轮都在问对方要主意（结构信号，不依赖词表）
  const qmarks = (text.match(/[?？]/g) || []).length;
  if (qmarks >= 2) { score += 2; reasons.push(`连问${qmarks}次`); }

  // 问了话却没有任何具身推进 = 把推进责任整个推给对方。
  // 这是**结构判定**，不列词表 —— 模型换一百种问法都躲不掉。
  if (qmarks >= 1 && progress === 0) { score += 4; reasons.push('只问不做'); }

  // 和上一版角色回复高度相似 = 复读
  //
  // 阈值为什么要看长度：2-gram 相似度对**长文**天然偏低（随机重合被稀释）、
  // 对**短文**天然偏高（几句客套话就能刷很高）。实测 395 组连续回复：
  //   120 字以上有 44% 被判 >0.5 —— 全是正常长篇，纯粹误伤；
  //   30~60 字只有 5%，而这 5% 里几乎全是真正的退化输出。
  // 所以长文用 0.62（只抓真的照抄），短文保持 0.5。同时也给一个**绝对长度**豁免：
  // 一条 200 字的长回复几乎不可能只靠几句套话就跟上一条重合到这个程度。
  if (previousReply) {
    const sim = similarity(text, previousReply);
    const len = text.replace(/\s/g, '').length;
    const threshold = len >= 120 ? 0.62 : len >= 60 ? 0.55 : 0.5;
    // 骨架完全一样另算（换了几个词就算"新回复"不算数）
    const skeletonSame = (() => {
      const sk = (s) => String(s).replace(/[\s*（）()【】「」，。！？、…—~～"“”'']/g, '');
      const a = sk(text);
      const b = sk(previousReply);
      return a.length >= 12 && a === b;
    })();
    if (skeletonSame || sim > threshold) {
      score += skeletonSame ? 6 : 4;
      reasons.push(`与上一轮雷同${(sim * 100).toFixed(0)}%`);
    }
  }

  // 整句照抄历史里的描写 = 复读（模型爱用同一句环境/动作描写凑字数）
  const repeated = repeatedSentences(text, contextText);
  // 整句复读：除了台词，**环境括号反复用同一句**也算（实测连续 5 轮
  // 「（空气中透着淡淡的草木香）」，每轮只扣 3 分、够不到重抽阈值 4，于是全放过去了）。
  // 环境描写重复比台词重复更伤：它让整段像模板。
  if (repeated.length) {
    const envRepeat = repeated.filter((t) => /^[（(]/.test(t)).length;
    const scoreAdd = 3 * repeated.length + (envRepeat ? 2 : 0);
    score += scoreAdd;
    reasons.push(envRepeat
      ? `整句复读×${repeated.length}（含环境描写重复×${envRepeat}）`
      : `整句复读×${repeated.length}`);
  }

  // 同一条回复里把整句又写一遍 = 退化（复读的另一种形态）
  const dup = duplicatesInReply(text);
  if (dup.length) { score += 3 * Math.min(2, dup.length); reasons.push(`整句重复×${dup.length}`); }

  // —— 出戏：自编自演 / 日记体 ——
  const narration = narrationOnly(text);
  const userAct = USER_ACTION_RE.test(narration);
  const userMind = USER_MIND_RE.test(narration);
  if (userAct || userMind) {
    score += 2 * ((userAct ? 1 : 0) + (userMind ? 1 : 0));
    reasons.push(userAct && userMind ? '替对方行动+写心理' : userAct ? '替对方行动' : '替对方写心理');
  }
  if (NARRATOR_RE.test(text)) { score += 2; reasons.push('旁白式推进（跳时间/总结）'); }
  // 整段几乎都是自我描写 → 日记感。
  // 但模型常把台词也塞进 *…* 里，占比算不出来，所以**有引号或有问号一律不算**
  //（那说明它至少在跟对方说话）。
  const compact = text.replace(/\s/g, '').length;
  const hasSpeechMark = /[？?]/.test(text) || /["“”「」『』]/.test(text);
  if (compact >= 80 && !hasSpeechMark && dialogueRatio(text) < 0.15) {
    score += 3;
    reasons.push('几乎没有台词（整段自我描写）');
  }
  const mind = MIND_WORDS.filter((w) => text.includes(w)).length;
  if (mind >= 4) { score += 2; reasons.push(`心理活动过多×${mind}`); }

  // 语言：整段换语言 / 中英夹杂（多语言底座 + 高温时常见）
  const lang = langStats(text);
  if (lang.cjk === 0 && (lang.latin || lang.kana || lang.other)) {
    score += 6; reasons.push('整段不是中文');
  } else if (lang.kana + lang.other >= 3) {
    score += 4; reasons.push('混进了日文/韩文/俄文');
  } else if (lang.latin >= 6 && lang.latin > lang.cjk / 4) {
    score += 3; reasons.push(`英文单词太多×${lang.latin}`);
  } else if (lang.latin >= 1 && lang.latin >= lang.cjk / 2) {
    score += 1; reasons.push(`夹了英文×${lang.latin}`);
  }

  // 繁体字（模型偶尔整段串成繁体，读起来很出戏）
  const trad = (text.match(TRAD_ONLY) || []).length;
  if (trad >= 2) { score += 3; reasons.push(`繁体字×${trad}`); }
  // 环境括号里写动作（用户明确要求：（）只写小变化/气味线索）
  if (ENV_ACTION_RE.test(text)) { score += 2; reasons.push('（）里写了动作'); }

  // 完全没有动作描写
  if (!/\*[^*\n]+\*/.test(text)) { score += 1; reasons.push('没有动作'); }

  // 太短，基本没内容（只写了开头就停 = 这一版等于废掉）
  //
  // ⚠ 但「短」不等于「坏」。gold-v1 这类精调过的小 LoRA 天然就是短回复
  // （30~60 字一条，一条动作一条台词），旧的 <40 一刀切会把它们全判成
  // 「过短」→ 触发重抽 → 重抽出来的更短 → 你看到的就是"回了一点点就没了"。
  // 所以这里改成看**结构**：有动作 + 有台词 = 完整的一轮，短也算数；
  // 只有"有开头没内容"（光一个 *动作* 或光一句话）才算废掉。
  const chars = text.replace(/\s/g, '').length;
  const hasAction = /\*[^*\n]{2,}\*/.test(text);
  const hasSpeech = /[^\s*（()）”。，！？!?…]/.test(text.replace(/\*[^*\n]*\*/g, ''));
  const structured = hasAction && hasSpeech;
  if (chars < 10) { score += 8; reasons.push('几乎是空的'); }
  // 动作只是「我」这种空壳（*我* / *我轻哼*），台词也没有 → 等于没写
  else if (chars < 16) { score += 6; reasons.push(`只有 ${chars} 字（空壳）`); }
  else if (chars < 40 && !structured) { score += 2; reasons.push('过短'); }
  // 括号没闭合 / 星号落单 = 生成被截断了（模型没写完就停了），别说成"过短"，
  // 直接判废 —— 这种留进历史会教坏下一轮。
  const openP = (text.match(/[（(]/g) || []).length;
  const closeP = (text.match(/[）)]/g) || []).length;
  const stars = (text.match(/\*/g) || []).length;
  if (openP !== closeP) { score += 6; reasons.push(`括号没闭合（${openP} 开 ${closeP} 闭）`); }
  else if (stars % 2 === 1) { score += 6; reasons.push('动作星号落单（写到一半断了）'); }

  return { score: Math.max(0, score), reasons };
}

/** 提示文案：告诉用户为什么重生成过。 */
export function describeQuality(reasons) {
  return `这轮质量偏低（${reasons.slice(0, 3).join('、')}），已换一版`;
}

/* ---------- 历史清洗（只在发送前做，不动存档） ---------- */

// 一句里出现"拖延/征询"说法就删掉，但只删"独立成句"的那句，动作段不碰。
// 目的不是改写存档，而是**切断模仿链**：模型每轮都在照抄自己前几轮的
//「别急 / 慢慢来 / 要不要先坐下」，历史里留着它就会一直复读。
// 命中的说法去重：'先说好' 已经命中时，不再把被它包含的 '说好' 重复计一次。
// （否则一句普通台词会因为子串重叠被误判成"两个说法"）
function distinctHits(text, patterns) {
  const matched = patterns.filter((w) => text.includes(w));
  return matched.filter((w) => !matched.some((other) => other !== w && other.includes(w)));
}

// 「纯拖延套话」：这些词本身**不承载任何剧情信息**，出现一次就足以判为废话。
// 历史清洗里靠它区分：
//   「别急，慢慢来」        → 纯套话，删
//   「衣服，你自己脱还是我帮你？」→ 含"我帮你"+问号，但这是**用户回答过的问题**，必须留
//   「行，随你。」/「挺懂规矩的嘛。」→ 同理，留
// 判断错了的代价不对称：多留一句套路只是有点烦，删掉剧情信息模型就真的忘了在干什么。
const HARD_STALL = new Set([
  '别急', '不要急', '慢慢来', '不急', '别紧张', '放轻松', '深呼吸',
  '准备好了吗', '你准备好了', '准备好了没', '好不好', '行不行', '你说是不是', '你说呢',
  '喝口水', '喝点水', '歇口气', '歇会儿', '歇一歇', '休息一下',
  '待会儿', '等一会儿', '稍等', '再等等', '先说说', '先说好',
  '互相尊重', '尊重我', '换个话题', '换个方式', '谈心', '谈谈心',
]);

function stripPatternSentences(line) {
  const patterns = [...STALL_WORDS, ...CONSULT_WORDS];
  // 先把 *动作* 段切出来单独保留：动作和台词写在同一行时，
  // 不能因为台词该删就把前面的动作块一起带走。
  const parts = [];
  const re = /\*[^*\n]*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push({ text: line.slice(last, m.index), action: false });
    parts.push({ text: m[0], action: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last), action: false });

  const kept = [];
  const dropped = [];
  for (const part of parts) {
    if (part.action) { kept.push(part.text); continue; }
    for (const s of part.text.split(/(?<=[。！？!?～~])/)) {
      const t = s.trim();
      if (!t) continue;
      const hits = distinctHits(normalize(t), patterns);
      // 判定要"短套话"和"带内容的句子"分开：
      //   歇口气，喝口水。（7 字，2 个信号）           → 删
      //   别急，慢慢来，我们再说。（11 字）             → 删
      //   你说呢？（4 字，纯套话）                      → 删
      //   待会儿该我了——我伺候你这么多（30 字，2 个信号）→ **留**（这句在推进剧情）
      // 判断错了代价不对称：多留一句套路只是有点烦，删掉剧情信息模型就真的忘了在干什么。
      const strong = hits.length >= 3
        || (hits.length >= 2 && t.length <= 14)
        || (hits.some((w) => HARD_STALL.has(w)) && t.length <= 10);
      if (strong) dropped.push(t);
      else kept.push(s);
    }
  }
  return { text: kept.join('').trim(), dropped };
}

/**
 * 清洗**历史里**的一条角色回复（发送给模型用，不改存档）。
 * 先规整星号/括号标记（老记录里模型常把 * 和 ) 混着用），
 * 再清凭空造出来的动静，最后去掉成句的拖延/征询台词。
 * @returns {{ text: string, changed: boolean }}
 */
export function cleanHistoryText(reply, contextText = '', opts = {}) {
  const original = String(reply || '');
  if (!original.trim()) return { text: original, changed: false };

  // 历史里的标记和人称也要规整：模型会照着前几轮的样子写，留着坏例子会一直传染
  let normalized = normalizePerson(normalizeMarkup(original, { keep: [opts.name] }), opts.name);
  // 「自我复读锁定」：模型在历史里看到自己说过某句，就会把那句当成风格继续复制。
  // 把**和更早历史重复的整句**从**发给模型的历史**里删掉（存档不动），循环就断了。
  const priorNorm = String(contextText || '').replace(/\s+/g, '');
  let historyDeduped = false;
  if (priorNorm) {
    const kept = [];
    let dropped = 0;
    for (const line of normalized.split('\n')) {
      const parts = line.split(/(?<=[。！？!?～~])/);
      const keptParts = [];
      for (const part of parts) {
        const key = part.replace(/\s+/g, '');
        if (key.length >= 8 && priorNorm.includes(key)) { dropped += 1; continue; }
        keptParts.push(part);
      }
      const joined = keptParts.join('').trim();
      if (joined) kept.push(joined);
    }
    if (dropped) { normalized = kept.join('\n'); historyDeduped = true; }
  }
  // 历史清洗要看**整段**上文来判断"这个动静是不是本来就存在"。
  // 用默认的 1200 字窗口会误删早就确立的场景事实（实测删掉过
  //「（电视里换了个场景，音量还是不大，正好盖住隔壁的动静）」——
  //  "隔壁"上次出现是在 1200 字以外，于是被当成凭空造出来的）。
  const first = sanitizeReply(normalized, contextText, { window: HISTORY_WINDOW });
  const lines = [];
  let touched = first.cleaned.length > 0 || historyDeduped || normalized !== original; // 规整过标记也算"动过"
  for (const line of first.text.split('\n')) {
    // 整行都是动作描写（去掉 *…* 后没有台词）→ 原样保留
    const spoken = line.replace(/\*[^*\n]*\*/g, '').trim();
    if (!spoken) { lines.push(line); continue; }
    const r = stripPatternSentences(line);
    if (r.dropped.length) touched = true;
    const joined = r.text.trim();
    if (joined) lines.push(joined);
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // 安全阀：清完几乎没内容了，就保持原样
  if (!touched || text.replace(/\s/g, '').length < 8) return { text: original, changed: false };
  return { text, changed: true };
}

/**
 * 按顺序清洗整段历史：每条只看它**之前**的内容判断"凭空"，
 * 所以早期消息里本来就有的动静不会被误判成凭空。
 * @returns {{ messages: Array, cleanedCount: number, removedChars: number }}
 */
export function cleanHistory(messages, opts = {}) {
  let acc = '';
  let cleanedCount = 0;
  let removedChars = 0;
  // 已经出现过的环境描写（括号段）：同一句第二次出现就从历史里拿掉。
  // 为什么要这一步：模型会**自我锁定** —— 它自己发明一句环境描写写进历史后，
  // 每次生成都能看到它，于是继续用。实测某会话 30 条回复里 23 条都是
  // 「（空气中透着淡淡的草木香）」，而这句在训练数据里出现 0 次。
  // 光靠「质量分 → 重抽」救不了：重抽时上下文里还有那句，模型照样写。
  // 只有把它从**发给模型的历史**里摘掉，才断得掉这个循环。
  const seenEnv = new Set();
  const dropRepeatEnv = (text) => {
    let dropped = 0;
    const kept = text.replace(/[（(]([^）)]{2,60})[）)]/g, (whole, inner) => {
      const key = inner.replace(/\s/g, '');
      if (key.length < 6) return whole;        // 太短的不算（"（嗯）"这种）
      if (seenEnv.has(key)) { dropped += 1; return ''; }
      seenEnv.add(key);
      return whole;
    });
    return { text: dropped ? kept.replace(/\n{3,}/g, '\n\n').trim() : text, dropped };
  };
  // 整条重复的角色回复：同一句回复在历史里出现第二次就摘掉。
  // 为什么必须做：一旦某条回复被存了两次，模型会照着复读（上下文自我强化）。
  // 实测：我在测试里连问同一句，会话里攒了 4 条一模一样的回复之后，
  // 连**未训练的基座模型**都开始逐字复读同一句 —— 说明污染在历史，不在权重。
  // 之前的括号去重只挡环境描写，挡不住整句重复。
  const seenReplies = new Set();
  const normReply = (t) => String(t || '').replace(/\s+/g, '');
  const out = messages.map((m) => {
    const content = String(m.content || '');
    if (m.role !== 'assistant') {
      acc += `\n${content}`;
      return m;
    }
    const key = normReply(content);
    if (key.length >= 20) {
      if (seenReplies.has(key)) {
        cleanedCount += 1;
        removedChars += content.length;
        acc += `\n${content}`;
        return null;              // 重复的整条不再发给模型
      }
      seenReplies.add(key);
    }
    const r = cleanHistoryText(content, acc, opts);
    acc += `\n${content}`; // 判断依据用原文，保证"上文提过没有"是准确的
    // 去重放在清洗之后：清洗可能已经删掉了部分段落，剩下的才是要判重的
    const dedup = dropRepeatEnv(r.text);
    if (dedup.dropped) {
      cleanedCount += 1;
      removedChars += Math.max(0, r.text.length - dedup.text.length);
      if (!dedup.text.replace(/\s/g, '')) {
        // 整条只剩那句重复的环境描写 → 整条丢掉（留着反而更强化它）
        return null;
      }
      return { ...m, content: dedup.text };
    }
    if (!r.changed) return m;
    cleanedCount += 1;
    removedChars += Math.max(0, content.length - r.text.length);
    return { ...m, content: r.text };
  }).filter(Boolean);
  return { messages: out, cleanedCount, removedChars };
}

