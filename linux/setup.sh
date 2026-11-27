#!/usr/bin/env bash
# 本地AI对话工作台 —— 桌面 Linux / macOS 一次性环境准备
#
# 做三件事：确保有可用的 Node（缺就下载便携版进项目）、显示数据目录、装一个 `workbench` 命令。
# 不调用 sudo、不改系统包、不写 /usr。
#
# 用法： bash linux/setup.sh
set -e

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
echo "==> 项目目录：$PROJ"

# ── 1. Node：便携版优先，其次系统版；都没有就下载便携版 ──────────────────────
NODE_OK=0
if [ -x "$PROJ/runtime/node/bin/node" ]; then
  echo "==> 便携 Node：$("$PROJ/runtime/node/bin/node" -v)  （$PROJ/runtime/node）✓"
  NODE_OK=1
elif command -v node >/dev/null 2>&1; then
  VER="$(node -p 'process.versions.node')"
  MAJOR="${VER%%.*}"
  if [ "$MAJOR" -ge 18 ]; then
    echo "==> 系统 Node：v$VER  ✓"
    NODE_OK=1
  else
    echo "==> 系统 Node 太旧（v$VER，需要 >=18），改用便携版"
  fi
fi

if [ "$NODE_OK" != 1 ]; then
  echo "==> 没找到合适的 Node，现在下载便携版（约 30-50 MB，只放进项目的 runtime/）"
  if ! bash "$PROJ/linux/get-node.sh"; then
    echo
    echo "✗ 便携版没下下来（网络不通？）。也可以自己装一个："
    echo "    Debian / Ubuntu / SteamOS :  sudo apt install -y nodejs npm"
    echo "    Arch / SteamOS(桌面模式)   :  sudo pacman -S nodejs npm"
    echo "    Fedora                     :  sudo dnf install -y nodejs npm"
    echo "    macOS (Homebrew)           :  brew install node"
    echo "  Steam Deck 若 apt 报只读文件系统，先： sudo steamos-readonly disable"
    exit 1
  fi
fi

# ── 2. 数据目录 ────────────────────────────────────────────────────────────
# data-dir.txt 是设备相关的绝对路径，不进传输包；这里只提示，不擅自覆盖。
if [ -f "$PROJ/data-dir.txt" ]; then
  echo "==> 数据目录（data-dir.txt）：$(grep -v '^#' "$PROJ/data-dir.txt" | grep -v '^$' | head -1)"
else
  echo "==> 数据目录：默认 $PROJ/data"
fi

# ── 3. workbench 命令 ─────────────────────────────────────────────────────────
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/workbench" <<EOF
#!/usr/bin/env bash
exec bash "$PROJ/linux/run.sh" "\$@"
EOF
chmod +x "$BIN_DIR/workbench"
echo "==> 已安装命令：$BIN_DIR/workbench"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "    ⚠ $BIN_DIR 不在 PATH 里，加一行到 ~/.bashrc（或 ~/.zshrc）："
    echo "        export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

echo
echo "✅ 准备完成。以后启动："
echo "     workbench                 # 默认 5178，只监听本机"
echo "     workbench 5178 0.0.0.0    # 手机 / 平板也能连"
echo "   或者： bash \"$PROJ/linux/run.sh\""
