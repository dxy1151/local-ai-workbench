# 星野·本地版（xingye-chat / local-ai-workbench）项目文档

> 面向**要在这个项目上写插件 / 改功能**的人。读完你应该知道：
> 一次聊天请求从浏览器到模型再回来都经过了谁、数据存在哪、接口长什么样、
> 从哪里插进去最不容易踩坑，以及这个项目已经踩过哪些坑（照着躲）。

- 版本：**v2.4.1**（版本号唯一来源是 `package.json`，见 `lib/version.js`；改版本号时 CHANGELOG 必须同步加一节）
- 运行形态：单个 Node.js 进程（Node ≥ 18，ESM，**零 npm 依赖**）+ 浏览器页面
- 数据形态：本地 JSON 文件，一个对象一个文件（为了 Syncthing 这类文件级同步能干净合并）

## 目录

1. [它是什么](#1-它是什么)
2. [跑起来 & 自检](#2-跑起来--自检)
3. [全局架构](#3-全局架构)
4. [模块职责表](#4-模块职责表)
5. [一次聊天请求的完整生命周期](#5-一次聊天请求的完整生命周期)
6. [HTTP API 参考](#6-http-api-参考)
7. [数据模型与磁盘布局](#7-数据模型与磁盘布局)
8. [提示词管线](#8-提示词管线)
9. [模型后端适配](#9-模型后端适配)
10. [前端结构](#10-前端结构)
11. [训练 / 素材工具链](#11-训练--素材工具链)
12. [**插件开发指南**](#12-插件开发指南)
13. [测试](#13-测试)
14. [排错表](#14-排错表)
15. [附录：常量 / 环境变量 / 术语](#15-附录常量--环境变量--术语)

---

## 1. 它是什么

一个跑在自己机器上的 AI 聊天工作台，两套模式：

| 模式 | 系统提示词 | 用的接口 | 典型用途 |
|---|---|---|---|
| **角色模式** | 由 `lib/prompt.js` 按角色卡拼一大段（人设/场景/常用词/维度/提示/备忘/资料/搜索…） | `POST /api/chat` | 角色扮演，带质量控制、多人分角色 |
| **直连模式** | **一条都没有**（可选只有「常用语」一段） | `POST /api/direct/chat` | 就当个纯净的 OpenAI 客户端用 |

周边能力：星野角色抓取、资料库（关键词 + 语义检索）、必应联网搜索、TTS 朗读、
识图 / 附图（本机 Ollama 视觉模型）、工作时段锁、本机 Ollama 管理、
QLoRA 训练队列与模型部署、手写素材编辑页、手机 / 局域网访问。

**设计取向**（改代码前先认同这三条，不然容易拧着来）：

1. **数据只在本机**：没有账号、没有遥测、不联任何除了「你填的 baseUrl」之外的地址。
2. **零依赖**：只用 Node 内置模块。没有 `express`、没有 `openai` SDK、没有 `ws`。
   HTTP 用 `node:http`，流式 SSE 手写，OpenAI 兼容调用手写（含可选 HTTP 代理 CONNECT 隧道）。
3. **不引入构建步骤**：`public/` 下的文件浏览器直接加载，没有打包、没有转译。

---

## 2. 跑起来 & 自检

```bash
node start.js                          # 5178，只监听 127.0.0.1
node start.js 5179                     # 换端口
node start.js 5178 0.0.0.0             # 监听全部网卡（手机可连）
WORKBENCH_HOST=192.168.1.5 node start.js
node smoke.js                          # 冒烟自检（会起一个临时数据目录的服务，跑完清理）
bash build.sh [--release]              # 打包 zip 到上一级目录
```

启动链路：`start.js` → `lib/server.js#startServer(port, host)`
→ `ensureDataReady()`（迁移旧数据、维护 `.stignore`）
→ `http.createServer(route)`
→ `resumeQueue()`（接着跑上次没跑完的训练队列）。

启动横幅会把可用局域网 IP 列出来；失败时对 `EADDRINUSE / EADDRNOTAVAIL / EACCES`
分别给出人话提示（见 `start.js` 尾部）。

### 数据目录解析（优先级从高到低）

1. 环境变量 `WORKBENCH_DATA_DIR`（兼容旧名 `XINGYE_DATA_DIR`）
2. 项目根 `data-dir.txt` 里第一行非注释路径
3. 默认 `./data`

本机实际指到 `/mnt/data4t/xingye-sync`（`data-dir.txt`），所以程序目录和数据目录是分开的，
升级只换程序、不动数据。

### 远程访问口令 / 2FA / 可信网段（可选）

- 口令来源优先级：`~/.config/xingye-tunnel/auth.json`（v2.3.9 起网页可改，权限 600）
  > 环境变量 `WORKBENCH_PASSWORD`（兼容 `XINGYE_PASSWORD`）。
  **注意：v2.4.1 前这里写"不落盘"是错的** —— 网页里改过口令就会写进 auth.json。
- 没设口令 = 不启用认证；设了之后：
  - **本机（回环且没有代理转发头）免密**；
  - **可信网段免密**（v2.3.42）：`XINGYE_TRUST_CIDRS` 或 auth.json 的 `trustCidrs`，
    例 `192.168.1.0/24,100.64.0.0/10`（覆盖局域网和 Tailscale）；
  - 带 `cf-connecting-ip` / `x-forwarded-for` / `x-real-ip` / `cf-ray` 的请求**永远不算本机、也不算可信网段**；
  - 其它来源过一次 `POST /__login`（`application/x-www-form-urlencoded`，字段 `password`、
    可选 `code`），成功后发 `HttpOnly` Cookie `xingye_pass`（30 天）。`/__logout` 清 Cookie。
- **2FA（TOTP）**：`WORKBENCH_TOTP_SECRET` 或 auth.json 的 `totpSecret`；开启后 `/__login` 额外校验 `code`。
- `/api/auth/*`（改口令 / 开关 2FA）**只接受本机请求**（`isLoopback`），远程改锁一律 403。
- 实现在 `lib/access.js`，门在 `route()` 最前面；`/api/*` 未授权回 401 JSON，其它路径回登录页 HTML。
- v2.4.1 修复：`/train.xml`、`/train.json` 原来在口令门**之前**放行（注释说要给 RSS 阅读器用），
  但 `public/` 里从来没有这两个文件 —— 那是死豁免 + 一个"放个同名文件就免鉴权"的口子，已删除。

---

## 3. 全局架构

```
┌──────────────────────────── 浏览器（public/）────────────────────────────┐
│ index.html  单页：侧栏 tabs（角色/会话/直连/手写/星野）+ 聊天区 + 弹窗      │
│ app.js      状态机、渲染、SSE 客户端、所有交互                            │
│ train.html  训练监控（独立页）      review.html  素材人工挑选（独立页）    │
│ 纯逻辑模块：autopair.js（括号补全） uistate.js（发送键状态）              │
│             cheat.js（cheats=1/quit） slashpick.js（/ 以谁的身份发）          │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ HTTP JSON + SSE（同源，无鉴权头，靠 Cookie / 回环）
┌───────────────┴──────────────────────────────────────────────────────────┐
│ lib/server.js  route(req,res) = 一条超长 if-chain（55+ 路由）             │
│   ├─ 静态文件 serveStatic（public/，Cache-Control: no-store）             │
│   ├─ 聊天：handleChat / handleDirectChat（SSE 流式）                      │
│   ├─ 素材 / 训练 / 星野 / 导出 / 设置 …                                   │
│   └─ 统一错误：route() 抛错 → 500 {error}                                 │
├──────────────────────────────────────────────────────────────────────────┤
│ 领域模块                                                                  │
│   prompt.js    提示词组装（buildMessages / previewContext / cast / 解析） │
│   sanitize.js  回复清洗 + 质量分（凭空动静 / 复读 / 第三人称 / 拖延）     │
│   markup.js    记号规整（*/（）互转）+ 人称归一                           │
│   loopguard.js 流式复读检测与截断                                         │
│   limit.js     字数上限截断                                               │
│   knowledge.js 资料库分块 / 词法检索 / 语义检索（本地 embedding 缓存）    │
│   search.js    必应抓取解析（走同一个代理）                               │
│   openai.js    OpenAI 兼容客户端（流式、代理、prefill、后端锁）           │
│   ollama.js    Ollama 原生接口（think、keep_alive、预加载、释放）         │
│   vision.js    识图 / 附图（本机 Ollama 视觉模型）                        │
│   tts.js       朗读（OpenAI 兼容 /v1/audio/speech，本地磁盘缓存）         │
│   workguard.js 工作时段锁（北京时间工作日两段）                           │
│   candidates.js 多候选生成（🎲 / 🙋 / gold）                              │
│   export.js    训练数据导出（SFT / DPO / 手写素材 + 权重）                │
│   trainer.js   训练队列（spawn llm-chat 的 python 训练 + 部署）           │
│   trainlog.js  训练日志 / GPU 快照读取                                    │
│   gpu.js       显存探测、训练前腾卡、训练后恢复                            │
│   xingye.js    星野分享链接抓取 / 搜索 / 注册                             │
│   store.js     全部本地存储 + 配置归一化（唯一的写盘入口）                │
├──────────────────────────────────────────────────────────────────────────┤
│ 外部依赖（全可选）                                                        │
│   OpenAI 兼容 API（云端）｜ Ollama 127.0.0.1:11434 ｜ llama-server :18080  │
│   llm-chat 训练工程（.venv-train / train_qlora.py / deploy.sh）           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 模块职责表

| 文件 | 行数级 | 干什么 | 关键导出 |
|---|---|---|---|
| `start.js` | 77 | 入口，参数/环境变量解析，启动横幅与错误提示 | — |
| `lib/server.js` | 4341 | 唯一 HTTP 入口：路由、SSE、所有业务流程编排 | `startServer` |
| `lib/store.js` | 1156 | 本地 JSON 存储（角色/会话/配置/资料/素材）+ 所有字段归一化 | `DATA_DIR`、`getConfig/saveConfig`、`listCharacters/saveCharacter/deleteCharacter`、`listSessions/getSession/createSession/saveSession/deleteSession`、`getKnowledge/saveKnowledge`、`getSharedKnowledge/saveSharedKnowledge`、`listScripts/getScript/createScript/saveScript/deleteScript`、`exportBundle/mergeBundle`、`ensureDataReady` |
| `lib/prompt.js` | 1558 | 提示词：角色系统提示词、多人、维度、常用词、提示、备忘、字数、资料、搜索、等义词、`/no_think`、历史裁剪、回复解析 | `buildMessages`、`previewContext`、`directMessages`、`parseCast/castOf`、`parseReplyLines`（可传 cast 名字）、`normalizeCastSpeaker`、`asNudge`、`applyAsIdentity`、`dropAsSpeaker`、`dropMultiOpener`、`CONTEXT_BUDGET` |
| `lib/sanitize.js` | 1014 | 回复质量：清凭空动静、角色泄漏、套路句（`*…*` 和 `（）` 两种记号）、复读、**模型替用户写的动作/心理**；质量打分；历史清洗（含自我复读锁定） | `sanitizeReply`、`stripUserActions`、`stripClicheActions`、`replyQuality`、`cleanHistory` |
| `lib/markup.js` | 461 | 记号与人称：`*…*`↔`（…）`、外语残留、第三人称旁白检测与改第一人称 | `normalizeMarkup`、`normalizePerson`、`thirdPersonSubjects` |
| `lib/openai.js` | 597 | OpenAI 兼容流式客户端；HTTP 代理隧道；prefill；后端串行锁；gemma 角色交替修复 | `streamChat`、`listModels`、`withBackendLock`、`OpenAIError`、`MAX_OUTPUT_TOKENS` |
| `lib/ollama.js` | 643 | Ollama 原生 API：探活、模型列表、`think`、`keep_alive`、预加载、释放、启动 | `isOllamaBase`、`localOllamaBase`、`listLocalModels`、`streamChatNative`、`thinkControl` |
| `lib/knowledge.js` | 634 | 资料分块 / 词法检索 / 语义检索 / 向量缓存 / 口语映射 | `chunkText`、`pickChunksSmart`、`knowledgeBlock`、`applyColloquialMap` |
| `lib/search.js` | 299 | 必应搜索与结果解析（同代理） | `searchBing`、`cleanQuery` |
| `lib/vision.js` | 143 | 识图与附图（图片校验、临时切视觉模型） | `describeImage`、`parseImagePayload` |
| `lib/tts.js` | 170 | 朗读合成 + 缓存 | `synthesize`、`speechText`、`ttsCacheKey` |
| `lib/workguard.js` | 92 | 工作时段锁（北京时间 09–12 / 14–18）与本地接口判定 | `workState`、`isLocalEndpoint` |
| `lib/candidates.js` | 111 | 一次生成 N 个候选（截断自动翻倍重抽、清洗角色标记） | `generateCandidates` |
| `lib/export.js` | 427 | 导出训练样本：会话 SFT / DPO 偏好对 / 手写素材（含权重） | `exportTrainingSamples`、`exportPreferencePairs`、`exportScriptSamples` |
| `lib/weights.js` | 92 | 训练样本权重（handwritten 8 / edited 5 / adopted 2 / plain 1，上限 12） | `normalizeWeights`、`applySampleWeights` |
| `lib/trainer.js` | 1147 | 训练队列：导数据→清洗→spawn python→日志→部署；OOM 重排；重启恢复 | `enqueueTraining`、`enqueueScriptTraining`、`queueState`、`deployTraining` |
| `lib/trainlog.js` | 321 | 训练日志索引、GPU 快照、活动进程 | `listTrainRuns`、`gpuSnapshot` |
| `lib/gpu.js` | 436 | 显存/进程探测；训练前停 Ollama / llama-server / ComfyUI，训练后恢复 | `prepareGpuForTraining`、`restoreGpu` |
| `lib/xingye.js` | 887 | 星野分享链接解析、抓取、注册、搜索（有频率控制） | `extractUrls`、`resolveShare`、`fetchOne`、`registerCharacters` |
| `lib/access.js` | 239 | 远程访问口令（环境变量 + Cookie） | `isAuthorized`、`loginPage` |
| `lib/version.js` | 16 | 版本号唯一来源（读 package.json） | `VERSION` |

---

## 5. 一次聊天请求的完整生命周期

以角色模式 `POST /api/chat` 为例（`lib/server.js#handleChat`）。**插件最常插的地方用 🧩 标出**。

1. **读 body**（最多 1MB，附图放宽到 `VISION_IMAGE_MAX + 512KB`）。字段：
   `{ sessionId, content, regenerate?, rejectedReason?, hint?, next?, image?, pinnedReply?, as? }`
2. **取会话**（`getSession`）和角色卡（`listCharacters` 里按 `session.characterId` 找）。
3. 🧩 **`as`（v1.2.2）**：输入框 `/` 选**这个对话里的人物**（多人卡的 cast / 老卡的【人物】标记）
   → 这条消息**以那个角色的身份**发出（用户消息存 `as`）。服务端做四件事：
   ① 历史里这条标成「（陈梦说）…」；② system 的人物名单**拿掉用户演的角色**并说明「你只演其他人物」；
   ③ 历史里模型替用户角色写的话（开场白等）用 `dropAsSpeaker` 摘掉，免得它跟着演；
   ④ 回复只保留其他人物的段落，若只演了用户角色就重抽/报错；⑤ 这一轮**不注入资料库**
   （资料块会把模型拽回"第三人称叙述"）。重抽时从最后一条用户消息的 `as` 还原。
4. **多人判定**：`castOf(character).length >= 2` → 多人模式（分角色输出、分气泡）。
5. **工作时段锁**：云端接口才生效（`isLocalEndpoint` 判本机/内网），
   锁着直接 403，且在写任何消息**之前**拦下。
6. **写用户消息**（除了 `next`（cheats=1 接着演）和 `regenerate`）；`to` 字段记录「这条问谁」。
7. 🧩 **`pinnedReply`**：预选模式，前端挑好的一版直接落盘，不调模型。
8. **开 SSE**（200 + `text/event-stream`），挂客户端断开检测（`req/res` 的 close → `AbortController`）。
9. 🧩 **资料库**：`pickKnowledgeFor` → `pickChunksSmart`（语义优先、失败降级词法）。
10. 🧩 **联网搜索**：`searchPlan(config)`；开着才发请求，结果只进 system 参考层。
11. 🧩 **拼上下文**：`buildMessages(character, messages, CONTEXT_BUDGET, narrative, buildOpts)`
    → `previewContext`（顺序见 §8）。`buildOpts` 里塞了维度/提示/备忘/资料/搜索/thinkOff 等。
12. 🧩 **提示注入**：`withNudge(extra)` 把「换一个走向 / 接着演 / 人称」等要求拼进 system 末尾；
    `rebuild()` 用来整段重建（比如重抽时摘掉常用语）。
13. 🧩 **调模型**：`streamChat({config, messages, onDelta, signal, prefill})`
    → 云端 OpenAI 兼容 / Ollama 原生（think）/ llama-server，逐字回调 `onDelta`。
14. **流式防护**：`detectTailLoop`（紧邻复读）/ `detectDuplicateSentence`（整句复读）命中即断流；
    长时间无新内容（`IDLE_MS`，默认 90s）判定卡住并重试。
15. **质量门**：`replyQuality` 打分，分 ≥4 且还有重试次数 → 发 `reset` 让前端擦掉重打。
16. 🧩 **后处理链**（顺序敏感）：
    `normalizeMarkup`（记号统一）→ `stripRoleLeak` → `sanitizeReply`（清凭空动静/套路）
    → `normalizePerson`（第三人称掰第一人称）→ `normalizeCastSpeaker`（多人前缀归位）
    → `trimToLimit`（字数上限，截掉的进「已否决」）→ 复读截断。
    每次改动都发 `replace` 事件让界面同步成干净版，同时把原文存进消息的 `rejected`。
17. **落盘**：`session.messages.push({role:'assistant', content, at, segments?, sources?, rejected?})`，
    `saveSession`。多人模式额外 `parseReplyLines` 出 `segments`。
18. **收尾**：本地 Ollama 每轮重按一次 keep-alive（原生 `/api/generate`），
    发 `done`，`res.end()`。异常/中止时把已生成部分存下来，`send('done',{aborted:true})` 或 `send('error')`。

### SSE 事件协议

| event | data | 何时 | 前端行为 |
|---|---|---|---|
| `delta` | `{text}` | 每个增量 | 追加到当前气泡 |
| `reset` | `{reason:'empty'\|'quality'\|'stuffed'}` | 判定这一版要作废重来 | 清空气泡重新累计 |
| `replace` | `{text, note?, cleaned?}` | 后处理换成了干净版 | 用 `text` 覆盖气泡，`note` 弹 toast |
| `web` | `{phase:'start'\|'done', ...}` | 联网搜索进度/结果摘要 | 占位 / 失败提示 |
| `done` | `{title?, cleaned?, rejected?, aborted?}` | 正常结束 | 拉取会话整体重绘、挂操作按钮 |
| `error` | `{error}` | 上游报错 | 气泡显示错误、刷新工作锁 |

> 前端不用 `EventSource`（它不支持 POST），而是 `fetch` + 手写 `ReadableStream` 解析
> `event:` / `data:` 行（`public/app.js#streamReply`）。

---

## 6. HTTP API 参考

约定：

- 所有 `/api/*` 除特别说明都是 **JSON 进 JSON 出**；错误统一 `{ error: string }`，状态码 400/401/403/404/409/500/502。
- 请求体超过上限（默认 1MB）会抛「请求体过大」→ 500。
- **同一个请求体只能读一次**（`readBody` 消费流）。外层读过之后，处理器里要复用外层变量，
  不能再读（`/api/script/generate` 就踩过这个坑，代码里有注释）。
- `GET /api/version` → `{version}`（取自 `package.json`；v2.4.1 前连续 8 个版本忘了改，页脚一直显示旧号）。

### 6.0 安全 / 运维 / 评分（v2.4.1 补：这些以前根本没写进文档）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/status` | 口令/2FA 状态（来源 file/env、是否开启）**仅本机** |
| POST | `/api/auth/password` | 改口令（两次输入）**仅本机** |
| POST | `/api/auth/totp/new` | 生成 2FA 密钥 + 二维码矩阵 **仅本机** |
| POST | `/api/auth/totp/enable` | 校验一次验证码后开启 2FA **仅本机** |
| POST | `/api/auth/totp/disable` | 关闭 2FA **仅本机** |
| POST | `/api/data-dir/open` | 在**本机**用 `xdg-open` 打开数据目录（只对本机放开） |
| GET/POST | `/api/rl/labels` · `/api/rl/label` | 日常强化评分的标签读写 |
| POST | `/api/gpu/arbitrate` | 手动触发显存调度 |
| POST | `/api/gpu/restore` | 恢复被临时停掉的显存服务 |
| POST | `/api/quit` | 退出进程（在口令门之后，不是无鉴权） |

> ⚠ v2.4.1 前 `/train.xml`、`/train.json` 在口令门**之前**放行 —— 那是死豁免（public 里没这两个文件），已删除。

### 6.1 配置 / 模型 / 上下文

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/config` | 读/改本机配置。PUT 是**局部更新**；`apiKey: ""` = 不改 Key。`baseUrl` 会校验格式、本地地址必须带端口；`model` 以 `gemma` 开头且地址不是 `:18080` 时**自动改到 llama-server** |
| GET | `/api/context?sessionId=` | 「查看上下文」：返回**真发出去的** system + history + 统计（`characterName/model/baseUrl/temperature/thinkControl/knowledge/webSearch/stats`） |
| GET | `/api/direct/context?sessionId=` | 直连模式的同一件事 |
| GET | `/api/models` | 当前后端的模型列表（本机 llama-server 的也会并进来） |
| GET | `/api/local-models` | 本机 Ollama 模型（附 `backend`，gemma 走 `llama`）+ **云端模型**（`backend:'cloud'`，带 `baseUrl`，DeepSeek 时含 `deepseek-v4-flash`/`deepseek-v4-pro`）；含「支不支持思考」 |
| POST | `/api/switch-model` | 一键切后端：`{model, backend?:'ollama'\|'llama', cloud?:true}`。`cloud:true` 还原上次存的云端配置 |
| GET | `/api/workguard` | 工作时段锁状态 |
| GET | `/api/ollama` / POST `{action}` | Ollama 状态与操作：`on` 启动 / `keep` 常驻 / `auto` 改回 2 分钟 / `preload` 预加载 / `free` 立刻释放显存 |
| GET | `/api/gpu` | `{ollamaUp, ollamaLoaded[], llamaServerUp}` |
| POST | `/api/gpu/unload` | 卸掉本机显存里的 Ollama 模型 |

### 6.2 角色 / 会话

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/characters` | — | `{characters: Character[]}` |
| POST | `/api/characters` | Character（可只给部分字段） | `{character}` |
| DELETE | `/api/characters/:id` | — | `{ok}`（**级联删掉该角色所有会话**） |
| GET | `/api/sessions` | — | `{sessions: SessionSummary[]}`（摘要，不含 messages） |
| POST | `/api/sessions` | `{characterId, greeting?}` | `{session}`；`greeting` 不给就去角色卡上取；多人卡会把开场白的「（名字）」归位成「名字：」 |
| GET | `/api/sessions/:id` | — | `{session}`（含全部 messages） |
| DELETE | `/api/sessions/:id` | — | `{ok, removed}` |
| PATCH | `/api/sessions/:id` | `{title?, action?, ...}` | `{session, removed?}` |

`PATCH` 的 `action`：

| action | 参数 | 作用 |
|---|---|---|
| （无 action，只给 title） | `{title}` | 改标题 |
| `recall` | `{index}` | 撤回：删掉第 index 条及其之后全部 |
| `adopt` | `{index, rejectedIndex}` | 采用「已否决」里的某一版（当前版进否决列表，可来回切） |
| `edit` | `{index, content}` | 人工改写（会打 `editedAt`、`origin:'edited'`） |
| `vetoReason` | `{index, rejectedIndex, tag, on}` 或 `{index, rejectedIndex, reason}` | 给「已否决」的某一版打标签（可多个，如「知识错误」「设定不符」；训练时按标签过滤噪声） |
| `truncateLast` | — | 丢掉末尾所有 assistant 回复（前端随后重新请求生成） |

### 6.3 聊天（SSE）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/chat` | 角色模式，SSE（见 §5） |
| POST | `/api/direct/chat` | 直连模式，SSE；body 同上但无角色 |
| GET/POST | `/api/direct/sessions` | 直连会话列表 / 新建（`{title?}` → `{session}`，`kind='direct'`） |
| POST | `/api/direct/phrases` | 常用语预览：`{text, level}` → `{count, level, block, how}`（措辞只在这里维护一份） |
| POST | `/api/chat/presend` | 预选回复：`{sessionId, content, n?}` → `{ok, candidates[], model}`（不落盘） |
| POST | `/api/chat/suggest` | 「该我说什么」：模型反过来扮演你，给 N 个你可回的话 |
| POST | `/api/gold/generate` | 生成候选组并存盘（训练标准库用）：返回 `{groupId, candidates, context, user, model}` |
| POST | `/api/gold/choose` | `{groupId, index, character?}` 采纳某个候选，其余记负样本 |
| POST | `/api/gold/reject-all` | `{groupId}` 全部否决（全进负样本） |
| GET | `/api/gold/stats` | 标准库统计 |

`/api/chat` 关键行为：

- `regenerate:true`：把末尾的角色回复摘下来（保存到 `droppedMsgs` 以便失败还原），
  `previousReply` 喂回去要求换走向，温度 +0.1。
- `next:true`（cheats=1）：不追加用户消息，让角色接着演；回复**合并**进上一条 assistant
  （避免「末尾两条 assistant」被 OpenAI 兼容接口 400）。
- `image`：`{mime, base64}`，这一轮临时切 `visionModel`，历史里仍只存纯文本。
- `as`：`{name}`，**以本会话人物表里某个角色的身份**发这条消息（v1.2.2；不在人物表里的名字忽略）。
  用户消息记 `as`，发给模型时标成「（名字说）…」，模型只演其他人物；回复会摘掉用户角色的台词。

### 6.4 资料库 / 搜索 / 素材 / 导出

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/knowledge?characterId=` | 每角色一份资料；GET 可带 `query` 做「这一轮会挑中哪几块」的预演；PUT 空文本 = 删 |
| GET/PUT | `/api/knowledge/shared` | 共享资料（直连 + 所有角色都读）。旧名 `/api/direct/knowledge` 保留为别名 |
| POST | `/api/search` | 试搜：`{query, site?:'intl'\|'cn', count?, proxy?}` → `{query, site, results[], notice?, status?}`；失败 502 + 人话错误 |
| POST | `/api/tts` | `{text, voice?}` → 音频流（模型/语速/格式/服务地址全在 `config.tts`；磁盘缓存，缓存命中标 `X-TTS-Cache: disk`） |
| POST | `/api/vision` | 识图：`{image: dataURL或base64, mime?, prompt?}` → `{ok, text, model}`；请求体放宽到图片上限+1MB |
| GET | `/api/export` | 整包备份 JSON（**不含 API Key**） |
| POST | `/api/import` | 合并导入（按 updatedAt 合并，两边都保留），body 上限 50MB |
| GET | `/api/export-training?...` | 导出 QLoRA SFT 样本；`download=1` 直接下载 JSONL |

`/api/export-training` 的 query 参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `sessionId` / `characterId` | 不限 | 只导某个会话 / 某个角色 |
| `maxTokens` | 3072 | 单条样本 token 上限 |
| `histTokens` | 0 | 历史部分 token 上限（0=只导单轮） |
| `minChars` | 12 | 短于这个字数的回复剔除 |
| `withRejected` | `1` | 是否把「已否决」版本导成 DPO 负样本（`0`=不要） |
| `download` | `0` | `1` = 直接返回 `application/x-jsonlines` 附件 |

### 6.5 手写素材（`/api/script/*`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/script` 或 `/api/script/list` | `{scripts: ScriptSummary[]}` |
| GET | `/api/script/get?id=` | 单条完整素材 |
| GET | `/api/script/all` | 全部完整素材（带 turns） |
| POST | `/api/script/create` | `{title}` |
| POST | `/api/script/save` | `{script}` 整份保存 |
| POST | `/api/script/delete` | `{id}` |
| POST | `/api/script/reject` | `{id, rejected:boolean}` 标记参与/剔除训练 |
| POST | `/api/script/generate` | `{id, input, provider:'ollama'\|'llama'\|'api', model?, temperature?, maxTokens?}` → `{text, usage, debug?, provider}` |
| GET | `/api/script/character-system?id=` | 把某个角色的系统提示词取出来（和真实聊天同一套 `buildMessages`），写到素材的 `system` 里 |

`provider` 三条通道的差别：

- `ollama`：Ollama 原生 `/api/chat`（唯一给准确 `prompt_eval_count/eval_count` 的接口）→ 有 token 用量。
- `llama`：llama-server 的**原始** `/completion` + 自己拼 Gemma 模板
  （新版 llama-server 的自动解析器对 Gemma 模板会 400）；服务没起会 `systemctl --user start gemma-server` 并等就绪。
- `api`：`config.baseUrl` 的云端接口（写素材笔力更强）。

### 6.6 训练（`/api/train/*`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/train/session` | `{sessionId, maxTokens?, epochs?, lr?, weights?}` 会话 → 导出清洗 → 入队 |
| POST | `/api/train/script` | `{epochs?, lr?, maxSeqLen?, weights?, base?, autoDeploy?, mixRatio?, mixClaude?, gradAccum?}` 手写素材训练 |
| POST | `/api/train/gold` | 用标准库（gold）起训练 |
| GET | `/api/train/queue` | 队列状态 `{running, currentId, items[]}` |
| GET | `/api/train/status` | `{running, status, step, log[], outPath, archivePath, queue}` |
| GET | `/api/train/runs` | 历史训练日志列表 + GPU 快照 + 活动进程 |
| GET | `/api/train/run?name=` | 某个日志的完整内容 |
| POST | `/api/train/cancel` / `/api/train/remove` | 取消（含正在跑的，会触发下一项）/ 从队列移除 |
| POST | `/api/train/stop` | 停止当前训练 |
| POST | `/api/train/deploy` | `{adapter, version?}` 合并→GGUF→量化→注册（走 llm-chat 的 deploy.sh） |
| GET | `/api/models/versions` | 模型版本注册表（`llm-chat/models/registry/*` + manifest） |

### 6.7 星野抓取 / 其它

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/xingye/status` | `{ok, stats}` 抓取统计 |
| GET | `/api/xingye/cards?query=&limit=200&offset=0` | 已抓角色列表（本地 registry） |
| POST | `/api/xingye/job` | 建抓取任务：`{mode:'links'\|'ids', links?, ids?, autoRegister?, downloadAvatar?}` → `{jobId}`（同一时间只允许一个任务，忙时 409） |
| GET | `/api/xingye/job/:id` | 任务进度与日志 |
| POST | `/api/xingye/register` | `{npcIds}` 把已抓的注册成角色卡 |
| POST | `/api/xingye/search` | `{query}` → `{ok, items[]}` 搜星野角色（远程） |
| GET/DELETE | `/api/xingye/cards/:id` | 看 / 删抓取记录（删除不动已注册角色） |
| GET | `/api/xingye/avatar/:id` | 头像文件 |
| POST | `/api/quit` | 关掉程序（顺带卸载本机 Ollama 模型） |

---

## 7. 数据模型与磁盘布局

```
<数据目录>/
├── config.json                 本机配置（含 API Key；.stignore 排除同步）
├── characters/
│   └── <角色id>.json           一张卡一个文件
├── characters.json.migrated    老版本整包角色文件的迁移留底
├── sessions/
│   └── <会话id>.json           一个会话一个文件
├── knowledge/
│   ├── _shared.md              共享资料（直连 + 所有角色）
│   ├── <角色id>.md             角色专属资料
│   └── .embed-cache-*          语义检索的块向量缓存（本机重算，不同步）
├── scripts/
│   └── <素材id>.json           手写素材（一问一答的完整对话）
├── xingye/
│   ├── registry.json           抓取索引
│   ├── cards/<npcId>.json      星野完整角色卡
│   └── avatars/<npcId>.<ext>   头像原图
├── .stignore                   应用自动维护：config.json / *.tmp / *.migrated / .embed-cache-*
└── （训练队列 **不在**这里：在 llm-chat/data/.train-queue.json，见 lib/trainer.js:32）
```

### Character（角色卡）

```json
{
  "id": "d3d87e516a9c7d2f",
  "name": "陈梦和罗启",
  "avatar": "🌙 或 /api/xingye/avatar/123 或 http(s)://…",
  "tagline": "一句话设定",
  "persona": "人物设定正文（可含【人物】节，老格式）",
  "scenario": "背景场景",
  "greeting": "开场白（会作为会话第一条 assistant）",
  "phrases": "一行一个口头禅，也支持逗号",
  "voice": "这个角色专用的 TTS 音色（留空=全局）",
  "dims": [{ "name": "动作", "level": 2 }],
  "hint": "这个角色专用的『特点提示词』",
  "cast": [{ "name": "陈梦", "desc": "…" }, { "name": "罗启", "desc": "…" }],
  "createdAt": 1790000000000,
  "updatedAt": 1790000000000
}
```

- `saveCharacter` 的合并语义：**没传的字段沿用旧值**，显式传 `""` 才是清空
  （曾因为整体覆盖把开场白清掉过）。
- 多人模式：`cast.length >= 2` 即启用；也兼容老卡的 `persona` 里写 `【人物】` 标记（`parseCast`）。
- 最大 8 个人物、名字 12 字、设定 800 字（`normalizeCast`）。

### Session（会话）

```json
{
  "id": "716b26154054ee37",
  "characterId": "…",          // 直连会话没有
  "kind": "",                  // '' / 'direct'
  "title": "新的对话",
  "createdAt": 0, "updatedAt": 0,
  "messages": [ Message, … ]
}
```

`Message` 的字段（按需出现）：

| 字段 | 谁写 | 含义 |
|---|---|---|
| `role` | — | `user` / `assistant` |
| `content` | — | 全文（多人消息也保留全文，训练/复制/朗读都用它） |
| `at` | — | 时间戳 |
| `segments` | 服务端（多人） | `[{speaker, text}]`，前端按人物分气泡 |
| `sources` | 服务端（联网搜索） | `[{title, url}]` |
| `rejected` | 服务端 | 被否决/清理前的版本 `[{text, reason, source, at}]`，最多 5 条 |
| `as` | 服务端（`/` 身份发送） | 这条用户消息是以哪个人物的身份说的 |
| `to` | 服务端 | 用户这条是指定谁回答的 |
| `editedAt` / `origin` | 服务端（人工改写/采纳） | 训练权重用：`edited` / `adopted` / `presend` / `gemma` / `api` / `multi` … |
| `adoptedAt` | 服务端（采纳否决版本） | — |

`normalizeMessages` 会把「末尾两条连续 assistant」合并（OpenAI 兼容接口会直接 400）。

### Script（手写素材）

```json
{
  "id": "04cc75eb18ada7db",
  "title": "电车美女·日常（api）-1",
  "system": "完整系统提示词（可以用 /api/script/character-system 从角色卡生成）",
  "turns": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }],
  "origin": "api",             // handwritten / api / gemma / multi
  "autoGen": false,
  "rejected": true,            // 可选：人工剔除，不参与训练
  "createdAt": 0, "updatedAt": 0
}
```

### config.json 全字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiKey` | `''` | 也可用环境变量 `OPENAI_API_KEY` |
| `baseUrl` | `https://api.deepseek.com/v1` | 也认 `OPENAI_BASE_URL` |
| 模型别名 | — | `deepseek-v4-flash` → 实际 id `deepseek-flash`（`lib/openai.js#resolveModelId`）；`/api/models` 会把别名并进下拉 |
| `reasoningEffort` | `high` | 推理强度：`none`/`low`/`high`/`max`；请求体带 `reasoning_effort`（只对云端）。云端思考过程从 `delta.reasoning_content` 收集，存进消息的 `reasoning` 字段 |
| token 用量 | — | 云端流式带 `stream_options:{include_usage:true}` 拿 usage；本地原生拿 `prompt_eval_count/eval_count`；取不到按字数估算。存进消息的 `usage` 字段（`input/output/reasoning/cached/total`），SSE 有 `event: usage`；前端操作栏胶囊 + 聊天下方状态条 |
| `model` | `deepseek-flash` | 也认 `OPENAI_MODEL` |
| `temperature` | `0.85` | |
| `proxy` | `''` | 只支持 HTTP 代理（Clash mixed 端口即可）；聊天和搜索都走它 |
| `workGuard` | `true` | 工作时段锁，只对云端接口生效 |
| `extraBody` | `''` | JSON 字符串，原样铺进请求体（负 seed 会被丢掉） |
| `thinkOff` | `false` | Qwen3 → system 加 `/no_think`；R1 → 请求体 `think:false` |
| `narrative` | `''` | 叙事推进指令，**默认不注入** |
| `dims` | `null` | 全局默认维度图 `[{name, level 0-10}]` |
| `hint` / `hintPresets` | `''` / `[]` | 全局默认微调提示 / 提示预设（≤20 条） |
| `synonyms` / `synonymsOutput` | `''` / `false` | 等义词表；`#输出` 标记的才进输出侧 |
| `memo` | `''` | 场景备忘（≤800 字） |
| `maxChars` | `0` | 回复字数上限（0=不限，上限 2000） |
| `autoClean` | `true` | 自动清「凭空动静」 |
| `forceAction` | `true` | 「动作开头」prefill |
| `cleanHistory` | `true` | 发送前清洗历史（只改发出去的，不改存档） |
| `autoPair` | `true` | 输入框自动补括号 |
| `maxTries` | `2` | 质量门最多重试次数（1–3）。**v2.4.1 前 getConfig 从不返回它 → 恒为 2** |
| `knowledgeChars` | `500` | 资料注入上限（0–8000，v2.3.28 从 2000 提上来；单块最多 260 字、topK ≤ 20） |
| `knowledgeSemantic` | `false` | 语义检索（**v2.3.1 起默认关**，默认走词法）；开了失败自动降级词法 |
| `knowledgeThreshold` | `0.5` | 相似度阈值（0–0.9） |
| `knowledgeEmbedModel` | `qwen3-embedding:0.6b` | 本机 Ollama 的 embedding 模型 |
| `knowledgeMap` | `''` | 口语→术语映射（每行 `词=意思`） |
| `directPhrases` / `directPhraseLevel` | `''` / `4` | 直连模式唯一会注入的常用语 |
| `directDims` / `directHint` / `directMemo` / `directMaxChars` | — | 直连模式自己的那份 |
| `tts` | `{}` | `{baseUrl, apiKey, model, voice, speed, format, auto}` |
| `keepAlive` | `null` | Ollama keep-alive（不干预）；`'2m'` 之类由用户设，`-1` = 常驻 |
| `visionModel` | `qwen2.5vl:3b` | 识图/附图用的本机视觉模型 |
| `webSearch` / `webSearchSite` / `webSearchCount` / `webSearchChars` | `false` / `intl` / `5` / `1600` | 联网搜索 |
| `fullSystem` | `false` | 本地后端也用完整 system（v2.3.33；与 `compactSystem` 互斥） |
| `compactSystem` | `false` | 极简 system（v2.3.36）；系统提示词压到约 400~1500 字，给未微调基座模型 |
| `systemInUser` | `false` | 设定塞进最后一条 user 消息（v2.3.40） |
| `qualityGate` | `true` | 质量门：关掉 = 只生成一次、不重抽（v2.3.35） |
| `repeatPenalty` | `1.1` | 本地模型重复惩罚（0.9–2；v2.3.37 从写死 1.3 改成可配） |
| `thinkOff` / `thinkForce` | `false` | 关 / 强制开思考；v2.4.1 起关思考按 `/api/show` 能力探测决定发不发 `think:false` |
| `l1TopicPick` | `false` | 常驻知识按话题分段注入（**v2.4.1 前从未生效**，配置里根本没这个字段） |
| `contextWindow` | `0` | 本地 Ollama `num_ctx`（**v2.4.1 前根本没发给 Ollama**） |
| `reasoningEffort` | `'high'` | `reasoning_effort`，**只对云端生效**；本地后端在 UI 上灰掉 |
| `savedCloud` | `null` | 从云端切到本地时自动存的云端配置，切回来用 |

> 读配置一律走 `getConfig()`（它会补默认值 + 环境变量回退），**不要直接读文件**。

---

## 8. 提示词管线

### 8.1 入口

| 函数 | 用途 |
|---|---|
| `previewContext(character, history, budget, narrative, opts)` | **唯一真源**：算出这次实际发出去的 `messages` + `stats` |
| `buildMessages(...)` | 就是 `previewContext(...).messages`（聊天和「查看上下文」共用，保证预览不撒谎） |
| `directMessages(history, budget)` | 直连模式：零 system，只裁历史 + 去掉开头的 assistant |

`opts` 关键字段：`cleanHistory, dims, hint, synonyms, synonymsOutput, memo, maxChars, knowledge, noKnowledge, search, searchChars, skipPhrases, thinkOff, cast`。

### 8.2 组装顺序（`previewContext`）

1. 资料块 `knowledgeBlock(chunks)` 和搜索块 `webSearchBlock(results)` 先算出来，
   **从历史预算里扣掉**（`histBudget = max(600, budget - kBlock - sBlock)`）。
2. 历史按字符预算从新到旧裁剪（`trimHistory`）。
3. `cleanHistory`（若开）：把历史里的套路/凭空动静在**发出去之前**擦掉（不改存档）。
4. `systemPrompt(...)` 拼 system（单卡 / 多人两套顺序，见下）。
5. 等义词块拼在最末尾（脚注性质，吃到「越靠后越被当回事」）。
6. `thinkOff` → 末尾追加 `/no_think`（Qwen3 这代实测唯一有效）。
7. 输出 `[{role:'system'}, ...history]`。

### 8.3 单卡 system 顺序

`身份（你现在扮演「X」…）` → `一句话设定` → `人物设定` → `背景场景` → `常用词/口头禅`（频率由「常用词」维度控制）
→ **扮演要求 1–10**（第一人称、不出戏、（）环境、动作克制、主动推进、人称规则、像在说话不是写小说、不支配对方身体…）
→ `叙事推进`（有才加）→ `【描写幅度】`（维度块）→ `特点提示词` → `资料库`（挑中才有；非空但没挑中会给「本轮没有资料」）
→ `【网页搜索结果】` → `场景备忘` → `【字数上限】`。

### 8.4 多人 system 顺序

> 注意：多人模式下发模型的历史里会**去掉开场白**（`dropMultiOpener`）——
> 开场白通常是单人一句话（「陈梦：你好…」），留着会把模型锚成"整段只有一个人说话"。


`一句话设定` → `castPromptBlock`（人物表 + 10 条多人规则 + 6.1，含「名字：内容」格式；`opts.castPlan` 决定这一轮点名谁开口）
→ `背景场景` → `常用词` → `叙事推进` → `【描写幅度】` → `特点提示词` → `资料库` → `网页搜索`
→ `【字数上限】` → `场景备忘`。

### 8.5 多人回复解析

- `parseReplyLines(text)`：按行首「名字：」切 `[{speaker, text}]`；认不出来就整段
  `speaker:''`（保证不丢内容）。
- `normalizeCastSpeaker(text, cast)`：把行首「（cast 里的名字）」改回「名字：」——
  老卡开场白是「（陈梦）你好…」，模型会照着历史学坏（v1.2.0 修复，三处调用：
  建会话开场白、每轮历史、落盘前）。
- 前端：`msg.segments` 存在就按人物分气泡，同一人物固定一个颜色（6 色轮换）。

### 8.6 维度图

`DEFAULT_DIMS` / `clampDimLevel` / `dimsBlock`：档位 0–10，0 与 10 有专门的反向/强化措辞；
「环境 0」会把第 3 条规则改写成「这一次不要写环境描写」（否则小模型只听前半段）。

---

## 9. 模型后端适配

`lib/openai.js#streamChat` 一个入口适应三类后端：

| 后端 | 判定 | 路径 | 注意点 |
|---|---|---|---|
| 云端 / 任意 OpenAI 兼容 | 默认 | `POST {baseUrl}/chat/completions` | 走 `proxy` 的 CONNECT 隧道（`lib/openai.js#connectTunnel`，`lib/search.js` 复用） |
| Ollama 原生 | `isOllamaBase(config)` 探活 `/api/tags`（60s 缓存） | `POST /api/chat` | **只有原生接口认 `think:false`**；`/v1` 会丢掉这个字段（实测思考 47s、正文空） |
| llama-server（gemma GGUF） | 本机但不是 Ollama | `POST /v1/chat/completions` | 并发会互踢 → `withBackendLock` 按 baseUrl（去掉 `/v1`）串行；不认 `keep_alive/think`，硬发会 ECONNRESET |

其它要点：

- **`agent: false`**：Node 默认 keep-alive 复用死连接会 ECONNRESET（`accLen: 0`）。
- **流结束时的 ECONNRESET**：已经吐过内容就容忍（当正常结束），继续走收尾。
- **gemma 模板强制 user/assistant 交替**：发之前把 system 提到最前、合并连续同角色、
  去掉开头的 assistant（`needAlt = /gemma/i.test(model)` 或 `config.strictAlternation`）。
- **prefill**（动作开头/附图）：末尾追加一条 assistant 前缀；`makePrefixJoiner` 处理
  「有的服务端把前缀回显、有的只回续写」两种行为。
- **`MAX_OUTPUT_TOKENS = 2200`**：上限保护。
- **`thinkOn` 分派**：`thinkControl(config)` 给前端显示这一轮实际怎么关的；
  Qwen3 → system `/no_think`，R1 → 请求体 `think:false`，Gemma → 原生 `think:false`。
- **Ollama keep-alive**：OpenAI 兼容端点忽略该字段，所以每轮生成后用原生 `/api/generate`
  重按一次（`server.js` 收尾处）。
- **模型名以 `gemma` 开头**：`PUT /api/config` 会自动把 baseUrl 切到 `:18080`；
  想用 Ollama 里的 gemma 模型要走 `POST /api/switch-model {backend:'ollama'}`。

---

## 10. 前端结构

### 10.1 页面骨架（`public/index.html`）

```
.app
├── aside.sidebar
│   ├── header（logo + ⚙）
│   ├── .tabs：角色 / 会话 / 直连 / 手写 / 星野（data-tab）
│   ├── .tab-panel#panel-characters   #character-list + 新建按钮
│   ├── .tab-panel#panel-sessions     #session-list
│   ├── .tab-panel#panel-script       #script-list（手写素材）
│   ├── .tab-panel#panel-direct       #direct-list
│   ├── .tab-panel#panel-xingye       星野搜索 / 任务进度 / 已抓列表
│   └── #status-line
└── main.main
    ├── header.chat-head（头像/名字/一排图标按钮）
    ├── #messages（消息容器，多气泡由渲染函数拼）
    ├── #lock-bar / #attach-bar
    ├── form#composer
    │   ├── #composer-chips（/ 身份胶囊）
    │   └── .composer-main（图标 + #input + 发送）
    └── #slash-pop（/ 弹出的角色列表）
```

弹窗（都是 `.modal-mask` + `.modal`）：`#character-modal`、`#settings-modal`、
`#confirm-modal`、`#context-modal`、`#veto-modal`、`#dims-modal`、`#know-modal`、
`#phrases-modal`、`#xy-links-modal`、`#xy-detail-modal`，外加全局 `#toast`。

### 10.2 `public/app.js` 结构

`state`（全局状态）关键字段：`characters / sessions / activeCharacterId / activeSessionId /
mode('character'|'direct') / directSessions / activeDirectId / messages / streaming / abort /
shutDown / config / work / dims / hint / memo / maxChars / pendingImage / xingye`。

基础工具（插件可以直接抄）：

| 函数 | 作用 |
|---|---|
| `api(path, options)` | `fetch` 封装：JSON 进出，非 2xx 抛 `Error(data.error)` |
| `toast(msg, isError)` | 顶部提示条 |
| `escapeHtml(s)` | 拼 HTML 时必须用（项目里所有用户内容都走 textContent/它） |
| `avatarMark(character)` / `isImageAvatar` / `bindAvatarFallback` | 头像（emoji 或图片，图片 404 回退首字） |
| `scrollBottom()` | 滚到最新 |

功能分区（按文件中出现顺序）：

| 区 | 关键函数 |
|---|---|
| 角色列表 / 编辑 | `renderCharacters`、`openCharacterModal`、`submitCharacter`、`removeCharacter`、`fillCastForm`、`syncCastUi` |
| 设置 / 切模型 | `openSettings`、`loadModels`、`loadLocalModels`、`switchToLocalModel`、`switchToCloud`、`submitSettings` |
| 会话 | `selectCharacter`、`newSession`、`openSession`、`showEmptyState` |
| 直连 | `enterDirectMode`、`newDirectSession`、`openDirectSession`、`renderDirectSessions` |
| 常用语 | `openPhrases`、`renderPhrasesPreview`、`savePhrases` |
| 查看上下文 | `openContext`、`openDirectContext`、`ctxBlock` |
| 朗读 | `testTts`、`speakMessage`、`autoSpeakLast` |
| Ollama 控制 | `renderOllama`、`refreshOllama`、`ollamaAction`、`thinkState`、`toggleThink` |
| 联网搜索 | `updateWebSearchButton`、`toggleWebSearch`、`testWebSearch`、`attachSources` |
| 资料库 | `openKnowledge`、`saveKnowledgeText`、`previewKnowledge` |
| 消息渲染 | `renderMessages`、`createMessageEl`、`appendMessageEl`、`attachActions`、`renderMultiMessage`、`metaText`、`castColor` |
| 维度 / 提示 / 备忘 | `openDims`、`renderDims`、`applyDims`、`saveMemo`、`renderPresets` |
| 否决 / 撤回 / 改写 | `renderVeto`、`adoptRejected`、`tagRejected`、`recallFrom`、`startEdit`、`regenerate` |
| 聊天 | `sendMessage`、`sendDirectMessage`、`streamReply`（SSE 客户端）、`stopStreaming` |
| 输入框 | `attachAutoPair`、`autoResize`、`updateSendState`、`updatePlaceholder`、`syncSlashPop`、`applySlash` |
| 识图 / 附图 | `describePickedImage`、`attachPickedImage`、`shrinkImage`、`renderAttachBar` |
| 训练面板 | `openTrainPanel`、`pollTrain`、`trainFromSession`、`openCandidatePanel` |
| 同步 | `exportBackup`、`importBackup` |
| 事件绑定 | `bindEvents()`（一个大函数，所有 UI 事件都在这） |
| 启动 | `boot()`（先 `refreshConfig` → workguard → characters → sessions → direct → 选第一个角色） |
| 斜杠命令 | `refreshAsChip`、`setAsPick`、`clearAsPick`、`currentSlashTrigger`、`renderSlashPop`、`moveSlash`、`applySlash` |
| 星野面板 | 文件末尾一大段（`renderXingye*`、`startPollingXingyeJob`、`xingyeRegister/Remove`） |

### 10.3 消息渲染约定

- 一个消息 = `.msg.<role>`（`user`/`assistant`），里面 `.bubble` + `.meta`，最后挂 `.msg-actions`。
- 多人消息额外 `.msg.assistant.multi`，里面是多个 `.bubble.cast-bubble`，每个带 `.cast-name`。
- `.msg-actions` 里的按钮靠 `dataset.act` 分发：`edit / speak / dims / regen / cands / veto / recall`。
- 渲染一律用 `document.createElement` + `textContent`（**不要**用 innerHTML 拼用户内容，XSS 口子）。

### 10.4 纯逻辑模块（可在 Node 里单测）

| 文件 | 导出 | 说明 |
|---|---|---|
| `public/autopair.js` | `applyAutoPair`、`applyBackspacePair` | 括号自动补全 |
| `public/uistate.js` | `sendButtonState` | 发送键状态（正常/停止/禁用） |
| `public/cheat.js` | `parseCheat`、`describeCheat` | `cheats=1`（接着演）、`quit`（关程序） |
| `public/slashpick.js` | `slashTrigger`、`filterCharacters`、`conversationSpeakers` | `/` 触发判定、按查询词过滤、**本会话人物表**（cast / 【人物】标记 / 单角色回退） |

---

## 11. 训练 / 素材工具链

工作台自己不训练，它是**调度器**：数据导出 → 清洗 → 拼命令行 → `spawn` 外部
`llm-chat` 工程（默认 `/home/don0ox1/deepseek/llm-chat`，可用 `LLM_CHAT_DIR` 覆盖）。

```
🧠 会话训练 / 手写素材训练 / gold 标准库
        │
        ├─ lib/export.js        导出 SFT / DPO / 手写样本，按 origin 加权
        │   权重：handwritten 8 / edited 5 / adopted 2 / plain 1（MAX_WEIGHT 12）
        │   来源判定：会话导出 → 手改过的 = edited、采纳候选 = adopted、其余 = plain；
        │   手写素材导出 → 只有 origin 是 handwritten（或没标）的 = handwritten，其余一律按 adopted
        ├─ lib/trainer.js       入队（<data>/.train-queue.json）→ 串行跑
        │   状态：queued / running / done / error / canceled
        │   可选混入 Claude 文风数据：mixClaude + mixRatio（claude-imitation/runs/claude-style/sft.jsonl）
        ├─ lib/gpu.js           训练前停 Ollama/llama-server/ComfyUI 腾显存，训练后恢复
        └─ train_qlora.py       （llm-chat）4-bit NF4 + LoRA → ckpt/<run>/final
              ↓ POST /api/train/deploy 或 autoDeploy
           llm-chat/deploy.sh：合并 → bf16 GGUF → Q4_K_M → models/registry/<版本>/
              ↓
           ollama create <版本>（Modelfile 模板在 llm-chat）
```

- 训练日志：`llm-chat/logs/*.log`；`/api/train/runs` 直接读文件，不依赖进程状态
  （服务重启后队列会 `resumeQueue` 自动接着跑）。
- **训练控制台**：训练一开始 `lib/trainer.js#openTrainConsole()` 自动用 ptyxis/xterm 弹
  `tools/train-console.mjs`（显存余量 / 训练数据 / 实时日志），也能手动
  `POST /api/train/console` 或在 `/train.html` 点「🖥 控制台」。
- 监控页：`public/train.html`；素材人工挑选页：`public/review.html`（`/api/script/reject`）。
- 产物目录默认在 4TB 盘：`/mnt/data4t/ai-models/training/`（ckpt / build / models）；
  `llm-chat` 目录只留代码。
- **多人模式的训练配方**（v1.3.0，gemma3-12b-rp4 采用 / rp7 备选）：
  用 DeepSeek API 造多人物对话（`gen-multi*.py`，`reasoning_effort:'none'` 省 token），
  每轮必须让 2 个人物各说一句、动作用（）；单角色样本抽 260 条做锚，
  多人样本过采样 ×2 且只保留「≥80% 回合有 2 人说话」的行；
  训练 2 epochs、lr 7e-5，部署时 Modelfile 加 `repeat_penalty 1.08`。
  实测 rp4（seq 2048，686 行）综合最好：双人卡 7/7 轮两人说话、37~61 字、3.2s；
  20 轮 soak 后仍 20/20 双人说话、0 复读、2.3s（不随轮次退化）；
  rp7（seq 1792，只保留双人+每轮两人，485 行）双人卡同为 7/7 但 4.5s、三人卡回 180 字过长，
  作为"更爱两人一起说"的备选（`ollama run gemma3-12b-rp7`）。
- 版本控制约定（本项目一直这么做）：每次训练/功能改动都往
  `llm-chat/xingye-patches/` 放一个 `releases/<日期>-<版本>/` 补丁包 + 更新 CHANGELOG，
  推 `git@github.com:dxy1151/qlora-.git`。**只存代码，不存模型/适配器/GGUF。**

---

## 12. 插件开发指南

> 现状：**项目还没有插件加载器**（没有 `plugins/` 目录、没有 hook 注册表）。
> 所以「写插件」= 在既有结构上加一层，尽量少碰核心文件。下面给出三种粒度和
> 建议的接入点，最后有一个可运行的最小例子。

### 12.1 先选粒度

| 粒度 | 改动范围 | 适合 |
|---|---|---|
| **A. 纯前端插件** | 只加 `public/plugin-xxx.js` + 在 `index.html` 加一个 `<script type="module">` | 换肤、快捷按钮、消息后处理显示、导出聊天记录、外挂翻译 |
| **B. 后端 + 前端（推荐）** | 新增 `lib/plugins/xxx.js`，在 `route()` 里注册 3–5 行；前端同上 | 新数据源、新模型后端、新 API、新面板 |
| **C. 深度集成** | 改 `handleChat` / `streamReply` 等核心流程 | 改提示词/质量门的插件（谨慎，容易被上游改动撞到） |

### 12.2 后端插件骨架（推荐做法）

新建 `lib/plugins/<name>.js`，导出 `NAME` 和处理函数：

```js
// lib/plugins/hello.js
// ⚠ 前置改动：把 lib/server.js 里的 sendJson / readBody 改成 export（见本节末尾）
import { sendJson, readBody } from '../server.js';

export const NAME = 'hello';

/**
 * 处理属于本插件的路由。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {string} method
 * @returns {Promise<boolean>} true = 已经处理并写完响应；false = 不是我的路由
 */
export async function handle(req, res, url, method) {
  if (url.pathname === '/api/plugin/hello/ping' && method === 'GET') {
    sendJson(res, 200, { ok: true, pong: Date.now() });
    return true;
  }
  if (url.pathname === '/api/plugin/hello/echo' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    sendJson(res, 200, { ok: true, echo: body });
    return true;
  }
  return false;
}
```

然后在 `lib/server.js#route()` 的最后（`sendJson(res, 404, …)` **之前**）挂上：

```js
  // --- 插件路由 ---
  if (await helloPlugin.handle(req, res, url, method)) return;

  sendJson(res, 404, { error: '未知接口' });
```

顶部 `import * as helloPlugin from './plugins/hello.js';`。
插件多了就写个 `loadPlugins()` 扫描 `lib/plugins/*.js`（`fs.readdir` + 动态 `import()`，缓存住），
循环调用、谁先返回 `true` 谁负责。

约定（强烈建议遵守，否则插件多了会互相打架）：

- **路径命名空间**：`/api/plugin/<name>/*`，不要占用 `/api/*` 一级名字。
- **数据目录**：`<数据目录>/plugins/<name>/`（自己 `fs.mkdir -p`），不要往 characters/sessions 里混。
- **配置**：不要往 `config.json` 顶层塞字段（会和 `getConfig()` 的默认值/前端表单打架）。
  在 `<数据目录>/plugins/<name>/config.json` 里存自己的配置；要出现在设置页就自己加弹窗。
- **`readBody` 只能读一次**：请求流是一次性的。插件自己读没问题，但**外层已经读过的地方**
  （比如 `/api/script/*` 那个大块）不能再读，必须复用外层变量。
- **SSE 插件**：先 `writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive'})`，
  再 `res.write('event: delta\ndata: {...}\n\n')`，最后 `res.end()`。**写完头就不能再 sendJson**。
- **错误**：处理器内部 try/catch，业务错误回 400/409 + `{error}`，别让 `route()` 兜 500。
- **幂等**：GET 不改状态；POST 重复执行不该产生重复数据（或明确报 409）。
- **不要阻塞事件循环**：重活 `spawn` 子进程（参考 `trainer.js`），不要同步读大文件。

> **`sendJson` / `readBody` 目前是 `lib/server.js` 的模块内函数，没有导出。**
> 二选一：
> ① 在 server.js 里给这两个函数加 `export`（一行改动，最省事，推荐）；
> ② 插件自己实现：`sendJson` 就 4 行（`JSON.stringify` + `writeHead` + `end`），
> 读 body 就是 `for await (const chunk of req)` 拼 Buffer 再 `JSON.parse`。
>
> 注意：插件 `import '../server.js'` 会形成**循环依赖**。ESM 允许循环引用，
> 函数声明（`sendJson`/`readBody` 都是）在模块实例化阶段就可用，所以调用时没问题；
> 但**不要在插件模块顶层**去读 server.js 里用 `const` 定义的量（那时还没初始化，会 TDZ 报错），
> 要用就放进 `handle()` 函数体里。

### 12.3 前端插件骨架

```html
<!-- index.html，在 </body> 前 -->
<script type="module" src="/plugin-hello.js"></script>
```

```js
// public/plugin-hello.js
const $ = (s) => document.querySelector(s);
const api = async (path, opt = {}) => {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opt });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
};

// 1) 在聊天头部加一个按钮（chat-head 是 flex，插哪都行）
const btn = document.createElement('button');
btn.className = 'icon-btn';
btn.title = '我的插件';
btn.textContent = '🧩';
btn.addEventListener('click', async () => {
  const r = await api('/api/plugin/hello/ping');
  alert(`插件通了：${JSON.stringify(r)}`);
});
$('.chat-head')?.appendChild(btn);

// 2) 监听聊天完成（index.html 目前没有抛事件 → 用 MutationObserver 观察 #messages）
const messages = $('#messages');
new MutationObserver(() => {
  const last = messages.querySelector('.msg.assistant:last-child .bubble');
  if (last) console.log('[plugin] 新回复：', last.textContent.slice(0, 40));
}).observe(messages, { childList: true, subtree: true });

// 3) 输入框回车前拦截/改写的例子
$('#input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    const v = $('#input').value;
    if (v.startsWith('!tr ')) {           // 自定义命令：!tr 文本
      e.preventDefault();
      e.stopImmediatePropagation();       // 抢在 app.js 的发送之前
      $('#input').value = '';
      api('/api/plugin/hello/echo', { method: 'POST', body: JSON.stringify({ text: v.slice(4) }) });
    }
  }
}, true);   // 捕获阶段，才能抢在 app.js 的监听前
```

> 前端插件要注意：`app.js` 里的内部函数（`api`、`toast`、`state`…）**没有挂到 `window`**。
> 想要复用，最干净的做法是改成 `public/app.js` 末尾加一句
> `window.WB = { state, api, toast, escapeHtml, renderMessages, get messages(){…} };`
> （一行改动，比复制粘贴工具函数好维护）。

### 12.4 可插点清单（按「改哪个函数」）

| 想插什么 | 位置 | 说明 |
|---|---|---|
| 新 API | `lib/server.js#route()` 末尾 | 见 12.2 |
| 新页面 | `public/xxx.html` | `serveStatic` 自动能访问 `/xxx.html`（无鉴权以外限制） |
| 新设置项 | `public/index.html` 的设置表单 + `lib/server.js#PUT /api/config` + `lib/store.js#getConfig` | 三处要同步，否则刷新后丢 |
| 系统提示词注入 | `handleChat` 的 `buildOpts` / `buildSystem(extra)` | 加字段或在 `withNudge` 里追加一段；**别拼进用户消息**（模型会当台词） |
| 回复后处理 | `handleChat` 第 16 步之后、落盘之前 | 参考 `normalizeCastSpeaker` 的写法：改了就进 `rejectedExtra` 并 `send('replace')` |
| 新的模型后端 | `lib/openai.js#streamChat` | 加分支 + 探活；注意 `withBackendLock` 串行、`agent:false` |
| 新的资料源 | `handleChat` 里 `pickKnowledgeFor` 之后 | 结果塞进 `buildOpts.knowledge`（会从历史预算里扣字数） |
| 新消息按钮 | `public/app.js#attachActions` + `bindEvents` 的 `dataset.act` 分发 | 加 `act` 名 + 处理逻辑 |
| 新输入框命令 | `public/app.js` 输入框 keydown / `slashpick.js` | 现有例子：`cheats=1`、`quit`、`/` 身份发送 |
| 新侧栏 tab | `index.html` `.tabs` + `.tab-panel`；`app.js#bindEvents` 的 `.tab` 点击处 | 参考 `data-tab="script"` |
| 新训练数据来源 | `lib/export.js` | 产出 `{messages:[...]}` 行 + `origin`（决定权重） |
| 新 TTS / 视觉 / 搜索 | `lib/tts.js` / `lib/vision.js` / `lib/search.js` | 都是独立模块，替换实现即可 |
| 聊天完成事件 | 目前无事件 → 建议在 `streamReply` 的 `finally` 里 `window.dispatchEvent(new CustomEvent('wb:chat-done', {detail:{session, messages}}))` | 插件监听它比 MutationObserver 干净 |

### 12.5 最小可运行插件（完整例子）

目标：聊天头部加一个 🧩 按钮，点了让后端数一下当前会话有多少条消息。

**① 前置：让 `lib/server.js` 导出两个工具**（顶部函数各加一个 `export`）

```js
export function sendJson(res, status, data) { … }
export async function readBody(req, maxBytes = 1024 * 1024) { … }
```

**② `lib/plugins/count.js`**

```js
import { getSession } from '../store.js';
import { sendJson, readBody } from '../server.js';

export const NAME = 'count';

export async function handle(req, res, url, method) {
  if (url.pathname !== '/api/plugin/count' || method !== 'POST') return false;
  const body = await readBody(req).catch(() => ({}));
  const session = await getSession(String(body.sessionId || ''));
  if (!session) {
    sendJson(res, 404, { error: '会话不存在' });
    return true;
  }
  sendJson(res, 200, {
    ok: true,
    count: session.messages.length,
    title: session.title,
    speakers: [...new Set(session.messages.flatMap((m) => (m.segments || []).map((x) => x.speaker)).filter(Boolean))],
  });
  return true;
}
```

**③ `lib/server.js#route()` 末尾注册**

```js
import * as countPlugin from './plugins/count.js';
// …
if (await countPlugin.handle(req, res, url, method)) return;
```

**④ `public/plugin-count.js`**，并在 `index.html` 的 `</body>` 前加
`<script type="module" src="/plugin-count.js"></script>`

```js
const $ = (sel) => document.querySelector(sel);

const btn = document.createElement('button');
btn.type = 'button';
btn.className = 'icon-btn';
btn.title = '数一数这个会话';
btn.textContent = '🧩';
btn.addEventListener('click', async () => {
  // 会话 id 从 app.js 暴露的状态里拿（见下一段「一行改动」）
  const sid = window.WB?.state?.activeSessionId;
  if (!sid) return alert('先打开一个会话');
  const res = await fetch('/api/plugin/count', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sid }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || `请求失败（${res.status}）`);
  alert(`「${data.title}」共 ${data.count} 条消息${data.speakers.length ? `，出场人物：${data.speakers.join(' / ')}` : ''}`);
});

$('.chat-head')?.appendChild(btn);
```

**那行「一行改动」**：在 `public/app.js` 最末尾（`boot();` 之前或之后都行）加

```js
// 给外部插件用的最小接口（刻意只暴露只读状态 + 几个工具函数）
window.WB = { state, api, toast, escapeHtml, avatarMark };
```

之后所有前端插件都能 `window.WB.state` / `window.WB.api(...)`，不用复制工具函数。

### 12.6 插件作者必须知道的坑

1. **`readBody` 只能读一次**，外层读过就没了（`/api/script/generate` 的注释就是这个坑）。
2. **SSE 一旦 `writeHead(200, event-stream)`**，后面就只能 `res.write` / `res.end`，
   不能再 `sendJson`；异常时发 `event: error`。
3. **前端 `hidden` 属性会被 `display:flex` 覆盖**：项目里凡是 `display:flex/grid` 的容器
   都额外写了 `[hidden]{display:none}`（新加容器记得照做）。
4. **别在聊天里拼用户消息当提示**：模型会把提示当台词念出来。提示一律进 system
   （参考 `handleChat` 的 `withNudge`）。
5. **发 gemma 的 messages 要做角色交替**：否则 `Conversation roles must alternate` 400。
6. **本机 llama-server 并发会 ECONNRESET**：走 `withBackendLock`，key 用「去掉 `/v1` 的 baseUrl」。
7. **Node 默认 keep-alive 复用死连接**：HTTP 客户端要 `agent:false`。
8. **数据目录可能被 Syncthing 同步**：一个对象一个文件、`config.json` 在 `.stignore` 里；
   插件别写大文件到数据根目录（会拖慢同步），要缓存就放 `plugins/<name>/` 并建议加进 `.stignore`。
9. **字符预算**：`CONTEXT_BUDGET = 7200` 字符，资料/搜索块会从历史预算里扣；插件注入内容
   一定要限量，否则本地 8K 上下文的模型会被撑爆。
10. **别直接读/写 config.json**：走 `getConfig()/saveConfig()`，它会补默认值、
    处理 `apiKey:''`（不改 Key）和 `savedCloud`。
11. **Windows/安卓兼容**：路径用 `path.join`；别用 `/tmp` 硬编码；别假设有 shell。
12. **桌面环境别乱停服务**：训练相关（`gpu.js`）会停 Ollama/llama-server，插件别自己 `pkill`。

### 12.7 发布流程（和本项目现有约定一致）

1. 改 `package.json` 的 `version`（唯一版本源）+ 在 `CHANGELOG.md` 顶部加一节。
2. 如果是给训练工程打补丁：在 `deepseek/llm-chat/xingye-patches/releases/<日期>-<版本>/`
   放改动的文件 + `README.md`（怎么打、踩了什么坑），更新那边 `CHANGELOG.md`。
3. `git add … && git commit && git push`（远端走 SSH，DNS 受限时用
   `GIT_SSH_COMMAND="ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:7897 %h %p'"`）。
4. `node smoke.js` 过一遍；新增纯逻辑记得在 smoke 里加检查。

---

## 13. 测试

```bash
node smoke.js          # 起临时数据目录的服务，跑 600+ 项检查，结束清理
```

`smoke.js` 的组织：

- 顶部 `import { TMP_DATA } from './smoke-env.js'` **必须在所有 import 之前**
  （ESM import 提升，store.js 会在求值时读数据目录——顺序错了就写到真实数据里）。
- 安全闸：`DATA_DIR !== TMP_DATA` 直接退出。
- 先起服务（`startServer(0)` 随机端口），再按功能分组：配置 / 角色 / 会话 / 聊天 mock /
  常用词 / 关思考 / 联网 / 资料库 / TTS / 导出 / 训练队列参数 / 纯逻辑单测 / 前端静态检查。
- 纯逻辑（括号补全、`slashTrigger`、`filterCharacters`、`normalizeCastSpeaker`、
  工作锁、提示词块…）直接 import 模块测，不需要 DOM。
- 前端只做**静态检查**（`index.html` 里有没有某个 id、`app.js` 里有没有某个函数名、
  有没有误用 innerHTML 拼网页内容）。

**已知**：当前有 20 项失败是**历史遗留的过期断言**（常用词档位措辞、关思考 mock、
联网搜索 mock 的旧期望），和功能无关；新增的检查都是绿的。改这些断言前先确认
当前提示词/接口的意图是不是已经变了（提示词文案改过好几轮）。

无头浏览器在这台机器上跑不起来（沙箱里的 Chromium 连不上本机端口，
data:/file: 正常、http 全超时），需要看 UI 时用「把 `style.css` 内联进一个
静态 HTML 预览页，再用 `--screenshot` 截图」的办法（`/` 功能的 UI 就是这么验的）。

---

## 14. 排错表

| 现象 | 多半是 | 处理 |
|---|---|---|
| 启动就 `data/` 写不进去 | 程序放只读目录 | 用 `WORKBENCH_DATA_DIR` 指到可写目录 |
| `EACCES` 起不来 | 端口 <1024 或 Windows 保留段 | 换端口（`netsh interface ipv4 show excludedportrange protocol=tcp`） |
| 手机打不开 | 只监听了 127.0.0.1 | `node start.js 5178 0.0.0.0`，防火墙放行 |
| 聊天 401 | 没 API Key 且不是本地地址 | 设置里填 Key，或换本机 Ollama |
| 回复突然很慢（几十秒）/ 爆显存 | 显卡上同时加载了**多个** 12B（gemma-server:18080、llama-gemma4:8080、Ollama:11434、ComfyUI:8188），16G 装不下 | **v1.4.0 起自动调度**：聊天前重启掉线的 Ollama、停常驻 llama-server、让 ComfyUI `/free` 卸模型（不杀进程）、不够再临时停 ComfyUI 并空闲 2 分钟自动恢复；手写素材走 gemma 时反过来卸 Ollama。可在设置里关掉 / 用 `POST /api/gpu/arbitrate` 手动触发。`lib/gpu.js#arbitrateForChat` |
| 多人回复只有一个人说话 | 提示词「不要求全员出场」+ 历史里都是单人回复，模型会跟着学 | v1.7.2 起：改为按 `castSpeakChance`（默认 65%）**几率点名**谁开口，不再是「2 个人物都开口」，`sanitize.cleanHistory` 还会把复读的整句从发给模型的历史里删掉 |
| 回复空 / 47 秒空转 | `/v1` 把 `think` 丢了 | 走 Ollama 原生 `/api/chat`（内置已处理） |
| `Conversation roles must alternate` | gemma 模板要求交替 | 已自动修复；插件自己发 gemma 时也要做 |
| `ECONNRESET, accLen:0` | Node keep-alive 复用死连接 | 客户端 `agent:false` |
| llama-server 并发互踢 | 并发请求 | 走 `withBackendLock` 串行 |
| `Unable to generate parser for this template` | llama-server 自动解析器不支持 gemma 模板 | 加 `--reasoning off` 或改用原始 `/completion` 自己拼模板 |
| `model not found` | Ollama 模型目录不对 | 设 `OLLAMA_MODELS`，或换对 baseUrl |
| 改了 gemma 模型保存后连不上 | 自动切到了 `:18080` 但服务没起 | `systemctl --user start gemma-server` |
| 训练说「没有 CUDA」 | 在 DSH 沙箱里跑训练 | 训练必须从普通 shell / systemd 用户服务里起 |
| 训练后队列卡在 running | 服务重启丢了进程 | 重启服务会自动 `resumeQueue`；或 `/api/train/cancel` |
| 预览上下文和实际不一样 | 少见 | 预览和聊天共用 `previewContext`，不一致就是新代码绕过了它 |
| 多人消息不分气泡 | 回复没按「名字：」 | 检查开场白/历史有没有「（名字）」写法（`normalizeCastSpeaker` 会处理） |
| 身份发送后模型还在演我选的角色 | 模型跟着开场白/历史学 | v1.2.2 起会 `dropAsSpeaker` 摘掉历史里替该角色写的话，并把它从 system 人物名单里拿掉 |
| 页面白屏 | app.js 挂了 | 浏览器控制台看第一个报错；`node --check public/app.js` |

---

## 15. 附录：常量 / 环境变量 / 术语

### 常量

| 常量 | 值 | 位置 |
|---|---|---|
| `CONTEXT_BUDGET` | 7200 字符 | `lib/prompt.js` |
| `MAX_OUTPUT_TOKENS` | 2200 | `lib/openai.js` |
| `DIM_MAX` | 10 | `lib/prompt.js` |
| `HINT_MAX` | 500 | `lib/prompt.js` |
| `MEMO_MAX` | 800 | `lib/prompt.js` |
| `MAX_CHARS_LIMIT` | 2000 | `lib/prompt.js` |
| `SYNONYMS_MAX` | 2000 | `lib/prompt.js` |
| `KNOWLEDGE_MAX` | 500000 字符 | `lib/store.js` |
| `DIRECT_PHRASES_MAX` | 1000 | `lib/store.js` |
| `HINT_PRESET_MAX` | 20 | `lib/store.js` |
| `VISION_IMAGE_MAX` | 12MB | `lib/vision.js` |
| `DEFAULT_VISION_MODEL` | `qwen2.5vl:3b` | `lib/vision.js` |
| 样本权重 | handwritten 8 / edited 5 / adopted 2 / plain 1（上限 12） | `lib/weights.js` |
| `CONTEXT_BUDGET` 的历史下限 | `max(600, budget - 资料 - 搜索)` | `lib/prompt.js#previewContext` |

### 环境变量

| 变量 | 作用 |
|---|---|
| `PORT` / 第一个参数 | 端口（默认 5178） |
| `WORKBENCH_HOST` / `XINGYE_HOST` / 第二个参数 | 监听地址（默认 127.0.0.1） |
| `WORKBENCH_DATA_DIR` / `XINGYE_DATA_DIR` | 数据目录（优先级最高） |
| `WORKBENCH_PASSWORD` / `XINGYE_PASSWORD` | 远程访问口令（不设=不启用） |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | 配置的兜底来源 |
| `OLLAMA_EXE` / `OLLAMA_MODELS` | Ollama 可执行文件 / 模型目录 |
| `OLLAMA_HOST_URL` | 显存探测用的 Ollama 地址（`lib/gpu.js`） |
| `LLM_CHAT_DIR` | 训练工程目录（默认 `/home/don0ox1/deepseek/llm-chat`） |
| `LLM_CKPT_DIR` | 训练产物目录（默认 4TB 盘） |
| `CLAUDE_IMITATION_DIR` / `CLAUDE_STYLE_DIR` | Claude 文风数据目录 |
| `XINGYE_EMBED_BASE` / `XINGYE_EMBED_MODEL` | embedding 服务地址 / 模型覆盖 |
| `XINGYE_BING_BASE` | 必应抓取基地址（测试用） |
| `XINGYE_IDLE_MS` / `WORKBENCH_IDLE_MS` | 流式卡住判定时长 |
| `XINGYE_WORKGUARD_NOW` / `WORKBENCH_WORKGUARD_NOW` | 假装现在是某个时刻（测工作锁） |
| `XINGYE_BACKUP` / `XINGYE_BACKUP_IDLE_MS` | 数据备份开关 / 空闲阈值 |
| `TRAIN_REQUIRED_GB` | 训练前要求的最小空闲显存 |
| `NODE_VERSION` / `NODE_MIRROR` | 便携 Node 下载 |

### 术语

| 词 | 含义 |
|---|---|
| 角色卡 / character | 一个人在聊天的「设定文件」 |
| 会话 / session | 一段对话记录 |
| 直连 / direct | 零系统提示词模式 |
| 维度 / dims | 描写幅度的十档比例图（动作/神态/语言/反应/环境/主动性/常用词…） |
| 提示 / hint | 「特点提示词」，一次性的微调要求 |
| 备忘 / memo | 场景既成事实，越靠近 prompt 结尾优先级越高 |
| 已否决 / rejected | 被质量门/人工淘汰的版本，用于 DPO 负样本和事后对比 |
| standard / gold | 人工挑选的标准回答库 |
| 素材 / script | 手写的一问一答完整对话，用于 SFT |
| prefill | 末尾追加 assistant 前缀，强制模型从某个开头续写 |
| nudge | 临时拼进 system 末尾的一段要求 |
| cast | 多人模式的人物表 |
| segments | 多人回复按人物切出来的段 |
| 质量门 / quality gate | 回复打分，分高就重抽一版 |
| 静默/凭空动静 | 模型自己编出来的场景事件，会被清洗 |

## 发布节奏（用户约定，2026-10-31）

- **补丁版本只在本地累积，不逐个推送**。1.5.1 / 1.5.2 这类小补丁改动先落本地，
  攒到一起再以**大版本**（如 1.6.0 / 2.0.0）统一打补丁包、提交并 `git push`。
- 每个大版本推送时：`CHANGELOG.md` 合并记录这一批小改动 + `releases/<日期>-<版本>/` 一个包即可。
- 服务重启/浏览器强刷仍然照常（本地部署不受影响）。
