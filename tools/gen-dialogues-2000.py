#!/usr/bin/env python3
# 用云端 API 批量生成角色扮演训练对话（默认目标：约 2000 条「角色回复」训练样本）。
#
# 为什么这么干：本地模型质量不行，根因是数据量太少（新风格唯一的素材只有 79 条）。
# 这里用工作台里真实的角色卡 + 完整的系统提示词（含 v1.7.5 的规则）去让云端模型
# 「演」出一段段对话，再把每段拆成训练样本 —— 语感/格式/规则都跟线上一致。
#
# 用法：
#   python3 gen-dialogues-2000.py --dialogues 500 --workers 12
#   （每段对话框 4 个来回 = 4 条 assistant 样本 → 500 段 ≈ 2000 条训练样本）
#
# 输出：
#   <out>/dialogues.jsonl   原始对话（system + turns），方便复查
#   <out>/train.jsonl       训练样本（messages 数组，可直接喂 train_qlora.py）
#   <out>/cost.json         本次 token 用量与估算费用
import argparse, json, os, random, re, sys, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

WB = 'http://127.0.0.1:5178'
API = 'https://api.deepseek.com/v1/chat/completions'
MODEL = 'deepseek-flash'
OUT = '/mnt/data4t/训练数据（归档）/API生成/v2-2000'

# 多把 Key 轮着用（余额各自独立）。从环境变量读，**不要**写进代码 —— 仓库是公开的。
#   export DEEPSEEK_KEYS="sk-xxx,sk-yyy"
KEYS = [k.strip() for k in os.environ.get('DEEPSEEK_KEYS', '').split(',') if k.strip()]
if not KEYS:
    raise SystemExit('未配置 DEEPSEEK_KEYS 环境变量（逗号分隔多把 key）')

TRAD = set('開還們這說來時過個沒為麼車東頭見長門問聽買賣錢幾給對後裏裡兒兩從會實當學覺讓無舊處號語話誰應該體發變樣點數隻雙邊關係願聲與嗎羅啟夢陳')

# 场景种子：尽量覆盖日常/冲突/亲密/时间推进，避免模型每次都写同一种开头
SCENES = [
    '傍晚刚到家，屋里灯还没开全，两个人在门口换鞋。',
    '半夜，一个人先醒了，另一个人在装睡，屋里只有风扇声。',
    '周末早上，阳光晒进来，一个人赖床不想起。',
    '饭桌上，菜快凉了，一个人一直在看手机，另一个想说话。',
    '下雨天，两个人挤在同一个屋檐下等雨停。',
    '一个人刚被上司骂完回来，进门就去冰箱拿酒。',
    '一个人生病发烧，另一个翻箱倒柜找退烧药。',
    '两个人为了钱的事吵起来，谁都不肯先低头。',
    '深夜阳台，烟抽了一半，说起很久以前的一件事。',
    '早上赶时间，一个人帮另一个人系领带/拉拉链。',
    '一个人在收拾行李，另一个站在门口看着，不帮忙也不走。',
    '停电了，两个人摸黑找蜡烛，手碰到一起。',
    '节日/纪念日，一个人装作忘了，另一个其实准备了东西。',
    '刚洗完澡，头发还在滴水，两个人隔着浴室门说话。',
    '一个人喝多了，被另一个半扶半架着回家。',
    '早上醒来，发现对方已经出门了，只留了张纸条。',
    '两个人在超市里推着车，为了买什么拌嘴。',
    '一个人靠在窗边看外面，另一个从背后走过来。',
    '加班到很晚，一个人趴在桌上睡着了，另一个回来看到。',
    '去医院拿报告，两个人在走廊上坐着等叫号。',
]


def beijing_now():
    from datetime import datetime, timezone, timedelta
    return datetime.now(timezone.utc) + timedelta(hours=8)


def in_peak():
    """DeepSeek 高峰：北京时间周一至周五 9:00-12:00、14:00-18:00（节假日忽略，按工作日近似）。"""
    t = beijing_now()
    if t.weekday() >= 5:   # 周六日全天空闲
        return False
    hm = t.hour * 60 + t.minute
    return (9 * 60 <= hm < 12 * 60) or (14 * 60 <= hm < 18 * 60)


