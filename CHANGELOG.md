# 更新日志

## 1.0.0 — 2026-10-16

第一个正式发行版：**本地AI对话工作台（`local-ai-workbench`）**。

### 改名与授权

- 项目更名为「本地AI对话工作台」：包名 `local-ai-workbench`，命令行 `workbench`
- 采用 **MIT License**，Copyright (c) 2026 **xue yi duan**（项目根目录 `LICENSE`，设置页最下方也有原文）
- 界面标题、侧边栏、控制台横幅、帮助文案、各平台脚本里的显示名统一

### 跨平台

- 新增 `windows/`：`start.cmd`（双击启动）、`start-minimized.cmd`（最小化 / 开机自启）、`stop.cmd`
- 新增 `linux/`：`setup.sh`（环境检查 + 安装 `workbench` 命令）、`run.sh`（启动，可选自动开浏览器）
- `lib/ollama.js` 的 Ollama 路径探测跨平台化：
  Windows 查 `D:\ollama`、`%LOCALAPPDATA%`；Linux / macOS 查 `/usr/local/bin`、`/usr/bin`、`/snap/bin`、`/opt/ollama/bin`、`~/.local/bin` 与 `~/.ollama/models`，最后回落到 PATH
- 新增 `build.sh`（`build.ps1` 的 Linux / macOS 等价物），两个打包脚本都支持**发行模式**：
  `bash build.sh --release` / `powershell -File build.ps1 -Release`，产出干净的 `local-ai-workbench-v<版本>.zip`
- **便携 Node**：`linux/get-node.sh` 与 `windows/get-node.ps1` 可以把 Node LTS 直接装进项目的 `runtime/`，
  启动器会优先使用它 —— 使用者不必自己装 Node

### 健壮性

- 端口无权限（`EACCES`）不再只吐一句 `listen EACCES`：现在会说明「<1024 需要管理员」和
  「Windows 可能把这个端口划进 Hyper-V / WSL 的保留段」，并给出 `netsh` 查法
- `share.js` 默认共享的包名跟随项目名与版本号
- 打包自检扩展到：条目名无反斜杠、无 `data/` 泄漏、无 `runtime/`（便携 Node 绝不进包）、发行包里不含 `smoke.js`

### 行为变更

- **「叙事推进指令」默认不再注入**：开箱时它是空的，要开就在设置里自己写一段
  （老配置里已经存过的那段不受影响，照旧生效）
- **环境变量改用 `WORKBENCH_*`**：`WORKBENCH_HOST` / `WORKBENCH_DATA_DIR` /
  `WORKBENCH_EMBED_BASE` / `WORKBENCH_EMBED_MODEL`。旧的 `XINGYE_*` 名字**仍然能读**，
  已经在用的脚本不用改，新文档只写新名字

### 继承自上游项目 v0.62.0 的能力

- 角色卡（人设 / 背景 / 开场白 / 简介 / 常用词，随时二次编辑）、多轮会话管理、**直连模式**（零系统提示词）
- 资料库 + 关键词 / 语义检索（embedding 缓存）、**联网搜索**（必应，国际版 / 国内版 / 代理）
- **朗读**（任意 OpenAI 兼容 `/v1/audio/speech` 服务）、**识图 / 附图**（本机 Ollama 视觉模型）
- 回复质量处理：自动清洗凭空动静、动作开头、叙事推进、维度图、字数上限、撤回 / 重新生成 / 已否决
- 工作时段锁（只对云端接口生效）、删除二次确认、括号自动补全、场景备忘、等义词表
- 本机 Ollama 管理：启动 / 常驻不卸载 / 立刻释放显存 / 一键切模型 / 关掉思考（Qwen3）
- 导出备份 / 导入合并（按时间合并，两边都保留）、Syncthing 多设备同步（自动维护 `.stignore`）
- 局域网访问（手机 / 平板浏览器直接用）、安卓 Termux 独立运行
