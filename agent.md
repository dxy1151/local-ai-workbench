# agent.md — 星野工作台交接文档

> 给下一个接手的 agent（或未来的自己）看。写清楚：**这是什么、改动规矩、现在改到哪一步、踩过哪些坑**。
>
> ## 📌 本文档需要维护
>
> **改完代码、踩了新坑、做完待办里的一项，就回来更新这里。** 不维护的交接文档比没有更糟 ——
> 下一个人会照着过期的描述去改，反而制造 bug。
>
> 至少更新这三处：
> 1. **§4 当前改动现状** —— 改了什么、完成到哪、有没有 commit
> 2. **§5 踩过的坑** —— 新的坑当场记，别等"以后再说"
> 3. **§9 待办** —— 做完的打勾，新发现的加进去
>
> 末尾有 **§10 变更记录**，每次改动加一行（日期 + 一句话）。
>
> 最后更新：2026-11-22

---

## 1. 这是什么

本地跑的 AI 角色扮演工作台（`xingye-chat`），带训练数据生产链路。

| 项 | 值 |
|---|---|
| 代码 | `/mnt/data4t/xingye-chat-fixed-portable` ← **只改这里** |
| 数据 | `/mnt/data4t/xingye-sync`（config.json / characters/ / sessions/ / knowledge/） |
| 服务 | `5178`，`node start.js 5178 0.0.0.0` |
| 主模型 | llama-server `8081` + `aeon-q3`（Q3_K_M，12.57GB）。2026-11-23 从 q38(11.73GB, 3.81bpw) 换过来 |
| 备用 | Ollama `11434` |

⚠️ 同级还有个 `xingye-chat-portable`（旧版）。**改错目录的代码不会生效**，这是踩过的。

---

## 2. 铁律（动代码前必须遵守）

1. **只改 `xingye-chat-fixed-portable`**
2. **不要关思考**（`thinkForce:true` 是用户主动选择）。目标是把思考**训好**，不是绕过它
3. **不要重启 `dsh web`**（会掐断正在对话的会话）。改完代码重启 `5178` 那个 node 进程就行
4. **密钥不写进代码**。opencode 的 key 在 `~/.dsh/.credentials.yaml` 的 `refs.OPENCODE_API_KEY`，脚本从 `process.env` 取
5. **不擅自新建会话做测试**。直连会话会污染用户的 `sessions/`，测完要删（见 §6）
6. **不把手写内容说成模型输出**。用户会追问"这是模型的本事还是你的"，必须如实回答
7. **子智能体不给看敏感内容**（一处都不发）。但注意这条只约束**发给 qwen 的**任务；
   需要在本机处理敏感目录时走第 8 条。
8. **要碰禁止处理的目录，只能交给子智能体，绝不在本会话里读**（用户 2026-11-23 明确要求）：
   - 本会话（lead 的上下文）**一次都不读** `sessions/` `knowledge/` `characters/` `config.json`
     `lib/prompts/` `llm-chat/` 这些路径 —— 一旦读进来，后续每一轮请求都会带着它被送审
   - 需要其中的内容时，派**同后端子智能体**处理（默认继承父级路由 `deepseek-account`）。
     **不要**派 qwen API 的子智能体读这些目录：它有内容审核，会整单拒答，白跑
   - 本会话里**严禁出现敏感词汇**：不转述、不举例、不贴报错原文；只接收子智能体回来的
     **结论 / 计数 / 路径 / 行号**
   - 子智能体内部处理完不要把原文带回来；它的上下文用完即弃

---

## 3. 提示词架构

### 单一来源原则

```
lib/prompts/
  rules.js    系统提示词「要求」段（compactRules / fullRulesText / thinkStyleRule / localRules）
  nudges.js   追加式提示（重抽 / 继续 / 反拖延 / 空回复）
  blocks.js   各类「块」的拼装（资料 / 维度 / 字数 / 备忘 / 联网）
  cast.js     多人卡（「名字：台词」）
  shared.js   共享句子片段（同一句话只写一次）
  video.js    文生视频提示词规范（直连模式开关）
lib/prompt.js 只负责取用和拼装
```

### 三条铁律

1. **同一件事只能写一处**。字数、动作、环境重复写必然打架 → 模型随机挑一条执行
2. **字数只由 `limitBlock()` 给**（`prompts/blocks.js`）。其它任何地方**不写数字**
3. **可复用句子放 `shared.js`**，不要手抄第二遍

