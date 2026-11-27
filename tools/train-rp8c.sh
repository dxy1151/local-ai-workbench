#!/bin/bash
set -u
L=/home/don0ox1/deepseek/llm-chat
cd $L
PYTHONUNBUFFERED=1 .venv-train/bin/python train_qlora.py \
  --base /mnt/data4t/ai-models/training/base-models/gemma3-12b-it-ms \
  --data "/mnt/data4t/训练数据（归档）/训练集/gemma-train11.jsonl" \
  --out $L/ckpt/gemma3-12b-rp8c \
  --max-seq-len 2048 --epochs 2 --lr 7e-5 --batch-size 1 --grad-accum 8 \
  --lora-layers 16 --base-gb 24.4 --no-completion-only --no-eval > /tmp/train-gemma8c.log 2>&1
echo "EXIT=$?" >> /tmp/train-gemma8c.log
