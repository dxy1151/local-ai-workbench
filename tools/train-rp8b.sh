#!/bin/bash
set -u
L=/home/don0ox1/deepseek/llm-chat
cd $L
PYTHONUNBUFFERED=1 .venv-train/bin/python train_qlora.py \
  --base /mnt/data4t/ai-models/training/base-models/gemma3-12b-it-ms \
  --data "/mnt/data4t/训练数据（归档）/训练集/gemma-train10.jsonl" \
  --out $L/ckpt/gemma3-12b-rp8b \
  --max-seq-len 1792 --epochs 3 --lr 1e-4 --batch-size 1 --grad-accum 8 \
  --lora-layers 16 --base-gb 24.4 --no-completion-only > /tmp/train-gemma8b.log 2>&1
echo "EXIT=$?" >> /tmp/train-gemma8b.log
