#!/data/data/com.termux/files/usr/bin/bash
# 本地AI对话工作台 · 安卓 Termux 启动脚本
# 用法：bash android/run.sh [端口]
set -e

cd "$(dirname "$0")/.."
PORT="${1:-5178}"
URL="http://127.0.0.1:$PORT"

# 防止安卓在后台把 Termux 进程杀掉
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
fi

# 等服务起来后自动唤起手机浏览器
if command -v termux-open-url >/dev/null 2>&1; then
  ( sleep 2; termux-open-url "$URL" ) &
fi

echo
echo "  本地AI对话工作台启动中…"
echo "  地址：$URL"
echo "  没自动打开，就手动在手机浏览器里访问上面这个地址。"
echo "  按 Ctrl+C 停止。"
echo

exec node start.js "$PORT"
