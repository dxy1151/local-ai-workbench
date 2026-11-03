#!/bin/bash
# 从 HuggingFace 的 piper-voices 仓库加一个音色到本地 TTS。
# 用法：tools/tts-add-voice.sh zh/zh_CN/huayan/medium
#      tools/tts-add-voice.sh en/en_US/amy/medium
# 说明：路径就是仓库里的 <语言>/<地区>/<音色>/<质量>，文件名自动拼（<lang>_<REGION>-<voice>-<quality>.onnx）
set -u
VOICE_DIR="${XINGYE_TTS_VOICES:-$HOME/tts/voices}"
REPO="${PIPER_REPO:-https://huggingface.co/rhasspy/piper-voices/resolve/main}"
ARG="${1:-}"
if [ -z "$ARG" ]; then
  echo "用法：$0 <语言/地区/音色/质量>  例：$0 zh/zh_CN/huayan/medium"; exit 1
fi
ARG="${ARG#/}"; ARG="${ARG%/}"
IFS='/' read -r LANG REGION VOICE QUALITY <<< "$ARG"
if [ -z "$QUALITY" ]; then
  echo "路径要 4 段：<语言>/<地区>/<音色>/<质量>，例如 zh/zh_CN/huayan/medium"; exit 1
fi
NAME="${LANG}_${REGION}-${VOICE}-${QUALITY}"
mkdir -p "$VOICE_DIR"
for EXT in onnx onnx.json; do
  echo "↓ $NAME.$EXT"
  curl -sL --fail --max-time 600 -o "$VOICE_DIR/$NAME.$EXT" "$REPO/$LANG/$REGION/$VOICE/$QUALITY/$NAME.$EXT" || {
    echo "下载失败：$REPO/$LANG/$REGION/$VOICE/$QUALITY/$NAME.$EXT"; rm -f "$VOICE_DIR/$NAME.$EXT"; exit 1; }
done
echo "✅ 已加音色：$NAME → $VOICE_DIR"
echo "   工作台 设置 → 朗读 → 音色 填：$NAME"
echo "   如果服务是 systemd 起的，不用重启（TTS 服务每次按需加载新音色）"
