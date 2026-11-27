// 工作时段锁：工作日（周一至周五）北京时间 09:00-12:00、14:00-18:00 不许对话。
//
// 这里只做纯计算（给一个时刻 + 开关，判断是否被锁、锁到什么时候），
// 不碰 DOM、不读配置，所以 node smoke.js 可以直接 import 进来测。
// 中国没有夏令时，固定 UTC+8，所以偏移直接写死，比依赖运行环境的时区更稳。

// v2.4.1："是不是本地接口"统一由 lib/net.js 判定（原来这里另有一份，口径不一致）。
import { isLocalBaseUrl } from './net.js';

export const BLOCKS = [
  { from: 9, to: 12, label: '09:00 - 12:00' },
  { from: 14, to: 18, label: '14:00 - 18:00' },
];

export const SCHEDULE_TEXT = '工作日（周一至周五）09:00-12:00、14:00-18:00（北京时间）';

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 判断某一时刻是否处于锁定时段。
 *
 * @param {Date} now
 * @param {boolean} enabled 关掉开关就永远不锁
 * @returns {{enabled: boolean, blocked: boolean, until: number|null, label: string|null, reason: string}}
 *          until 是解锁时刻的 Unix 毫秒（只在 blocked 时有意义）
 */
export function workState(now = new Date(), enabled = true) {
  if (!enabled) return { enabled: false, blocked: false, until: null, label: null, reason: 'off' };

  // 把 UTC 时刻加上 8 小时，再用 getUTC* 读出来，就是北京时间的"墙上时钟"。
  const bj = new Date(now.getTime() + BJ_OFFSET_MS);
  const day = bj.getUTCDay(); // 0 = 周日
  if (day === 0 || day === 6) {
    return { enabled: true, blocked: false, until: null, label: null, reason: 'weekend' };
  }

  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  for (const block of BLOCKS) {
    if (minutes >= block.from * 60 && minutes < block.to * 60) {
      // 解锁时刻 = 今天的 block.to 点（北京时间）→ 减 8 小时换回 UTC。
      const until = Date.UTC(
        bj.getUTCFullYear(),
        bj.getUTCMonth(),
        bj.getUTCDate(),
        block.to - 8,
        0,
        0,
        0,
      );
      return { enabled: true, blocked: true, until, label: block.label, reason: 'work' };
    }
  }
  return { enabled: true, blocked: false, until: null, label: null, reason: 'free' };
}

/** 给人看的剩余时长，例如 "1 小时 23 分" / "4 分 05 秒" / "30 秒"。 */
export function humanLeft(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${String(s).padStart(2, '0')} 秒`;
  return `${s} 秒`;
}

/* ---------- 本地接口判定 ---------- */

// 工作时段锁**只管云端**：本地模型（Ollama 之类）不受影响。
// 理由是锁的目的是"别在上班时间把内容发到外面去、别摸鱼刷云模型"，
// 本地推理既不花钱也不出网，没有必要拦。
//
// v2.4.1 审计修复：这里原来自己实现了一份主机名白名单，**不认 Tailscale 的 100.64/10**，
//   而 lib/ollama.js 的 localOllamaBase 认。于是 baseUrl 指向 Tailscale 上的 Ollama
//   （http://100.x.x.x:11434/v1）时：聊天走 Ollama 原生接口（当成本地 ✅），
//   工作时段锁却当成"云端"，上班时间直接 403（❌ ——"连自己家的 Ollama 却被锁住"）。
//   现在统一改用 lib/net.js 的唯一实现（回环 + RFC1918 + Tailscale 100.64/10 + .local + 默认端口）。
export function isLocalEndpoint(baseUrl) {
  return isLocalBaseUrl(baseUrl);
}
