#!/usr/bin/env bash
# 把一份**便携 Node** 装进项目里的 runtime/ —— 使用者不必自己装 Node。
#
# 只解压到一个目录、不改系统环境变量、不写 /usr：
#     runtime/node/bin/node
# 之后 linux/run.sh 会自动优先用它。
#
# 用法：
#     bash linux/get-node.sh                 # 默认装 NODE_VERSION
#     NODE_VERSION=v22.20.0 bash linux/get-node.sh
#     NODE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/nodejs-release bash linux/get-node.sh
#
# 支持 Linux / macOS（x64 与 arm64）。Windows 用 windows\get-node.ps1。
set -e

NODE_VERSION="${NODE_VERSION:-v24.22.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$ROOT/runtime"
TARGET="$RUNTIME/node"

case "$(uname -s)" in
  Linux)  PLAT=linux ;;
  Darwin) PLAT=darwin ;;
  *) echo "✗ 这个脚本只支持 Linux / macOS；当前系统：$(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "✗ 不认识的 CPU 架构：$(uname -m)" >&2; exit 1 ;;
esac

# Linux 用 .tar.xz，macOS 只有 .tar.gz
if [ "$PLAT" = linux ]; then EXT="tar.xz"; else EXT="tar.gz"; fi
FILE="node-$NODE_VERSION-$PLAT-$ARCH.$EXT"
DIRNAME="node-$NODE_VERSION-$PLAT-$ARCH"

if [ -x "$TARGET/bin/node" ]; then
  HAVE="$("$TARGET/bin/node" -v 2>/dev/null || echo '?')"
  if [ "$HAVE" = "$NODE_VERSION" ]; then
    echo "==> 已经有了：$TARGET/bin/node（$HAVE），跳过"
    exit 0
  fi
fi

MIRRORS=(
  "${NODE_MIRROR:-https://nodejs.org/dist}"
  "https://registry.npmmirror.com/-/binary/node"
  "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release"
)

mkdir -p "$RUNTIME"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

OK=0
for M in "${MIRRORS[@]}"; do
  URL="$M/$NODE_VERSION/$FILE"
  echo "==> 下载 $URL"
  if curl -fL --connect-timeout 15 --retry 2 -o "$TMP/$FILE" "$URL"; then OK=1; break; fi
  echo "    这个源不行，换下一个…"
done
[ "$OK" = 1 ] || { echo "✗ 所有源都下不动。可手动下载 $FILE 放到 $RUNTIME 再重跑。" >&2; exit 1; }

echo "==> 解压到 runtime/"
rm -rf "$TARGET"
if [ "$EXT" = "tar.xz" ]; then
  tar -xJf "$TMP/$FILE" -C "$RUNTIME" || { xz -dc "$TMP/$FILE" | tar -xf - -C "$RUNTIME"; }
else
  tar -xzf "$TMP/$FILE" -C "$RUNTIME"
fi
mv "$RUNTIME/$DIRNAME" "$TARGET"

echo
echo "✅ 装好了：$TARGET/bin/node（$("$TARGET/bin/node" -v)）"
echo "   启动： bash linux/run.sh    （会自动优先用这一份）"
