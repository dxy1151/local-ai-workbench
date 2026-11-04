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

/** 生成 otpauth:// 链接，给验证器 App 扫码 / 手动输入。 */
export function otpauthUrl(secret, account = 'workbench', issuer = '星野工作台') {
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

// ============================================================================
//  极简 QR 编码器（byte mode，版本 1~10，L 级纠错，掩码 0）
//
//  为什么自己写：这个项目零依赖（package.json 里没有 dependencies）。
//  二维码标准（ISO 18004）核心三块：数据编码 → RS 纠错 → 掩码+格式信息。
//  otpauth:// 链接只有 100~160 字节，版本 4~7 就够，上面这块精简实现够用。
// ============================================================================

/** 把任意文本编成二维码矩阵（二维布尔数组，true = 黑）。 */
export function qrMatrix(text) {
  const CAP_L = [19, 34, 55, 80, 108, 136, 156, 194, 232, 274];
  const ECC = { 1: 7, 2: 10, 3: 15, 4: 20, 5: 26, 6: 18, 7: 20, 8: 24, 9: 30, 10: 18 };
  const BLK = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 2, 10: 4 };

  const bytes = Buffer.from(String(text), 'utf8');
  let version = 0;
  for (let v = 0; v < CAP_L.length; v++) {
    const need = 4 + (v < 9 ? 8 : 16) + bytes.length * 8;
    if (need <= CAP_L[v] * 8) { version = v + 1; break; }
  }
  if (!version) throw new Error('文本太长，二维码装不下');

  const cap = CAP_L[version - 1];
  const eccLen = ECC[version];
  const blocks = BLK[version];

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
  const outBytes = [];
  let off = 0;
  for (let b = 0; b < blocks; b++) {
    const n = perBlock + (b < extra ? 1 : 0);
    const chunk = dataBytes.slice(off, off + n);
    off += n;
    outBytes.push(...chunk, ...rsEncode(chunk, eccLen));
  }

  // --- 排矩阵 ---
  const size = 17 + version * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = v; };

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

  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0 ? 1 : 0);
    set(i, 6, i % 2 === 0 ? 1 : 0);
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

  for (let i = 0; i < 9; i++) { set(8, i, 2); set(i, 8, 2); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, 2); set(size - 1 - i, 8, 2); }

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
        if (m[r][c] === null) m[r][c] = nextBit();
      }
    }
    up = !up;
  }

  // 掩码 0：(r + c) % 2 === 0
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (m[r][c] === 2) continue;
    if ((r + c) % 2 === 0) m[r][c] ^= 1;
  }

  // 格式信息：L 级(01) + 掩码0(000) = 0100 0000 0000 000，BCH(15,5)，再异或 0x5412
  let rem = 0b010000000000000 << 10;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0b10100110111 << (i - 10);
  const fmt = ((0b010000000000000 << 10) | rem) ^ 0b101010000010010;
  const fb = (i) => (fmt >>> i) & 1;
  for (let i = 0; i < 6; i++) set(8, i, fb(i));
  set(8, 7, fb(6)); set(8, 8, fb(7)); set(7, 8, fb(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, fb(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, fb(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, fb(i));
  set(size - 8, 8, 1);

  return m.map((row) => row.map((v) => v === 1));
}
