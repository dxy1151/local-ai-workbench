# gemma3-12b 草稿服务（手写素材生成用）

手写素材页的「自动生成」默认用 gemma3-12b（`gemma3-12b-m21-heretic-Q5_K_M`）。
它不放在 Ollama 里 —— **游戏2 那个盘只剩几 GB，8.45 GB 的模型塞不进去**。
改为用 llama-server 直接读 `星野抓提示词/models/` 下的 GGUF，不占额外空间。

## 服务

systemd 用户单元：`~/.config/systemd/user/gemma-server.service`

```bash
systemctl --user status gemma-server     # 看状态
systemctl --user restart gemma-server    # 重启
journalctl --user -u gemma-server -n 80  # 看日志
```

- 监听 `127.0.0.1:18080`
- `-ngl 99`：全部层上 GPU，常驻约 **10 GB 显存**
- `Linger=yes`，开机自动起（不需要登录）
- `Restart=on-failure`

## 和训练的关系

训练要整块显存，所以：

| 时机 | 行为 |
|---|---|
| 训练开始前 | `prepareGpuForTraining()` **停掉这个服务**，腾出 10 GB |
| 训练结束后 | `restoreGpu()` **自动重新启动** |
| 服务没起时调生成接口 | `server.js` 会 `systemctl --user start` 并等它 ready（最多 80 秒） |

## 为什么不用 /v1/chat/completions

新版 llama-server 会从 jinja 模板**自动生成解析器**，Gemma 模板里有它不支持的表达式：

```
400 Unable to generate parser for this template. Automatic parser generation failed…
```

所以 `lib/server.js` 的 `callLlama()` 走**原始 `/completion`**，自己按 Gemma 格式拼 prompt：

```
<start_of_turn>user
{system}<end_of_turn>
<start_of_turn>user
{用户}<end_of_turn>
<start_of_turn>model
{角色}<end_of_turn>
```

两个坑：

1. Gemma **没有 system 角色** → system 一律放在最前面的一条 user 段里
2. 素材常以**角色开场白**开头（第一条是 assistant）→ 早期写法「只有第一条是 user 才拼 system」
   会把 system 整个丢掉，模型就自称「我是 Gemma，一个由 Google DeepMind 训练的…」

## 换模型

改 unit 里的 `-m` 路径，`systemctl --user daemon-reload && systemctl --user restart gemma-server`。