def sleep_until_idle():
    """睡到下一个空闲时段开始（高峰时用来省钱）。"""
    while in_peak():
        t = beijing_now()
        hm = t.hour * 60 + t.minute
        if 9 * 60 <= hm < 12 * 60:
            target = 12 * 60
        else:
            target = 18 * 60
        wait = target - hm
        log(f'现在是高峰时段（{t.strftime("%H:%M")}），等 {wait} 分钟到空闲时段再开始…')
        time.sleep(min(wait * 60, 600))


def log(m):
    print(f'[{time.strftime("%H:%M:%S")}] {m}', flush=True)


def get_json(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def load_characters():
    chars = get_json(WB + '/api/characters')['characters']
    out = []
    for c in chars:
        cast = c.get('cast') or []
        try:
            d = get_json(f"{WB}/api/script/character-system?id={c['id']}&preset=global&local=1")
            system = d['system']
        except Exception as e:
            log(f'跳过「{c["name"]}」：取系统提示词失败 {e}')
            continue
        if not system or len(system) < 200:
            continue
        out.append({'id': c['id'], 'name': c['name'], 'system': system, 'is_multi': len(cast) >= 2,
                    'cast': [x.get('name') for x in cast]})
    return out


def build_meta(character, scene, turns_per_dialog=4):
    multi = character['is_multi']
    extra = ''
    if multi:
        names = '、'.join(character.get('cast') or [])
        extra = (f'\n7. 这是多人物场景（{names}）：角色侧的每一段都必须用「名字：内容」的格式，'
                 f'名字只能是人物表里的人；这一轮让 1~2 个人开口即可，不用每次全员。')
    return f'''你是一个专门生成「角色扮演训练数据」的编剧。请按下面的要求写一段对话，只输出 JSON。

场景种子（可以自由发挥细节，但不要改变人物关系）：{scene}

要求：
1. 对话里只有「用户」和「角色」两方：用户先说话，角色回一段；共 {turns_per_dialog} 个来回。
2. 用户的话 10~60 字，像真人随口说的，可以有（）包着的动作；不要替角色写动作。
3. 角色的回复按系统提示词要求的篇幅（一般 60~180 字），必须遵守系统提示词里的全部规则：第一人称、（）里写动作/环境、
   有具体细节（手里的东西、声音、光线、气味）、不注水、不复述、不写旁白总结、不替用户行动。
4. 每一轮角色**先直接回应对方这句话**（回答/接住），再写动作或推进；不许答非所问，
   也不许忽然换话题、换地点、换人。整段里时间可以慢慢往前（吃完、天黑），但必须从眼前的事长出来。
5. 用户没提到的人、东西、吃的、事件，角色不要凭空写出来；不要为了"有画面"硬塞无关的串串/烤串/路人/新人物。
6. 不要复读：同一句话不说第二遍，不重复上一轮的动作和句式。
7. 口语化、自然，不要 Markdown、不要出现 AI/模型/扮演/设定 这些词。
8.{extra or ' 台词要能听出人物性格，不要每段都用同一种开头。'}
9. 只输出 JSON：{{"turns":[{{"role":"user","content":"..."}},{{"role":"assistant","content":"..."}}, ...]}}'''


def call_api(key, messages, max_tokens=1400, retries=2):
    body = json.dumps({
        'model': MODEL, 'messages': messages, 'temperature': 0.95, 'max_tokens': max_tokens,
        'response_format': {'type': 'json_object'},
        # 数据生成不需要思考：省时间省钱（思考 token 也按输出计费）
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


def clean_assistant(text):
    t = str(text or '').strip()
    t = re.sub(r'^```[a-z]*\n?|```$', '', t).strip()
    return t


def valid_dialogue(obj, character, turns_per_dialog):
    turns = (obj or {}).get('turns')
    if not isinstance(turns, list) or len(turns) < 4:
        return None, 'turns 太少'
    out = []
    for t in turns:
        role = str((t or {}).get('role') or '').strip()
        content = str((t or {}).get('content') or '').strip()
        if role not in ('user', 'assistant') or not content:
            return None, '角色/内容不合法'
        out.append({'role': role, 'content': content})
    if out[0]['role'] != 'user':
        return None, '不是从用户开始'
    for i in range(1, len(out)):
        if out[i]['role'] == out[i - 1]['role']:
            return None, '没交替'
    if out[-1]['role'] != 'assistant':
        return None, '最后不是角色回复'
    n_assist = sum(1 for x in out if x['role'] == 'assistant')
    if n_assist < max(2, turns_per_dialog - 1):
        return None, '角色回复太少'
    for i, x in enumerate(out):
        c = x['content']
        if any(ch in TRAD for ch in c):
            return None, '有繁体字'
        if re.search(r'\b(AI|ChatGPT|大模型|语言模型)\b|扮演|设定', c):
            return None, '有出戏的元信息'
        if x['role'] == 'user':
            if not (4 <= len(c) <= 120):
                return None, '用户话太长/太短'
        else:
            if not (50 <= len(c) <= 320):
                return None, f'角色回复长度 {len(c)} 不合格'
            if re.search(r'^(作为|我是|好的，|当然可以)', c):
                return None, '助手腔'
    if character['is_multi']:
        names = character.get('cast') or []
        pat = '|'.join(re.escape(n) for n in names if n)
        if not pat or not any(re.search(rf'^\s*({pat})[：:]', x['content'], re.M)
                              for x in out if x['role'] == 'assistant'):
            return None, '多人卡没写名字：'
    return out, ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dialogues', type=int, default=500, help='生成多少段对话（每段 4 条角色样本）')
    ap.add_argument('--turns', type=int, default=4, help='每段对话几个来回')
    ap.add_argument('--workers', type=int, default=12)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--char-limit', type=int, default=0, help='只用前 N 个角色（调试用）')
    ap.add_argument('--seed', type=int, default=20261102, help='随机种子（换种子 = 换场景顺序，避免重复）')
    ap.add_argument('--wait-idle', action='store_true',
                    help='如果现在是 DeepSeek 高峰时段，先睡到空闲时段再开始（高峰价翻倍）')
    ap.add_argument('--scene-offset', type=int, default=0, help='场景种子表整体后移，换个开头')
    ap.add_argument('--cutoff', default='', help='北京时间自动截止（如 06:00）：过了这个点就不再采集')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    if args.cutoff:
        hh, mm = (int(x) for x in args.cutoff.split(':'))
        now = beijing_now()
        cutoff_min = hh * 60 + mm
        if now.hour * 60 + now.minute > cutoff_min:
            log(f'已经过了采集截止时间 {args.cutoff}（现在 {now:%H:%M}），不再采集')
            return
        log(f'采集截止时间 {args.cutoff}，现在 {now:%H:%M}，继续')
    if args.wait_idle:
        sleep_until_idle()

    chars = load_characters()
    if args.char_limit:
        chars = chars[:args.char_limit]
    if not chars:
        sys.exit('没有可用角色')
    multi = [c for c in chars if c['is_multi']]
    single = [c for c in chars if not c['is_multi']]
    log(f'角色 {len(chars)} 个（多人 {len(multi)} / 单人 {len(single)}）')

    # 分配：多人卡额外多给一些，单人平均分
    plan = []
    extra_multi = args.dialogues // 6 if multi else 0
    base = max(1, (args.dialogues - extra_multi * len(multi)) // max(1, len(single))) if single else 0
    for c in single:
        plan += [c] * base
    for c in multi:
        plan += [c] * extra_multi
    rng = random.Random(args.seed)
    rng.shuffle(plan)
    plan = plan[:args.dialogues]
    log(f'计划生成 {len(plan)} 段对话，约 {len(plan) * args.turns} 条角色样本')

    res_lock = threading.Lock()
    stats = {'ok': 0, 'fail': 0, 'in': 0, 'out': 0, 'cached': 0, 'trials': 0}
    dialogues_path = os.path.join(args.out, 'dialogues.jsonl')
    rawf = open(dialogues_path, 'w', encoding='utf-8')

    def work(idx_item):
        i, ch = idx_item
        key = KEYS[i % len(KEYS)]
        scene = SCENES[(i + args.scene_offset) % len(SCENES)]
        meta = build_meta(ch, scene, args.turns)
        try:
            content, usage = call_api(key, [
                {'role': 'system', 'content': ch['system']},
                {'role': 'user', 'content': meta},
            ])
        except Exception as e:
            with res_lock:
                stats['fail'] += 1
            return None, f'请求失败 {e}'
        try:
            obj = json.loads(content)
        except Exception:
            with res_lock:
                stats['fail'] += 1
            return None, 'JSON 解析失败'
        turns, why = valid_dialogue(obj, ch, args.turns)
        if not turns:
            with res_lock:
                stats['fail'] += 1
            return None, why
        with res_lock:
            stats['ok'] += 1
            stats['in'] += int(usage.get('prompt_tokens') or 0)
            stats['out'] += int(usage.get('completion_tokens') or 0)
            stats['cached'] += int(usage.get('prompt_cache_hit_tokens') or 0)
            rawf.write(json.dumps({'character': ch['name'], 'is_multi': ch['is_multi'],
                                   'system': ch['system'], 'turns': turns}, ensure_ascii=False) + '\n')
            rawf.flush()
            if stats['ok'] % 25 == 0:
                log(f"进度 {stats['ok']}/{len(plan)} 失败 {stats['fail']}  tokens in={stats['in']} out={stats['out']}")
        return (ch, turns), ''

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(work, (i, ch)) for i, ch in enumerate(plan)]
        results = []
        for f in as_completed(futs):
            r, why = f.result()
            if r:
                results.append(r)
            elif why:
                with res_lock:
                    stats.setdefault('why', {})
                    stats['why'][why] = stats['why'].get(why, 0) + 1
    rawf.close()

    # 组装训练样本：每个角色回复一条（带它之前的历史）
    rows = []
    seen = set()
    for ch, turns in results:
        for i, t in enumerate(turns):
            if t['role'] != 'assistant':
                continue
            msgs = [{'role': 'system', 'content': ch['system']}]
            for x in turns[:i + 1]:
                msgs.append({'role': x['role'], 'content': x['content']})
            key = (msgs[0]['content'][:80], msgs[-2]['content'][:60] if len(msgs) > 2 else '')
            if key in seen:
                continue
            seen.add(key)
            rows.append({'messages': msgs})
    out_path = os.path.join(args.out, 'train.jsonl')
    with open(out_path, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')

    # 费用估算（DeepSeek 官方价，当前是空闲时段：输入未命中 1元/M，命中 0.02元/M，输出 4元/M）
    cost = stats['in'] / 1e6 * 1.0 + stats['out'] / 1e6 * 4.0
    cost = max(0, cost - stats['cached'] / 1e6 * (1.0 - 0.02))
    cost_info = {**stats, 'rows': len(rows), 'dialogues': len(results),
                 'seconds': round(time.time() - t0, 1), 'cost_cny_idle': round(cost, 3),
                 'cost_cny_peak': round(cost * 2, 3)}
    with open(os.path.join(args.out, 'cost.json'), 'w', encoding='utf-8') as f:
        json.dump(cost_info, f, ensure_ascii=False, indent=2)
    log(f"完成：{len(results)} 段对话 → {len(rows)} 条训练样本")
    log(f"tokens：输入 {stats['in']}（缓存命中 {stats['cached']}）/ 输出 {stats['out']}")
    log(f"费用估算：空闲 ¥{cost:.2f} / 高峰 ¥{cost*2:.2f}；用时 {cost_info['seconds']}s")
    if stats.get('why'):
        log('失败原因：' + json.dumps(stats['why'], ensure_ascii=False))
    log(f'输出：{out_path}')


if __name__ == '__main__':
    main()
