// 「块」—— 拼进系统提示词末尾的那些独立段
//
// 每个块都是自包含的：没有资料就不返回（空串），调用方用 `if (x) L.push(x)` 拼。
// 这些块大多带**硬约束**（字数、时间、暗号），精简模式里也不能丢 ——
// 极简的目的是「别把 5000 字规则塞给基座模型」，不是「把用户的设置全丢掉」。

import { NOT_DIALOG_SUFFIX, TIME_ADVANCE_RULE } from './shared.js';

/* ---------- 字数 ---------- */

/**
 * 篇幅块。
 *
 * ⚠ 这是**全流程唯一提到篇幅的地方**。别再在 hint、customRules、detailNudge 里写别的数字 ——
 *   实测三处冲突（hint 90 字 / customRules 250-350 字 / 这里另一个上限），
 *   模型只能随机挑一条，表现为「有时候短得离谱、有时候长得没边」。
 *
 * v2.5.6 —— **不再给「下限」的数字，一律只给上限**。
 *
 * 踩过的坑（这是最贵的一次）：
 *   提示词里同时出现「不要超过 60 字」和「至少写 30 字」，模型把这当成一道
 *   **要它自己解开的算术题**，于是每轮思考都变成：
 *     数一下字数：（1）拇（2）指（3）压（4）住…
 *     正好 60 字！让我再检查一遍。
 *     字符计数：( = 1 / 指 = 2 / … / 腿 = 56 / 别 = 57 …
 *   实测连跑两轮，1709 / 3466 字的思考里九成在逐字点字数，
 *   最后连正文都没写出来（reasoning 被当成回复吐出来）。
 *   上限是"别写太长"，模型不会真去数；**下限是"写够 N 字"，它一定会去数**——
 *   「够不够」这个判断没法估，只能一个一个点。区间越窄，点得越狠。
 *
 * 所以：下限只在**真的会截断**的场合给（见 minChars 的调用方），
 *   这里只保留上限，下限改成**不带数字**的质量要求。
 *
 * @param {number} maxChars 上限（0/空 = 不限制）
 * @param {number} minChars 下限（0 = 不设）—— 只用来判断要不要催"写具体点"，不再输出数字
 */
export function limitBlock(maxChars, minChars = 0) {
  const n = normalizeMaxCharsLocal(maxChars);
  // v2.5.5：上下限绝不能打架 —— 下限 >= 上限时直接丢掉下限（上限是硬约束）。
  const raw = Number(minChars) > 0 ? Math.round(Number(minChars)) : 0;
  const wantFuller = raw > 0 && raw < n;
  const lower = wantFuller
    ? '\n别只写一两句就收 —— 台词给足，动作写到手上、身上，让人看得出这一段发生了什么。'
    : '';
  if (!n) return wantFuller ? lower.trim() : '';
  return `【篇幅】整条回复（动作 + 台词 + 环境描写全算）**不要超过 ${n} 字**。`
    + '目标是写够具体细节但不注水；写超了会被截断，别用凑字数的废话填。' + lower;
}

// 本地小工具：只用来把传入值收成合法数字（真正的归一化在 prompt.js 的 normalizeMaxChars）
function normalizeMaxCharsLocal(raw) {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(4000, n) : 0;
}

/* ---------- 本轮没有资料 ---------- */

export function noKnowledgeBlock() {
  return '【本轮没有可用资料】资料库里没有和当前问题相关的内容。'
    + '如果这个问题需要事实依据，请直说"我这边没有相关资料"，不要凭记忆编造具体数字、日期、人名或结论。';
}

/* ---------- 场景推进 ---------- */

export function timeNudge() {
  return `【场景推进】这一轮要把时间/场景往前走一点：用台词或一个动作带出来`
    + `（过了一阵、天色更暗了、饭吃完了、换到另一个地方、该睡了/该走了），`
    + `**不要问用户"要不要走/要不要睡"**，直接让它发生。`
    + `${TIME_ADVANCE_RULE}这是系统要求，不是台词：不要照抄这句话。`;
}

/* ---------- 本轮暗号 ---------- */

export function keywordActionsBlock(matches) {
  const list = Array.isArray(matches) ? matches : [];
  if (!list.length) return '';
  return [
    '【本轮暗号】用户这句话里提到了下面这些关键词，角色必须照做：',
    ...list.map((x) => `- 「${x.kw}」→ ${x.action}`),
    '命中暗号时：直接把这个动作写进（）里、照着做，不要问"为什么/你确定吗"，也不要把暗号本身念出来；',
    '做完动作再照常接台词。这是系统要求，不是台词。',
  ].join('\n');
}

/* ---------- 描写幅度（维度） ---------- */

export const DIM_MAX = 10;

const DIM_HELP = {
  语言: '台词、对话的多少',
  动作: '肢体动作、身体移动',
  神态: '表情、眼神、语气里透出的情绪',
  心理: '内心活动、想法',
  环境: '场景里本来就有的东西：光线、声音、气味、陈设（**不要凭空加新事件/新人物**）',
};

function clampLevel(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(DIM_MAX, n)) : DIM_MAX;
}

function levelWord(level) {
  if (level === 0) return '完全不出现';
  if (level <= 3) return '只偶尔带一笔';
  if (level <= 6) return '正常出现';
  if (level <= 8) return '多写一点（不延长句子，多给一处）';
  return '重点写（不延长句子，多给几处）';
}

/**
 * 按权重分配这一轮的笔墨。
 *
 * @param {Array<{name:string, level:number}>} dims
 */
export function dimsBlock(dims) {
  const list = Array.isArray(dims)
    ? dims
        .filter((d) => d && String(d.name || '').trim())
        .filter((d) => String(d.name).trim() !== '常用词')   // 常用词有自己的一段
        .map((d) => ({ name: String(d.name).trim().slice(0, 8), level: clampLevel(d.level) }))
        .slice(0, 10)
    : [];
  if (!list.length) return '';
  const rows = list.map((d) => {
    const hint = DIM_HELP[d.name] ? `（${DIM_HELP[d.name]}）` : '';
    const extra = d.name === '语言' && d.level === 0
      ? '　**这一轮一句台词都不要写**：引号里的对话、心里话、自言自语全都不要，只写动作、神态、环境。'
      : '';
    return `- ${d.name}${hint}：${d.level}/${DIM_MAX} —— ${levelWord(d.level)}${extra}`;
  });
  return [
    `【描写幅度】这一轮的笔墨大致按这个比例分（0 = 不出现，${DIM_MAX} = 多写）：`,
    ...rows,
    // v2.5.6：末尾原来是一句"以上只调节比例，不改变其它硬性要求：必须有台词、不替对方行动或写心理、
    //   不写旁白式总结、不跳时间"—— 那串清单会被模型当成**待核对的检查项**，
    //   实测思考里逐条复述"必须有台词✓/不替对方✓"要花掉几百字，还把思考撑到上万字。
    //   现在只说"别改别的"，不再重复列一遍。
    '总篇幅不变，只是内部比例不同。不要因为这张表改变其它要求。',
  ].join('\n');
}

/* ---------- 用户的 hint / 备忘 ---------- */

export function memoBlock(memo) {
  const text = String(memo || '').trim();
  if (!text) return '';
  return `【备忘】${text.slice(0, 600)}`;
}
