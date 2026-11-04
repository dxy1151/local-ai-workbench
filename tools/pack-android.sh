#!/usr/bin/env bash
# 生成安卓（Termux）部署包 —— 把所有要拷到平板上的东西打成一个 tarball。
#
# 用法：
#   bash tools/pack-android.sh                 # 生成到 ~/android-deploy/
#   bash tools/pack-android.sh --with-model    # 连模型权重一起打包（约 5GB）
#
# 产物：
#   xingye-chat-android.tar.gz     代码 + 启动脚本 + 数据（角色卡/会话/知识库）
#   qwen3-8b-v7k-q4.gguf           模型（--with-model 才带）
#   INSTALL.md                     平板上照着做的步骤
#
# 为什么用 Termux：安卓上没有 root，跑不了 systemd，Termux 是个完整的用户态
# Linux 环境，自带 node / python，能把工作台当成普通 node 程序跑起来。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ANDROID_OUT:-$HOME/android-deploy}"
WITH_MODEL=false
for a in "$@"; do
  case "$a" in
    --with-model) WITH_MODEL=true ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
  esac
done

DATA="${ANDROID_DATA:-$HOME/xingye-sync}"
mkdir -p "$OUT"

echo "==> 打包代码"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/xingye-chat"
mkdir -p "$PKG"

# 代码本体（不含 node_modules / .git / 测试产物）
rsync -a --quiet \
  --exclude '.git' --exclude 'node_modules' --exclude 'data' \
  --exclude 'data-smoke' --exclude 'runtime' --exclude '.tts-cache' \
  --exclude '*.log' --exclude 'data-dir.txt' \
  "$ROOT/" "$PKG/"

# 数据：角色卡、会话、知识库（这些是平板上要用的「性格」和「记忆」）
if [ -d "$DATA" ]; then
  echo "==> 打包数据（$DATA）"
  mkdir -p "$PKG/data"
  for sub in characters sessions knowledge; do
    [ -d "$DATA/$sub" ] && rsync -a --quiet --exclude '.embed-cache-*' "$DATA/$sub/" "$PKG/data/$sub/"
  done
  # config.json 带上，但**改成平板能用的值**：
  #   - proxy 清空（电脑的 7897 代理在平板上不存在，留着会让所有请求走一个死端口）
  #   - contextWindow 降到 8192（12GB 内存跑 5GB 模型，16384 的 KV cache 要 2.25GB，容易 OOM）
  #   - 关语义检索（平板上没有 embedding 模型，开了会一直超时降级）
  if [ -f "$DATA/config.json" ]; then
    python3 - "$DATA/config.json" "$PKG/data/config.json" <<'PYCFG'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding='utf8'))
d['proxy'] = ''                 # 平板不经过电脑的代理
d['contextWindow'] = 8192       # 内存友好
d['knowledgeSemantic'] = False  # 平板上别开语义检索（要 embedding 模型）
json.dump(d, open(dst, 'w', encoding='utf8'), ensure_ascii=False, indent=2)
PYCFG
    echo "    config.json 已改成平板可用（代理清空 / 上下文 8192 / 关语义检索）"
  fi
else
  echo "⚠ 没找到数据目录 $DATA，只打包代码"
fi

# 平板上必须用 0.0.0.0 才能让同 Wi-Fi 的其它设备连；Termux 里其实只用 127.0.0.1
# 也够（同一个平板的浏览器），所以这里不改任何东西。

tar -czf "$OUT/xingye-chat-android.tar.gz" -C "$STAGE" xingye-chat
echo "✅ 代码包: $OUT/xingye-chat-android.tar.gz ($(du -h "$OUT/xingye-chat-android.tar.gz" | cut -f1))"

