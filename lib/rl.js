// ============================================================================
//  日常强化评分（v1.9.0）
//
//  聊天时按 w 给这一轮的角色回复打一个分（0~3，步长 0.5），回车提交。
//  这里只做一件事：**把评分连同当时的上下文落盘**，不改线上模型，也不自动训练。
//
//  落盘格式：<data>/rl-labels/YYYY-MM-DD.jsonl，一行一条：
//    { id, at, sessionId, characterId, model, w, prompt: [...], reply: "..." }
//  其中 prompt 是**当时喂给模型的那串消息（包含 system）**，reply 是被评的回复。
//  以后要跑 DPO / 加权 SFT，直接读这个目录就行。
//
//  为什么存全量 prompt 而不是 sessionId 让训练端去还原：
//    · 会话后面还会继续聊，事后还原不出"当时那一轮"的上下文
//    · 重新生成会把旧版挤掉
//    · 存全量还能顺带记录当时用的是哪个模型、哪版提示词
// ============================================================================
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const RL_DIR = path.join(DATA_DIR, 'rl-labels');
export const RL_W_MIN = 0;
export const RL_W_MAX = 3;
export const RL_W_STEP = 0.5;

/** 评分归一化：夹在 0~3，按 0.5 取整；非数字返回 null（= 无评分）。 */
export function normalizeW(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.min(RL_W_MAX, Math.max(RL_W_MIN, n));
  return Math.round(clamped / RL_W_STEP) * RL_W_STEP;
}

export function describeW(w) {
  if (w === null || w === undefined) return '未评分';
  if (w >= 3) return '完美';
  if (w >= 2) return '很好';
  if (w >= 1.5) return '不错';
  if (w >= 1) return '一般';
  if (w > 0) return '较差';
  return '很差';
}

const dayKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

async function ensureDir() {
  await fs.mkdir(RL_DIR, { recursive: true });
}

/**
 * 落一条评分。
 * @param {object} input {sessionId, characterId, model, w, prompt, reply, note}
 */
export async function saveLabel(input = {}) {
  await ensureDir();
  const w = normalizeW(input.w);
  if (w === null) throw new Error('w 必须是 0~3 的数字');
  const reply = String(input.reply || '').trim();
  if (!reply) throw new Error('没有可评分的回复');
  const prompt = Array.isArray(input.prompt)
    ? input.prompt
      .filter((m) => m && typeof m === 'object' && m.content !== undefined)
      .map((m) => ({ role: String(m.role || 'user'), content: String(m.content) }))
    : [];
  const rec = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    sessionId: String(input.sessionId || ''),
    characterId: String(input.characterId || ''),
    model: String(input.model || ''),
    w,
    wLabel: describeW(w),
    prompt,
    reply,
    ...(input.note ? { note: String(input.note).slice(0, 500) } : {}),
  };
  await fs.appendFile(path.join(RL_DIR, `${dayKey()}.jsonl`), `${JSON.stringify(rec)}\n`, 'utf8');
  return rec;
}

/** 读最近 N 条（新的在前），给界面显示"已记多少条"用。 */
export async function listLabels(limit = 50) {
  await ensureDir();
  let files = [];
  try {
    files = (await fs.readdir(RL_DIR)).filter((f) => f.endsWith('.jsonl')).sort().reverse();
  } catch {
    return { count: 0, recent: [] };
  }
  const recent = [];
  let count = 0;
  for (const f of files) {
    let text = '';
    try {
      text = await fs.readFile(path.join(RL_DIR, f), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n').filter((l) => l.trim());
    count += lines.length;
    for (let i = lines.length - 1; i >= 0 && recent.length < limit; i -= 1) {
      try {
        const rec = JSON.parse(lines[i]);
        recent.push({
          at: rec.at, w: rec.w, wLabel: rec.wLabel || describeW(rec.w),
          sessionId: rec.sessionId, characterId: rec.characterId,
          reply: String(rec.reply || '').slice(0, 120),
        });
      } catch {
        /* 坏行跳过 */
      }
    }
    if (recent.length >= limit) break;
  }
  return { count, recent, dir: RL_DIR };
}

/** 统计：总条数、平均分、按分值分布。 */
export async function labelStats() {
  const { count } = await listLabels(0);
  const dist = {};
  let sum = 0;
  let scored = 0;
  await ensureDir();
  let files = [];
  try {
    files = (await fs.readdir(RL_DIR)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  for (const f of files) {
    let text = '';
    try {
      text = await fs.readFile(path.join(RL_DIR, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const w = normalizeW(rec.w);
        if (w === null) continue;
        dist[w] = (dist[w] || 0) + 1;
        sum += w;
        scored += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return { count, scored, avg: scored ? Math.round((sum / scored) * 100) / 100 : 0, dist };
}
