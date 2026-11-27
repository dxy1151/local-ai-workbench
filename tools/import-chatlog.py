#!/usr/bin/env python3
"""把「导出的聊天记录 .md」转成训练样本（可加权）。

用法：
  python3 import-chatlog.py --dir "/home/don0ox1/下载/训练-临时" --weight 3 \
      --out "/mnt/data4t/训练数据（归档）/真人对话/手写对话/rows.jsonl"

设计：
- 每个 assistant 回复一条样本（system + 它之前的历史）。
- 系统提示词用**本地精简版**（character-system?...&local=1），和本地推理一致。
- --weight N：每条样本重复 N 次（加权；不改变内容，只增加训练出现次数）。
- 自动去重（同一条消息序列只留一份），并跳过太短/空回复。
"""
import argparse, hashlib, json, os, re, urllib.request

WB = 'http://127.0.0.1:5178'
os.environ.setdefault('no_proxy', '127.0.0.1,localhost')

def api(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)

def get_chars():
    return api(WB + '/api/characters')['characters']

def system_for(cid, local=True):
    q = '&local=1' if local else ''
    d = api(f'{WB}/api/script/character-system?id={cid}&preset=global{q}')
    return d['system']

MSG_RE = re.compile(r'^\*\*(.+?)\*\*\s*·\s*\d{1,2}:\d{2}\s*$')

def parse_md(path):
    text = open(path, encoding='utf-8').read()
    m = re.search(r'^- 角色：(.+)$', text, re.M)
    char_name = (m.group(1).strip() if m else '').strip()
    msgs = []
    cur = None
    for line in text.split('\n'):
        mm = MSG_RE.match(line.strip())
        if mm:
            speaker = mm.group(1).strip()
            cur = {'speaker': speaker, 'lines': []}
            msgs.append(cur)
            continue
        if cur is not None:
            if line.startswith('# ') or line.startswith('---'):
                cur = None
                continue
            cur['lines'].append(line)
    out = []
    for x in msgs:
        content = '\n'.join(x['lines']).strip()
        content = re.sub(r'\n{3,}', '\n\n', content)
        if not content:
            continue
        role = 'user' if x['speaker'] == '我' else 'assistant'
        out.append({'role': role, 'content': content})
    return char_name, out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True)
    ap.add_argument('--weight', type=int, default=3)
    ap.add_argument('--out', required=True)
    ap.add_argument('--md-archive', default='', help='把原始 md 复制到这个目录归档')
    ap.add_argument('--max-history-chars', type=int, default=2600)
    ap.add_argument('--local', type=int, default=1, help='1=用本地精简系统提示词（默认）')
    a = ap.parse_args()

    chars = get_chars()
    by_name = {c['name']: c for c in chars}
    sys_cache = {}
    files = sorted(f for f in os.listdir(a.dir) if f.endswith('.md'))
    seen = set()
    rows = []
    stats = {'files': 0, 'dup': 0, 'msgs': 0, 'rows': 0, 'unknown_char': 0}
    for f in files:
        path = os.path.join(a.dir, f)
        name, msgs = parse_md(path)
        char = by_name.get(name)
        if not char:
            stats['unknown_char'] += 1
            print(f'⚠️ 跳过：找不到角色「{name}」（{f}）')
            continue
        key = hashlib.sha256(json.dumps(msgs, ensure_ascii=False).encode()).hexdigest()
        if key in seen:
            stats['dup'] += 1
            continue
        seen.add(key)
        stats['files'] += 1
        if char['id'] not in sys_cache:
            sys_cache[char['id']] = system_for(char['id'], bool(a.local))
        system = sys_cache[char['id']]
        stats['msgs'] += len(msgs)

        for i, m in enumerate(msgs):
            if m['role'] != 'assistant':
                continue
            if len(m['content']) < 15:
                continue
            # 历史从最近的往前取，字符数封顶
            hist = []
            used = 0
            j = i - 1
            while j >= 0 and used < a.max_history_chars:
                c = msgs[j]['content']
                if used + len(c) > a.max_history_chars:
                    break
                hist.insert(0, msgs[j])
                used += len(c)
                j -= 1
            if not any(x['role'] == 'user' for x in hist):
                continue
            row = {'messages': [{'role': 'system', 'content': system}] + hist + [{'role': 'assistant', 'content': m['content']}]}
            rows.append(row)
            stats['rows'] += 1
        if a.md_archive:
            os.makedirs(a.md_archive, exist_ok=True)
            with open(path, 'rb') as src, open(os.path.join(a.md_archive, f), 'wb') as dst:
                dst.write(src.read())

    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as fp:
        for r in rows:
            for _ in range(a.weight):
                fp.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'扫描 {len(files)} 个 md：可用 {stats["files"]}，重复跳过 {stats["dup"]}，'
          f'角色缺失 {stats["unknown_char"]}；共 {stats["msgs"]} 条消息')
    print(f'生成样本 {stats["rows"]} 条 × 权重 {a.weight} = {stats["rows"] * a.weight} 行 → {a.out}')

if __name__ == '__main__':
    main()
