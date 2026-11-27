// ============================================================================
//  TOTP（RFC 6238）—— 两步验证的第二个因子
//
//  为什么自己写：这个项目**零依赖**（package.json 里没有 dependencies），
//  为了一个 TOTP 引 30MB 的 node_modules 不值得。RFC 6238 本身就是
//  HMAC-SHA1 的简单封装，Node 内置 crypto 够用。
//
//  和口令的分工：
//    · 口令（WORKBENCH_PASSWORD）—— 你知道的东西
//    · TOTP（WORKBENCH_TOTP_SECRET）—— 你手机里有、而别人没有的东西
//  两个都要对才放行。这样即使口令泄露，别人也进不来。
//
//  没设 WORKBENCH_TOTP_SECRET 时**完全跳过第二步** —— 和以前行为一模一样。
// ============================================================================
import crypto from 'node:crypto';
import { totpSecretFromStore } from './access.js';

/** 取 TOTP 密钥（Base32）。没设 = 不启用两步验证。 */
export function totpSecret() {
  return totpSecretFromStore().replace(/\s+/g, '');
}

/** 两步验证是不是开着。 */
export function totpEnabled() {
  return totpSecret().length >= 16;
}

/** Base32 解码（RFC 4648，A-Z 2-7，去掉填充）。 */
export function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(s).toUpperCase().replace(/=+$/, '')) {
    const idx = A.indexOf(ch);
    if (idx < 0) continue;            // 忽略空格/连字符等
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Base32 编码（给生成密钥用）。 */
export function base32Encode(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

/** 算某个时间片的 6 位验证码。 */
export function totpAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[off] & 0x7f) << 24)
    | ((hmac[off + 1] & 0xff) << 16)
    | ((hmac[off + 2] & 0xff) << 8)
    | (hmac[off + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

/**
 * 校验用户输入的验证码。
 * 允许 ±1 个时间片（前后 30 秒）—— 手机和电脑的时钟常差几秒，
 * 不容差的话天天要重输。再多就不给了，不然 6 位码就形同虚设。
 */
export function checkTotp(input) {
  const secret = totpSecret();
  if (!secret) return true;                       // 没启用 = 永远通过
  const code = String(input || '').replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (const d of [0, -1, 1]) {
    if (totpAt(secret, step + d) === code) return true;
  }
  return false;
}

/** 生成一个新的随机密钥（给 tools/gen-totp.mjs 用）。 */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));    // 160 bit，RFC 推荐
}

/**
 * 生成 otpauth:// 链接。
 *
 * ⚠ 这里刻意用**很短的 issuer / account**：URL 长度直接决定二维码版本，
 * 版本 1~5 是**单块**纠错（实现简单、已验证可扫），版本 6+ 是多块交织
 * （实测手写实现的交织部分仍有 bug，扫不出来）。
 * 150 字节以内基本能落在版本 5，所以：
 *   issuer 'X' + account 'w'  →  URL 约 100 字节 → 版本 5 → ✅ 已验证可扫
 * 验证器里显示的名字照样能改，短名字不影响使用。
 */
export function otpauthUrl(secret, account = 'w', issuer = 'X') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * 当前实现的二维码只支持**单块**（版本 1~5）。
 * 超了就直接报错，不要生成一个扫不出来的码 —— 那比报错更糟。
 */
export const QR_MAX_BYTES = 106;   // 版本 5 L 级能装的数据字节数

// ============================================================================
//  极简 QR 编码器（byte mode，版本 1~10，L 级纠错，掩码 0）
//
//  为什么自己写：这个项目零依赖（package.json 里没有 dependencies）。
//  二维码标准（ISO 18004）核心三块：数据编码 → RS 纠错 → 掩码+格式信息。
//  otpauth:// 链接只有 100~160 字节，版本 4~7 就够，上面这块精简实现够用。
// ============================================================================

