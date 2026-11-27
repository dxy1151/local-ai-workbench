#!/bin/bash
# 最后一轮数据采集：等到北京时间 05:58 开跑（06:00 是截止点，之后不再采集）
set -u
cd /home/don0ox1/xingye-chat
LOG=/tmp/round4-collect.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }
say "等待 05:58 采集最后一轮数据（截止 06:00）…"
python3 - <<'PY'
import datetime, time
now = datetime.datetime.now()
target = now.replace(hour=5, minute=58, second=0, microsecond=0)
if target <= now:
    print(f'已过 05:58（现在 {now:%H:%M}），直接开始')
else:
    time.sleep((target - now).total_seconds())
PY
say "开始最后一轮数据采集（06:00 自动截止；高峰保护开着）"
python3 tools/gen-dialogues-2000.py --dialogues 720 --workers 12 --seed 20261104 \
  --scene-offset 13 --cutoff 06:00 --wait-idle \
  --out "/mnt/data4t/训练数据（归档）/API生成/v4-2000" 2>&1 | tee -a $LOG
say "构建第三轮数据集"
python3 tools/build-dataset.py \
  --src "/mnt/data4t/训练数据（归档）/API生成/v4-2000/train.jsonl" \
  --out "/mnt/data4t/训练数据（归档）/训练集/gemma-train14-api2000.jsonl" \
  --rows 2000 --seed 20261104 2>&1 | tee -a $LOG
say "✅ 最后一轮数据采集完成（之后不再采集）"
