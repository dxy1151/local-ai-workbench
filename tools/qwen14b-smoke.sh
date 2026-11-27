#!/bin/bash
# 夜间任务：挂载检查 → rp8b 部署收尾 → Qwen 权重续传 → 20 条 QLoRA 冒烟 → Q6 部署 + 测速
set -u
L=/home/don0ox1/deepseek/llm-chat
WB=/home/don0ox1/xingye-chat
DATA=/tmp/qwen-smoke20.jsonl
CKPT=$L/ckpt/qwen3-14b-abl-lora-smoke
LOG=/tmp/qwen-night.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }
export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
for k in ALL_PROXY all_proxy NO_PROXY no_proxy; do unset $k 2>/dev/null || true; done

# 0) 4TB 盘必须挂载：ckpt/build/ollama 模型都在它上面
if ! mountpoint -q /mnt/data4t; then
  systemctl --user start data4t-models.mount.service 2>/dev/null || true
  sleep 3
fi
if ! mountpoint -q /mnt/data4t; then
  say "❌ /mnt/data4t 未挂载（NTFS 脏）。先把 Qwen 权重下到 data500 继续："
  ~/deepseek/llm-chat/.venv-train/bin/python $WB/tools/fetch-qwen14b.py /mnt/data500/ai-models/qwen3-14b-abl-v2 >> $LOG 2>&1 || true
  say "权重下载到 data500 后退出；等 4TB 盘挂载后重新运行本任务（或在设置里手动挂一次）"
  exit 1
fi

# rp8b 部署收尾（白天断电/重启导致没完成时）
if [ -f $L/ckpt/gemma3-12b-rp8b/final/adapter_config.json ] && ! ollama list 2>/dev/null | grep -q "gemma3-12b-rp8b"; then
  say "rp8b 部署收尾中…"
  rm -rf /mnt/data4t/ai-models/training/build/gemma3-12b-rp8b-merged \
         /mnt/data4t/ai-models/training/build/gemma3-12b-rp8b-bf16.gguf 2>/dev/null
  rm -f /mnt/data4t/ai-models/training/models/gemma3-12b-rp8b-Q4_K_M.gguf 2>/dev/null
  nohup bash $WB/tools/deploy-rp8b.sh >> /tmp/deploy-gemma8b-retry.log 2>&1
  for i in $(seq 1 80); do
    sleep 30
    ollama list 2>/dev/null | grep -q "gemma3-12b-rp8b" && { say "rp8b 部署完成"; break; }
    pgrep -f "deploy-rp8b|merge-only|convert_hf|llama-quantize" >/dev/null || { say "rp8b 部署进程结束（可能失败）"; break; }
  done
fi

# 选权重目录：优先 data4t，否则用 data500
BASE=/mnt/data4t/ai-models/training/base-models/qwen3-14b-abl-v2
if [ ! -f "$BASE/model-00001-of-00006.safetensors" ] && [ -f /mnt/data500/ai-models/qwen3-14b-abl-v2/model-00001-of-00006.safetensors ]; then
  BASE=/mnt/data500/ai-models/qwen3-14b-abl-v2
fi

# 0) 若权重还没下完：续传（hf_hub 会用 .incomplete 断点续传）
if [ "$(ls "$BASE"/model-*.safetensors 2>/dev/null | wc -l)" -lt 6 ] || [ -n "$(find "$BASE" -name '*.incomplete' 2>/dev/null | head -1)" ]; then
  say "权重未下完，续传中…"
  ~/$L/.venv-train/bin/python /tmp/dl-qwen14b.py >> $LOG 2>&1 || { say "❌ 权重下载失败"; exit 1; }
fi
say "权重就绪：$(du -sh "$BASE" | cut -f1)"

# 1) 20 条数据（从已清洗数据集里抽，保持同一套 system 提示词）
python3 - <<'PY'
import json, random
rows=[json.loads(l) for l in open('/home/don0ox1/deepseek/llm-chat/data/gemma-train10.jsonl',encoding='utf-8') if l.strip()]
random.Random(7).shuffle(rows)
sel=rows[:20]
with open('/tmp/qwen-smoke20.jsonl','w',encoding='utf-8') as f:
    for r in sel: f.write(json.dumps(r,ensure_ascii=False)+'\n')
