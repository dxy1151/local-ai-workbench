// ============================================================================
//  样本加权：把你「亲手改过」和「挑一版选中」的回答放大
//
//  为什么需要加权：
//    模型原始输出里混着你不满意的（只问不做、复读、过长…）；
//    而你亲手改的 / 从候选里挑的，是**明确的正面信号**。
//    同样一条样本，凭什么是模型自己写的就该和你改过的等权？
//
//  实现方式：不改 loss 公式，走 token 上限剪裁（数据复制）。
//    SFT ：跑 --epochs 轮，每轮权重 w 的样本出现一次以上的概率是 min(1, w)
//          期望轮数 = 1 + w  →  w = 3 等价于这条被学 4 遍
//    DPO ：每对训练一次，直接按整数复制（数量少，不能靠概率）
//
//  默认值保守：3 / 2。改太猛（比如 8）会让模型复读这些样本的表达方式。
// ============================================================================

/** 默认权重。UI 和接口都用这一份，避免两边各写一套。 */
// edited：作者亲手改过的回复（最可信的「这样写才对」信号）
// adopted：从候选里挑中的那一版（次之）
// plain：原样保留、没动过的
// 2026-10-25：手改从 3 提到 5 —— 实测手改样本只占 12%，梯度里被淹没；
// 加权走的是「样本复制」，不改 loss 公式，所以提高只是让它多出现几次。
// handwritten：作者亲手写的「提示 + 回复」（手写素材页）——
// 这是最干净的目标样本，没有模型生成的痕迹，所以给最高档。
export const DEFAULT_WEIGHTS = Object.freeze({ handwritten: 8, edited: 5, adopted: 2, plain: 1 });

/** 权重上限：超过这个值基本等于把标准答案背下来，泛化会塌。 */
export const MAX_WEIGHT = 12;

/** 把任意输入规整成 {edited, adopted, plain}，每项夹在 [1, MAX_WEIGHT] 的整数。 */
export function normalizeWeights(w = {}) {
  const out = { ...DEFAULT_WEIGHTS };
  for (const k of ['handwritten', 'edited', 'adopted', 'plain']) {
    if (w[k] === undefined || w[k] === null || w[k] === '') continue;
    const n = Math.round(Number(w[k]));
    if (Number.isFinite(n)) out[k] = Math.max(1, Math.min(MAX_WEIGHT, n));
  }
  return out;
}

/** 某个溯源标记对应的权重。 */
export function weightOf(origin, weights = DEFAULT_WEIGHTS) {
  return weights[origin] ?? weights.plain ?? 1;
}

/**
 * 按权重做上限剪裁采样（unbiased-ish）。
 * @param {Array} rows      每行至少带 w 字段或 {meta:{origin}}
 * @param {object} o  { weights, originOf, rng }
 * @returns {{rows: Array, stat: object}}
 */
export function applySampleWeights(rows, o = {}) {
  const weights = normalizeWeights(o.weights);
  const originOf = o.originOf || ((r) => r?.meta?.origin || 'plain');
  const rng = o.rng || Math.random;
  const out = [];
  const stat = { input: rows.length, output: 0, byOrigin: {}, byWeight: {} };
  for (const r of rows) {
    const origin = originOf(r);
    const w = weightOf(origin, weights);
    stat.byOrigin[origin] = (stat.byOrigin[origin] || 0) + 1;
    stat.byWeight[w] = (stat.byWeight[w] || 0) + 1;
    const copies = Math.floor(w) + (rng() < w - Math.floor(w) ? 1 : 0);
    for (let i = 0; i < Math.max(1, copies); i++) out.push(r);
  }
  stat.output = out.length;
  return { rows: out, stat };
}

/**
 * DPO 用的确定性复制（不打乱：chosen/rejected 成对，顺序无关紧要但保持可复现）。
 */
export function expandPairs(pairs, o = {}) {
  const weights = normalizeWeights(o.weights);
  const originOf = o.originOf || ((r) => r.origin || 'plain');
  const out = [];
  const stat = { input: pairs.length, output: 0, byOrigin: {} };
  for (const p of pairs) {
    const origin = originOf(p);
    const w = weightOf(origin, weights);
    stat.byOrigin[origin] = (stat.byOrigin[origin] || 0) + 1;
    for (let i = 0; i < Math.max(1, Math.round(w)); i++) out.push(p);
  }
  stat.output = out.length;
  return { rows: out, stat };
}

/** 给训练面板看的一行中文说明。 */
export function describeWeights(w) {
  const weights = normalizeWeights(w);
  return `手改 ×${weights.edited} · 挑一版 ×${weights.adopted} · 原始 ×${weights.plain}`;
}
