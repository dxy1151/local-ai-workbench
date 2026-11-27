#!/usr/bin/env python3
"""给素材打质量分，挑出可用的（主要针对云端 API 生成的）。

打分维度全部来自踩过的坑：
  出戏（自称名字/AI/提扮演）          -100
  用 *星号*（和训练约定不一致）        -100
  剧本格式「角色名：」                -100
  括号旁白化（（）占整条一半以上）     -25
  空动作（微微一笑/挑了挑眉…）        -12/次
  旁白词（就这样/不知过了多久/仿佛）   -10/次
  说教（你应当/我理解你的感受）        -15/次
  整条没有真台词（括号外少于6字）      -20/次
  同一条里句子重复                    -18/次
  同一素材的回复开头雷同（8字）        -8/次
  括号过多（>3）                      -6/次
  太短(<15字) / 太长(>200字)          -10

用法：python3 curate-scripts.py [--apply] [--keep-ratio 0.6] [--dedupe]
"""
from __future__ import annotations
import argparse, glob, json, os, re
from collections import Counter

SCRIPT_DIR = '/home/don0ox1/xingye-sync/scripts'

FATAL = [
    (re.compile(r'我(?:的)?名字(?:叫|是)'), '自称名字'),
    (re.compile(r'我是(?:AI|人工智能|语言模型|助手|一个模型)'), '自称AI'),
    (re.compile(r'作为(?:一个)?(?:AI|人工智能|语言模型)'), '自称AI'),
    (re.compile(r'(?:请|建议)(?:你)?(?:尊重|保持)(?:我的)?边界'), '边界话术'),
]
STAR = re.compile(r'\*[^*\n]{1,80}\*')
SCRIPT_FMT = re.compile(r'^[^\s：:]{1,8}[：:]\s')
EMPTY_ACT = ['微微一笑', '挑了挑眉', '耸了耸肩', '勾了勾嘴角', '抿了抿嘴唇', '挑了挑眉梢',
             '淡淡一笑', '轻轻一笑', '嘴角上扬']
NARRATION = ['就这样', '接下来', '不知过了多久', '几分钟后', '之后你们', '仿佛', '似乎',
             '心里想', '暗自', '你感到', '他觉得', '她知道']
PREACH = ['你应当', '你应该', '我理解你的感受', '我明白你的', '建议你', '希望你能够']


def has_speech(reply: str) -> int:
    """括号外真正说出口的字数"""
    outside = re.sub(r'（[^）]*）', '', reply)
    outside = re.sub(r'\([^)]*\)', '', outside)
    return len(re.sub(r'[\s\W]', '', outside))


def score_script(d) -> tuple[int, list[str]]:
    replies = [t['content'] for t in d.get('turns', []) if t['role'] == 'assistant']
    if not replies:
        return 0, ['无回复']
    s = 100
    why = Counter()

    for r in replies:
        t = r.strip()
        if STAR.search(t):
            return 0, ['用星号']
        if SCRIPT_FMT.search(t):
            return 0, ['剧本格式']
        for pat, tag in FATAL:
            if pat.search(t):
                return 0, [tag]
        if len(t) < 15:
            s -= 10; why['太短'] += 1
        if len(t) > 200:
            s -= 10; why['太长'] += 1
        inside = sum(len(x) for x in re.findall(r'（[^）]*）', t))
        if len(t) and inside / len(t) > 0.5:
            s -= 25; why['旁白化'] += 1
        if has_speech(t) < 6:
            s -= 20; why['没台词'] += 1
        for w in EMPTY_ACT:
            if w in t: s -= 12; why['空动作'] += 1
        for w in NARRATION:
            if w in t: s -= 10; why['旁白词'] += 1
        for w in PREACH:
            if w in t: s -= 15; why['说教'] += 1
        sents = [x.strip() for x in re.split(r'[。！？!?\n]', t) if len(x.strip()) >= 8]
        if len(sents) != len(set(sents)):
            s -= 18; why['句子重复'] += 1
        if t.count('（') > 3:
            s -= 6; why['括号过多'] += 1

    # 开头雷同：同一素材里多条回复前 8 字一样
    heads = [re.sub(r'\s+', '', r)[:8] for r in replies]
    for h, n in Counter(heads).items():
        if n > 1:
            s -= 8 * (n - 1); why['开头雷同'] += n - 1
    return max(0, s), [f'{k}×{v}' for k, v in why.items()]


