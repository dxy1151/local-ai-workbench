#!/usr/bin/env python3
"""双上下文对聊生成训练数据（UltraChat 式）。

和以前的「单上下文自问自答」的区别：
  · 角色侧：一个模型实例，只看得到角色卡 + 用户说的话（历史只含"别人的话+自己说过的话"）
  · 用户侧：另一个模型实例，只拿到"普通用户"的人设 prompt + 角色说过的话
  · 两边**互相看不到对方的 system prompt**，所以不会角色粘连、不会替对方写心理
  · 每轮之间可以做「导演」注入（只进角色侧，不进对话正文），防止两边互相客气、原地打转

用法：
  python3 gen-dual-context.py --rounds 8 --dialogues 2            # 演示：每角色 2 段
  python3 gen-dual-context.py --chars 林栀,云庭 --rounds 8 --dialogues 6
  python3 gen-dual-context.py --pro-design 3 --rounds 8 --dialogues 2   # 先让 v4p 设计 3 个新角色

输出（默认写到冷目录/API生成/dual-v1/）：
  dialogues.jsonl   原始对话（角色 system + turns），方便复查
  train.jsonl       训练样本（每个角色回复一条，带历史）
  cost.json         token 用量与估算费用
"""
import argparse
import json
import os
import random
import re
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

WB = 'http://127.0.0.1:5178'
API = 'https://api.deepseek.com/v1/chat/completions'
CHAR_MODEL = 'deepseek-flash'          # 角色侧：便宜、稳
USER_MODEL = 'deepseek-v4-pro'         # 用户侧：更像真人，会误解/拒绝
DIRECTOR_MODEL = 'deepseek-flash'      # 导演：最便宜
OUT_DEFAULT = '/mnt/data4t/训练数据（归档）/API生成/dual-v1'

# 从环境变量读（仓库是公开的，密钥绝不入库）
#   export DEEPSEEK_KEYS="sk-xxx,sk-yyy"
KEYS = [k.strip() for k in os.environ.get('DEEPSEEK_KEYS', '').split(',') if k.strip()]
if not KEYS:
    raise SystemExit('未配置 DEEPSEEK_KEYS 环境变量（逗号分隔多把 key）')

def log(m):
    print(f'[{time.strftime("%H:%M:%S")}] {m}', flush=True)

