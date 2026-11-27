#!/usr/bin/env python3
"""用云端 API（DeepSeek）自问自答生成对话素材。

「你说你回」：让模型同时写用户那句和角色回复，产出成对的训练素材。
产物写进 xingye-sync/scripts/，origin='api'（权重按「采用」×2，不是手写档）。

用法：
  python3 gen-api-dialogue.py --char 沈慕言 --scene 日常 --rounds 6
  python3 gen-api-dialogue.py --char 沈慕言,虞曼宁 --scene 日常,冲突 --rounds 6
"""
from __future__ import annotations
import argparse, glob, json, os, re, sys, time, urllib.request

CHAR_DIR = '/home/don0ox1/xingye-sync/characters'
SCRIPT_DIR = '/home/don0ox1/xingye-sync/scripts'
API = 'https://api.deepseek.com/v1/chat/completions'
KEY_FILE = os.path.expanduser('~/.config/xingye/api.env')

# 预设：任何 OpenAI 兼容接口都能用（--base-url 覆盖）
PROVIDERS = {
    'deepseek': ('https://api.deepseek.com/v1', 'deepseek-flash', 'DEEPSEEK_API_KEY'),
    'grok':     ('https://api.x.ai/v1',          'grok-4',         'XAI_API_KEY'),
    'openai':   ('https://api.openai.com/v1',    'gpt-4o',         'OPENAI_API_KEY'),
}

SCENES = {
    '日常': '两人在家里，一天结束，随口聊天。不要大场面，就是琐碎的生活感。',
    '冲突': '两人因为一件事起了争执，话说得不好听，但底下有情绪。',
    '亲近': '两人靠得很近，气氛暧昧但没有挑明，靠动作和停顿说话。',
    '试探': '一方向另一方试探底细/态度，话里带钩子，谁也不肯先露底。',
    '久别': '隔了很久没见，重逢时的第一段对话，克制着不表现得太明显。',
    '试探底线': '对方在越界，角色既抗拒又退让，拒绝的话说得很轻。',
}

SYS_RULES = """怎么演：
1. 第一人称，说出口的话直接写，不加引号。
2. 动作、神态、环境都写进（）里，一条回复最多两处，别每句都加。
3. 动作要跟眼前这件事有关，别用「微微一笑」这种放哪都行的空动作。
4. 回合一两句话说清就停，不总结、不跳时间、不替对方做决定或写对方的心理。
5. 角色的性格落在具体的话和动作里，不直接说出来。"""


def lean_system(card: dict) -> str:
    lines = [f"你现在扮演「{card['name']}」，不是 AI 助手，就是这个角色本人。", '']
    if card.get('tagline'):
        lines += [f"一句话设定：{card['tagline']}", '']
    if card.get('persona'):
        lines += ['人物设定：', card['persona'], '']
    if card.get('scenario'):
        lines += ['背景：', card['scenario'], '']
    lines.append(SYS_RULES)
    return '\n'.join(lines)


def gen_prompt(character_sys: str, scene: str, rounds: int, greeting: str) -> str:
    opening = f"角色说的第一句（已存在，不要重复写）：{greeting}\n" if greeting else ''
    return f"""{character_sys}

---
你现在的任务**不是**扮演，而是**写一段对话素材**。

场景：{scene}
{opening}写 {rounds} 个来回（{rounds} 句用户 + {rounds} 句角色），要求：

- 「用户」那一侧：短、口语、像真人临时想起来的，可以带（）里的动作，偶尔不完整。
- 「角色」那一侧：严格按上面的设定和「怎么演」来写。
- 两句之间要有真实的你来我往：接住对方的话、反驳、转移话题、沉默都行，别写成问答手册。
- 不要旁白、不要总结、不要跳时间。整段就是眼前这一小会儿。

只输出 JSON，格式：
{{"turns":[{{"role":"user","content":"..."}},{{"role":"assistant","content":"..."}}]}}"""


def read_key(name='API_KEY'):
    """按优先级找 key：环境变量 → api.env 里的 <NAME> → 通用 API_KEY"""
    v = os.environ.get(name)
    if v:
        return v.strip()
    try:
        for line in open(KEY_FILE):
            if line.startswith(name + '='):
                return line.split('=', 1)[1].strip()
    except OSError:
        pass
    return open(KEY_FILE).read().split('API_KEY=')[1].strip()


def call_api(messages, model='deepseek-flash', temperature=0.95, max_tokens=2000,
             base_url=None, api_key=None, json_mode=True):
    url = (base_url or API).rstrip('/')
    if not url.endswith('/chat/completions'):
        url += '/chat/completions'
    body_obj = {
        'model': model, 'messages': messages, 'temperature': temperature,
        'max_tokens': max_tokens,
    }
    if json_mode:
        body_obj['response_format'] = {'type': 'json_object'}
    body = json.dumps(body_obj).encode()
    req = urllib.request.Request(url, body, {
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (api_key or read_key()),
    })
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.load(r)
    return (d['choices'][0]['message'].get('content') or ''), d.get('usage') or {}


