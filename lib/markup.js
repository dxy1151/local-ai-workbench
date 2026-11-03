// 标记规整：把模型写歪的「星号 / 括号」修回本程序的约定 ——
//   *...*  动作、神态
//   （...） 环境、场景
//   其余    台词
//
// 实测（扫自己 77 条回复）的毛病：
//   12 条 半角括号 ( )   —— 和全角（）混着用
//   12 条 星号不成对      —— 最典型是「* 开头、) 收尾」，标记永远闭不上
//   11 条 空标记 * *      —— 动作块里塞了个空的
// 纯字符串处理，不碰 DOM / 网络，node smoke.js 可直接测。

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// 「中文语境」判定：汉字 + 中文标点 + 中文引号。
// 半角标点转全角时只看汉字会漏：`"台词", 结束` 里紧挨着逗号的是引号不是汉字，
// 于是那个半角逗号就留下来了（全角引号配半角逗号，很难看）。
const CJK_CTX = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff60\u2018\u2019\u201c\u201d]/;
// 半角标点 → 全角（只在紧挨着中日韩文字时才换，免得把 1.5 / v0.2 / URL 弄坏）
const PUNCT = [
  [/,/g, '，'],
  [/!/g, '！'],
  [/\?/g, '？'],
  [/;/g, '；'],
  [/:/g, '：'],
];

function chars(s) {
  return Array.from(String(s || ''));
}