# 模型
if $WITH_MODEL; then
  echo "==> 导出模型 GGUF"
  MODEL="${ANDROID_MODEL:-qwen3-8b-v7k:latest}"
  GGUF="$OUT/qwen3-8b-v7k-q4.gguf"
  if [ ! -f "$GGUF" ]; then
    # 从 ollama 的 blob 里直接取（Q4_K_M 那个 blob 就是 GGUF）
    MANIFEST="$HOME/.ollama/models/manifests/registry.ollama.ai/library/${MODEL%%:*}/latest"
    if [ -f "$MANIFEST" ]; then
      DIGEST=$(python3 -c "
import json,sys
d=json.load(open('$MANIFEST'))
for l in d.get('layers',[]):
    if 'model' in l.get('mediaType',''): print(l['digest']); break
" 2>/dev/null)
      BLOB="$HOME/.ollama/models/blobs/${DIGEST//:/-}"
      if [ -n "$DIGEST" ] && [ -f "$BLOB" ]; then
        echo "    从 ollama blob 复制: $BLOB"
        cp "$BLOB" "$GGUF"
      fi
    fi
  fi
  if [ -f "$GGUF" ]; then
    echo "✅ 模型: $GGUF ($(du -h "$GGUF" | cut -f1))"
  else
    echo "⚠ 没导出模型，请手动把 GGUF 放到 $OUT/"
  fi
fi

# 安装说明
cat > "$OUT/INSTALL.md" <<'EOF'
# 安卓平板部署（红魔平板3 / Termux）

## 一、装 Termux

从 **F-Droid** 装 Termux（不要用 Google Play 那个，版本太旧）：
https://f-droid.org/packages/com.termux/

打开后先跑一次：
```bash
termux-setup-storage      # 弹窗点「允许」，这样才能访问下载目录
```

## 二、把文件拷到平板

任选一种：
- **U 盘 / OTG**：把 `xingye-chat-android.tar.gz` 拷进平板
- **局域网**：平板浏览器打开 `http://192.168.1.40:5178` 不行的话，用文件管理器 SMB
- **微信/QQ 传文件**：传给自己，然后「用其它应用打开」→ 保存到下载目录

## 三、解压并安装

```bash
cd ~
mkdir -p xingye && cd xingye
tar xzf ~/storage/downloads/xingye-chat-android.tar.gz
cd xingye-chat
bash android/setup.sh        # 装 Node.js + workbench 命令（只需一次）
```

## 四、模型（二选一）

### A. 不装模型，连电脑跑（推荐，快且省电）

平板只当浏览器。电脑上确保工作台监听 `0.0.0.0`：
```bash
# 电脑上改 ~/.config/systemd/user/xingye-chat.service
ExecStart=/usr/bin/node /mnt/data4t/xingye-chat-portable/start.js 5178 0.0.0.0
systemctl --user daemon-reload && systemctl --user restart xingye-chat
```
然后平板浏览器直接打开：`http://192.168.1.40:5178`
（在外网用 Tailscale：`http://100.124.214.66:5178`）

### B. 平板本地跑模型（离线）

装 Ollama for Android（Termux 里跑）：
```bash
pkg install -y ollama
ollama serve &
```

把 `qwen3-8b-v7k-q4.gguf` 放进模型目录，建 Modelfile：
```bash
mkdir -p ~/models
cp ~/storage/downloads/qwen3-8b-v7k-q4.gguf ~/models/
cat > ~/models/Modelfile <<'MF'
FROM /data/data/com.termux/files/home/models/qwen3-8b-v7k-q4.gguf
PARAMETER num_ctx 8192
PARAMETER temperature 0.85
PARAMETER stop "<|im_end|>"
PARAMETER stop "<|endoftext|>"
MF
ollama create qwen3-8b-v7k -f ~/models/Modelfile
```

⚠️ **平板上 num_ctx 建议 8192**（不要 16384）：
12GB 内存里，系统占 2.5GB、Termux+Node 占 1GB、模型权重 5GB，
剩下约 3.5GB 给 KV cache —— 8192 上下文只要 1.1GB，16384 要 2.25GB，容易 OOM。

## 五、启动

```bash
workbench                    # 自动开浏览器
# 或指定端口：bash android/run.sh 5178
```

平板浏览器会打开 `http://127.0.0.1:5178`。

## 六、设置（在平板上点右上角「设置」）

| 项 | 填什么 |
|---|---|
| Base URL | `http://127.0.0.1:11434/v1`（本地模型）或 `http://192.168.1.40:11434/v1`（连电脑） |
| API Key | 本地 Ollama 随便填个 `x` |
| 模型 | `qwen3-8b-v7k` |
| 上下文窗口 | **8192**（平板内存有限） |
| 常驻知识 | 从电脑的「设置 → 常驻知识」复制过来，或清空（省内存） |
| 关掉思考 | 打开 |

## 七、后台不被杀

Termux 跑久了安卓会杀进程。三件事：
1. 装 **Termux:Widget**（快捷启动）
2. 平板设置 → 电池 → 应用 → Termux → 允许后台活动
3. `android/run.sh` 里已经调了 `termux-wake-lock`

## 八、性能预期

红魔平板3 Pro（骁龙 8 Elite / 12GB）：

| 场景 | 预期 |
|---|---|
| 连电脑跑 8B | 20~40 tok/s（网络瓶颈，不是平板瓶颈） |
| 平板本地跑 8B Q4 | **5~12 tok/s**（CPU 推理，无 GPU 加速） |
| 冷启动加载模型 | 20~40 秒 |

本地跑适合「没网也想聊」，不适合长时间连续对话（发热降频）。
EOF

echo "✅ 安装说明: $OUT/INSTALL.md"
echo
echo "所有产物在: $OUT"
ls -lh "$OUT"
