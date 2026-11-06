// ============================================================================
//  L1 常驻知识按话题分段注入
//
//  为什么改：原来每轮把 4705 字的 L1 全文塞进 system，不管用户在聊什么。
//  「问价多少钱」和「你自己弄过没有」拿到的是一样的 4705 字 → 模型要在里面
//  自己找重点，大部分段落跟当前这句无关，等于噪声。
//
//  改成：根据用户这句话命中哪些话题，只注入相关的 2~4 段（600~900 字）。
//  实测 L1 用词命中率从 56% 往上走的空间就在这里。
//
//  匹配思路：不看语义（口语和百科没词面重叠，语义实测也只有 50% 精度），
//  而是按「这句话大概在干什么」分档。宁可多注入一段，也别漏掉该用的。
// ============================================================================

/**
 * 话题定义：命中任一关键词 → 注入该段。
 * keys 里放的是**用户台词**里会出现的说法，不是百科里的术语。
 */
export const TOPICS = [
  {
    // 价位、规矩、寒暄——这类对话不需要身体知识，但称谓和长度规则仍然要
    id: 'deal',
    keys: ['多少钱', '价钱', '什么价', '贵', '便宜', '包夜', '包宿', '小时',
           '给钱', '付钱', '收费', '两百', '一百', '讲价', '砍价', '刷卡',
           '赊', '先给', '多少钱一次'],
    sections: ['称谓：台词里怎么说自慰'],
  },
  {
    id: 'body',
    keys: ['摸', '碰', '亲', '舔', '咬', '抱', '搂', '压', '靠', '贴',
           '手', '嘴', '舌', '胸', '腿', '腰', '脖子', '耳朵', '后背', '肩',
           '脱', '解', '掀', '伸手', '凑近', '凑过来'],
    sections: ['敏感点与刺激方式', '兴奋时的身体反应',
               '写身体时的用词：说人话，不用解剖术语'],
  },
  {
    id: 'position',
    keys: ['姿势', '体位', '怎么弄', '怎么来', '躺着', '趴', '跪', '坐上来',
           '扶着', '从后面', '压上来', '跨', '腿架', '抬腿', '换个'],
    sections: ['性交体位（写姿势时带上名字）'],
  },
  {
    id: 'oral',
    keys: ['口', '嘴', '含', '吞', '咽', '舔', '亲下面', '舌尖'],
    sections: ['口交收尾的说法'],
  },
  {
    id: 'hand',
    keys: ['手', '撸', '弄', '抠', '抚', '指'],
    sections: ['互相抚慰 / 手交', '称谓：台词里怎么说自慰'],
  },
  {
    id: 'masturbation',
    keys: ['自己弄', '自己来', '自慰', '撸', '打飞机', '手冲', '解决',
           '一个人', '平常', '平时', '在家'],
    sections: ['自慰：女性', '自慰：男性', '称谓：台词里怎么说自慰',
               '自慰相关的常识，别写成病'],
  },
  {
    id: 'orgasm',
    keys: ['射', '高潮', '受不了', '要到了', '快', '停', '喘', '叫',
           '出来', '喷', '酸', '麻'],
    sections: ['高潮的身体表现', '消退与余韵'],
  },
  {
    id: 'anatomy',
    keys: ['里面', '里头', '深', '顶', '进', '缩', '软', '硬', '湿', '湿了',
           '那根', '底下', '那儿', '那里'],
    sections: ['女性外阴', '女性内生殖', '男性外生殖', '男性内生殖'],
  },
  {
    id: 'phone',
    keys: ['电话', '打电话', '发消息', '短信', '微信', '语音', '打字'],
    sections: ['电话/文字里的性'],
  },
];

/** 拆 L1 全文成 {名称: 内容} 的段落表。 */
export function splitSections(text) {
  const out = new Map();
  const raw = String(text || '');
  // ⚠ 不能用 /^【...】([\s\S]*?)(?=^【|$)/gm：m 标志下 $ 匹配行尾，
  //   [\s\S]*? 会缩到空就满足 $，每段只抓到标题本身。
  //   改用：先按行扫描找标题位置，再切片。
  const lines = raw.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*【([^】]+)】/.exec(lines[i]);
    if (m) marks.push({ name: m[1].trim(), start: i });
  }
  if (!marks.length) return out;
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].start;
    const end = i + 1 < marks.length ? marks[i + 1].start : lines.length;
    const body = lines.slice(start, end).join('\n').trim();
    out.set(marks[i].name, body);
  }
  return out;
}

/**
 * 根据用户这句话挑要注入的 L1 段落。
 * 返回 { text, picked, topics }。
 *
 * 兜底规则：
 *   - 一段都没命中 → 返回「常用基础段」（用词规范 + 称谓 + 长度），
 *     这三段在绝大多数对话里都用得上，体量也小（约 500 字）。
 *   - 命中的段落总字数超过 maxChars → 按优先级截断。
 */
export function pickL1(l1Text, userText, opts = {}) {
  const maxChars = opts.maxChars || 1200;
  const base = opts.baseSections || ['写身体时的用词：说人话，不用解剖术语',
                                    '称谓：台词里怎么说自慰'];
  const whole = String(l1Text || '');
  const sections = splitSections(whole);
  if (!sections.size) return { text: whole, picked: [], topics: [] };

  const q = String(userText || '');
  const topics = [];
  const picked = new Set();

  for (const t of TOPICS) {
    if (t.keys.some((k) => q.includes(k))) {
      topics.push(t.id);
      for (const s of t.sections) if (sections.has(s)) picked.add(s);
    }
  }

  // 一段没命中：给基础段，别给空
  if (!picked.size) {
    for (const s of base) if (sections.has(s)) picked.add(s);
  } else {
    // 命中了话题，基础段也要带上（用词规范永远有用）
    for (const s of base) if (sections.has(s)) picked.add(s);
  }

  // 按原顺序拼，控制字数
  const order = [...sections.keys()];
  const chosen = [];
  let total = 0;
  for (const name of order) {
    if (!picked.has(name)) continue;
    const body = sections.get(name);
    if (total + body.length > maxChars && chosen.length >= 1) continue;
    chosen.push(name);
    total += body.length;
  }

  const text = chosen.map((n) => sections.get(n)).join('\n\n');
  return { text, picked: chosen, topics };
}
