#!/usr/bin/env bash
# 打包传输 zip —— build.ps1 的 Linux / macOS 版本。
#
#   bash build.sh             开发包：什么都带（含 smoke.js 自检）
#   bash build.sh --release   发行包：去掉测试与开发文件，只留使用者需要的
#
# 两者都：
#   - 版本号取自 package.json，包内顶层目录固定为项目目录名
#   - 排除 data/（绝不把 API Key 打进包）、data-dir.txt（设备相关）、runtime/（便携 Node，几十 MB）
#   - 自检：条目名无反斜杠、无 data/ 泄漏、无 runtime/
#
# 用法： bash build.sh [--release]
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
NAME="$(basename "$ROOT")"
MODE="dev"
[ "$1" = "--release" ] && MODE="release"

VERSION="$(node -p "require('$ROOT/package.json').version")"
if [ "$MODE" = "release" ]; then SUFFIX=""; TAG="发行包"; else SUFFIX="-dev"; TAG="开发包"; fi
OUT="$(dirname "$ROOT")/$NAME-v$VERSION$SUFFIX.zip"

if ! command -v zip >/dev/null 2>&1; then
  echo "✗ 没装 zip。Debian/Ubuntu: sudo apt install -y zip" >&2
  exit 1
fi

# 顶层目录里要排除的名字
EXCLUDES=(
  './data' './node_modules' './data-smoke' './.tts-cache' './runtime'
  './data-dir.txt' './.gitignore' './*.zip'
)
if [ "$MODE" = "release" ]; then
  EXCLUDES+=('./smoke.js' './smoke-env.js')
fi

# 用临时暂存目录，强制顶层目录名是项目名（和 build.ps1 的包结构一致）
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME"

ARGS=()
for e in "${EXCLUDES[@]}"; do ARGS+=(--exclude="$e"); done

( cd "$ROOT" && tar "${ARGS[@]}" -cf - . ) | ( cd "$STAGE/$NAME" && tar -xf - )

rm -f "$OUT"
( cd "$STAGE" && zip -r -q -X "$OUT" "$NAME" )

# 自检：包内不能有反斜杠条目、不能有 data/ 或 runtime/
BAD="$(unzip -Z1 "$OUT" | grep -c '\\' || true)"
LEAK="$(unzip -Z1 "$OUT" | grep -c "^$NAME/data/" || true)"
RUNTIME="$(unzip -Z1 "$OUT" | grep -c "^$NAME/runtime/" || true)"
SMOKE="$(unzip -Z1 "$OUT" | grep -c "^$NAME/smoke.js$" || true)"
COUNT="$(unzip -Z1 "$OUT" | wc -l | tr -d ' ')"
SIZE="$(du -k "$OUT" | cut -f1)"

if [ "$MODE" = "release" ] && [ "$SMOKE" != 0 ]; then
  echo "✗ 发行包里混进了 smoke.js，检查排除规则" >&2
  exit 1
fi

echo
echo "  output   : $OUT"
echo "  mode     : $MODE（$TAG）"
echo "  version  : v$VERSION"
echo "  files    : $COUNT"
echo "  size     : ${SIZE} KB"
echo "  backslash: $BAD $([ "$BAD" = 0 ] && echo OK || echo 'FAIL - unzip will break')"
echo "  data leak: $LEAK $([ "$LEAK" = 0 ] && echo 'OK (no API key)' || echo 'FAIL - API key leaked')"
echo "  runtime  : $RUNTIME $([ "$RUNTIME" = 0 ] && echo 'OK (not bundled)' || echo 'FAIL - portable node shipped')"
echo "  smoke.js : $SMOKE $([ "$MODE" = release ] && echo '(发行包应为 0)' || echo '(开发包应有 1)')"
echo
[ "$BAD" = 0 ] && [ "$LEAK" = 0 ] && [ "$RUNTIME" = 0 ]
