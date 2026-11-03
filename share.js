#!/usr/bin/env node
// 临时把传输包通过局域网共享给手机下载。
// 只共享这一个文件，不暴露聊天应用本身；用完按 Ctrl+C 就关。
//
// 用法：node share.js [端口] [文件路径]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VERSION } from './lib/version.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8137;
// 默认共享 build.ps1 刚打出来的带版本号的那个包。
const FILE = path.resolve(
  process.argv[3] || path.join(ROOT, '..', `local-ai-workbench-v${VERSION}.zip`),
);

if (!fs.existsSync(FILE)) {
  console.error(`\n  找不到要共享的文件：${FILE}`);
  console.error('  用法：node share.js [端口] [文件路径]\n');
  process.exit(1);
}

const stat = fs.statSync(FILE);
const name = path.basename(FILE);
// 地址里带一段随机串，避免同 WiFi 的旁人瞎猜路径。
const token = crypto.randomBytes(4).toString('hex');
const urlPath = `/d/${token}/${encodeURIComponent(name)}`;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  if (req.url !== urlPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${name}"`,
  });
  fs.createReadStream(FILE).pipe(res);
  console.log(`  → 手机开始下载（${(stat.size / 1024).toFixed(1)} KB）`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 被占用，换一个：node share.js 8138\n`);
  } else {
    console.error('\n  启动失败：', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log(`\n  正在共享：${name}（${(stat.size / 1024).toFixed(1)} KB）`);
  console.log('  只在局域网内有效，传完按 Ctrl+C 关闭。\n');
  if (!ips.length) {
    console.log('  ⚠ 没检测到局域网 IP，确认手机和电脑连着同一个 WiFi。\n');
  }
  for (const ip of ips) {
    console.log(`  手机浏览器打开：  http://${ip}:${PORT}${urlPath}`);
  }
  console.log();
});
