#!/usr/bin/env node
// 启动入口：node start.js [端口] [监听地址]
//   默认只监听 127.0.0.1（只有本机能打开）。
//   想让手机连过来（同一个 Wi-Fi，或 Radmin VPN / ZeroTier 这种虚拟局域网）：
//     node start.js 5178 0.0.0.0
//   或者只绑到虚拟网卡那一个地址（暴露面更小，推荐）：
//     set WORKBENCH_HOST=192.168.1.5  &&  node start.js
import os from 'node:os';
import { startServer } from './lib/server.js';
import { VERSION } from './lib/version.js';

const port = Number(process.argv[2]) || Number(process.env.PORT) || 5178;
const host = String(process.argv[3] || process.env.WORKBENCH_HOST || process.env.XINGYE_HOST || '127.0.0.1').trim();
// 只监听本机 = 安全默认；绑到别的地址就意味着"同网络的人也能打开这个页面"
const localOnly = host === '127.0.0.1' || host === 'localhost' || host === '::1';

// 列出所有非回环 IPv4，方便直接挑一个填进手机
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

try {
  await startServer(port, host);
  const lan = lanAddresses();
  console.log(`\n  本地AI对话工作台 v${VERSION} 已启动`);
  if (localOnly) {
    console.log(`  本机访问:  http://127.0.0.1:${port}`);
    if (lan.length) {
      console.log(`\n  手机想连过来的话（同一个 Wi-Fi / Radmin VPN / ZeroTier）：`);
      for (const a of lan) console.log(`    http://${a.address}:${port}    ← ${a.name}`);
      console.log(`  但当前只监听了本机，手机打不开。改用：node start.js ${port} 0.0.0.0`);
    }
  } else if (host === '0.0.0.0') {
    console.log(`  监听全部网卡，下面每个地址都能打开：`);
    console.log(`    http://127.0.0.1:${port}    ← 本机`);
    for (const a of lan) console.log(`    http://${a.address}:${port}    ← ${a.name}`);
    console.log(`\n  ⚠ 同网络的设备都能打开这个页面（聊天记录也在里面）。`);
    console.log(`    想只对某一个网卡开放，就把 0.0.0.0 换成上面某个具体地址。`);
  } else {
    const nic = lan.find((a) => a.address === host);
    console.log(`  只监听了 ${host}${nic ? `（${nic.name}）` : ''}，用这个地址打开：`);
    console.log(`    http://${host}:${port}`);
    // 绑具体地址时 127.0.0.1 是不通的（这不是 bug，是绑定的含义），
    // 启动横幅必须说清楚 —— 否则本机打开 127.0.0.1 会一脸懵（踩过）。
    console.log(`\n  注意：这次 127.0.0.1:${port} 是打不开的（只绑了一张网卡）。`);
    console.log(`  想本机和手机都能开：node start.js ${port} 0.0.0.0`);
    console.log(`  想知道同网络还有谁能开：这一步就已经把范围限在「${nic ? nic.name : '这一张网卡'}」了。`);
  }
  console.log(`\n  首次使用请点右上角「设置」填入 API Key。`);
  console.log(`  按 Ctrl+C 停止。\n`);
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${port} 已被占用。换一个端口：node start.js 5179\n`);
  } else if (err.code === 'EADDRNOTAVAIL') {
    console.error(`\n  监听地址 ${host} 在本机不存在（网卡还没起来？）。`);
    console.error(`  用 node start.js ${port} 0.0.0.0 可以监听全部网卡。\n`);
  } else if (err.code === 'EACCES') {
    // 两种情况都会走到这里，报错原文只有一句 "listen EACCES"，看不出该干嘛：
    //   ① 端口 < 1024，普通用户没权限绑（Linux/macOS 常见）
    //   ② Windows 上端口被系统**保留**了 —— Hyper-V / WSL / Docker 会预留成段，
    //      落在段里的端口一绑就是 EACCES（不是被占用，换端口才是正解）
    console.error(`\n  端口 ${port} 没权限监听（EACCES）。`);
    console.error('  可能是：① 1024 以下的端口要管理员 / root；');
    console.error('          ② Windows 把这个端口划进系统保留段了（Hyper-V / WSL 会预留）。');
    console.error('  Windows 查保留段：netsh interface ipv4 show excludedportrange protocol=tcp');
    console.error(`  换个端口即可：node start.js ${port + 1}\n`);
  } else {
    console.error('\n  启动失败:', err.message, '\n');
  }
  process.exit(1);
}
