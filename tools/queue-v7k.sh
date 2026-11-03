#!/bin/bash
# 排队：等 qwen3-8b-v6k 训练+部署结束，再跑 v7k（gemma → 部署 → qwen → 部署）
set -u
cd /home/don0ox1/xingye-chat
LOG=/tmp/queue-v7k.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }

say "等待 qwen3-8b-v6k 训练结束…"
for i in $(seq 1 720); do grep -q "^EXIT=" /tmp/train-qwen3-8b-v6k.log 2>/dev/null && break; sleep 30; done
grep -q "^EXIT=" /tmp/train-qwen3-8b-v6k.log || { say "❌ v6k 训练没结束，放弃 v7k"; exit 1; }
say "v6k 训练结束，等它的部署收尾…"
for i in $(seq 1 240); do
  grep -q "本轮部署结束\|✅ qwen3-8b-v6k 完成" /tmp/qwen-v6k-chain.log 2>/dev/null && break
  sleep 30
done
[ -f "/mnt/data4t/训练数据（归档）/训练产出/v6k/qwen/manifest.json" ] || say "⚠️ v6k qwen 归档未见 manifest，继续跑 v7k"
sleep 30

say "===== v7k：gemma3-12b 训练 ====="
bash tools/train-v7k-gemma.sh
[ -f "/mnt/data4t/ai-models/training/llm-chat/ckpt/gemma3-12b-v7k/final/adapter_config.json" ] || { say "❌ v7k gemma 失败"; exit 1; }
say "v7k gemma 部署"
bash tools/deploy-round.sh v7k "/mnt/data4t/训练数据（归档）/训练集/gemma-train17-dual.jsonl" gemma
say "===== v7k：qwen3-8b 训练 ====="
bash tools/train-v7k-qwen.sh
[ -f "/mnt/data4t/ai-models/training/llm-chat/ckpt/qwen3-8b-v7k/final/adapter_config.json" ] || { say "❌ v7k qwen 失败"; exit 1; }
say "v7k qwen 部署"
bash tools/deploy-round.sh v7k "/mnt/data4t/训练数据（归档）/训练集/gemma-train17-dual.jsonl" qwen
say "✅ v7k 全部完成"
