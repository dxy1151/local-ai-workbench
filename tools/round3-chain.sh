#!/bin/bash
# 最后一轮数据采集：等到北京时间 06:00（空闲时段）再采集，然后等第二轮训练结束接着训第三轮。
set -u
cd /home/don0ox1/xingye-chat
LOG=/tmp/round3-chain.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }

say "等到 06:00（空闲时段）采集最后一轮数据…"
python3 - <<'PY'
import datetime, time
now = datetime.datetime.now()
target = now.replace(hour=6, minute=0, second=0, microsecond=0)
if target <= now:
    print(f'已经过了 06:00（现在 {now:%H:%M}），直接开始')
else:
    wait = (target - now).total_seconds()
    print(f'现在 {now:%H:%M:%S}，睡 {wait/3600:.2f} 小时到 06:00')
    time.sleep(wait)
PY
say "开始采集最后一轮数据（高峰保护已开，若已进入高峰会自动等待）…"
python3 tools/gen-dialogues-2000.py --dialogues 720 --workers 12 --seed 20261104 \
  --scene-offset 13 --wait-idle \
  --out "/mnt/data4t/训练数据（归档）/API生成/v4-2000" 2>&1 | tee -a $LOG

say "构建第三轮数据集…"
python3 tools/build-dataset.py \
  --src "/mnt/data4t/训练数据（归档）/API生成/v4-2000/train.jsonl" \
  --out "/mnt/data4t/训练数据（归档）/训练集/gemma-train14-api2000.jsonl" \
  --rows 2000 --seed 20261104 2>&1 | tee -a $LOG

say "等第二轮训练（gemma→qwen）跑完…"
for i in $(seq 1 1440); do
  grep -q "^EXIT=" /tmp/train-v3k-qwen.log 2>/dev/null && break
  sleep 30
done
grep -q "^EXIT=" /tmp/train-v3k-qwen.log 2>/dev/null || { say "❌ 第二轮训练没结束，放弃第三轮"; exit 1; }
say "第二轮结束，开始第三轮 gemma…"
bash tools/train-v4k-gemma.sh
say "第三轮 gemma 结束，开始 qwen…"
bash tools/train-v4k-qwen.sh
say "✅ 第三轮训练全部结束"