// 一个标记里有没有"实质内容"（只有标点/空白就当成写歪了）
function hasContent(s) {
  return chars(s).some((c) => !/[\s,，.。!！?？;；:：、…—~～"'“”'']/.test(c));
}

/** 规整一行里的星号 / 括号配对。 */
function fixLine(line) {
  const arr = chars(line);
  let out = '';
  let starOpen = false;
  let starStart = -1; // 当前动作块在 out 里的起点，用于判断"里面是不是空的"
  let starAtHead = false; // 这个星号是不是在行首（行首的视为"本该成对"，行中的视为写歪的）
  let parenOpen = false;
  let openCount = 0;
  let closeCount = 0;

  for (let i = 0; i < arr.length; i += 1) {
    const ch = arr[i];
    const rest = arr.slice(i + 1).join('');

    if (ch === '*') {
      if (starOpen) {
        starOpen = false;
        starStart = -1;
        out += '*';
      } else if (parenOpen) {
        // 环境块里出现星号：后面还有右括号就是嵌套内容，否则当成"把 （ 写成了 *"
        if (/[)）]/.test(rest)) out += '*';
        else { out += '）'; parenOpen = false; }
      } else {
        starOpen = true;
        starStart = out.length;
        starAtHead = out.trim() === '';
        out += '*';
      }
      continue;
    }

    if (ch === '(' || ch === '（') {
      parenOpen = true;
      openCount += 1;
      // 括号里是中文 → 统一成全角（半角 ( 配全角 ）这种"混着来"的也一起修掉）
      const close = arr.findIndex((c, k) => k > i && (c === ')' || c === '）'));
      const inner = close > -1 ? arr.slice(i + 1, close).join('') : rest;
      out += CJK.test(inner) ? '（' : ch;
      continue;
    }

    if (ch === ')' || ch === '）') {
      const open = arr.findLastIndex((c, k) => k < i && (c === '(' || c === '（'));
      const inner = open > -1 ? arr.slice(open + 1, i).join('') : '';
      const closer = CJK.test(inner) ? '）' : ch;
      if (starOpen && !parenOpen) {
        // ★ 关键修复：动作块用 ) 收尾 → 改回 *（12 条里大半是这种）
        out += '*';
        starOpen = false;
        starStart = -1;
      } else if (parenOpen) {
        parenOpen = false;
        closeCount += 1;
        out += closer;
      } else if (closeCount >= openCount) {
        // 找不到对应左括号的孤立右括号（模型手滑）：直接丢掉，
        // 免得句子末尾挂一个突兀的 "）"。**有配对的照常保留**。
        closeCount += 1;
      } else {
        closeCount += 1;
        out += closer;
      }
      continue;
    }

    out += ch;
  }

  // 行尾没收尾
  if (starOpen) {
    const inner = out.slice(starStart + 1);
    if (!hasContent(inner)) {
      // 只包了个空壳（如 "*, "）→ 撤掉这个星号
      out = out.slice(0, starStart) + inner;
    } else if (starAtHead) {
      out += '*'; // 行首那个八成是"忘了收尾"，补上
    } else {
      // 行中的孤星：多半是模型手滑多打了一个，直接去掉更像原意
      out = out.slice(0, starStart) + inner;
    }
  } else if (parenOpen) {
    out += '）';
  }
  return out;
}

/** 半角括号转全角：只在括号里是中文内容时转，避免误伤代码/数字。 */
function fullWidthParens(text) {
  return String(text).replace(/\(([^()\n]*)\)/g, (all, inner) => (CJK.test(inner) ? `（${inner}）` : all));
}

/**
 * 方括号旁白统一成 *...*。
 * 有的模型会写 `[她转过身去]` 或 `【叙述继续】` 当旁白，跟本程序的约定（*动作*）不一致，
 * 屏幕上就是三种括号混着来。只转换**里面是中文**的配对括号，`[1]`/`[ok]` 这类不动。
 */
function squareToStar(text) {
  return String(text).replace(/(【[^【】\n]*】|\[[^[\]\n]*\])/g, (all) => {
    const inner = all.slice(1, -1).trim();
    return inner && CJK.test(inner) ? `*${inner}*` : all;
  });
}

/** 半角标点在中文旁边时转全角。 */
function fullWidthPunct(text) {
  let t = String(text);
  for (const [re, full] of PUNCT) {
    t = t.replace(re, (m, offset, whole) => {
      const before = chars(whole.slice(0, offset)).pop() || '';
      const after = chars(whole.slice(offset + 1))[0] || '';
      return CJK_CTX.test(before) || CJK_CTX.test(after) ? full : m;
    });
  }
  return t;
}

/**
 * 半角双引号 " 统一成中文引号 “”。
 * 8B 那批模型基本不用引号（台词光着写），换了 14B 之后台词会写成 "……"，
 * 屏幕上就变成英文引号夹在中文标点里 —— 跟「标记规整」的承诺不一致。
 * 处理方式分两步：
 *   ① 同一行内成对的最稳，先配对（"台词" → “台词”）；
 *   ② 剩下落单的按出现顺序轮流当开/合，状态**跨行保留**（台词偶尔会折行：
 *      `"我话还没说完` / `你就别问了"`）。
 * 只动双引号；英文撇号 ' 不碰（容易误伤 don't / it's 这类）。
 */
function curlyQuotes(text) {
  let t = String(text).replace(/"([^"\n]*)"/g, '“$1”');
  let open = true;
  t = t.replace(/"/g, () => {
    const c = open ? '“' : '”';
    open = !open;
    return c;
  });
  return t;
}

/**
 * 规整整段回复。返回新字符串（没毛病就原样返回）。
 */
