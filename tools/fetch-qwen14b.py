#!/usr/bin/env python3
# 下载 Qwen3-14B-abliterated-v2 的 HF 权重（断点续传；断电后重跑即可）
import os, sys
# 清理会干扰 httpx 的代理变量（ALL_PROXY=socks + NO_PROXY 里的 [::1] 都会报错）
for k in ('ALL_PROXY','all_proxy','NO_PROXY','no_proxy'):
    os.environ.pop(k, None)
os.environ.setdefault('https_proxy','http://127.0.0.1:7897')
os.environ.setdefault('http_proxy','http://127.0.0.1:7897')
os.environ.setdefault('HTTPS_PROXY','http://127.0.0.1:7897')
os.environ.setdefault('HTTP_PROXY','http://127.0.0.1:7897')
from huggingface_hub import snapshot_download
dest = sys.argv[1] if len(sys.argv) > 1 else '/mnt/data500/ai-models/qwen3-14b-abl-v2'
snapshot_download(repo_id='huihui-ai/Qwen3-14B-abliterated-v2', local_dir=dest,
                  allow_patterns=['*.json','*.safetensors','*.txt','*.model'])
print('DONE', dest)