### ⚠️ 高频陷阱：`export *` 到不了 `prompt.js`

`prompts/index.js` 里 `export *` 出来的东西，`prompt.js` 若用**显式 re-export 列表**导出，
就必须**手动把名字加进那个列表**，否则 `server.js` import 会报
`does not provide an export named 'xxx'`。**这个坑踩过两次。**

---

## 4. 当前改动现状（未提交）

`git status` 显示 5 个文件已改，**尚未 commit**：

### 4.1 `lib/prompts/rules.js` — 重写（已完成）

**背景**：用户反馈「详细描写又没了」。查下来是限制堆太多：

| 原来的限制 | 后果 |
|---|---|
| `ACTION_LENGTH_RULE`：一个动作块 **≤15 字**，禁止写表情/感受/环境 | 动作变干巴巴一根短句，环境干脆不写 |
| 「要克制、不要每句都加」 | 动作越写越少 |
| 「不注水：不堆形容词」 | 连合理的修饰都不敢写 |
| 原第 10 条：不许写对方身体、不许用旁白口吻评价 | 最伤描写 |
| 原第 13 条：一轮只推进一件事，说完就住口 | 回复越写越短 |

**现在**：`compactRules()` 从 8 条 → 6 条，`fullRulesText()` 从 13 条 → 7 条，
**全部只留扮演要求 + 一条「写具体」的正向引导**，不再有任何压篇幅的条款。

> 2026-11-23 二次调整：放开限制后出现**描写繁琐**（连着几段堆身体细节，台词被挤没），
> 把「写具体」改成了「**具体，但不啰嗦**」：一个动作写到能看见就停、同一个意思不换说法重描、
> 括号一轮放一两处就够。注意方向 —— 不是退回「15 字上限」，是**限制密度不是限制长度**。

保留的核心：
- 人称（我就是角色本人，我/你，不用他她）
- 不替对方行动、不替对方写心理
- **写具体**（动作落到身体、视线里的都写）
- 动作写在（）里，**长度按场面需要来**（不设上限也不设下限）
- 台词口语；不出戏

### 4.2 `dimsInPrompt` — 维度改成可选项（**代码已改，UI 还没做**）

`config.dimsInPrompt`，默认 **false**。关着时「描写幅度」比例表**不注入提示词**，
维度数据照旧保存。

- ✅ `lib/store.js`：字段读写（默认 `false`）
- ✅ `lib/prompt.js`：`dimsForPrompt(dims, opts)` 三处调用点统一切换
- ✅ `lib/server.js`：4 处 opts 透传
- ✅ `public/index.html`：维度弹窗里加了「把这张比例表写进提示词」复选框
- ✅ `public/app.js`：`openDims()` 读 `cfg.dimsInPrompt`、`applyDims()` 存回 `/api/config`
- ✅ `public/style.css`：`.dims-into-prompt` 加分隔线，直连模式下隐藏

**已验证**（浏览器实测）：
```
打开弹窗 → 勾选框默认未勾（false）
勾上应用   → 服务端 dimsInPrompt = true
重开弹窗   → 勾选框回显 true（读路径通）
取消并应用 → 服务端 dimsInPrompt = false
```
提示词侧：`dimsInPrompt=false` → 系统提示词 1471 字、不含【描写幅度】；
`=true` → 1743 字、含。

**为什么默认关**：这张表把环境固定成 3/10（"只偶尔带一笔"），等于每轮提醒模型少写环境，
和「写具体」直接打架。

### 4.3 `lib/prompt.js` — customRules 截断修复（已完成）

原来是 `.slice(0, 450)` 硬切，实测把段落**从句子中间砍断**，输出末尾停在「每一轮至少写 」。
半句话被模型当噪声。改成按 `【】` 段边界累加，装不下就**整段丢掉**，上限 700 字。

### 4.5 人设不再截断（2026-11-23，已完成）

用户反馈「忘人设很严重」。查下来是**代码把角色卡切了**，不完全怪量化：

```js
// 改之前
人设：${persona.slice(0, 380)}      // 极简版
人物设定：${persona.slice(0, 700)}  // 完整版
场景：${scenario.slice(0, 160)}
```