def wb(path, method='GET', body=None):
    req = urllib.request.Request(WB + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def llm(key, model, messages, max_tokens, temperature, retries=2):
    body = json.dumps({
        'model': model, 'messages': messages, 'temperature': temperature, 'max_tokens': max_tokens,
        # 数据生成不需要思考：省时间省钱
        'reasoning_effort': 'none', 'thinking': {'type': 'disabled'},
    }).encode()
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(API, body, {
                'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.load(r)
            return d['choices'][0]['message'].get('content') or '', d.get('usage') or {}
        except Exception as e:
            last = e
            time.sleep(2 + i * 2)
    raise last

# ---------------- 两套 system prompt（关键：互相看不到对方那份） ----------------

def character_system(cid):
    d = wb(f'/api/script/character-system?id={cid}&preset=global&local=1')
    return d['system']

def user_system(char_name, tagline, scenario, seed):
    rng = random.Random(seed)
    traits = rng.choice([
        '你有点急，不太有耐心，说话直接',
        '你今天心情一般，容易误解对方的意思',
        '你有点防备，不太愿意立刻相信人',
        '你挺累的，话不多，但偶尔会突然问一句私事',
        '你带着一点试探，想看清对方是什么人',
    ])
    return f'''你现在是一个普通用户，不是 AI、不是作者、不是助手。
你正在和「{char_name}」聊天。{('对方的一句话设定：' + tagline) if tagline else ''}
场景：{scenario or '你们在一个日常场景里碰上了。'}
你的状态：{traits}。

规则：
1. 只写你自己的话和动作；动作写在（）里，一句话就好。不要替对方说话，不要写对方的心理，不要写旁白或总结。
2. 短句、口语，每轮不超过 40 字；偶尔带语气词。不要用书面语，不要长篇大论。
3. 你是「用户」这一侧：会误解、会不耐烦、会拒绝、会突然问不该问的；不要总是配合。
4. 不要换场景、不要引入上面没提过的新人物；场景就是上面写的那个，接着演。
5. 不要使用 Markdown，不要提到 AI/扮演/设定，不要输出解释。
只输出你这一轮要说的话（可以带一个（）动作），不要输出别的东西。'''

# ---------------- 导演注入（只进角色侧） ----------------

DIRECTOR_BEATS = [
    '对方突然提出一个不合理的要求，你要拒绝或讨价还价',
    '你被问到一件不想提的旧事，反应别太大但要能看出你在回避',
    '对方说了一句带刺的话，你要接住并且把气氛稳住',
    '你主动提起一个之前没说过的小秘密（很小，别夸张）',
    '时间往前走：天黑了/雨停了/该走了，你要用一个动作把它带出来',
]

def director_note(dialogue, key):
    lines = []
    for t in dialogue[-6:]:
        who = '对方' if t['role'] == 'user' else '你'
        lines.append(f'{who}：{t["content"][:80]}')
    prompt = ('下面是你们的对话片段：\n' + '\n'.join(lines) +
              '\n\n请给「你（角色）」下一轮一个简短的隐藏导演指令（25 字内），'
              '要求这轮有点变化、制造一点真实摩擦。只输出指令本身，不要解释。')
    try:
        txt, _ = llm(key, DIRECTOR_MODEL, [{'role': 'user', 'content': prompt}], 80, 0.9)
        return txt.strip().replace('\n', ' ')[:60]
    except Exception:
        return random.choice(DIRECTOR_BEATS)

# ---------------- 单段双上下文对聊 ----------------

def run_dialogue(ch, rounds, seed):
    rng = random.Random(seed)
    char_sys = ch['system']
    user_sys = user_system(ch['name'], ch.get('tagline') or '', ch.get('scenario') or '', seed)
    turns = []          # 真实对话正文（不带导演指令）
    char_msgs = [{'role': 'system', 'content': char_sys}]   # 角色侧看到的历史
    user_msgs = [{'role': 'system', 'content': user_sys}]   # 用户侧看到的历史
    stats = {'in': 0, 'out': 0}

    def add_usage(u):
        stats['in'] += int(u.get('prompt_tokens') or 0)
        stats['out'] += int(u.get('completion_tokens') or 0)

    # 先让用户开口
    for r in range(rounds):
        # 导演：每 5 轮，给角色侧单独加一句（只在这一轮生效）
        director = ''
        if r > 0 and r % 5 == 0:
            director = director_note(turns, KEYS[r % 2])
            char_msgs = list(char_msgs)
            char_msgs[0] = {'role': 'system', 'content': char_sys + f'\n\n【导演提示（系统内部，不要说出来）】本轮：{director}'}

        # ---- 用户侧开口 ----
        u_text = ''
        for attempt in range(3):
            txt, u = llm(KEYS[1], USER_MODEL, user_msgs, 90, 0.85)
            add_usage(u)
            txt = txt.strip().strip('"“”')
            txt = re.sub(r'^\[[^\]]*\]\s*', '', txt)
            # 用户太长的重生成（不截断）
            if 2 <= len(txt) <= 60:
                u_text = txt
                break
        if not u_text:
            u_text = txt[:50]
        user_msgs.append({'role': 'assistant', 'content': u_text})
        char_msgs.append({'role': 'user', 'content': u_text})
        turns.append({'role': 'user', 'content': u_text})

        # ---- 角色侧回复 ----
        a_text = ''
        base_sys = char_msgs[0]['content']
        for attempt in range(3):
            txt, u = llm(KEYS[0], CHAR_MODEL, char_msgs, 300, 0.95)
            add_usage(u)
            txt = txt.strip()
            if 60 <= len(txt) <= 260:
                a_text = txt
                break
            # 太短：把"写够字数"补进 system 再试一次（只影响生成，训练行仍用原 system）
            char_msgs[0] = {'role': 'system', 'content': base_sys
                            + '\n\n【本轮补充】上一版太短了：这一版至少写 70 字，'
                            + '补一个跟眼前事情有关的具体动作 + 一个场景里本来就有的细节。'}
        char_msgs[0] = {'role': 'system', 'content': base_sys}
        if not a_text:
            a_text = txt
        char_msgs.append({'role': 'assistant', 'content': a_text})
        user_msgs.append({'role': 'user', 'content': a_text})
        turns.append({'role': 'assistant', 'content': a_text})

        # 导演那句只对那一轮生效，不留在历史 system 里
        if director and char_msgs[0]['content'] != char_sys:
            char_msgs[0] = {'role': 'system', 'content': char_sys}

    return {'character': ch['name'], 'cid': ch['id'], 'system': char_sys,
            'is_multi': ch.get('is_multi', False), 'turns': turns, 'stats': stats}

# ---------------- v4-pro 设计角色（可选） ----------------

def pro_design(n, theme):
    out = []
    for i in range(n):
        prompt = f'''你是角色卡设计师。设计一个适合「角色扮演聊天」的角色，输出 JSON（不要解释）：
{{"name":"角色名(2~4字)","tagline":"一句话设定(20字内)",
  "persona":"人物设定：年龄职业、性格、说话习惯、和用户的关系（200~300字）",
  "scenario":"背景场景：两人此刻在哪、在做什么（60~100字）",
  "greeting":"开场白（60~120字，第一人称，动作写在（）里）"}}
题材：{theme}。再换一个方向，别和之前重复。'''
        txt, _ = llm(KEYS[0], USER_MODEL, [{'role': 'user', 'content': prompt}], 900, 0.95)
        try:
            card = json.loads(txt)
        except Exception:
            continue
        card = {k: str(card.get(k) or '').strip() for k in ('name', 'tagline', 'persona', 'scenario', 'greeting')}
        if not card['name'] or not card['persona']:
            continue
        try:
            created = wb('/api/characters', 'POST', card)
            ch = created.get('character') or created
            ch['system'] = character_system(ch['id'])
            ch['is_multi'] = len(ch.get('cast') or []) >= 2
            out.append(ch)
            log(f'v4p 设计角色：{ch["name"]}（{ch["id"]}）')
        except Exception as e:
            log(f'角色保存失败：{e}')
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chars', default='', help='逗号分隔的角色名（默认用库里全部）')
    ap.add_argument('--pro-design', type=int, default=0, help='先用 v4-pro 设计 N 个新角色')
    ap.add_argument('--theme', default='都市现实题材，成年人的情感关系，普通职业但性格鲜明', help='设计角色的题材')
    ap.add_argument('--rounds', type=int, default=8)
    ap.add_argument('--dialogues', type=int, default=2, help='每个角色生成几段')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--out', default=OUT_DEFAULT)
    ap.add_argument('--max-train-rows', type=int, default=2000)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    chars = []
    if args.pro_design:
        chars += pro_design(args.pro_design, args.theme)
    allc = wb('/api/characters')['characters']
    if args.chars:
        names = [x.strip() for x in args.chars.split(',') if x.strip()]
        for n in names:
            c = next((x for x in allc if x['name'] == n), None)
            if not c:
                log(f'⚠️ 没有角色「{n}」，跳过'); continue
            c['system'] = character_system(c['id'])
            c['is_multi'] = len(c.get('cast') or []) >= 2
            chars.append(c)
    elif not args.pro_design:
        for c in allc:
            c['system'] = character_system(c['id'])
            c['is_multi'] = len(c.get('cast') or []) >= 2
            chars.append(c)
    if not chars:
        sys.exit('没有可用角色')

    jobs = []
    for c in chars:
        for k in range(args.dialogues):
            jobs.append((c, 20261103 + hash(c['id']) % 1000 + k, k))
    log(f'角色 {len(chars)} 个，共 {len(jobs)} 段对话 × {args.rounds} 轮')

    lock = threading.Lock()
    results = []
    cost = {'in': 0, 'out': 0}
    def work(job):
        c, seed, k = job
        try:
            d = run_dialogue(c, args.rounds, seed)
            with lock:
                cost['in'] += d['stats']['in']
                cost['out'] += d['stats']['out']
                results.append(d)
            return True
        except Exception as e:
            log(f'❌ {c["name"]} 第{k+1}段失败：{e}')
            return False

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(work, j) for j in jobs]
        for f in as_completed(futs):
            f.result()

    # 写原始对话
    with open(os.path.join(args.out, 'dialogues.jsonl'), 'w', encoding='utf-8') as f:
        for d in results:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')

    # 组装训练样本：每个角色回复一条（带历史），过滤明显的坏样本
    rows = []
    for d in results:
        turns = d['turns']
        for i, t in enumerate(turns):
            if t['role'] != 'assistant':
                continue
            if not (45 <= len(t['content']) <= 260):
                continue
            msgs = [{'role': 'system', 'content': d['system']}]
            for x in turns[:i + 1]:
                msgs.append({'role': x['role'], 'content': x['content']})
            rows.append({'messages': msgs})
    random.Random(20261110).shuffle(rows)
    rows = rows[:args.max_train_rows]
    with open(os.path.join(args.out, 'train.jsonl'), 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')

    # 费用：角色/导演走 flash（空闲：输入1/M 输出4/M），用户侧走 v4-pro（4.5/M、13.5/M）
    # 粗略按一半一半估
    cost_cny = (cost['in'] / 2 / 1e6 * 1 + cost['out'] / 2 / 1e6 * 4
                + cost['in'] / 2 / 1e6 * 4.5 + cost['out'] / 2 / 1e6 * 13.5)
    info = {'dialogues': len(results), 'rows': len(rows), 'rounds': args.rounds,
            'tokens_in': cost['in'], 'tokens_out': cost['out'],
            'cost_cny_idle_est': round(cost_cny, 3)}
    with open(os.path.join(args.out, 'cost.json'), 'w', encoding='utf-8') as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    log(f'完成：{len(results)} 段 → {len(rows)} 条训练样本；tokens in={cost["in"]} out={cost["out"]}；约 ¥{cost_cny:.2f}')
    log(f'输出：{args.out}')

if __name__ == '__main__':
    main()
