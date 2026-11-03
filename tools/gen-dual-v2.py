#!/usr/bin/env python3
"""双上下文对聊 v2：角色侧 flash / 用户侧 v4-pro / 每 5 轮导演 / 结束后把角色回复扩写到 100~150 字。

和 v1 的区别：
  · 支持长对话（50 轮）：每侧只保留最近 N 条历史，控制费用与上下文
  · 角色回复**生成后扩写**（方案 A）：保持内容不变、补到 100~150 字，让训练风格符合"详细但不冗长"
  · 分模型记账（flash 角色 / pro 用户 / flash 导演+扩写），带费用上限，超了就停

用法：
  python3 gen-dual-v2.py --pro-design 15 --chars "票客,倒模（女）,沈慕言,虞曼宁,天" --rounds 50 --dialogues 2
"""
import argparse, json, os, random, re, sys, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

WB = 'http://127.0.0.1:5178'
API = 'https://api.deepseek.com/v1/chat/completions'
CHAR_MODEL = 'deepseek-flash'
USER_MODEL = 'deepseek-v4-pro'
AUX_MODEL = 'deepseek-flash'
OUT_DEFAULT = '/mnt/data4t/训练数据（归档）/API生成/dual-v2'
# 从环境变量读（仓库是公开的，密钥绝不入库）：export DEEPSEEK_KEYS="sk-xxx,sk-yyy"
KEYS = [k.strip() for k in os.environ.get('DEEPSEEK_KEYS', '').split(',') if k.strip()]
if not KEYS:
    raise SystemExit('未配置 DEEPSEEK_KEYS 环境变量（逗号分隔多把 key）')
PRICE = {  # 空闲时段（元/百万 token）
    'deepseek-flash': {'in': 1.0, 'out': 4.0},
    'deepseek-v4-pro': {'in': 4.5, 'out': 13.5},
}
usage_lock = threading.Lock()
cost = {'by_model': {}, 'total': 0.0, 'rows': 0}
COST_CAP = 30.0
LOG = None

def log(m):
    line = f'[{time.strftime("%H:%M:%S")}] {m}'
    print(line, flush=True)
    if LOG:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')

