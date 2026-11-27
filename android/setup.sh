#!/data/data/com.termux/files/usr/bin/bash
# 本地AI对话工作台 · 安卓 Termux 一键环境准备（只需跑一次）
# 用法：在项目目录里执行   bash android/setup.sh
set -e

if [ ! -d /data/data/com.termux/files/usr ]; then
  echo "✗ 这看起来不是 Termux 环境。"
  echo "  请在安卓上装好 Termux（建议从 F-Droid 装），再在 Termux 里运行本脚本。"
  exit 1
fi

echo "==> 更新软件源（若长时间卡住，可按 Ctrl+C 重试）"
pkg update -y

echo "==> 安装 Node.js"
pkg install -y nodejs termux-tools

echo "==> Node 版本：$(node --version)"

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
echo "==> 项目目录：$PROJ"

# 装一个 workbench 命令，之后在任何目录输入 workbench 就能启动
BIN="${PREFIX:-/data/data/com.termux/files/usr}/bin/workbench"
cat > "$BIN" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
cd "$PROJ" || exit 1
exec bash android/run.sh "\$@"
EOF
chmod +x "$BIN"

echo
echo "✅ 准备完成。"
echo "   以后启动：在 Termux 里直接输入   workbench"
echo "   或者：   cd \"$PROJ\" && node start.js"
