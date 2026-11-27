// ============================================================================
//  xingye-chat → QLoRA 训练数据导出（被 /api/export-training 和 /api/train/session 共用）
//
//  设计要点：训练数据必须和「聊天时真实发出去的那一刻」逐字一致。
//  所以全程复用 lib/prompt.js 的 buildMessages，不自己拼 system。
//
//  长度按 token 估算：中文正文约 1.6 字/token。
//  你的 system prompt 本身就有约 3100 字（≈1900 token），所以：
//    - maxTokens 2048 → 几乎放不下对话（只够 1 轮）
//    - maxTokens 3072 → 能放 1~7 轮，是推荐值
// ============================================================================
import { buildMessages, CONTEXT_BUDGET } from './prompt.js';
import { listCharacters, listSessions, getSession, getConfig } from './store.js';

const estTok = (t) => Math.ceil(String(t).length / 1.6);

function buildOptsFor(config, character) {
  return {
    cleanHistory: config.cleanHistory !== false,
    dims: character?.dims?.length ? character.dims : config.dims,
    hint: String(character?.hint || '').trim() || config.hint,
    synonyms: config.synonyms,
    synonymsOutput: config.synonymsOutput === true,
    memo: config.memo,
    maxChars: config.maxChars,
    knowledge: [],      // 资料库/联网结果不烧进 LoRA：它们的运行时按需注入的
    noKnowledge: false,
    search: [],
    searchChars: config.webSearchChars,
    thinkOff: false,    // 本地 chat 模式不需要 /no_think
  };
}

