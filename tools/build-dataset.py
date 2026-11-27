#!/usr/bin/env python3
"""把生成器产出的 train.jsonl 合并/去重/截断成指定行数的训练集。"""
import argparse, json, random

ap = argparse.ArgumentParser()
ap.add_argument('--src', nargs='+', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--rows', type=int, default=2000)
ap.add_argument('--seed', type=int, default=20261102)
ap.add_argument('--no-dedupe', action='store_true', help='不去重（保留加权重复行）')
a = ap.parse_args()

rows = []
for p in a.src:
    try:
        for line in open(p, encoding='utf-8'):
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    except FileNotFoundError:
        pass
seen, out = set(), []
for r in rows:
    m = r['messages']
    k = (m[0]['content'][:80], m[-2]['content'][:60] if len(m) > 2 else '')
    if not a.no_dedupe:
        if k in seen:
            continue
        seen.add(k)
    out.append(r)
random.Random(a.seed).shuffle(out)
out = out[:a.rows]
with open(a.out, 'w', encoding='utf-8') as f:
    for r in out:
        f.write(json.dumps(r, ensure_ascii=False) + '\n')
assist = sorted(len(m['content']) for r in out for m in r['messages'] if m['role'] == 'assistant')
print(f'{len(rows)} 条样本 → 去重 {len(seen)} → 取 {len(out)} 行 → {a.out}')
if assist:
    print(f'assistant 中位 {assist[len(assist)//2]} 字，最短 {assist[0]}，最长 {assist[-1]}')
