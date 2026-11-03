#!/usr/bin/env python3
"""生成「多人模式」训练素材：角色侧每句都带「名字：」前缀。

为什么单独造：现有数据一条多人格式都没有，微调后的模型会把系统提示词里的
「名字：内容」要求压掉（实测 gemma3-12b-rp 输出完全不带名字）。

用法：
  python3 gen-api-multi.py --char 陈梦和罗启 --scene 来访,争吵 --rounds 4
"""
import argparse, glob, json, os, re, time, urllib.request

CHAR_DIR = '/home/don0ox1/xingye-sync/characters'
SCRIPT_DIR = '/home/don0ox1/xingye-sync/scripts'
WORKBENCH = 'http://127.0.0.1:5178'
KEY_FILE = os.path.expanduser('~/.config/xingye/api.env')
API = 'https://api.deepseek.com/v1/chat/completions'
MODEL = 'deepseek-flash'

SCENES = {
    '来访': '客人第一次上门，两个人都没想到会这么快见面，气氛有点僵。',
    '争吵': '两个人当着客人的面起了争执，一个想忍，一个憋不住。',
    '日常': '三个人在同一间屋子里，各做各的事，话赶话聊起来。',
    '试探': '客人想搞清楚这对夫妻的底细，两个人一个推一个挡。',
    '饭桌': '在饭桌上谈事，筷子动得慢，话里有话。',
    '深夜': '很晚了，灯只开一盏，说些白天不会说的话。',
    '为难': '客人提出一件让两个人都为难的事，两人反应完全不同。',
    '收尾': '客人要走，两个人都想留，说法却不一样。',
}


def api_key():
    for line in open(KEY_FILE):
        if line.startswith('MULTI_KEY='):
            return line.split('=', 1)[1].strip()
    return open(KEY_FILE).read().split('API_KEY=')[1].strip()


def character_system(name: str):
    """从工作台取这个角色的完整系统提示词（含多人规则）。"""
    chars = json.load(urllib.request.urlopen(WORKBENCH + '/api/characters', timeout=20))
    items = chars if isinstance(chars, list) else chars['characters']
    c = next((x for x in items if x['name'] == name), None)
    if not c:
        raise SystemExit(f'没有角色「{name}」')
    d = json.load(urllib.request.urlopen(
        f"{WORKBENCH}/api/script/character-system?id={c['id']}&preset=global", timeout=30))
    return c, d['system']


def call(messages, max_tokens=1800):
    body = json.dumps({'model': MODEL, 'messages': messages, 'temperature': 0.95,
                       'max_tokens': max_tokens,
                       'response_format': {'type': 'json_object'}}).encode()
    req = urllib.request.Request(API, body, {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + api_key()})
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.load(r)
    return d['choices'][0]['message'].get('content') or '', d.get('usage') or {}


def build_prompt(system: str, cast, scene: str, rounds: int) -> str:
    names = '、'.join(c['name'] for c in cast)
    roster = '\n'.join(f"- {c['name']}：{c.get('desc') or ''}" for c in cast)
    return f"""{system}

---
现在请**写一段对话素材**（不是扮演，是写作）。

场景：{scene}
人物：{roster}

硬性格式（必须遵守）：
- 「用户」那一侧：只有一个人（就是来看他们的客人），说话短、口语、可带（）动作。
- 「角色」那一侧：**每一句都必须以「名字：」开头**，名字只能是 {names} 之一，用全角冒号。
  换人说话就必须重新标名字；同一个人连着说可以只标一次。
  正确示例：
  陈梦：*把手在围裙上擦了擦* 您先坐。
  罗启：妈说今天不能留人吃饭……
  陈梦：你别总提你妈。
- 角色之间要真的你来我往：接话、反驳、打断、沉默，别写成轮流念台词。
- 每轮至少有一句是直接回应客人的。
- 不要旁白、不要总结、不要跳时间。整段就是眼前这一小会儿。

写 {rounds} 个来回（{rounds} 句客人 + {rounds} 组角色反应）。
只输出 JSON：{{"turns":[{{"role":"user","content":"..."}},{{"role":"assistant","content":"陈梦：...\n罗启：..."}}]}}"""


def clean(raw: str, cast_names):
    m = re.search(r'\{[\s\S]*\}', raw or '')
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
        if role == 'user' and content:
            turns.append({'role': 'user', 'content': content})
        elif role == 'assistant' and content:
            # 至少要有一行是「已知人物：」
            if not any(re.match(rf'^\*{{0,2}}{re.escape(n)}\s*[：:]', ln)
                       for n in cast_names for ln in content.split('\n')):
                return []
            turns.append({'role': 'assistant', 'content': content})
    while turns and turns[-1]['role'] != 'assistant':
        turns.pop()
    return turns if len([t for t in turns if t['role'] == 'assistant']) >= 2 else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--char', required=True)
    ap.add_argument('--scene', default='来访,争吵,日常')
    ap.add_argument('--rounds', type=int, default=4)
    ap.add_argument('--repeat', type=int, default=1)
    args = ap.parse_args()

    card, system = character_system(args.char)
    cast = card.get('cast') or []
    if len(cast) < 2:
        m = re.findall(r'^[ \t]*【人物】[ \t]*([^\n]{1,12})[ \t]*$', card.get('persona') or '', re.M)
        cast = [{'name': n.strip(), 'desc': ''} for n in m]
    if len(cast) < 2:
        raise SystemExit('这个角色没有 ≥2 个人物，先在上面的多人面板里加人物')
    names = [c['name'] for c in cast]
    print(f'角色 {args.char} · 人物 {names} · system {len(system)} 字')

    out = []
    for scene in [s.strip() for s in args.scene.split(',') if s.strip()]:
        desc = SCENES.get(scene, scene)
        for rep in range(args.repeat):
            try:
                content, usage = call([
                    {'role': 'system', 'content': build_prompt(system, cast, desc, args.rounds)},
                    {'role': 'user', 'content': '开始写。'},
                ])
            except urllib.error.HTTPError as e:
                print(f'  ❌ {scene} API {e.code}: {e.read().decode()[:100]}')
                continue
            turns = clean(content, names)
            if not turns:
                print(f'  ⚠ {scene} 格式不合格，丢弃：{content[:70]!r}')
                continue
            script = {
                'id': os.urandom(8).hex(),
                'title': f'{args.char}·多人{scene}' + (f'-{rep+1}' if args.repeat > 1 else ''),
                'system': system, 'turns': turns, 'origin': 'multi', 'autoGen': False,
                'createdAt': int(time.time() * 1000), 'updatedAt': int(time.time() * 1000),
            }
            os.makedirs(SCRIPT_DIR, exist_ok=True)
            json.dump(script, open(os.path.join(SCRIPT_DIR, script['id'] + '.json'), 'w'),
                      ensure_ascii=False, indent=2)
            out.append(script)
            speakers = re.findall(r'^\*{0,2}([^\s*：:]{1,12})\s*[：:]', '\n'.join(
                t['content'] for t in turns if t['role'] == 'assistant'), re.M)
            print(f'  ✅ {scene}: {len(turns)//2} 来回 · 说话人 {sorted(set(speakers))} · {usage.get("total_tokens")} tok')
    print(f'\n写出 {len(out)} 个多人素材')


if __name__ == '__main__':
    main()
