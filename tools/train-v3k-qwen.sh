#!/bin/bash
set -u
L=/home/don0ox1/deepseek/llm-chat
cd $L
DATA="/mnt/data4t/训练数据（归档）/训练集/gemma-train13-api2000.jsonl"
PYTHONUNBUFFERED=1 .venv-train/bin/python train_qlora.py \
  --base /mnt/data4t/ai-models/training/base-models/qwen3-8b-base \
  --data "$DATA" \
  --out $L/ckpt/qwen3-8b-v3k \
  --max-seq-len 2048 --epochs 2 --lr 1e-4 --batch-size 1 --grad-accum 8 \
  --lora-layers 16 --base-gb 16.8 --no-eval > /tmp/train-v3k-qwen.log 2>&1
echo "EXIT=$?" >> /tmp/train-v3k-qwen.log