export function normalizeMarkup(text, opts = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return raw;
  const keep = opts.keep || [];
  let t = raw
    .split('\n')
    .map((line) => fixLine(line))
    .join('\n');
  t = squareToStar(t);
  t = fullWidthParens(t);
  // 引号要在半角标点转全角**之前**统一：`"台词", 结束` 换成 `“台词”, 结束` 后，
  // 那个逗号的左邻是引号，靠 CJK_CTX 才能判成中文语境、跟着转成全角。
  t = curlyQuotes(t);
  t = fullWidthPunct(t);
  // Markdown 加粗（`**阴道**`）先剥掉，再处理空标记。
  //
  // 为什么必须先剥：模型（实测 Qwen3-8B 微调版）会把生殖器/重点词用 **…** 强调，
  // 而 `*` 在本工作台里是**动作标记**。`**词**` 一旦留着，渲染时会和动作星号
  // 撞在一起，显示成 `**阴道**` 或者把整段吞进动作块里。
  // 规则：成对的 `**…**` 只删星号、保留文字（内容通常是有意义的台词）。
  // 限制在同一行内、且中间不含星号，避免把两个相邻动作块 `*A**B*` 误判。
  t = t.replace(/\*\*([^*\n]{1,80}?)\*\*/g, '$1');
  // 落单的 `**`（比如只写了开头没写结尾）：直接抹掉，别让它冒充动作起点
  t = t.replace(/\*\*(?![^*\n])/g, '');
  // 空标记："* *" / "**" 这种夹在中间的，直接去掉。
  // 注意必须限制在**同一行内**（[ \t]*，不能用 \s）：
  // 用 \s 会把 "*\n\n*" 这种跨行的两个动作块吞并成一个（踩过这个坑）。
  t = t.replace(/\*[ \t]*\*/g, '');
  t = stripMetaBlocks(t);
  t = stripForeignScript(t);
  t = stripStrayLatin(t, keep);
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // 半角标点刚转成全角时身后会留一个空格（`“台词”， 结束`），中文里不该有，去掉。
  // 只盯着**逗号顿号这类**，不碰引号/括号后面的空格 —— 中文夹英文时
  // `“台词一” 和 “台词二”` 那种空格是正常的，不该吃掉。
  // 只吃空格和制表符，不能用 \s —— 否则换行会被吞掉。
  t = t.replace(/([，。！？、；：])[ \t]+/g, '$1');
  return t;
}

/**
 * 清掉"非拉丁外文字符"。
 * 多语言底座（比如 Qwen3）偶尔会蹦出俄文/希腊文/阿拉伯文/韩文单词 ——
 * 实测："денег 夸张了吗？"、"WALL 发出吱呀声"。中文角色扮演里这些几乎肯定是乱码，
 * 直接删掉；英文单词不动（"OK""boss"这类是正常用法）。
 */
const FOREIGN_SCRIPT = /[\u0370-\u03FF\u0400-\u04FF\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\uAC00-\uD7AF\u3040-\u30FF]+/g;

export function stripForeignScript(text) {
  const s = String(text || '');
  // 只有当中文占多数时才清外语碎片；**整段**外语的话别乱删（交给打分去重抽），
  // 否则会把一整段日文/俄文删成空白，反而看不出问题。
  // 注意别把门槛设太严：短回复里夹一个外语词（"денег 夸张了吗？"）也要清掉。
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const foreign = (s.match(FOREIGN_SCRIPT) || []).join('').length;
  if (cjk === 0 || (foreign >= 8 && foreign > cjk * 2)) return s;
  return s
    .replace(FOREIGN_SCRIPT, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。！？、；：])/g, '$1');
}

/**
 * 清掉"元信息泄漏"：模型偶尔会把要求/指令写进正文 ——
 * 实测出现过 `（续写12字以内）`、`（字数控制在100）` 这种。
 * 只删（）里带这些字样的整块，正常的环境描写不受影响。
 */
// 注意别写太宽：曾经把 "要求" 也算进去，结果把提示词里合法的
// "（这是系统转达的要求，不是角色台词）" 整块删掉了 —— 只认明确的元信息字样。
const META_RE = /(字以内|字数|限\s*\d+\s*字|不超过\s*\d+\s*字|续写|指令|prompt|系统要求|格式要求)/i;
function stripMetaBlocks(text) {
  return String(text || '').replace(/（[^）\n]*）|\([^)\n]*\)/g, (block) => {
    const inner = block.slice(1, -1);
    return META_RE.test(inner) ? '' : block;
  });
}

