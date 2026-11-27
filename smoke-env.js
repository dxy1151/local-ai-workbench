// 冒烟测试的环境准备：**必须最先被 import**。
//
// 为什么单独一个文件：ESM 的 import 是提升的 —— 不管写在文件第几行，
// 都会在模块体之前求值。原来 `process.env.WORKBENCH_DATA_DIR = ...` 写在 import 之后，
// 于是 lib/store.js 在求值时读到的是**默认/真实数据目录**，
// 冒烟测试就往你的真实数据里写了测试角色和会话（踩过一次，已修）。
//
// 放在第一个 import，就能保证 store.js 求值前环境变量已经就位。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
export const TMP_DATA = path.join(ROOT, 'data-smoke');

process.env.WORKBENCH_DATA_DIR = TMP_DATA;
