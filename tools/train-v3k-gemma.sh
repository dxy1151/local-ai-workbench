#!/bin/bash
set -u
L=/home/don0ox1/deepseek/llm-chat
cd $L
DATA="/mnt/data4t/训练数据（归档）/训练集/gemma-train13-api2000.jsonl"
PYTHONUNBUFFERED=1 .venv-train/bin/python train_qlora.py \
  --base /mnt/data4t/ai-models/training/base-models/gemma3-12b-it-ms \
  --data "$DATA" \
  --out $L/ckpt/gemma3-12b-v3k \
  --max-seq-len 2048 --epochs 1 --lr 6e-5 --batch-size 1 --grad-accum 8 \
  --lora-layers 16 --base-gb 24.4 --no-eval > /tmp/train-v3k-gemma.log 2>&1
echo "EXIT=$?" >> /tmp/train-v3k-gemma.log
