#!/usr/bin/env bash
# 本地AI对话工作台 —— 通用 Linux / macOS 启动脚本（桌面系统，不是 Termux）
#
# 用法：
#   bash linux/run.sh                  # 默认 5178，只监听本机
#   bash linux/run.sh 5179             # 换端口
#   bash linux/run.sh 5178 0.0.0.0     # 让同 Wi-Fi 的手机也能连
#   NO_OPEN=1 bash linux/run.sh        # 不自动开浏览器
#
# Node 从哪来：优先用项目里的便携版 runtime/node（bash linux/get-node.sh 装的），
# 没有才用系统 PATH 里的 node。
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${1:-5178}"
HOST="${2:-127.0.0.1}"
URL="http://127.0.0.1:$PORT"

# ① 便携 Node ② 系统 node
if [ -x "$ROOT/runtime/node/bin/node" ]; then
  NODE_BIN="$ROOT/runtime/node/bin/node"
  export PATH="$ROOT/runtime/node/bin:$PATH"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  echo "✗ 没找到 Node.js（需要 >=18）。二选一：" >&2
  echo "     bash linux/get-node.sh    # 下载便携 Node 进项目（推荐，不用管理员权限）" >&2
  echo "     bash linux/setup.sh       # 检查环境并引导安装" >&2
  exit 1
fi

# 起服务后自动打开本机浏览器（没装就跳过，不影响使用）
if [ "${NO_OPEN:-0}" != "1" ]; then
  if command -v xdg-open >/dev/null 2>&1; then
    ( sleep 2; xdg-open "$URL" >/dev/null 2>&1 || true ) &
  elif command -v open >/dev/null 2>&1; then
    ( sleep 2; open "$URL" >/dev/null 2>&1 || true ) &
  fi
fi

echo
echo "  本地AI对话工作台启动中…  $URL"
echo "  按 Ctrl+C 停止。"
echo

exec "$NODE_BIN" start.js "$PORT" "$HOST"
