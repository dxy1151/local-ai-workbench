#!/usr/bin/env node
// 生成 TOTP 密钥并打印二维码（用验证器 App 扫一下就能加上）
//
//   node tools/gen-totp.mjs            生成新密钥 + 二维码
//   node tools/gen-totp.mjs --qr <密钥> 只重新显示已有密钥的二维码
//
// 二维码用终端字符块画的，不需要联网、不依赖任何包。
import { generateSecret, otpauthUrl, totpAt } from '../lib/totp.js';

const args = process.argv.slice(2);
const idx = args.indexOf('--qr');
const secret = idx >= 0 ? String(args[idx + 1] || '').toUpperCase() : generateSecret();
const url = otpauthUrl(secret);
const ACCOUNT = process.env.TOTP_ACCOUNT || 'dxy1151';

// ---- 极简 QR 编码器（只支持 byte mode + 版本 1-10 + L 级纠错）----
// 为什么自己写：这个项目零依赖。二维码标准（ISO 18004）核心就三块：
// 数据编码 → RS 纠错 → 掩码+格式化信息。下面是够用的精简实现。
function qrEncode(text) {
  // === 1. 选版本（版本 1~10，L 纠错）===
  const CAP_L = [   // 各版本 L 级的数据码字数
    19, 34, 55, 80, 108, 136, 156, 194, 232, 274,
  ];
  const bytes = Buffer.from(text, 'utf8');
  let version = 0;
  for (let v = 0; v < CAP_L.length; v++) {
    const needBits = 4 + (v < 9 ? 8 : 16) + bytes.length * 8;
    if (needBits <= CAP_L[v] * 8) { version = v + 1; break; }
  }
  if (!version) throw new Error('文本太长');

  const cap = CAP_L[version - 1];
  const eccLen = { 1: 7, 2: 10, 3: 15, 4: 20, 5: 26, 6: 18, 7: 20, 8: 24, 9: 30, 10: 18 }[version];
  const blocks = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 2, 10: 4 }[version];

  // === 2. 数据位流 ===
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);                                  // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  // 结尾 + 补齐
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

  // === 3. RS 纠错（GF(256)，多项式 0x11D）===
  const EXP = new Array(512), LOG = new Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
  const rsGen = (n) => {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gmul(g[j], EXP[i]);
      }
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

  // 分块 + 纠错
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

  // === 4. 排矩阵 ===
  const size = 17 + version * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = v; };

  // 定位图案
  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        set(rr, cc, dark ? 1 : 0);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // 定时图案
  for (let i = 8; i < size - 8; i++) {
    set(6, i, (i % 2 === 0) ? 1 : 0);
    set(i, 6, (i % 2 === 0) ? 1 : 0);
  }

  // 校正图案
  if (version >= 2) {
    const pos = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38],
      8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] }[version];
    for (const a of pos) for (const b of pos) {
      if ((a === 6 && b === 6) || (a === 6 && b === size - 7) || (a === size - 7 && b === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        set(a + dr, b + dc, dark ? 1 : 0);
      }
    }
  }

  // 预留格式信息区
  for (let i = 0; i < 9; i++) { set(8, i, 2); set(i, 8, 2); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, 2); set(size - 1 - i, 8, 2); }

  // 填数据（之字形，跳过第 6 列）
  let bi = 0;
  const totalBits = outBytes.length * 8;
  const nextBit = () => {
    if (bi >= totalBits) return 0;
    const b = outBytes[bi >> 3];
    const bit = (b >>> (7 - (bi & 7))) & 1;
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

  // === 5. 掩码（选得分为 0 的那个，遮罩 0）===
  const mask0 = (r, c) => (r + c) % 2 === 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (m[r][c] === 2 || m[r][c] === null) continue;
    if (mask0(r, c)) m[r][c] ^= 1;
  }
  // 格式信息（L 级 + 掩码 0）: 0100 0000 0000 000 → BCH + 0x5412
  let fmt = 0b010000000000000;
  let rem = fmt << 10;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0b10100110111 << (i - 10);
  const fmtBits = ((fmt << 10) | rem) ^ 0b101010000010010;
  const fbit = (i) => (fmtBits >>> i) & 1;
  // 左上
  for (let i = 0; i < 6; i++) set(8, i, fbit(i));
  set(8, 7, fbit(6)); set(8, 8, fbit(7)); set(7, 8, fbit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, fbit(i));
  // 右上 / 左下
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, fbit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, fbit(i));
  set(size - 8, 8, 1);   // 固定暗模块
  return m.map((row) => row.map((v) => v === 1));
}

// 用字符块画二维码（两个竖排像素拼一个字符，省一半高度）
function renderQR(qr) {
  const n = qr.length;
  const lines = [];
  lines.push('  ' + '▄'.repeat(n + 2));
  for (let r = 0; r < n; r += 2) {
    let line = '  █';
    for (let c = 0; c < n; c++) {
      const top = qr[r][c];
      const bot = r + 1 < n ? qr[r + 1][c] : false;
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
    }
    lines.push(line + '█');
  }
  lines.push('  ' + '▀'.repeat(n + 2));
  return lines.join('\n');
}

// --- 输出 ---
console.log('密钥（Base32）:');
console.log('  ' + secret);
console.log();
console.log('otpauth 链接:');
console.log('  ' + url);
console.log();
const qr = qrEncode(url);
console.log('用验证器 App 扫下面的二维码（Google Authenticator / Aegis / 1Password 都行）：');
console.log();
console.log(renderQR(qr));
console.log();
console.log('或者手动添加：选「输入设置密钥」，粘贴上面那串 Base32 密钥。');
console.log();
const now = Math.floor(Date.now() / 1000 / 30);
console.log(`当前验证码（30 秒一换，现在剩 ${30 - Math.floor(Date.now() / 1000) % 30} 秒）: ${totpAt(secret, now)}`);
console.log();
console.log('把密钥写进 ~/.config/xingye-tunnel/env：');
console.log(`  WORKBENCH_TOTP_SECRET=${secret}`);
console.log('然后   systemctl --user restart xingye-chat');
