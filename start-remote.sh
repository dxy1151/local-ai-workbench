#!/usr/bin/env bash
# 启动工作台并开放远程访问（带口令）
#   ./start-remote.sh        绑 0.0.0.0（局域网 + Tailscale 都能连）
#   ./start-remote.sh local  只绑本机（回到原来的行为）
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HOME/.config/xingye/env"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ 缺少 $ENV_FILE（里面应该有 WORKBENCH_PASSWORD=...）" >&2
  echo "   生成一个：echo \"WORKBENCH_PASSWORD=\$(head -c 12 /dev/urandom | base64 | tr -d '/+=')\" > $ENV_FILE"
  exit 1
fi

set -a; . "$ENV_FILE"; set +a
PORT="${PORT:-5178}"
HOST="0.0.0.0"
[ "${1:-}" = "local" ] && HOST="127.0.0.1"

# 已有实例就先停掉，避免端口占用
curl -s -X POST "http://127.0.0.1:$PORT/api/quit" >/dev/null 2>&1
sleep 2

cd "$HERE"
setsid node start.js "$PORT" "$HOST" > /tmp/xingye-$PORT.log 2>&1 < /dev/null &
sleep 4

if curl -s -o /dev/null -m 3 "http://127.0.0.1:$PORT/"; then
  echo "✅ 已启动（监听 $HOST:$PORT）"
  [ "$HOST" = "0.0.0.0" ] && echo "   本机：http://127.0.0.1:$PORT （免密）" \
                        && echo "   远程：http://192.168.1.46:$PORT 或 http://100.124.214.66:$PORT（需口令）"
else
  echo "❌ 启动失败，看 /tmp/xingye-$PORT.log" >&2
  tail -10 "/tmp/xingye-$PORT.log" >&2
  exit 1
fi
