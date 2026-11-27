#!/usr/bin/env python3
"""把素材整理成 gemma 能吃的格式。

gemma 的 chat template 有两条硬规则（会直接 raise）：
  1. 角色必须 user/assistant 交替；
  2. 第一句不能是 assistant（开场白要丢掉或并进 system）。
而我们的素材常以「角色开场白」开头、还有连续同类消息，所以必须转换。

用法：python3 make-gemma-data.py --out /home/don0ox1/deepseek/llm-chat/data/gemma-train.jsonl
"""
import argparse, glob, json, os

SCRIPT_DIR = '/home/don0ox1/xingye-sync/scripts'
CLAUDE = '/home/don0ox1/deepseek/claude-imitation/runs/claude-style/sft.jsonl'


def fix_messages(msgs):
    """system 抽到最前；丢掉开头 assistant；合并连续同角色"""
    sysparts, rest = [], []
    for m in msgs:
        role = m.get('role'); c = str(m.get('content') or '').strip()
        if not c:
            continue
        if role == 'system':
            sysparts.append(c)
        elif role in ('user', 'assistant'):
            rest.append({'role': role, 'content': c})
    while rest and rest[0]['role'] == 'assistant':
        rest.pop(0)
    merged = []
    for m in rest:
        if merged and merged[-1]['role'] == m['role']:
            merged[-1]['content'] += '\n' + m['content']
        else:
            merged.append(dict(m))
    if not merged or merged[0]['role'] != 'user':
        return None
    out = []
    if sysparts:
        out.append({'role': 'system', 'content': '\n\n'.join(sysparts)})
    out += merged
    # 必须偶数长度（user/assistant 成对结尾）
    if len(merged) % 2 != 0:
        merged.pop()
    return out if len(merged) >= 2 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--claude', action='store_true', help='同时混入 Claude 改写数据')
    args = ap.parse_args()

    rows, stats = [], {'scripts': 0, 'claude': 0, 'skipped': 0}
    for f in glob.glob(os.path.join(SCRIPT_DIR, '*.json')):
        d = json.load(open(f))
        if d.get('rejected'):
            stats['skipped'] += 1
            continue
        m = fix_messages(d.get('turns') or [])
        if not m:
            stats['skipped'] += 1
            continue
        if d.get('system'):
            m = [{'role': 'system', 'content': d['system']}] + [x for x in m if x['role'] != 'system']
        rows.append({'messages': m, 'meta': {'origin': d.get('origin') or 'handwritten'}})
        stats['scripts'] += 1

    if args.claude and os.path.exists(CLAUDE):
        for line in open(CLAUDE):
            r = json.loads(line)
            m = fix_messages(r.get('messages') or [])
            if m:
                rows.append({'messages': m, 'meta': {'origin': 'claude'}})
                stats['claude'] += 1

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'写出 {len(rows)} 条 → {args.out}')
    print(f'  素材 {stats["scripts"]} 个、Claude {stats["claude"]} 条、跳过 {stats["skipped"]} 个')


if __name__ == '__main__':
    main()