STAR = re.compile(r'\*([^*\n]{1,120}?)\*')


def norm_markup(text: str) -> str:
    """统一记号：训练数据里一律用（）包动作/环境，不用 *星号*（用户手写素材就是这么写的）。"""
    return STAR.sub(lambda m: '（' + m.group(1).strip() + '）', text)


def clean_turns(raw: str):
    text = raw.strip()
    m = re.search(r'\{[\s\S]*\}', text)
    if not m:
        return []
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return []
    turns = []
    for t in (obj.get('turns') or []):
        role = t.get('role')
        content = str(t.get('content') or '').strip()
        if role in ('user', 'assistant') and content:
            turns.append({'role': role, 'content': norm_markup(content)})
    # 必须以角色回复结尾，且至少 2 轮
    while turns and turns[-1]['role'] != 'assistant':
        turns.pop()
    return turns if sum(1 for t in turns if t['role'] == 'assistant') >= 2 else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--char', required=True, help='角色名，逗号分隔')
    ap.add_argument('--scene', default='日常', help='场景（见 SCENES），逗号分隔')
    ap.add_argument('--rounds', type=int, default=5)
    ap.add_argument('--provider', default='deepseek', help='deepseek / grok / openai / 任意')
    ap.add_argument('--base-url', default='', help='覆盖接口地址（OpenAI 兼容）')
    ap.add_argument('--model', default='', help='模型名；留空用 provider 默认')
    ap.add_argument('--api-key-env', default='', help='从哪个环境变量取 key')
    ap.add_argument('--repeat', type=int, default=1, help='每个组合生成几份')
    args = ap.parse_args()

    prov_base, prov_model, prov_env = PROVIDERS.get(args.provider, ('', 'deepseek-flash', 'API_KEY'))
    base_url = args.base_url or prov_base
    model_name = args.model or prov_model
    api_key = read_key(args.api_key_env or prov_env) if args.base_url or args.provider in PROVIDERS else None
    print(f'provider={args.provider} model={model_name} url={base_url}')
    cards = {c['name']: c for c in (json.load(open(f)) for f in glob.glob(CHAR_DIR + '/*.json'))}
    scenes = [s.strip() for s in args.scene.split(',') if s.strip()]
    out = []
    for name in [x.strip() for x in args.char.split(',') if x.strip()]:
        card = cards.get(name)
        if not card:
            print(f'❌ 没有角色「{name}」（现有：{", ".join(cards)}）')
            continue
        system = lean_system(card)
        greeting = (card.get('greeting') or '').strip()
        for scene in scenes:
            desc = SCENES.get(scene, scene)
            for rep in range(args.repeat):
                try:
                    content, usage = call_api([
                        {'role': 'system', 'content': gen_prompt(system, desc, args.rounds, greeting)},
                        {'role': 'user', 'content': '开始写。'},
                    ], model=model_name, base_url=base_url, api_key=api_key)
                except urllib.error.HTTPError as e:
                    print(f'  ❌ {name}/{scene} API {e.code}: {e.read().decode()[:120]}')
                    continue
                turns = clean_turns(content)
                if not turns:
                    print(f'  ⚠ {name}/{scene} 解析失败，原始开头：{content[:80]!r}')
                    continue
                turns_full = ([{'role': 'assistant', 'content': norm_markup(greeting)}] if greeting else []) + turns
                script = {
                    'id': os.urandom(8).hex(),
                    'title': f'{name}·{scene}（api）' + (f'-{rep+1}' if args.repeat > 1 else ''),
                    'system': system, 'turns': turns_full, 'origin': 'api', 'autoGen': False,
                    'createdAt': int(time.time() * 1000), 'updatedAt': int(time.time() * 1000),
                }
                os.makedirs(SCRIPT_DIR, exist_ok=True)
                json.dump(script, open(os.path.join(SCRIPT_DIR, script['id'] + '.json'), 'w'),
                          ensure_ascii=False, indent=2)
                out.append(script)
                a = sum(1 for t in turns if t['role'] == 'assistant')
                print(f'  ✅ {name}/{scene}: {a} 条角色回复 · {usage.get("total_tokens")} tok')
                print(f'      {turns[1]["content"][:70] if len(turns) > 1 else turns[0]["content"][:70]}')
    print(f'\n写出 {len(out)} 个素材到 {SCRIPT_DIR}')


if __name__ == '__main__':
    main()
