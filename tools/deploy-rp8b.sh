#!/bin/bash
set -u
L=/home/don0ox1/deepseek/llm-chat
LOG=/tmp/deploy-gemma8b.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }
AD=$L/ckpt/gemma3-12b-rp8b/final
[ -f "$AD/adapter_config.json" ] || { say "❌ 缺少适配器"; exit 1; }
BASE=/mnt/data4t/ai-models/training/base-models/gemma3-12b-it-ms
BASE=$BASE BIG_DISK=/mnt/data4t/ai-models/training bash $L/deploy.sh --adapter "$AD" --version gemma3-12b-rp8b 2>&1 | tee -a $LOG
G=/mnt/data4t/ai-models/training/models/gemma3-12b-rp8b-Q4_K_M.gguf
[ -f "$G" ] || { say "❌ 没有 GGUF"; exit 1; }
MODELF=$L/gemma3-12b-rp8b.Modelfile
ollama show --modelfile gemma3-12b-rp2 > $MODELF.raw 2>/dev/null || true
{ sed "s#^FROM .*#FROM $G#" $MODELF.raw | sed "s/num_ctx 4096/num_ctx 8192/"; echo 'PARAMETER repeat_penalty 1.08'; echo 'PARAMETER repeat_last_n 256'; } > $MODELF
ollama create gemma3-12b-rp8b -f $MODELF 2>&1 | tail -3 | tee -a $LOG
say "✅ 全部完成：ollama run gemma3-12b-rp8b"
