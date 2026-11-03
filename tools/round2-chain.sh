#!/bin/bash
# 第二轮：等第一轮数据采集 + 第一轮训练都结束后，自动构建第二轮 2000 条数据集并开训。
set -u
cd /home/don0ox1/xingye-chat
LOG=/tmp/round2-chain.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }
say "等待第二轮数据采集完成…"
for i in $(seq 1 240); do
  [ -f "/mnt/data4t/训练数据（归档）/API生成/v3-2000/cost.json" ] && break
  sleep 15
done
[ -f "/mnt/data4t/训练数据（归档）/API生成/v3-2000/cost.json" ] || { say "❌ 第二轮数据没生成完"; exit 1; }
say "构建第二轮数据集…"
python3 tools/build-dataset.py \
  --src "/mnt/data4t/训练数据（归档）/API生成/v3-2000/train.jsonl" \
  --out "/mnt/data4t/训练数据（归档）/训练集/gemma-train13-api2000.jsonl" \
  --rows 2000 --seed 20261103 2>&1 | tee -a $LOG
say "等第一轮训练（gemma→qwen）跑完…"
for i in $(seq 1 1440); do
  grep -q "^EXIT=" /tmp/train-v2k-qwen.log 2>/dev/null && break
  sleep 30
done
grep -q "^EXIT=" /tmp/train-v2k-qwen.log 2>/dev/null || { say "❌ 第一轮训练没结束，放弃第二轮"; exit 1; }
say "第一轮结束，开始第二轮 gemma…"
bash tools/train-v3k-gemma.sh
say "第二轮 gemma 结束，开始 qwen…"
bash tools/train-v3k-qwen.sh
say "✅ 第二轮训练全部结束"