库里 **6/50** 张卡的人设超过 380 字，最多被砍 271 字；实测某张 597 字的卡被砍 217 字。
角色卡通常把「说话习惯 / 禁忌」写在**后面**，被切掉的正巧是最影响"像不像"的部分。

现在：`persona` / `scenario` **原样注入，不截断**（`lib/prompt.js` 两处）。
实测某 597 字人设的卡：system 从 2807 → 3024 字，`system.includes(完整persona) === true`。

> 注：`hint` 仍有 400 字上限，但库里最长 325 字，等于没有截断，暂不动。

### 4.6 量化实测：q38 vs Q3_K_M（2026-11-23）

用 `llama-perplexity` 在**同域语料**（本地 425KB、句级文本）上测 40 块 × 512 token：

| 模型 | 量化 | PPL | 相对 |
|---|---|---|---|
| **Q3_K_M**（现用） | 4.08 bpw 均匀 Q3_K | **34.57** ± 1.08 | 基准 |
| q38 | 3.81 bpw 混合（160 张量 IQ2_S） | 35.64 ± 1.09 | **+3.0%** |

3% 是真实但**不大**的差距 —— 印证了"q38 不是废，只是指令跟随更飘"。行为上更明显：
同 prompt 采样 5 次，q38 描写占比 38%、Q3_K_M 30%。

**跑 PPL 的两个坑（都会让人误判）**：

1. **必须设 `LD_LIBRARY_PATH`**，否则 CUDA 后端加载不上，静默跑 CPU：
   ```bash
   CUDART=/home/don0ox1/deepseek/llm-chat/llama-bin/cudart-llama-b11827-bin-ubuntu-cuda-13.4-x64
   LL=/home/don0ox1/deepseek/llm-chat/llama-bin/llama-b11827
   LD_LIBRARY_PATH="$LL:$CUDART" $LL/llama-perplexity -m <model> -f <corpus> -c 512 -ngl 99 -fa on --chunks 40
   ```
   踩过：不设时 34 秒/块（CPU），设了 1.5 秒/块；日志里没有 `ggml_cuda` 字样就是没上 GPU。
2. **要先停 llama-server** 腾显存，测完再 `POST /api/switch-model` 起回来。

### 4.4 `lib/openai.js` — opencode 请求头（已完成）

`opencode.ai` 的接口强制要 `x-opencode-session`，不带直接 400 `MissingSessionID`。
加了 `opencodeHeaders()`，只对 opencode 域名发这个头。

---

## 5. 踩过的坑（都会复发，逐条记住）

### 提示词 / 模型行为

| 症状 | 真因 | 处理 |
|---|---|---|
| 回复里逐字数字数（`1.拇 2.指 3.…`） | 提示词同时给了**字数上限和下限**，模型就去核对 | 只给上限，下限一律用非数字措辞（"别只写一两句"） |
| 整段思考被当正文吐出来 | `finish_reason=length` 时旧代码把 reasoning 当 reply 兜底 | 记 `finishReason`，length 截断 + 思考里出现"用户要求/版本1/字数"就不救 |
| 回复里出现「让我看看你能撑多久」这类考官句 | 模型把身体动作换成了**评价** | 已在 DPO 数据里做成负例（见 §7） |
| 思考几千字正文几十字 | 模型在思考里复述要求、列草稿、逐条打勾 | `thinkStyleRule()`：只想三件事，想完就动笔 |

### 端口 / 进程

| 症状 | 真因 | 处理 |
|---|---|---|
| `Ollama 400: invalid model name` | **8081 上跑的是 Ollama 不是 llama-server**（有人 `OLLAMA_HOST=127.0.0.1:8081 ollama serve`） | 用 `/api/tags` 判别：**200 = Ollama，404 = llama-server**。启动前 `freePort8081()` 清掉 |
| `pkill -f xxx` 把自己杀了 | `bash -c` 的命令串里含 `xxx`，pkill 匹配到自己 | 用 `ps -eo pid,cmd \| awk '/[x]xx/ {print $1}'` 精确取 PID |
| `kill -9 $P` 杀掉刚起的进程 | `$P` 里捕获了多个 PID（含新进程） | 先 echo 确认，逐个杀，别一把梭 |
| 生成突然从 22 tok/s 掉到 5 tok/s，`nvidia-smi` 看到两张卡各占一半 | **llama.cpp b11827 的 `--fit` 默认 on**，它按"所有可见卡显存之和"自动分层 → 27B 被平摊到 5060 Ti + 5060 上，跨卡拷贝把 decode 拖到 5 tok/s | 必须 `--device CUDA0 --fit off` 同时写。只写 `--device` 没用（`--fit on` 会把 8G 卡也算进去）；`startLlama8081()` 已在 args 里带这两项。实测单卡独占：prefill 696 tok/s / decode 24 tok/s |

