#!/bin/bash
# 晚上单独跑 qwen3-8b-v5k：训练 → 部署 → 归档
set -u
cd /home/don0ox1/xingye-chat
LOG=/tmp/run-qwen-v5k.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }
say "开始 qwen3-8b-v5k 训练"
bash tools/train-v5k-qwen.sh
[ -f "/mnt/data4t/ai-models/training/llm-chat/ckpt/qwen3-8b-v5k/final/adapter_config.json" ] || { say "❌ 缺 qwen 适配器"; exit 1; }
say "qwen 训练完成 → 部署 + 归档"
bash tools/deploy-round.sh v5k "/mnt/data4t/训练数据（归档）/训练集/gemma-train15-mixed.jsonl" qwen
say "✅ qwen3-8b-v5k 全部完成"