/**
 * 中文里混进来的英文单词 —— 一律清掉。
 *
 * 为什么用"白名单"而不是"粘连判断"：实测模型会把单个英文词放在空格后面
 * （`（楼道里的脚步声飘进你的 Mouth）`），粘连规则抓不到 ✗。
 * 所以反过来：除了**口语里真会说的外来词**，其它英文单词都当碎片删掉。
 */
export const OK_LATIN = new Set([
  'ok', 'okay', 'boss', 'hi', 'hey', 'bye', 'no', 'yes', 'sorry', 'please', 'thanks', 'thx',
  'wifi', 'app', 'id', 'mv', 'cd', 'dj', 'ktv', 'gps', 'ai', 'pc', 'tv', 'usb', 'pm', 'am',
  'mm', 'em', 'hmm', 'yeah', 'wow', 'oh', 'ah', 'ha', 'lol', 'mua', 'vip', 'ceo', 'dna',
]);

function stripStrayLatin(text, keep = []) {
  const s = String(text || '');
  const keeps = keep.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
  // 整段外语就别删了（会删成空白，反而看不出问题）—— 交给打分去重抽
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinLetters = (s.match(/[A-Za-z]/g) || []).length;
  if (cjk === 0 || latinLetters > cjk * 1.5) return s;
  return s
    .replace(/[A-Za-z]{2,}/g, (w) => {
      const lower = w.toLowerCase();
      if (OK_LATIN.has(lower)) return w;
      if (keeps.some((k) => k === lower || k.includes(lower))) return w; // 角色名等
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。！？、；：）】」])/g, '$1')
    .replace(/([（(【「])\s+/g, '$1');
}

/** 找出回复里"不该出现的英文单词"（打分用，和清理保持同一套规则）。 */
export function strayLatinWords(text, keep = []) {
  const keeps = keep.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
  const out = new Set();
  for (const m of String(text || '').matchAll(/[A-Za-z]{2,}/g)) {
    const lower = m[0].toLowerCase();
    if (OK_LATIN.has(lower)) continue;
    if (keeps.some((k) => k === lower || k.includes(lower))) continue;
    out.add(m[0]);
  }
  return [...out];
}

/**
 * 清掉"粘在中文里的英文单词"（没有空格的那种，如 `了stripe`）。
 * 有空格的情况由 stripStrayLatin 处理。
 */
function stripGluedLatin(text) {
  return String(text || '')
    .replace(/(?<=[\u4e00-\u9fff])[A-Za-z]{3,}/g, '')
    .replace(/[A-Za-z]{3,}(?=[\u4e00-\u9fff])/g, '');
}

/** 给用户看的提示（只有在真的改了东西时才用）。 */
export function describeMarkup() {
  return '已规整星号/括号（模型把标记写混了）';
}

/**
 * 人称规整：把**第三人称**改回第一人称。
 *
 * 这是最"出戏"的一类问题（实测 86 条回复里 30 条出现了角色自己的名字、
 * 25 条出现了"他/她"）：
 *   *<角色名>的声音更低沉了一些*   → *我的声音更低沉了一些*
 *   *她的表情却是痛苦与兴奋*   → *我的表情却是痛苦与兴奋*
 *
 * 两条规则，都只作用于**引号之外**（引号里是台词，一个字都不动）：
 *
 *   ① 角色自己的名字 → 我（任何位置）
 *   ② "句子主语位置"的他/她 → 我
 *   ③ 同一小句里"我"已经出场过，后面再出现的他/她 → 你
 *      （`我拉住她的手` → `我拉住你的手`：这个场合只有两个人，"她的手"就是对方的手）
 *
 * ②里"主语位置"的判定很关键 —— `听他的，把模取了` 里的"他"跟在动词后面，
 * 那是台词的宾语（真在说别人），不能动；而 `她抬起头` 开头就是主语，一定是自称。
 * 开头允许夹"虽然/然后/不过"这类连接词（模型很爱写"虽然她嘴上这么说"）。
 *
 * v0.39 的两个修正（用户反馈"还是会有第三人称"）：
 *   - 旧版只改 `*动作*` 段里的他/她，**光秃秃的旁白**（`她抬起头看着你。`）和
 *     `（环境）`段里的他/她一律漏掉 → 现在所有引号外的文字都过一遍；
 *   - 旧版把句边界只算成"行首 + 句读"，于是 `*笑了一下*她转过身`（星号块之后）、
 *     `（她抿了抿嘴）`（括号之后）都漏掉 → 现在块边界也算新句子。
 */
