// 多人卡（一卡多人）相关的提示
//
// 约定：角色卡的 persona 里用「【人物】名字」分节，第一个节是主视角角色：
//
//   人物设定：
//   【人物】罗启
//   妈宝男，什么都听妈妈的，没主见。
//
//   【人物】陈梦
//   温柔漂亮，传统保守，脸皮薄。
//
// 识别到 ≥2 个「【人物】」节就进入多人模式；没有标记 → 走单角色逻辑。
// 输出格式：每段台词用「名字：」开头，模型自己决定这一轮谁来接话。

/* ---------- 人物表 ---------- */

export function castNudge(castNames = []) {
  const names = (Array.isArray(castNames) ? castNames : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  if (names.length < 2) return '';
  return `【多人场面】对话里有这些人物：${names.map((n) => `「${n}」`).join('、')}。`
    + '每人说话都要单独起一行、写成「名字：台词」；没有台词的人物不要出现。'
    + '一轮里最多两个人开口。';
}

/* ---------- 单条指定谁回答 ---------- */

/**
 * 「这一条由对话里的谁回答」。
 *
 * 只认**本会话人物表**里的人名 —— 提示词里要明确到"这一个人"，
 * 模型才不会再自己挑人。和别的 nudge 一样拼进 **system 末尾**：
 * 当用户消息塞进去会被模型当台词念出来。
 */
export function asNudge(name, others = []) {
  const n = String(name || '').trim() || '这个人物';
  const rest = (Array.isArray(others) ? others : [])
    .map((x) => String(x || '').trim())
    .filter((x) => x && x !== n);
  const who = rest.length ? rest.map((x) => `「${x}」`).join('、') : '其他人物';
  return `【这一条是「${n}」说的】用户在扮演「${n}」，这条消息以 ${n} 的身份发出。\n`
    + `- 你只演${who}，不要替「${n}」说话，也不要把「${n}：」写进回复。\n`
    + `- 回复仍然用「名字：内容」的格式，名字只能是${who}之一。`;
}

/* ---------- 多人卡的格式规则 ---------- */

export function castFormatBlock(castNames = []) {
  const names = (Array.isArray(castNames) ? castNames : []).filter(Boolean);
  if (names.length < 2) return '';
  return [
    '4. **人称与记号**：每个人物都用第一人称「我」说自己；动作、神态、环境写在中文括号（）里'
      + `（\`${names[0]}：（搓了搓手）我妈说……\`）。`,
  ].join('\n');
}
