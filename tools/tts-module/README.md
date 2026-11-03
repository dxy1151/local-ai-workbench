# 本地 TTS 模块（v1.6 预研，暂时不启用）

- `tts-server.py`：OpenAI 兼容 `/v1/audio/speech`，piper 中文音色，纯 CPU
- `tts-add-voice.sh`：从 HuggingFace `rhasspy/piper-voices` 下载音色

**当前状态：已从工作台运行配置里移除、systemd 服务已删除、模型/虚拟环境已清理**，只保留代码模块，需要时再装：

```bash
uv venv ~/tts/venv --python 3.12 && uv pip install --python ~/tts/venv/bin/python piper-tts
~/xingye-chat/tools/tts-module/tts-add-voice.sh zh/zh_CN/huayan/medium
python3 ~/xingye-chat/tools/tts-module/tts-server.py   # 127.0.0.1:18099
```

工作台「设置 → 朗读」填 `http://127.0.0.1:18099/v1` 即可。