function dialogMsgs(session) {
  return (session.messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .filter((m) => String(m.content || '').trim());
}

/**
 * 导出训练样本。
 * o.sessionId   只导某个会话
 * o.characterId 只导某个角色
 * o.maxTokens   单条样本 token 上限，默认 3072
 * o.histTokens  历史预算 token；0 = 自动（用剩余预算）
 * o.minChars    回复最短字数，默认 12
 * o.withRejected 是否导出被否决的负样本，默认 true
 *
 * 每条样本的 meta.origin 标明来源（加权训练要用）：
 *   edited  你在「编辑」里亲手改过（editedAt）
 *   adopted 你在「🎲 挑一版」里选中的（adoptedAt）
 *   plain   模型原始输出
 */
export async function exportTrainingSamples(o = {}) {
  const config = await getConfig();
  const maxTokens = Number(o.maxTokens) || 3072;
  const histTok = Number(o.histTokens) || 0;
  const minChars = Number.isFinite(Number(o.minChars)) ? Number(o.minChars) : 12;
  const withRejected = o.withRejected !== false;

  const chars = await listCharacters();
  const charById = new Map(chars.map((c) => [c.id, c]));
  let sessions = await listSessions();
  if (o.sessionId) sessions = sessions.filter((s) => s.id === o.sessionId);
  if (o.characterId) sessions = sessions.filter((s) => s.characterId === o.characterId);
  sessions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const samples = [];
  const negatives = [];
  const stat = { sessions: 0, turns: 0, skippedShort: 0, skippedLong: 0, rejected: 0, errors: 0 };

  for (const s of sessions) {
    const session = await getSession(s.id);
    if (!session) continue;
    const character = charById.get(session.characterId) || { id: session.characterId, name: '对话', persona: '' };
    const msgs = dialogMsgs(session);
    if (msgs.length < 2) continue;
    stat.sessions += 1;
    const buildOpts = buildOptsFor(config, character);
    const narrative = config.narrative || '';

    for (let k = 1; k < msgs.length; k++) {
      const cur = msgs[k];
      if (cur.role !== 'assistant') continue;
      const reply = String(cur.content || '').trim();
      if (reply.length < minChars) { stat.skippedShort += 1; continue; }

      const historyUpTo = msgs.slice(0, k).map(({ role, content }) => ({ role, content }));
      let messages;
      try {
        // 先只算 system 的真实长度，剩余预算留给历史（否则 7200 字预算会塞满、每条都超长）
        const sysOnly = buildMessages(character, [], CONTEXT_BUDGET, narrative, buildOpts);
        const sysTok = estTok(sysOnly[0].content);
        const budgetTok = histTok > 0
          ? histTok
          : Math.max(0, maxTokens - sysTok - Math.max(40, Math.floor(maxTokens * 0.25)));
        const budgetChars = Math.floor(budgetTok * 1.6);
        const kept = [];
        let used = 0;
        for (let j = historyUpTo.length - 1; j >= 0; j--) {
          const c = historyUpTo[j].content.length + 8;
          if (used + c > budgetChars && kept.length > 0) break;
          used += c;
          kept.unshift(historyUpTo[j]);
        }
        if (!kept.length) { stat.skippedLong += 1; continue; }
        messages = buildMessages(character, kept, CONTEXT_BUDGET, narrative, buildOpts);
      } catch { stat.errors += 1; continue; }

      const sys = messages[0];
      const convo = messages.slice(1);
      const totalTok = estTok(sys.content) + convo.reduce((n, m) => n + estTok(m.content), 0) + estTok(reply);
      if (totalTok > maxTokens) { stat.skippedLong += 1; continue; }

      // 溯源标记：这条回复是「你亲手改过的」还是「🎲 挑一版选中的」还是「模型原始输出」。
      // 加权训练就靠它 —— 见 lib/weights.js。
      const origin = cur.origin === 'edited' || cur.editedAt
        ? 'edited'
        : (cur.origin === 'adopted' || cur.adoptedAt ? 'adopted' : 'plain');
      samples.push({
        messages: [sys, ...convo, { role: 'assistant', content: reply }],
        meta: {
          sessionId: session.id, character: character.name || '', turn: k, estTokens: totalTok,
          origin,
          msgId: String(cur.id || ''),
          editedAt: Number(cur.editedAt) || 0,
          adoptedAt: Number(cur.adoptedAt) || 0,
        },
      });
      stat.turns += 1;

      if (withRejected && Array.isArray(cur.rejected)) {
        for (const r of cur.rejected) {
          const t = String(r.text || '').trim();
          if (t.length < minChars) continue;
          const tTok = estTok(sys.content) + convo.reduce((n, m) => n + estTok(m.content), 0) + estTok(t);
          if (tTok > maxTokens) continue;
          negatives.push({
            messages: [sys, ...convo, { role: 'assistant', content: t }],
            reason: String(r.reason || '').slice(0, 200),
            sessionId: session.id,
          });
          stat.rejected += 1;
        }
      }
    }
  }

  const toks = samples.map((s) => s.meta.estTokens).sort((a, b) => a - b);
  const pct = (q) => (toks.length ? toks[Math.min(toks.length - 1, Math.floor(toks.length * q))] : 0);
  return {
    samples,
    negatives,
    stat: {
      ...stat,
      maxTokens,
      tokMedian: pct(0.5),
      tokP90: pct(0.9),
      tokMax: toks.length ? toks[toks.length - 1] : 0,
    },
  };
}

export function toJsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

// ============================================================================
//  数据清洗：剔除会让 LoRA 学到「坏习惯」的样本
//
//  针对你的实际情况（抽查 193 条角色回复得到的比例）：
//    - 6%  含「就这样/接下来/几分钟后」跳时间旁白  → prompt 明确禁止
//    - <40 字过短回复（14%）                     → 不足以体现节奏
//    - 与上一轮几乎重复的回复                     → 会让模型变复读机
//    - 纯台词、无动作无环境（1%）                → 破坏格式一致性
// ============================================================================
const NO_TIME_SKIP = /(就这样|接下来|几分钟后|片刻后|过了一会儿|许久之后|不知过了多久)/;
const ACTION_MARK = /\*[^*]{2,}\*/;
const ENV_MARK = /[（(][^）)]{2,}[）)]/;

