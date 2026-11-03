// ============================================================================
//  会话 → 聊天记录（Markdown / JSON）
//
//  「导出聊天记录」用：会话列表每一项的 ⬇，把这一段对话原样存成 .md 文件。
//  只导真正的对话（user / assistant），**不导思考过程、不导被否决的版本** ——
//  那些是训练数据的事（见 lib/export.js），聊天记录保持人能直接读的样子。
//
//  多人卡里 assistant 的正文本来就带「陈梦：台词」这种行，原样保留，
//  不在这里重新切分 —— 导出的就是聊天页里看到的那个样子。
// ============================================================================
import { getCharacter } from './store.js';

const pad = (n) => String(n).padStart(2, '0');

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${fmtDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtClock(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 文件名里不能出现这些字符；顺便压掉换行和多余空格，太长的标题截断。
function safeName(s, fallback = '未命名') {
  const out = String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return out || fallback;
}

/** 下载用的文件名：日期-角色-会话标题.md */
export function chatLogFileName(session, character) {
  const day = fmtDate(session?.updatedAt || session?.createdAt || Date.now());
  const who = character?.name ? safeName(character.name) : '直连';
  return `${day}-${who}-${safeName(session?.title, '对话')}.md`;
}

function dialogMsgs(session) {
  return (session?.messages || []).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim(),
  );
}

/**
 * 会话 → Markdown 聊天记录。character 传进来就不用再读一次角色卡。
 */
export async function sessionToMarkdown(session, character) {
  const card = character !== undefined ? character : session?.characterId ? await getCharacter(session.characterId) : null;
  const msgs = dialogMsgs(session);
  const cast = Array.isArray(card?.cast) ? card.cast.filter((c) => c && c.name) : [];
  const isMulti = cast.length >= 2;

  const lines = [];
  lines.push(`# ${session?.title || '对话'}`);
  lines.push('');
  if (card?.name) {
    lines.push(`- 角色：${card.name}${isMulti ? `（多人：${cast.map((c) => c.name).join('、')}）` : ''}`);
  } else {
    lines.push('- 模式：直连（无角色卡、无系统提示词）');
  }
  lines.push(`- 消息：${msgs.length} 条`);
  const first = msgs.find((m) => m.at)?.at;
  const last = [...msgs].reverse().find((m) => m.at)?.at;
  if (first && last) {
    lines.push(`- 时间：${fmtDateTime(first)} → ${fmtClock(last)}`);
  }
  lines.push(`- 导出：${fmtDateTime(Date.now())}`);
  lines.push('');
  lines.push('---');

  const aiLabel = card?.name || 'AI';
  let lastDay = '';
  for (const m of msgs) {
    const day = fmtDate(m.at);
    if (day && day !== lastDay) {
      lastDay = day;
      lines.push('');
      lines.push(`## ${day}`);
    }
    lines.push('');
    const who = m.role === 'user' ? '我' : aiLabel;
    lines.push(`**${who}**${m.at ? ` · ${fmtClock(m.at)}` : ''}`);
    lines.push('');
    lines.push(String(m.content).replace(/\r\n/g, '\n').trim());
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 会话 → JSON（带角色名，够当存档用；thinking / rejected 保留原样，备份不丢东西）。
 */
export function sessionToJson(session, character) {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      title: session?.title || '',
      character: character ? { id: character.id, name: character.name } : null,
      kind: session?.kind || 'roleplay',
      createdAt: session?.createdAt || null,
      updatedAt: session?.updatedAt || null,
      messages: session?.messages || [],
    },
    null,
    2,
  );
}