def jaccard(a: str, b: str) -> float:
    def grams(t):
        t = re.sub(r'\s+', '', t)
        return {t[i:i + 2] for i in range(len(t) - 1)}
    A, B = grams(a), grams(b)
    return len(A & B) / len(A | B) if (A or B) else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--keep-ratio', type=float, default=0.6)
    ap.add_argument('--min-score', type=int, default=0)
    ap.add_argument('--dedupe', type=float, default=0.5, help='近似重复阈值，0=关闭')
    ap.add_argument('--show', type=int, default=8)
    args = ap.parse_args()

    items = []
    for f in glob.glob(os.path.join(SCRIPT_DIR, '*.json')):
        d = json.load(open(f))
        items.append((f, d))

    api = [(f, d) for f, d in items if (d.get('origin') or 'handwritten') != 'handwritten']
    hw = len(items) - len(api)

    scored = []
    for f, d in api:
        sc, why = score_script(d)
        scored.append((sc, f, d, why))
    scored.sort(key=lambda x: -x[0])

    # 去重：分数高的保留
    drop_dup = set()
    if args.dedupe > 0:
        texts = [(f, ' '.join(t['content'] for t in d.get('turns', []) if t['role'] == 'assistant'))
                 for _, f, d, _ in scored]
        for i in range(len(texts)):
            if texts[i][0] in drop_dup: continue
            for j in range(i + 1, len(texts)):
                if texts[j][0] in drop_dup: continue
                if jaccard(texts[i][1], texts[j][1]) >= args.dedupe:
                    drop_dup.add(texts[j][0])

    n_keep = max(1, int(len(scored) * args.keep_ratio))
    keep, drop = [], []
    for idx, (sc, f, d, why) in enumerate(scored):
        if f in drop_dup:
            drop.append((sc, d, why + ['近似重复']))
        elif sc >= args.min_score and len(keep) < n_keep:
            keep.append((sc, f, d))
        else:
            drop.append((sc, d, why + ['分数偏低']))

    print(f'API 素材 {len(scored)} 个 → 保留 {len(keep)}，剔除 {len(drop)}（含近似重复 {len(drop_dup)}）')
    print(f'分数分布：最高 {scored[0][0]}，中位 {scored[len(scored)//2][0]}，最低 {scored[-1][0]}')
    print(f'\n=== 保留的（前 {args.show} 个示例）')
    for sc, f, d in keep[:args.show]:
        print(f'  {sc:3}  {d.get("title","")[:24]:26} {next((t["content"] for t in d["turns"] if t["role"]=="assistant"), "")[:56]}')
    print(f'\n=== 剔除的（前 {args.show} 个）')
    for sc, d, why in drop[:args.show]:
        print(f'  {sc:3}  {d.get("title","")[:24]:26} {why}')

    if args.apply:
        for sc, f, d in drop and [(s, None, dd) for s, dd in []] or []:
            pass
        # 写回标记
        keep_files = {f for _, f, _ in keep}
        for f, d in items:
            if (d.get('origin') or 'handwritten') == 'handwritten':
                continue
            bad = f not in keep_files
            if bool(d.get('rejected')) != bad:
                if bad:
                    d['rejected'] = True
                else:
                    d.pop('rejected', None); d.pop('rejectReason', None)
                json.dump(d, open(f, 'w'), ensure_ascii=False, indent=2)
        print(f'\n已写回：{len(keep)} 个合格、{len(drop)} 个标记 rejected')


if __name__ == '__main__':
    main()