function lastReply(sample) {
  const m = sample.messages || [];
  for (let i = m.length - 1; i >= 0; i--) {
    if (m[i].role === 'assistant') return String(m[i].content || '');
  }
  return '';
}

/** 判断两条回复是否高度重复（前缀相同或字符集合重合度高）。 */
function tooSimilar(a, b) {
  const A = a.replace(/\s+/g, '');
  const B = b.replace(/\s+/g, '');
  if (!A || !B) return false;
  if (A === B) return true;
  const n = Math.min(A.length, B.length, 40);
  if (n >= 20 && A.slice(0, n) === B.slice(0, n)) return true;
  return false;
}

/**
 * 清洗训练样本。
 * @param {Array} samples
 * @param {object} o { minChars=20, dropTimeSkip=true, dropNoAction=false, dedupe=true }
 * @returns {{samples: Array, report: object}}
 */
export function cleanSamples(samples, o = {}) {
  const minChars = Number.isFinite(Number(o.minChars)) ? Number(o.minChars) : 20;
  const dropTimeSkip = o.dropTimeSkip !== false;
  const dropNoAction = o.dropNoAction === true;
  const dedupe = o.dedupe !== false;

  const keep = [];
  const report = {
    input: samples.length,
    removedTimeSkip: 0,
    removedTooShort: 0,
    removedNoAction: 0,
    removedDuplicate: 0,
    output: 0,
  };
  const seen = [];

  for (const s of samples) {
    const r = lastReply(s).trim();
    if (dropTimeSkip && NO_TIME_SKIP.test(r)) { report.removedTimeSkip += 1; continue; }
    if (r.length < minChars) { report.removedTooShort += 1; continue; }
    if (dropNoAction && !ACTION_MARK.test(r) && !ENV_MARK.test(r)) { report.removedNoAction += 1; continue; }
    if (dedupe && seen.some((x) => tooSimilar(x, r))) { report.removedDuplicate += 1; continue; }
    seen.push(r);
    keep.push(s);
  }
  report.output = keep.length;
  return { samples: keep, report };
}

// ============================================================================
//  生成 DPO 偏好对：把同一轮里「保留下来的回复」和「被否决的回复」配成对
//
//  每条 assistant 消息的 `rejected` 字段记录了你当场否决的版本 + 原因。
//  DPO 就是让模型学会：在同样的上下文里，chosen 的概率要高于 rejected。
//
//  返回 [{ prompt, chosen, rejected, reason, sessionId }]，prompt 是 chat 模板
//  渲染后的字符串（不含最后的 assistant 回复）。
// ============================================================================
/**
 * DPO 用的 system prompt 瘦身。
 *
 * 为什么要瘦：DPO 的 loss 要同时算 chosen 和 rejected 两条路径的 logprob，
 * 两路激活同时驻留显存。seq 2650 时单步激活约 7 GB，
 * 加上权重/优化器就顶到 16 GB 卡的天花板（实测 OOM）。
 * gold-v1 那次 DPO 跑得动，是因为它的 prompt 里**根本没带 system**（356 字符）。
 */
// 这些 reason 说的是「换了一版」或「做了处理」，不代表 rejected 更差。
// 用它们当负样本会把 DPO 训成噪声拟合。
const NON_VETO_HINTS = [
  '重新生成前的一版',
  '调整描写幅度前的一版',
  '检测到整句重复',
  '超出字数上限',
  '清理前',
];

/**
 * 这个否决理由算不算「真否决」？
 * @param {string} reason
 * @returns {boolean} true = 只是换版/处理事件，不该当负样本
 */
function isNotAVeto(reason) {
  const t = String(reason || '');
  if (!t) return false;          // 没写理由的保留（老数据可能只是没记）
  return NON_VETO_HINTS.some((k) => t.includes(k));
}

