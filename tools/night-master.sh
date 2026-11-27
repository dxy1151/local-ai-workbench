#!/bin/bash
# 夜间流水线：训练 → 部署归档 → 下一轮训练；数据采集在 06:00 截止（由 round4-collect 负责）
set -u
cd /home/don0ox1/xingye-chat
LOG=/tmp/night-master.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }
wait_exit(){ # $1 = log file
  for i in $(seq 1 2880); do grep -q "^EXIT=" "$1" 2>/dev/null && return 0; sleep 30; done
  return 1
}
check_adapters(){ # $1..=ckpt 目录名
  local d
  for d in "$@"; do
    [ -f "/mnt/data4t/ai-models/training/llm-chat/ckpt/$d/final/adapter_config.json" ] \
      || { say "❌ 缺少适配器 $d/final，停止流水线（避免白跑）"; exit 1; }
  done
}

say "===== 等待第 1 轮训练结束（gemma→qwen）====="
wait_exit /tmp/train-v2k-qwen.log || { say "❌ 第 1 轮训练没结束"; exit 1; }
check_adapters gemma3-12b-v2k qwen3-8b-v2k
say "第 1 轮结束 → 部署 + 归档"
bash tools/deploy-round.sh v2k "/mnt/data4t/训练数据（归档）/训练集/gemma-train12-api2000.jsonl" both

say "===== 第 2 轮训练：gemma ====="
bash tools/train-v3k-gemma.sh
say "===== 第 2 轮训练：qwen ====="
bash tools/train-v3k-qwen.sh
check_adapters gemma3-12b-v3k qwen3-8b-v3k
say "第 2 轮结束 → 部署 + 归档"
bash tools/deploy-round.sh v3k "/mnt/data4t/训练数据（归档）/训练集/gemma-train13-api2000.jsonl" both

say "等待 06:00 最后一轮采集的数据集…"
for i in $(seq 1 2880); do [ -f "/mnt/data4t/训练数据（归档）/训练集/gemma-train14-api2000.jsonl" ] && break; sleep 30; done
[ -f "/mnt/data4t/训练数据（归档）/训练集/gemma-train14-api2000.jsonl" ] || { say "❌ 第三轮数据集没生成"; exit 1; }

say "===== 第 3 轮训练：gemma ====="
bash tools/train-v4k-gemma.sh
say "===== 第 3 轮训练：qwen ====="
bash tools/train-v4k-qwen.sh
check_adapters gemma3-12b-v4k qwen3-8b-v4k
say "第 3 轮结束 → 部署 + 归档（收尾）"
bash tools/deploy-round.sh v4k "/mnt/data4t/训练数据（归档）/训练集/gemma-train14-api2000.jsonl" both

say "✅ 夜间流水线全部结束"
