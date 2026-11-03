#!/bin/bash
# v6k：修好模板/数据后重训 gemma → 部署 → 训练 qwen → 部署
set -u
cd /home/don0ox1/xingye-chat
LOG=/tmp/run-v6k.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }
say "开始 gemma3-12b-v6k 训练（模板已修：Gemma 用 <start_of_turn>，结束符计入 loss）"
bash tools/train-v6k-gemma.sh
[ -f "/mnt/data4t/ai-models/training/llm-chat/ckpt/gemma3-12b-v6k/final/adapter_config.json" ] || { say "❌ gemma 失败"; exit 1; }
say "部署 gemma3-12b-v6k"
bash tools/deploy-round.sh v6k "/mnt/data4t/训练数据（归档）/训练集/gemma-train16-clean.jsonl" gemma
say "开始 qwen3-8b-v6k 训练"
bash tools/train-v6k-qwen.sh
[ -f "/mnt/data4t/ai-models/training/llm-chat/ckpt/qwen3-8b-v6k/final/adapter_config.json" ] || { say "❌ qwen 失败"; exit 1; }
say "部署 qwen3-8b-v6k"
bash tools/deploy-round.sh v6k "/mnt/data4t/训练数据（归档）/训练集/gemma-train16-clean.jsonl" qwen
say "✅ v6k 全部完成"
