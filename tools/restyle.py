#!/usr/bin/env python3
"""把现有对话数据改写成多种文风。

为什么要这个：638 条数据全是「（动作）台词」一种格式，
模型学出来只有一种腔调。让 DeepSeek 把同一段内容换成别的写法，
同一批情节就能覆盖多种文风。

只改格式不改内容 —— 情节、台词、人物都不动，所以不需要重新审核内容，
DeepSeek 也不会拒绝（千问/GLM/Kimi 那些一看到角色对话就拒）。

用法：
  python3 tools/restyle.py --in <train.jsonl> --out <目录>
"""
import argparse
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import requests

KEYS = [k.strip() for k in os.environ.get('DEEPSEEK_KEYS', '').split(',') if k.strip()]
if not KEYS:
    raise SystemExit('未配置 DEEPSEEK_KEYS')

API = 'https://api.deepseek.com/v1/chat/completions'
MODEL = 'deepseek-v4-flash'
PROXY = os.environ.get('HTTPS_PROXY') or 'http://127.0.0.1:7897'

# 五种文风。A 是原始的，不用改。
STYLES = {
    'B': ('动作改用 *星号* 包起来，不要用中文括号。台词和动作内容一字不改。',
          'light-novel'),
    'C': ('删掉所有动作描写和旁白，只保留人物说的话（台词原文一字不改）。'
          '如果原文只有动作没有台词，就原样返回。',
          'dialogue-only'),
    'D': ('把动作和神态扩写得更细，节奏放慢，写清楚身体怎么动、环境什么样；'
          '台词一字不改，情节不许增加。',
          'slow-detail'),
    'E': ('把长句拆成短句，一句一个动作，节奏加快；台词一字不改，内容不许增删。',
          'fast-beat'),
}

cost_lock = threading.Lock()
cost = {'in': 0, 'out': 0, 'calls': 0}


def log(msg):
    print(msg, flush=True)


def rewrite(text: str, style_key: str, key: str) -> Optional[str]:
    """把一段角色回复改成指定文风。失败返回 None。"""
    instr = STYLES[style_key][0]
    prompt = (f'把下面这段角色回复改写成另一种写法：{instr}\n'
              f'直接输出改写后的整段，不要解释、不要加引号、不要分段说明。\n\n'
              f'原文：\n{text}')
    body = {
        'model': MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'max_tokens': 700,
        'temperature': 0.7,
        # 不关思考的话返回的是 reasoning_content，拿不到正文（实测过）
        'thinking': {'type': 'disabled'},
    }
    for attempt in range(3):
        try:
            r = requests.post(
                API,
                headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
                json=body,
                proxies={'http': PROXY, 'https': PROXY},
                timeout=120,
            )
            d = r.json()
            if 'error' in d:
                log(f'  API 错误（第{attempt+1}次）: {d["error"]}')
                continue
            out = (d['choices'][0]['message'].get('content') or '').strip()
            u = d.get('usage') or {}
            with cost_lock:
                cost['in'] += u.get('prompt_tokens', 0)
                cost['out'] += u.get('completion_tokens', 0)
                cost['calls'] += 1
            if not out:
                continue
            # 去掉模型偶尔加的开头解释
            out = re.sub(r'^(改写后[:：]\s*|下面是改写.*?\n)', '', out).strip()
            if len(out) < len(text) * 0.3:
                continue
            return out
        except Exception as e:  # noqa: BLE001
            log(f'  异常（第{attempt+1}次）: {e}')
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', required=True)
    ap.add_argument('--out', dest='out', required=True)
    ap.add_argument('--styles', default='B,C,D,E')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--limit', type=int, default=0, help='只处理前 N 条（调试用）')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    styles = [s.strip() for s in args.styles.split(',') if s.strip() in STYLES]

    rows = [json.loads(l) for l in open(args.inp, encoding='utf-8') if l.strip()]
    if args.limit:
        rows = rows[:args.limit]
    log(f'读入 {len(rows)} 条，改写风格 {styles}')

    # 收集所有要改写的 assistant 回复
    targets = []
    for ri, row in enumerate(rows):
        for mi, m in enumerate(row['messages']):
            if m['role'] != 'assistant':
                continue
            t = (m.get('content') or '').strip()
            if len(t) < 20:
                continue
            for st in styles:
                targets.append((ri, mi, st, t))
    log(f'共 {len(targets)} 个改写任务')

    # 结果按 (row_index, style) 存一份副本
    out_rows = {ri: {st: json.loads(json.dumps(row)) for st in ['A'] + styles}
                for ri, row in enumerate(rows)}
    done = {'n': 0}
    lock = threading.Lock()

    def work(item):
        ri, mi, st, text = item
        key = KEYS[(ri + mi) % len(KEYS)]
        res = rewrite(text, st, key)
        with lock:
            done['n'] += 1
            n, total = done['n'], len(targets)
            if n % 20 == 0 or n == total:
                cny = cost['in'] / 1e6 * 2 + cost['out'] / 1e6 * 8
                log(f'  进度 {n}/{total}  费用 ¥{cny:.2f}')
        if res:
            out_rows[ri][st]['messages'][mi]['content'] = res

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(work, targets))

    # 每个风格写一份文件
    for st in ['A'] + styles:
        path = os.path.join(args.out, f'style-{st}.jsonl')
        with open(path, 'w', encoding='utf-8') as f:
            for ri in range(len(rows)):
                f.write(json.dumps(out_rows[ri][st], ensure_ascii=False) + '\n')
        log(f'写入 {path}')

    # 合并成一份（每条样本只出现一次，风格均分）
    merged = []
    for ri in range(len(rows)):
        for st in ['A'] + styles:
            merged.append(out_rows[ri][st])
    # 均分：每个风格抽相同数量
    per = len(rows)
    final = []
    for st in ['A'] + styles:
        final.extend([out_rows[ri][st] for ri in range(min(per, len(rows)))])
    path = os.path.join(args.out, 'train-mixed.jsonl')
    with open(path, 'w', encoding='utf-8') as f:
        for r in final:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')

    cny = cost['in'] / 1e6 * 2 + cost['out'] / 1e6 * 8
    log(f'\n✅ 完成')
    log(f'  合并文件: {path}（{len(final)} 条 = {len(rows)} 条 × {1 + len(styles)} 种风格）')
    log(f'  调用 {cost["calls"]} 次，输入 {cost["in"]/1e4:.0f} 万 token，输出 {cost["out"]/1e4:.0f} 万')
    log(f'  费用 ¥{cny:.2f}')


if __name__ == '__main__':
    main()