const SENTENCE_BREAK_CHARS = '，,、；;。！？!?…—';
const CONNECTIVE = '然后|接着|随即|于是|跟着|随后|之后|此时|此刻|只是|不过|但是|但|却|可|又|便|就|而|而且|虽然|尽管|即使|因为|所以|要是|如果|当|等到|一边|转而|反而|竟然|居然|终于|结果|同时|仍然|依旧|还是|干脆|索性|忽然|突然';
// 什么算"新句子开始了"：行首、句读、以及 *…* / （…） 这种块的边界。
// 注意别把字符类嵌进字符类（`[a[b]c]`）—— 内层的 `]` 会提前把外层关上，
// 正则不会报错，只是从此再也匹配不上（踩过这个坑）。
const PERSON_BREAK = `(^|[\\n*＊（）()【】「」『』${SENTENCE_BREAK_CHARS}])`;
// 主语位置的他/她（供 normalizePerson 和"质量分"共用，两处口径必须一致）
const SUBJECT_PRON = new RegExp(`${PERSON_BREAK}[ \\t]*(${CONNECTIVE})?[ \\t]*([他她])(?!们|妈|人)`, 'gm');
// 小句边界：判断"同一小句里有没有我"用
const CLAUSE_BREAK = /[，,、；;。！？!?\n]/;

/**
 * 找出"主语位置、且能确定是自称"的他/她。
 * 关键的一步排除：**同一小句里已经出现过"我"** → 这个他/她只能是别人。
 *   `他递给我`   → 小句里已有"我"，所以"他"是第三方 ✗ 不改
 *   `她抬起头`   → 小句里没有"我"，"她"就是角色自己 ✓ 要改
 * 少了这一步，`*我接过冰淇淋* 他递给我` 会被改成"我递给我"（实测踩过）。
 */
function subjectHits(piece) {
  const out = [];
  for (const m of String(piece).matchAll(SUBJECT_PRON)) {
    const tail = String(piece).slice(m.index + m[0].length);
    if (/我/.test(tail.split(CLAUSE_BREAK)[0])) continue;
    out.push({ index: m.index, len: m[0].length, brk: m[1] || '', conn: m[2] || '', text: `${m[2] || ''}${m[3] || ''}` });
  }
  return out;
}

/**
 * 找出"主语位置"的第三人称 —— 也就是角色在用第三人称讲自己。
 * 引号里的台词永远不算（那里提到别人是正常的）。
 *
 * 两处口径故意不同：
 *   - **改写**（normalizePerson）要保守，动错了会把台词改坏 → 光秃秃的文字只在
 *     "这条回复用引号标了台词"时才当旁白（includeBare 由它自己算）；
 *   - **判定**（质量分 / 是否重抽）可以激进，动的只是"要不要再抽一版" → 默认连
 *     光秃秃的文字一起算（includeBare 默认 true）。宁可多抽一版，也别让"她"留在屏幕上。
 * @param {string} text
 * @param {{includeBare?: boolean}} [opts]
 * @returns {string[]} 命中的片段，例如 ['她抬起头']
 */
export function thirdPersonSubjects(text, opts = {}) {
  const raw = String(text || '');
  const narrateBare = opts.includeBare ?? true;
  const hits = [];
  for (const piece of narrationPieces(raw)) {
    if (piece.bare && !narrateBare) continue;
    for (const h of subjectHits(piece.text)) hits.push(h.text);
  }
  return hits;
}

