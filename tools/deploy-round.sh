#!/bin/bash
# 把一轮训练产物部署出来：合并 LoRA → GGUF → 量化 → ollama create，
# 中间产物先放「下载/训练数据（热）」，再归档到机械盘（冷），并写 manifest 标注训练数据。
#
# 用法：bash tools/deploy-round.sh <轮次名> <数据集路径> [gemma|qwen|both]
#   例：bash tools/deploy-round.sh v2k "/mnt/data4t/训练数据（归档）/训练集/gemma-train12-api2000.jsonl" both
set -u
ROUND="${1:?用法: deploy-round.sh <轮次名> <数据集路径> [gemma|qwen|both]}"
DATA="${2:?需要数据集路径}"
WHICH="${3:-both}"
L=/home/don0ox1/deepseek/llm-chat
BIG=/mnt/data4t/ai-models/training
HOT="$HOME/下载/训练数据（热）/训练产出/$ROUND"
COLD="/mnt/data4t/训练数据（归档）/训练产出/$ROUND"
LOG=/tmp/deploy-$ROUND.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

ROWS=$(wc -l < "$DATA" 2>/dev/null || echo '?')
mkdir -p "$HOT"

deploy_one(){
  local kind="$1"
  local name base adapter hotdir
  case "$kind" in
    gemma)
      name="gemma3-12b-$ROUND"
      base="$BIG/base-models/gemma3-12b-it-ms"
      adapter="$BIG/llm-chat/ckpt/gemma3-12b-$ROUND/final"
      template_src="gemma3-12b-rp2"
      ;;
    qwen)
      name="qwen3-8b-$ROUND"
      base="$BIG/base-models/qwen3-8b-base"
      adapter="$BIG/llm-chat/ckpt/qwen3-8b-$ROUND/final"
      template_src="qwen3-8b-v17"
      ;;
    *) say "❌ 未知模型 $kind"; return 1 ;;
  esac
  [ -f "$adapter/adapter_config.json" ] || { say "❌ $kind 缺少适配器：$adapter"; return 1; }

  say "===== $name：合并 → GGUF → 量化 ====="
  rm -rf "$L/models/registry/$name"
  BASE="$base" BIG_DISK="$BIG" bash "$L/deploy.sh" --adapter "$adapter" --version "$name" 2>&1 | tee -a "$LOG"
  local gguf="$BIG/models/$name-Q4_K_M.gguf"
  [ -f "$gguf" ] || { say "❌ $name 没产出 GGUF"; return 1; }

  hotdir="$HOT/$kind"
  mkdir -p "$hotdir"
  say "$name：先放热数据目录（下载/训练数据（热））"
  cp "$gguf" "$hotdir/" && cp -a "$adapter" "$hotdir/adapter" 2>/dev/null || true
  python3 - "$hotdir" "$name" "$kind" "$DATA" "$ROWS" "$adapter" "$base" "$gguf" <<'PY'
import json, os, sys, time
hotdir, name, kind, data, rows, adapter, base, gguf = sys.argv[1:9]
m = {
  'model': name, 'kind': kind, 'created': time.strftime('%Y-%m-%d %H:%M:%S'),
  'dataset': data, 'dataset_rows': int(rows) if str(rows).isdigit() else rows,
  'base_model': base, 'adapter': adapter,
  'gguf': os.path.basename(gguf), 'gguf_bytes': os.path.getsize(gguf),
  'how': 'train_qlora.py QLoRA (assistant-only loss), deploy.sh merge→bf16 GGUF→Q4_K_M→ollama create',
  'note': '训练数据：API 生成对话样本（冷目录/API生成），与 gemma/qwen 共用同一批 2000 条',
}
open(os.path.join(hotdir, 'manifest.json'), 'w', encoding='utf-8').write(json.dumps(m, ensure_ascii=False, indent=2))
PY

  say "$name：热目录 → 机械盘冷归档"
  mkdir -p "$COLD/$kind"
  mv "$hotdir"/* "$COLD/$kind/" 2>/dev/null || true
  rmdir "$hotdir" 2>/dev/null

  # ollama create（模板沿用现有同族模型，FROM 指向冷归档里的 GGUF）
  local mf="/tmp/$name.Modelfile"
  ollama show --modelfile "$template_src" 2>/dev/null | sed "s#^FROM .*#FROM $COLD/$kind/$(basename "$gguf")#" > "$mf"
  say "$name：ollama create"
  ollama create "$name" -f "$mf" 2>&1 | tail -2 | tee -a "$LOG"
  say "✅ $name 完成（冷归档：$COLD/$kind）"
  # 中间产物（合并版 16~24G + bf16 GGUF 16~24G）用完就删，省机械盘空间
  rm -rf "$BIG/build/$name-merged" "$BIG/build/$name-bf16.gguf"
}

[ "$WHICH" = "gemma" ] || [ "$WHICH" = "both" ] && deploy_one gemma
[ "$WHICH" = "qwen" ] || [ "$WHICH" = "both" ] && deploy_one qwen
say "本轮部署结束：$ROUND"