### 配置 / 凭据

| 症状 | 真因 | 处理 |
|---|---|---|
| 手改 `.credentials.yaml` 后 key 消失 | credentials store 有内存快照，会覆盖回去 | 改完盯 30 秒；或走 GUI 设置页写 |
| `apiKeyEnv` 配了但报"no credential" | pi-ai 读的是 **`refs`**，不是 `llm-pi-ai/<provider>` record | key 写进 `refs.OPENCODE_API_KEY` |
| opencode 402 / 403 | 402=按量付费没余额；403=workspace 被撤/订阅没了 | 不是代码问题，别改路由 |

### 训练环境

| 症状 | 真因 | 处理 |
|---|---|---|
| V100 上训练慢得离谱 | **V100 没有原生 bf16**，`is_bf16_supported()` 返回 True 是骗人的（软件仿真） | 实测 bf16 14.87ms vs fp16 3.97ms（4096² matmul），**全部换 fp16 + GradScaler** |
| HF 下载卡在几百 MB 不动 | hf-mirror 按出口流量限速（~100 KB/s） | 用 **ModelScope**：实测 12 MB/s |

---

## 6. 常用验证

```bash
# 服务健康
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5178/

# 看这一轮实际发给模型的 system（最有用的一条）
SID=$(curl -s -X POST http://127.0.0.1:5178/api/direct/sessions -H 'Content-Type: application/json' -d '{}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).session.id')
curl -s "http://127.0.0.1:5178/api/direct/context?sessionId=$SID" | node -pe 'JSON.parse(require("fs").readFileSync(0)).system'

# 纯本地渲染 system（不用起服务、不会建会话）——改提示词后首选
node -e 'import("./lib/prompt.js").then(m=>console.log(m.systemPrompt(角色对象,"",null,"", "",0,null,false,{thinking:true,compactSystem:true})))'

# 端口判别
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8081/api/tags   # 404=llama-server, 200=Ollama

# 测完删掉建的直连会话
rm -f /mnt/data4t/xingye-sync/sessions/<id>.json
```

---

## 7. 训练数据现状

见 `/mnt/data4t/dpo-sick/`：

| 文件 | 内容 |
|---|---|
| `dpo-final.jsonl` | **294 对 DPO 正负样本**（287 合成 + 7 真实），trainer 直接能读 |
| `pairs.jsonl` | 合成正负对原始记录 |
| `gen-sick-dpo.js` | 病句生成脚本（单病灶 / 复合 / 交替，`--n` `--resume` `--all` `--combo`） |
| `filter-real-dpo.js` | 从会话 `rejected` 里筛真实偏好对 |

**病句六型**（从真实会话 1447 条里提炼，核心都是"把动作换成评价"）：

```
S1 考官口吻    让我看看你能撑多久
S2 旁观评价    看看你什么路数、底气实不实
S3 祈使+考核   再看看你能不能控制住自己
S4 主语漂移    他坐在沙发里…让我看看
S5 文白堆叠    不如先拿这点来抵个彩头
S6 空转连环    一句里连着两个"看看"
```

外加 8 种复合（C14/C15/C23/C26/C34/C56/C123/C456）。

**真实 rejected 里 96% 不能进 DPO**：那 580 条里 359 条是「只问不做/空动作/征询许可」
——是**没推进情节**，不是写错。这类拿去做 negative 会让模型学成"做了动作就是错的"。

`/mnt/data4t/grok-output/`：167 题 grok-4.7 作答（A–F 全、G 到 167），
缺 168–200。校验结果：**0 条术语错误、0 条方向写反、0 条格式坏**，61 条纯字数告警。

---

## 8. 27B 训练（未开工）

- 租 seetacloud：V100-SXM2-**32GB × 2**（实例已关，下次要重开）
- 环境：Python 3.12 / torch 2.8.0+cu128；缺 `transformers/peft/trl/bitsandbytes`（装一次即可）
- 基座：`Qwen/Qwen3.8-27B`（51.8 GB）—— **AEON 只有 GGUF，没有 HF 权重**，
  想在 AEON 上继续训拿不到原始权重