/** 这条回复用引号标台词了吗？（标了 → 引号外的文字就是旁白，可以放心掰） */
function hasQuotedDialogue(raw) {
  return /("[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』)/.test(String(raw || ''));
}

const QUOTE_SPLIT = /("[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』)/g;
const BLOCK_SPLIT = /(\*[^*\n]*\*|（[^）\n]*）|\([^)\n]*\))/g;

/**
 * 把一段回复切成"旁白片段"：
 *   - 引号内的台词段：quoted=true（一个字都不动）
 *   - `*…*` 和 `（…）` 块：bare=false（确定是旁白）
 *   - 其余光秃秃的文字：bare=true（**可能是台词**，本程序的约定是"剩下的都是台词"）
 */
function* narrationPieces(raw) {
  const segs = String(raw || '').split(QUOTE_SPLIT);
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (!seg) continue;
    if (i % 2 === 1) { yield { text: seg, quoted: true, bare: false }; continue; }
    const parts = seg.split(BLOCK_SPLIT);
    for (let k = 0; k < parts.length; k += 1) {
      if (!parts[k]) continue;
      yield { text: parts[k], quoted: false, bare: k % 2 === 0 };
    }
  }
}

export function normalizePerson(text, name, opts = {}) {
  const n = String(name || '').trim();
  const raw = String(text || '');
  if (!raw) return raw;
  // 光秃秃的文字到底算旁白还是台词，取决于这条回复有没有用引号标台词：
  //   标了（14B 的习惯）→ 引号外就是旁白，主语上的他/她可以放心改成"我"；
  //   没标（8B 的习惯）→ 那些文字**本身就是台词**，`*点头* 他刚才来过吗？` 里的
  //     "他"是在问第三方，改成"我"就把台词改坏了 → 这种只在 `*…*`/`（…）` 里动手。
  // opts.aggressive=true 是**最后一手**（见 server.js）：模型连抽几版都改不掉时，
  // 宁可冒"改坏某句台词"的风险，也不让"她"留在屏幕上。
  const narrateBare = opts.aggressive === true || hasQuotedDialogue(raw);
  // ①②：主语位置的他/她 + 角色名 → 我
  const toMe = (s) => {
    const hits = subjectHits(s);
    if (!hits.length) return s;
    let out = '';
    let last = 0;
    for (const h of hits) {
      out += s.slice(last, h.index) + h.brk + h.conn + '我';
      last = h.index + h.len;
    }
    return out + s.slice(last);
  };
  // ③：同一小句里"我"已经出场，后面再冒出来的他/她 → 你
  //    （允许跨逗号：`我伸出手，拉住她的手`。不跨句号和换行）
  const toYou = (s) => s.replace(/(我[^。！？!?\n]{0,20}?)(?<!其)([他她])(?!们|妈|人)/g, (m, head) => `${head}你`);
  // ④：旁白里"他/她的…"→"你的…"。角色说自己是"我"，所以旁白里的"他的/她的"
  //    只可能指对方（`（小床挨着他的床）`、`*看着他的神态*`）。
  //    只认带"的"的定语，不带"的"的不动 —— `她递给我` 里那个"她"可能是真第三方，
  //    一律改成"你"会把"谁给谁"搞反。
  const toYour = (s) => s.replace(/(?<!其)([他她])(?!们|妈|人)的/g, '你的');
  const fixPron = (s) => toYou(toYour(toMe(s)));
  // 角色名不受"算不算旁白"的影响：引号外**任何地方**写自己的名字都是自称
  // （实测 "<角色名>抬手揉了揉我的肩膀"），一律改成"我"。
  const fixName = (s) => (n ? s.split(n).join('我') : s);
  return [...narrationPieces(raw)]
    .map((p) => {
      if (p.quoted) return p.text;                          // 台词：一个字都不动
      if (p.bare && !narrateBare) return fixName(p.text);   // 光秃秃且没标台词 → 只改名字，人称放过
      return fixPron(fixName(p.text));                      // 确定的旁白：名字 + 人称一起掰
    })
    .join('');
}