/** 把任意文本编成二维码矩阵（二维布尔数组，true = 黑）。 */
export function qrMatrix(text) {
  // 版本 1~10、L 级纠错的**标准参数**（ISO 18004 表 9）。
  // 每项：总码字 / 纠错码字每块 / 块数。数据码字 = 总数 - 纠错×块数。
  // ⚠ 这里最容易错：perBlock 要按「**数据**码字 ÷ 块数」算，不是「总码字 ÷ 块数」。
  const V = {
    1:  { total: 26,  ecc: 7,  blocks: 1 },
    2:  { total: 44,  ecc: 10, blocks: 1 },
    3:  { total: 70,  ecc: 15, blocks: 1 },
    4:  { total: 100, ecc: 20, blocks: 1 },
    5:  { total: 134, ecc: 26, blocks: 1 },
    6:  { total: 172, ecc: 18, blocks: 2 },
    7:  { total: 196, ecc: 20, blocks: 2 },
    8:  { total: 242, ecc: 24, blocks: 2 },
    9:  { total: 292, ecc: 30, blocks: 2 },
    10: { total: 346, ecc: 18, blocks: 4 },
  };

  const bytes = Buffer.from(String(text), 'utf8');
  // ⚠ 只支持版本 1~5（单块）。多块交织的实现在实测中仍有 bug，
  // 与其生成一个扫不出来的码，不如直接报错 —— 用户看到错误提示能自己处理，
  // 看到一张扫不出来的二维码只会一脸懵。
  if (bytes.length > 106) {
    throw new Error(`二维码内容太长（${bytes.length} 字节 > 106）—— 当前实现只支持单块版本 1~5`);
  }
  let version = 0;
  for (let v = 1; v <= 5; v++) {
    const dataCw = V[v].total - V[v].ecc * V[v].blocks;   // 数据码字数
    const need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (need <= dataCw * 8) { version = v; break; }
  }
  if (!version) throw new Error('文本太长，二维码装不下（支持到版本 10 / L 级）');

  const cap = V[version].total - V[version].ecc * V[version].blocks;
  const eccLen = V[version].ecc;
  const blocks = V[version].blocks;

  // --- 数据位流 ---
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capBits = cap * 8;
  push(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    dataBytes.push(v);
  }
  const PAD = [0xEC, 0x11];
  let pi = 0;
  while (dataBytes.length < cap) dataBytes.push(PAD[pi++ % 2]);

  // --- RS 纠错（GF(256)，本原多项式 0x11D）---
  const EXP = new Array(512), LOG = new Array(256);
  let xx = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = xx; LOG[xx] = i; xx <<= 1; if (xx & 0x100) xx ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
  const rsGen = (n) => {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gmul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  };
  const rsEncode = (data, n) => {
    const g = rsGen(n);
    const res = new Array(n).fill(0);
    for (const d of data) {
      const factor = d ^ res[0];
      res.shift(); res.push(0);
      for (let i = 0; i < n; i++) res[i] ^= gmul(factor, g[i + 1]);
    }
    return res;
  };

  const perBlock = Math.floor(cap / blocks);
  const extra = cap % blocks;
  // ⚠ 交织规则（ISO 18004 §7.6）：**按码字索引轮转**，不是「整块整块地排」。
  //   数据区:  块1[0], 块2[0], 块1[1], 块2[1], …
  //   纠错区:  块1e[0], 块2e[0], 块1e[1], 块2e[1], …
  // 单块（版本 1~5）两种写法结果一样，所以版本 3 能对上；
  // 多块（版本 6+）写错就整个码错位 —— 实测版本 9 怎么都扫不出来的根因。
  const chunks = [];
  const eccs = [];
  let off = 0;
  for (let b = 0; b < blocks; b++) {
    const n = perBlock + (b < extra ? 1 : 0);
    const chunk = dataBytes.slice(off, off + n);
    off += n;
    chunks.push(chunk);
    eccs.push(rsEncode(chunk, eccLen));
  }
  const outBytes = [];
  const maxData = Math.max(...chunks.map((c) => c.length));
  for (let i = 0; i < maxData; i++) {
    for (const c of chunks) if (i < c.length) outBytes.push(c[i]);
  }
  const maxEcc = Math.max(...eccs.map((e) => e.length));
  for (let i = 0; i < maxEcc; i++) {
    for (const e of eccs) if (i < e.length) outBytes.push(e[i]);
  }

  // --- 排矩阵 ---
  const size = 17 + version * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  // reserved[r][c] = true 表示这是**功能图案**（定位/定时/校正/格式信息），
  // 掩码**不能**翻转它们 —— 只异或数据区。第一版漏了这一点，
  // 结果整个二维码扫不出来（实测定位图案全是反转的）。
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => {
    if (r >= 0 && c >= 0 && r < size && c < size) { m[r][c] = v; reserved[r][c] = true; }
  };
  // 只写数据格（不标记 reserved）
  const setData = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = v; };

  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= size || c >= size) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6
        || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      set(r, c, dark ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // 定时图案：第 6 行 / 第 6 列，从 8 到 size-9，交替 1/0，
  // 且 **(6,8) 和 (8,6) 必须是 1**（起点是深色模块）。
  // 第一版写成 i%2==0 ? 1 : 0 且从 8 起 —— 8%2==0 刚好是 1，看似对；
  // 但循环上界用了 size-8，把最后一个该是深色的位置漏了。
  for (let i = 8; i < size - 8; i++) {
    const v = (i % 2 === 0) ? 1 : 0;
    set(6, i, v);
    set(i, 6, v);
  }

  if (version >= 2) {
    const POS = {
      2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
      7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    }[version] || [];
    for (const a of POS) for (const b of POS) {
      if ((a === 6 && b === 6) || (a === 6 && b === size - 7) || (a === size - 7 && b === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        set(a + dr, b + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
      }
    }
  }

  // 格式信息区只用 reserved 标记「这里别填数据」，**不写占位值** ——
  // 写占位值会把先画好的定时图案 (6,8)/(8,6) 覆盖掉（第一版就栽在这）。
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) { reserved[8][i] = true; if (m[8][i] === null) m[8][i] = 0; }
    if (!reserved[i][8]) { reserved[i][8] = true; if (m[i][8] === null) m[i][8] = 0; }
  }
  for (let i = 0; i < 8; i++) {
    const c = size - 1 - i;
    if (!reserved[8][c]) { reserved[8][c] = true; if (m[8][c] === null) m[8][c] = 0; }
    if (!reserved[c][8]) { reserved[c][8] = true; if (m[c][8] === null) m[c][8] = 0; }
  }

  let bi = 0;
  const totalBits = outBytes.length * 8;
  const nextBit = () => {
    if (bi >= totalBits) return 0;
    const bit = (outBytes[bi >> 3] >>> (7 - (bi & 7))) & 1;
    bi++;
    return bit;
  };
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let row = 0; row < size; row++) {
      const r = up ? size - 1 - row : row;
      for (const c of [col, col - 1]) {
        if (m[r][c] === null) setData(r, c, nextBit());
      }
    }
    up = !up;
  }

  // 掩码 0：(r + c) % 2 === 0 —— **只翻转数据区**，功能图案保持原样
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (reserved[r][c]) continue;
    if (m[r][c] === null) m[r][c] = 0;
    if ((r + c) % 2 === 0) m[r][c] ^= 1;
  }

  // ---- 格式信息：5 位数据 + 10 位 BCH 校验，共 15 位，再异或 0x5412 ----
  // 5 位 = 纠错等级(2) + 掩码编号(3)。L 级 = 01，掩码 0 = 000 → 数据 0b01000
  // 标准流程：data << 10 得到 15 位，对生成多项式 0b10100110111 做模 2 除，
  // 余数就是校验位；最后整体异或 0b101010000010010（0x5412）打散避免全 0。
  const ECL_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
  const data5 = (ECL_BITS.L << 3) | 0;              // 0b01000
  let v = data5 << 10;
  for (let i = 14; i >= 10; i--) {
    if ((v >>> i) & 1) v ^= 0b10100110111 << (i - 10);
  }
  const fmt = ((data5 << 10) | (v & 0x3ff)) ^ 0b101010000010010;
  const fb = (i) => (fmt >>> i) & 1;   // fb(0) = 最低位

  // 写入位置（标准 ISO 18004 图 25）：**先写低位**，从左上角起逆时针绕一圈
  //   (8,0)..(8,5) ← bit 0..5
  //   (8,7),(8,8),(7,8) ← bit 6,7,8
  //   (5,8)..(0,8) ← bit 9..14
  // 第一版把方向写反了（(8,0) 存成了最高位），整张码格式信息错位 → 扫不出来。
  // ⚠ 方向容易写反：第 8 **行**存低 6 位，第 8 **列**存高 6 位。
  // 实测把行列写反 → (8,0) 和 (0,8) 整批都对调，扫码器读不出正确格式信息。
  for (let i = 0; i < 6; i++) set(i, 8, fb(i));       // (0..5, 8) ← bit 0..5
  set(7, 8, fb(6));
  set(8, 8, fb(7));
  set(8, 7, fb(8));
  for (let i = 9; i < 15; i++) set(8, 14 - i, fb(i)); // (8, 5..0) ← bit 9..14

  // 右上角那一份：第 8 行，从 size-1 往左 8 格 ← bit 0..7
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, fb(i));
  // 左下角那一份：第 8 列，从 size-7 往下（即 size-1 往上 7 格）← bit 8..14
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, fb(i));

  set(size - 8, 8, 1);

  return m.map((row) => row.map((v) => v === 1));
}
