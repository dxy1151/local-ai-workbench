#!/bin/bash
# 用 2000 条 API 生成样本训 gemma3-12b（QLoRA，只学角色回复）
set -u
L=/home/don0ox1/deepseek/llm-chat
cd $L
DATA="/mnt/data4t/训练数据（归档）/训练集/gemma-train12-api2000.jsonl"
PYTHONUNBUFFERED=1 .venv-train/bin/python train_qlora.py \
  --base /mnt/data4t/ai-models/training/base-models/gemma3-12b-it-ms \
  --data "$DATA" \
  --out $L/ckpt/gemma3-12b-v2k \
  --max-seq-len 2048 --epochs 1 --lr 6e-5 --batch-size 1 --grad-accum 8 \
  --lora-layers 16 --base-gb 24.4 --no-eval > /tmp/train-v2k-gemma.log 2>&1
echo "EXIT=$?" >> /tmp/train-v2k-gemma.log