print('20 条 ->', len(sel))
PY

# 2) 释放显卡（停会占卡的常驻服务 + 卸 Ollama 模型）
for u in comfyui gemma-server llama-gemma4; do systemctl --user stop $u 2>/dev/null; done
Q=$(curl -s http://127.0.0.1:11434/api/ps | python3 -c "import json,sys;print(' '.join(m['name'] for m in json.load(sys.stdin).get('models',[])))" 2>/dev/null)
for m in $Q; do curl -s -X POST http://127.0.0.1:11434/api/generate -H 'Content-Type: application/json' -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null; done
sleep 3
say "显存空闲：$(nvidia-smi --query-gpu=memory.free --format=csv,noheader)"

# 3) 训练（20 条 -> 验证流程即可；OOM 时 train_qlora 自己会降级重试）
if [ -f "$CKPT/final/adapter_config.json" ]; then
  say "已有 adapter，跳过训练"
else
  rm -rf "$CKPT"
  say "开始 QLoRA 冒烟训练（20 条，seq 1536，lora-layers 12）…"
  PYTHONUNBUFFERED=1 $L/.venv-train/bin/python $L/train_qlora.py \
    --base "$BASE" --data "$DATA" --out "$CKPT" \
    --max-seq-len 1536 --epochs 1 --lr 1e-4 --batch-size 1 --grad-accum 2 \
    --lora-layers 12 --base-gb 30 --no-completion-only >> $LOG 2>&1
  [ -f "$CKPT/final/adapter_config.json" ] || { say "❌ 训练失败（见日志）"; exit 1; }
  say "训练完成"
fi

# 4) 部署成 Q6_K（14B 合并+转GGUF+量化约 40~60 分钟）
if [ ! -f /mnt/data4t/ai-models/training/models/qwen3-14b-abl-lora-Q6_K.gguf ]; then
  say "部署量化 Q6_K …"
  QUANT=Q6_K BASE="$BASE" BIG_DISK=/mnt/data4t/ai-models/training bash $L/deploy.sh \
    --adapter "$CKPT/final" --version qwen3-14b-abl-lora >> $LOG 2>&1 || { say "❌ 部署失败"; exit 1; }
fi
G=/mnt/data4t/ai-models/training/models/qwen3-14b-abl-lora-Q6_K.gguf
ollama show --modelfile qwen3-14b-abl-q8 > /tmp/qwen-lora.Modelfile.raw 2>/dev/null || true
{ sed "s#^FROM .*#FROM $G#" /tmp/qwen-lora.Modelfile.raw | sed "s/num_ctx 6144/num_ctx 4096/"; } > /tmp/qwen-lora.Modelfile
ollama create qwen3-14b-abl-lora-q6 -f /tmp/qwen-lora.Modelfile >> $LOG 2>&1
say "ollama create 完成"

# 5) 速度实测：Q6 原版 / Q8 / 新 LoRA Q6（各生成 60 token）
bench(){
  local m=$1
  curl -s http://127.0.0.1:11434/api/generate -H 'Content-Type: application/json' \
    -d "{\"model\":\"$m\",\"prompt\":\"用一句话说说今天天气怎么样\",\"stream\":false,\"options\":{\"num_predict\":60}}" \
  | python3 -c "import json,sys
d=json.load(sys.stdin)
n=d.get('eval_count') or 0; ns=d.get('eval_duration') or 0
print(f\"{d.get('model','?')}: {n} tok / {ns/1e9:.1f}s = {n/(ns/1e9):.1f} tok/s\")" 2>/dev/null || echo "$m: 測试失败"
}
{ echo "=== 速度实测 ==="; bench qwen14b-abl-q6k; bench qwen3-14b-abl-q8; bench qwen3-14b-abl-lora-q6; } | tee -a $LOG > /tmp/qwen-night-result.txt
# 收尾：卸载模型，恢复 ComfyUI（如果本来在跑也没关系，下次用到会自己起）
curl -s -X POST http://127.0.0.1:11434/api/generate -H 'Content-Type: application/json' -d '{"model":"qwen3-14b-abl-q8","keep_alive":0}' >/dev/null
say "全部完成"
