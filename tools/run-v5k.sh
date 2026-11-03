#!/bin/bash
# 第 5 轮：训 gemma + qwen，然后部署归档（v5k）
set -u
cd /home/don0ox1/xingye-chat
LOG=/tmp/run-v5k.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }
say "开始 gemma3-12b-v5k"
bash tools/train-v5k-gemma.sh
say "开始 qwen3-8b-v5k"
bash tools/train-v5k-qwen.sh
for d in gemma3-12b-v5k qwen3-8b-v5k; do
  [ -f "/mnt/data4t/ai-models/training/llm-chat/ckpt/$d/final/adapter_config.json" ] || { say "❌ 缺适配器 $d"; exit 1; }
done
say "部署 + 归档 v5k"
bash tools/deploy-round.sh v5k "/mnt/data4t/训练数据（归档）/训练集/gemma-train15-mixed.jsonl" both
say "✅ v5k 全部完成"