- 显存估算：SFT ≈ 23–27 GB，DPO ≈ 25–31 GB（可用仅约 30 GB），**DPO 要开 `--precompute-ref`**
- 下载：`modelscope snapshot_download("Qwen/Qwen3.8-27B", local_dir=...)`

---

## 9. 待办

- [x] 维度开关 UI：弹窗复选框 + 读写 `dimsInPrompt`（2026-11-22 完成）
- [x] 重启 5178 让 `rules.js` / `dimsInPrompt` 生效（2026-11-22）
- [ ] **实测「详细描写」是否回来** —— 提示词已改，但还没跑真实对话对比
- [ ] **实测「忘人设」是否改善** —— 人设已不截断，需跑一轮长对话验证
- [ ] 本次改动 commit
- [ ] 补 grok 的 168–200（等新 opencode 号）
- [ ] 27B 训练：重开实例 → 装依赖 → ModelScope 下权重 → fp16 改造 → 显存实测

---

## 10. 变更记录

每改一次加一行，别偷懒。

| 日期 | 改了什么 |
|---|---|
| 2026-11-22 | `rules.js` 重写：砍掉 15 字动作上限等 5 类限制，只留扮演要求 + 「写具体」 |
| 2026-11-22 | 维度「描写幅度」改成可选（`config.dimsInPrompt`，默认关），弹窗内可勾 |
| 2026-11-22 | 修 `customRules` 450 字硬切造成的半句截断 |
| 2026-11-22 | `openai.js` 加 `x-opencode-session` 头（opencode 接口必需） |
| 2026-11-23 | 去掉人设/场景截断（380/700/160 → 不截断），治「忘人设」 |
| 2026-11-23 | 子智能体路由改 qwen API（优先 deepseek-v4.1-flash），铁律加"敏感内容零外发" |
| 2026-11-23 | 「写具体」收紧为「具体但不啰嗦」，治放开后的描写繁琐 |
| 2026-11-23 | 知识库加 5 条坐姿类动作条目 |
| 2026-11-23 | 加「台词是主体」+「直接点题」两条；实测同输入下描写占比 86%↔25% 波动大 |
| 2026-11-23 | 主模型 q38 → aeon-q3（Q3_K_M）。同 prompt 5 次采样：描写占比 38%→30%，均长 102→90 字 |
| 2026-11-23 | 铁律加第 8 条：敏感目录只能交给同后端子智能体处理，本会话禁读、禁出现敏感词 |
| 2026-11-23 | PPL 实测：Q3_K_M 34.57 vs q38 35.64（差 3.0%）；记录 LD_LIBRARY_PATH 坑 |
| 2026-11-23 | `startLlama8081()` 加 `--device CUDA0 --fit off`：锁 5060 Ti 单卡，防 `--fit` 自动平摊到双卡（平摊时 decode 只有 5 tok/s） |
| 2026-11-25 | v2.6.5 设置新增「无提示词」开关（`barePrompt`）：system 只发角色定义 + 人称定义，明细见下 |

**v2.6.5 明细：设置页「无提示词」开关（2026-11-25）**

- 设置页新增复选框「无提示词（只发角色定义 + 人称定义）」，config 字段 `barePrompt`（boolean，默认 false）
- 打开后 system 只保留两段：① 角色定义：你扮演「名字」/ 设定 / 人设 / 场景；② 人称定义：我用「我」说自己、用「你」称呼用户，用户消息里的「我」永远指用户本人，不用他/她指自己，不替用户行动/写心理/写旁白
- 规则、维度、提示、备忘、资料库、常驻知识、对照表、等义词、联网搜索全部不发；也跳过动作开头前缀；重抽不追加提示
- 「关掉思考」仍会附 `/no_think`（技术开关，不算提示词）
- 代码位置：`lib/store.js`（barePrompt 字段）、`lib/prompt.js`（bareSystemPrompt + previewContext 分支）、`lib/server.js`（handleChat 跳过各注入、`/api/context` 预览同步）、`public/index.html` + `public/app.js`（设置页复选框）
- 验证：抓真实请求体，裸模式 system 146 字（只有角色定义 + 人称定义 + no_think），不含任何规则/知识/对照块；`/api/context` 预览与真实请求完全一致