def wb(path, method='GET', body=None):
    req = urllib.request.Request(WB + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def add_usage(model, u):
    with usage_lock:
        p = PRICE.get(model, PRICE['deepseek-flash'])
        tin = int(u.get('prompt_tokens') or 0)
        tout = int(u.get('completion_tokens') or 0)
        bm = cost['by_model'].setdefault(model, {'in': 0, 'out': 0, 'cny': 0.0})
        bm['in'] += tin; bm['out'] += tout
        bm['cny'] += tin / 1e6 * p['in'] + tout / 1e6 * p['out']
        cost['total'] += tin / 1e6 * p['in'] + tout / 1e6 * p['out']

def llm(key, model, messages, max_tokens, temperature, retries=2):
    body = json.dumps({'model': model, 'messages': messages, 'temperature': temperature,
                       'max_tokens': max_tokens, 'reasoning_effort': 'none',
                       'thinking': {'type': 'disabled'}}).encode()
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(API, body, {'Content-Type': 'application/json',
                                                     'Authorization': 'Bearer ' + key})
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.load(r)
            add_usage(model, d.get('usage') or {})
            if cost['total'] > COST_CAP:
                raise SystemExit(f'费用超过上限 ¥{COST_CAP}')
            return d['choices'][0]['message'].get('content') or ''
        except SystemExit:
            raise
        except Exception as e:
            last = e; time.sleep(2 + i * 2)
    raise last

def character_system(cid):
    return wb(f'/api/script/character-system?id={cid}&preset=global&local=1')['system']

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

DIRECTOR_BEATS = [
    '对方突然提出一个不合理的要求，你要拒绝或讨价还价',
    '你被问到一件不想提的旧事，反应别太大但要能看出你在回避',
    '对方说了一句带刺的话，你要接住并且把气氛稳住',
    '你主动提起一个之前没说过的小秘密（很小，别夸张）',
    '时间往前走：天黑了/雨停了/该走了，你要用一个动作把它带出来',
]

def director_note(turns, key, r):
    lines = [('对方' if t['role'] == 'user' else '你') + '：' + t['content'][:80] for t in turns[-6:]]
    prompt = ('下面是你们的对话片段：\n' + '\n'.join(lines) +
              '\n\n请给「你（角色）」下一轮一个简短的隐藏导演指令（25 字内），要求这轮有点变化、制造一点真实摩擦。只输出指令本身。')
    try:
        return llm(key, AUX_MODEL, [{'role': 'user', 'content': prompt}], 80, 0.9).strip().replace('\n', ' ')[:60]
    except Exception:
        return random.choice(DIRECTOR_BEATS)

def expand_reply(text):
    """方案 A：把角色回复扩写到 100~150 字（不改变内容）。"""
    if len(text) >= 100:
        return text
    prompt = ('把下面这段角色台词扩写到 100~150 字：保持人称、意思、动作顺序不变，'
              '只补跟眼前事情有关的具体动作、神态或场景细节；不要新增人物、事件或旁白总结。'
              '**代词严格**：角色自己永远用「我」，对方一律用「你」，不要出现「他/她」指代对方。'
              '直接输出改写后的整段，不要解释。\n\n原文：\n' + text)
    for _ in range(2):
        try:
            out = llm(KEYS[0], AUX_MODEL, [{'role': 'user', 'content': prompt}], 260, 0.8).strip()
            out = re.sub(r'^```.*\n?|```$', '', out).strip()
            if 90 <= len(out) <= 240 and not (('他' in out or '她' in out)
                                              and ('他' not in text and '她' not in text)):
                return out
        except Exception:
            pass
    return text

def run_dialogue(ch, rounds, seed, expand, hist_cap=12):
    rng = random.Random(seed)
    char_sys = ch['system']
    user_sys = user_system(ch['name'], ch.get('tagline') or '', ch.get('scenario') or '', seed)
    turns = []
    char_hist = []   # 角色看到的历史（不含 system）
    user_hist = []   # 用户看到的历史（不含 system）
    for r in range(rounds):
        if cost['total'] > COST_CAP:
            raise SystemExit('费用超上限')
        director = ''
        if r > 0 and r % 5 == 0:
            director = director_note(turns, KEYS[r % 2], r)
        char_sys_round = char_sys + (f'\n\n【导演提示（系统内部，不要说出来）】本轮：{director}' if director else '')

        # ---- 用户侧 ----
        u_text = ''
        u_hist = user_hist[-hist_cap:]
        for _ in range(3):
            txt = llm(KEYS[1], USER_MODEL, [{'role': 'system', 'content': user_sys}] + u_hist, 90, 0.85).strip()
            txt = re.sub(r'^\[[^\]]*\]\s*', '', txt).strip().strip('"“”')
            if 2 <= len(txt) <= 60:
                u_text = txt; break
        if not u_text:
            u_text = txt[:50]
        user_hist.append({'role': 'assistant', 'content': u_text})
        user_hist.append({'role': 'user', 'content': u_text})  # 占位，马上被角色回复替换
        char_hist.append({'role': 'user', 'content': u_text})
        turns.append({'role': 'user', 'content': u_text})

        # ---- 角色侧 ----
        a_text = ''
        base_msgs = [{'role': 'system', 'content': char_sys_round}] + char_hist[-hist_cap:]
        for attempt in range(3):
            txt = llm(KEYS[0], CHAR_MODEL, base_msgs, 300, 0.95).strip()
            if 45 <= len(txt) <= 300:
                a_text = txt; break
            base_msgs = [{'role': 'system', 'content': char_sys_round
                          + '\n\n【本轮补充】上一版太短：这一版至少写 70 字，补一个具体动作 + 一个场景细节。'}] + char_hist[-hist_cap:]
        if not a_text:
            a_text = txt
        if expand:
            a_text = expand_reply(a_text)
        char_hist.append({'role': 'assistant', 'content': a_text})
        # 用户侧历史里，上一轮以为自己是 assistant 的那条其实对应用户；角色回复是 user
        user_hist[-1] = {'role': 'user', 'content': a_text}
        turns.append({'role': 'assistant', 'content': a_text})
    return {'character': ch['name'], 'cid': ch['id'], 'system': char_sys,
            'is_multi': ch.get('is_multi', False), 'turns': turns}

def pro_design(n, theme):
    out = []
    used = []
    for i in range(n):
        avoid = ('已经设计过的角色（不要重复名字和身份）：' + '、'.join(used)) if used else ''
        prompt = (
            '你是角色卡设计师。设计一个适合「角色扮演聊天」的角色，只输出一个 JSON 对象（不要代码块、不要解释）：\n'
            '{"name":"角色名(2~4字)","tagline":"一句话设定(20字内)",'
            '"persona":"人物设定：年龄职业、性格、说话习惯、和用户的关系（200~300字）",'
            '"scenario":"背景场景：两人此刻在哪、在做什么（60~100字）",'
            '"greeting":"开场白（60~120字，第一人称，动作写在（）里）"}\n'
            f'题材：{theme}。{avoid}\n'
            '要求：换一个完全不同的职业/关系/性格，名字别用「陈默」这类烂大街的。'
        )
        card = None
        for attempt in range(3):
            try:
                txt = llm(KEYS[0], USER_MODEL, [{'role': 'user', 'content': prompt}], 900, 0.95)
                txt = txt.strip()
                txt = re.sub(r'^```[a-z]*\n?|```$', '', txt).strip()
                m = re.search(r'\{.*\}', txt, re.S)
                card = json.loads(m.group(0) if m else txt)
                break
            except Exception as e:
                log(f'设计角色失败（第 {attempt+1} 次）：{e}')
        if not card:
            continue
        card = {k: str(card.get(k) or '').strip() for k in ('name', 'tagline', 'persona', 'scenario', 'greeting')}
        if not card['name'] or not card['persona']:
            continue
        try:
            created = wb('/api/characters', 'POST', card)
            ch = created.get('character') or created
            ch['system'] = character_system(ch['id'])
            out.append(ch)
            used.append(ch['name'])
            log(f'v4p 设计角色：{ch["name"]}（{ch["id"]}）')
        except Exception as e:
            log(f'保存角色失败：{e}')
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chars', default='')
    ap.add_argument('--pro-design', type=int, default=0)
    ap.add_argument('--theme', default='都市现实题材，成年人的情感/交易关系；职业普通但性格鲜明')
    ap.add_argument('--rounds', type=int, default=50)
    ap.add_argument('--dialogues', type=int, default=2)
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--expand', type=int, default=1, help='1=角色回复扩写到 100~150 字')
    ap.add_argument('--hist-cap', type=int, default=12, help='每侧保留最近多少条历史（控制费用）')
    ap.add_argument('--out', default=OUT_DEFAULT)
    ap.add_argument('--cost-cap', type=float, default=30.0)
    args = ap.parse_args()
    global COST_CAP, LOG
    COST_CAP = args.cost_cap
    os.makedirs(args.out, exist_ok=True)
    LOG = os.path.join(args.out, 'run.log')

    allc = wb('/api/characters')['characters']
    chars = []
    if args.pro_design:
        chars += pro_design(args.pro_design, args.theme)
    if args.chars:
        for n in [x.strip() for x in args.chars.split(',') if x.strip()]:
            c = next((x for x in allc if x['name'] == n), None)
            if not c:
                log(f'⚠️ 没有角色「{n}」，跳过'); continue
            c = dict(c)
            c['system'] = character_system(c['id'])
            chars.append(c)
    log(f'角色 {len(chars)} 个：' + '、'.join(c['name'] for c in chars))
    jobs = [(c, 20261120 + i * 97 + k, k) for i, c in enumerate(chars) for k in range(args.dialogues)]
    log(f'计划 {len(jobs)} 段对话 × {args.rounds} 轮（扩写={"开" if args.expand else "关"}，费用上限 ¥{COST_CAP}）')

    results = []
    errors = 0
    lock = threading.Lock()
    def work(job):
        nonlocal errors
        c, seed, k = job
        try:
            d = run_dialogue(c, args.rounds, seed, bool(args.expand), args.hist_cap)
            with lock:
                results.append(d)
            log(f'完成 {c["name"]} 第{k+1}段（{len(d["turns"])//2} 轮）；累计费用 ¥{cost["total"]:.2f}')
            return d
        except SystemExit as e:
            raise
        except Exception as e:
            with lock:
                errors += 1
            log(f'❌ {c["name"]} 第{k+1}段失败：{e}')
            return None

    t0 = time.time()
    try:
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = [ex.submit(work, j) for j in jobs]
            for f in as_completed(futs):
                f.result()
    except SystemExit as e:
        log(f'⛔ 中止：{e}')

    with open(os.path.join(args.out, 'dialogues.jsonl'), 'w', encoding='utf-8') as f:
        for d in results:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')

    rows = []
    for d in results:
        turns = d['turns']
        for i, t in enumerate(turns):
            if t['role'] != 'assistant': continue
            if not (70 <= len(t['content']) <= 260): continue
            msgs = [{'role': 'system', 'content': d['system']}] + turns[:i + 1]
            rows.append({'messages': msgs})
    random.Random(20261120).shuffle(rows)
    with open(os.path.join(args.out, 'train.jsonl'), 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')

    info = {'dialogues': len(results), 'rows': len(rows), 'rounds': args.rounds,
            'errors': errors, 'seconds': round(time.time() - t0, 1),
            'cost_total_cny': round(cost['total'], 3), 'by_model': cost['by_model']}
    with open(os.path.join(args.out, 'cost.json'), 'w', encoding='utf-8') as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    log(f'完成：{len(results)} 段 → {len(rows)} 行；费用 ¥{cost["total"]:.2f}')
    log(f'分模型：{json.dumps(cost["by_model"], ensure_ascii=False)}')
    log(f'输出：{args.out}')

if __name__ == '__main__':
    main()
