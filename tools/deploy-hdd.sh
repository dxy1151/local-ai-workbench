#!/bin/bash
# 把代码从开发目录（~/xingye-chat，git 仓库）同步到机械盘上的部署目录，并重启服务。
#
# 现在的自启动服务（systemd --user: xingye-chat）跑的是机械盘那份：
#   /mnt/data4t/xingye-chat-portable
# 所以改完代码后跑这个脚本，线上才是新代码。
#
# 数据不动：部署目录的 data-dir.txt 指向 /home/don0ox1/xingye-sync（实时数据）。
set -euo pipefail
DEV="${WORKBENCH_DEV_DIR:-$HOME/xingye-chat}"
DEPLOY="${WORKBENCH_DEPLOY_DIR:-/mnt/data4t/xingye-chat-portable}"

[ -f "$DEPLOY/start.js" ] || { echo "❌ 部署目录不可用（机械盘 /mnt/data500 没挂？）：$DEPLOY"; exit 1; }

# ⚠ 必须排除的东西：
#   .venv-tui / node_modules  —— 部署目录里的运行时依赖，开发目录没有或不完整，
#                                不排除的话 --delete 会把它们删掉（TUI 直接跑不了）
#   .git                     —— 部署目录要自己维护 git（以后就在那改）
#   data/ data-dir.txt       —— 数据在 xingye-sync，别覆盖
rsync -a --delete \
  --exclude='.git' --exclude='.venv-tui' --exclude='node_modules' \
  --exclude='data/' --exclude='data-dir.txt' --exclude='server.log' \
  --exclude='*.bak-*' --exclude='.tts-cache' \
  "$DEV/" "$DEPLOY/"

systemctl --user restart xingye-chat
sleep 2
V=$(curl -s http://127.0.0.1:5178/api/config | python3 -c "import sys,json;print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "?")
echo "✅ 已同步到 $DEPLOY 并重启服务；线上版本：$V"
