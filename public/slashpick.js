// 输入框「/」选这一条由谁回答 —— 纯逻辑部分（不碰 DOM，方便单测）
//
// 前端 app.js 用它来判断"光标前是不是一个 / 命令"，以及"按查询词过滤角色"。
// 单独拆出来的原因：这两条规则容易写错（正文里的 and/or、16/9 不该触发），
// 放在 DOM 代码里就没法单测了。

/**
 * 光标前是不是「行首 / 空格 + / + 查询词」。
 *
 * @param {string} value  输入框全文
 * @param {number} caret  光标位置（UTF-16 下标）
 * @returns {{start:number, query:string}|null}
 *   start = 那个斜杠的下标（确认后要把它到光标之间擦掉）；不在命令位置时返回 null
 */
export function slashTrigger(value, caret) {
  const text = String(value ?? '');
  let pos = Number(caret);
  if (!Number.isFinite(pos) || pos < 0) pos = text.length;
  if (pos > text.length) pos = text.length;
  const before = text.slice(0, pos);
  // 斜杠前面必须是行首或空白：漏了这条，「and/or」「16/9」之类的正文会被当成命令。
  // 查询词里也不许有空格（有空格就说明这不是在敲命令，而是接着写正文）。
  const m = /(^|\s)\/([^\s/]{0,20})$/.exec(before);
  if (!m) return null;
  return { start: pos - m[2].length - 1, query: m[2] };
}

/**
 * 按查询词过滤已注册角色：名字或一句话简介里包含即可（不区分大小写）。
 * 空查询 = 全部列出。
 */
export function filterCharacters(characters, query) {
  const list = Array.isArray(characters) ? characters : [];
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return list.slice();
  // 角色卡用 tagline，本会话人物表用 desc；两个都认，调用方不用关心是哪一种
  return list.filter((c) => `${c?.name ?? ''} ${c?.tagline ?? ''} ${c?.desc ?? ''}`.toLowerCase().includes(q));
}

// 老卡的多人写法：persona 里一行一个「【人物】名字」
const CAST_MARK_RE = /^[ \t]*【人物】[ \t]*([^\n]{1,12})[ \t]*$/gm;

/**
 * 「这个对话里有哪些人物」——输入框打 / 时列表的数据源（v1.2.1）。
 *
 * 注意：不是「所有已注册的角色卡」。角色卡是**另一个对话**，拉进来回答会串台；
 * 这里只取当前这个对话的人物表：
 *   ① 结构化字段 `cast`（≥2 人才算多人）
 *   ② 老卡的 persona 里写的「【人物】名字」标记（≥2 人）
 *   ③ 都没有 → 只有当前角色一个人
 *
 * @returns {{name:string, desc:string}[]}
 */
export function conversationSpeakers(character) {
  const fromField = (Array.isArray(character?.cast) ? character.cast : [])
    .map((c) => ({
      name: String(c?.name || '').trim().slice(0, 12),
      desc: String(c?.desc || '').trim(),
    }))
    .filter((c) => c.name);
  if (fromField.length >= 2) return fromField;

  const persona = String(character?.persona || '');
  const marks = [...persona.matchAll(CAST_MARK_RE)];
  if (marks.length >= 2) {
    const out = marks.map((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index : persona.length;
      return { name: String(m[1]).trim().slice(0, 12), desc: persona.slice(start, end).trim().slice(0, 120) };
    }).filter((c) => c.name);
    if (out.length >= 2) return out;
  }

  const name = String(character?.name || '').trim();
  return name ? [{ name, desc: String(character?.tagline || '').trim() }] : [];
}
