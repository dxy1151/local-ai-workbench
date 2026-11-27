// lib/prompts/ —— 所有提示词的单一来源
//
// 为什么要集中：
//   原来提示词散在 prompt.js 的 61 个函数里，改一处要满文件搜。
//   更要命的是**同样的意思写了三四遍**（字数限制、动作要求、环境要求），
//   彼此打架，模型只能随便挑一条执行（实测：90 字 / 250-350 字 / limitBlock 三处冲突）。
//
// 结构：
//   rules.js      —— 系统提示词里的「要求」段（精简版 / 完整版）
//   nudges.js     —— 追加式提示（重抽、继续、反拖延…），按需拼进请求末尾
//   blocks.js     —— 资料、维度、提示、字数这些「块」的拼装
//   cast.js       —— 多人卡（「名字：台词」）相关的提示
//   video.js      —— 文生视频提示词规范（直连模式的一个开关）
//
// 改提示词只改这里；prompt.js 只负责取用和拼装。

export * from './rules.js';
export * from './nudges.js';
export * from './blocks.js';
export * from './cast.js';
export * from './video.js';