function shapeSystemForDpo(messages, mode, maxChars, character) {
  if (mode === 'full') return messages;
  const rest = messages[0]?.role === 'system' ? messages.slice(1) : messages;
  if (mode === 'none') return rest;
  // short：角色名 + 说话风格提示，够模型知道"在扮谁"，但别塞满 1800 token 的规则
  const name = String(character?.name || '').trim();
  const hint = String(character?.hint || '').trim();
  let brief = `${name ? `你在扮演「${name}」。` : ''}用第一人称，动作写在 *星号* 里，环境变化写在（括号）里。`;
  if (hint) brief += `\n说话风格：${hint.slice(0, 200)}`;
  if (brief.length > maxChars) brief = `${brief.slice(0, maxChars)}…`;
  return [{ role: 'system', content: brief }, ...rest];
}

export async function exportPreferencePairs(o = {}) {
  const config = await getConfig();
  const maxTokens = Number(o.maxTokens) || 3072;
  const minChars = Number.isFinite(Number(o.minChars)) ? Number(o.minChars) : 12;
  // system prompt 怎么带：
  //   'full'  —— 和 SFT 完全一致（2866 字 ≈ 1800 token）。**16 GB 卡上 DPO 会 OOM**，
  //              因为 DPO 要同时算 chosen/rejected 两路激活，prompt 越长峰值得越高。
  //   'short' —— 只留角色名 + 说话风格摘要（几百字）。分布和 SFT 略有差异，但偏好信号完整。
  //   'none'  —— 完全不带 system（和 gold_corpus.py 导出的 DPO 一样）。最省显存。
  const systemMode = ['full', 'short', 'none'].includes(o.systemMode) ? o.systemMode : 'full';
  const shortSystemChars = Number(o.shortSystemChars) > 0 ? Number(o.shortSystemChars) : 800;

  const chars = await listCharacters();
  const charById = new Map(chars.map((c) => [c.id, c]));
  let sessions = await listSessions();
  if (o.sessionId) sessions = sessions.filter((s) => s.id === o.sessionId);
  if (o.characterId) sessions = sessions.filter((s) => s.characterId === o.characterId);

  const pairs = [];
  let skipped = 0;

  for (const s of sessions) {
    const session = await getSession(s.id);
    if (!session) continue;
    const character = charById.get(session.characterId) || { id: session.characterId, name: '对话', persona: '' };
    const msgs = (session.messages || [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
    const buildOpts = buildOptsFor(config, character);
    const narrative = config.narrative || '';

    for (let k = 0; k < msgs.length; k++) {
      const cur = msgs[k];
      if (cur.role !== 'assistant') continue;
      if (!Array.isArray(cur.rejected) || !cur.rejected.length) continue;

      const chosen = String(cur.content || '').trim();
      if (chosen.length < minChars) { skipped += 1; continue; }

      // 用和 SFT 完全相同的上下文构建方式，保证分布一致
      const historyUpTo = msgs.slice(0, k).map(({ role, content }) => ({ role, content }));
      let messages;
      try {
        const sysOnly = buildMessages(character, [], CONTEXT_BUDGET, narrative, buildOpts);
        const sysTok = estTok(sysOnly[0].content);
        const budgetTok = Math.max(0, maxTokens - sysTok - Math.max(40, Math.floor(maxTokens * 0.25)));
        const budgetChars = Math.floor(budgetTok * 1.6);
        const kept = [];
        let used = 0;
        for (let j = historyUpTo.length - 1; j >= 0; j--) {
          const c = historyUpTo[j].content.length + 8;
          if (used + c > budgetChars && kept.length > 0) break;
          used += c;
          kept.unshift(historyUpTo[j]);
        }
        if (!kept.length) { skipped += 1; continue; }
        messages = buildMessages(character, kept, CONTEXT_BUDGET, narrative, buildOpts);
        messages = shapeSystemForDpo(messages, systemMode, shortSystemChars, character);
      } catch { skipped += 1; continue; }

      const totalTok = estTok(messages[0].content)
        + messages.slice(1).reduce((n, m) => n + estTok(m.content), 0) + estTok(chosen);
      if (totalTok > maxTokens) { skipped += 1; continue; }

      for (const r of cur.rejected) {
        const rejected = String(r.text || '').trim();
        if (rejected.length < minChars) { skipped += 1; continue; }
        if (rejected === chosen) { skipped += 1; continue; }
        // ⚠ 只留「真的被否决」的样本。
        // 「重新生成前的一版」「调整描写幅度前的一版」这些只是**换了一版**，
        // 旧版未必更差；「已在句号处截断」「检测到整句重复，已截断」「清理前…」
        // 更是**处理事件**，不是否决 —— 这些当成 rejected 就是给 DPO 喂噪声。
        // 实测：141 组里 52 组（37%）是这种噪声，混着训 DPO 的
        // rewards/accuracies 只有 0.51（等于没学到）；只留真否决后
        // accuracies 末段 1.00、margin 从 0 涨到 +1.59。
        if (isNotAVeto(String(r.reason || ''))) { skipped += 1; continue; }
        const t2 = totalTok - estTok(chosen) + estTok(rejected);
        if (t2 > maxTokens) { skipped += 1; continue; }
        pairs.push({
          messages,                       // 完整上下文（含 system + 历史）
          chosen,
          rejected,
          // 标了「知识错误 / 设定不符」的版本：reason 前缀带上标记，训练侧能单独统计
          reason: (() => {
            const tags = Array.isArray(r.tags) ? r.tags : (r.tag ? [r.tag] : []);
            return (tags.length ? `[${tags.join('/')}] ` : '') + String(r.reason || '').slice(0, 200);
          })(),
          sessionId: session.id,
          estTokens: t2,
          // 加权用：chosen 是手改/挑一版的，这一对就该多学几遍
          origin: cur.origin === 'edited' || cur.editedAt
            ? 'edited'
            : (cur.origin === 'adopted' || cur.adoptedAt ? 'adopted' : 'plain'),
        });
      }
    }
  }
  return { pairs, skipped };
}

/**
 * 导出手写训练素材 → SFT 行。
 *
 * 和 exportTrainingSamples 的区别：那条链路会清洗、去重、按否决打折；
 * 这里**原样输出**，只做最基本的合法性检查（非空、以 assistant 结尾）。
 * meta.origin='handwritten' 让 weights.js 给它最高权重（默认 8）。
 */
export async function exportScriptSamples(o = {}) {
  const { listScripts, getScript } = await import('./store.js');
  const only = o.scriptId ? [{ id: o.scriptId }] : await listScripts();
  const samples = [];
  const skipped = [];
  for (const item of only) {
    const s = await getScript(item.id);
    if (!s) { skipped.push({ id: item.id, why: '读不到' }); continue; }
    // 人工/脚本筛掉的素材不参与训练（tools/curate-scripts.py 打的标记）
    if (s.rejected) { skipped.push({ id: s.id, why: '已剔除' }); continue; }
    const turns = (s.turns || []).filter((t) => t && String(t.content || '').trim());
    if (turns.length < 2) { skipped.push({ id: s.id, why: '少于两轮' }); continue; }
    if (turns[turns.length - 1].role !== 'assistant') {
      skipped.push({ id: s.id, why: '最后一条不是角色回复' });
      continue;
    }
    const messages = [];
    if (String(s.system || '').trim()) messages.push({ role: 'system', content: String(s.system) });
    for (const t of turns) messages.push({ role: t.role, content: String(t.content) });
    samples.push({
      messages,
      // 手写素材默认按 handwritten（×8）算；gemma 生成的草稿按 adopted（×2），
      // 不能因为「存在素材页里」就享受手写的权重。
      // 只有**用户亲手写的**素材才算 handwritten（×8）。
      // gemma 起草的、云端 API 生成的都只算「采用」（×2）——
      // 否则「存在素材页里」就自动享受最高权重，等于把模型写的东西当金标准。
      meta: {
        origin: (!s.origin || s.origin === 'handwritten') ? 'handwritten' : 'adopted',
        source: s.origin || 'script',
        scriptId: s.id, title: s.title,
      },
    });
  }
  return { samples, skipped };
}
