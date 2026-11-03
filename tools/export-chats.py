#!/usr/bin/env python3
# 聊天记录导出到「Windows 也能看到的」NTFS 共享盘。
# 双系统：Windows 读不了 Linux 的 ext4 /home，但 /mnt/data4t、/mnt/data500 是 NTFS，
# Windows 里会显示成普通盘。这个脚本把聊天记录导出成 markdown（好看）和 JSON（完整备份）。
#
# 用法：python3 tools/export-chats.py [输出目录]
# 默认输出到 /mnt/data4t/xingye-chats（可在环境变量 XINGYE_EXPORT_DIR 覆盖）
import json, os, re, sys, time, glob

DATA = os.environ.get('XINGYE_DATA_DIR', os.path.expanduser('~/xingye-sync'))
OUT = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get('XINGYE_EXPORT_DIR', '/mnt/data4t/xingye-chats'))
SESSIONS = os.path.join(DATA, 'sessions')
CHARS = os.path.join(DATA, 'characters')

def load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None

def write_if_changed(path, text):
    """内容没变就不动文件（NTFS 上少写一次少一次风险/碎片）；变了一律 tmp+rename 原子替换。"""
    try:
        with open(path, encoding='utf-8') as f:
            if f.read() == text:
                return False
    except Exception:
        pass
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)
    return True

def safe_name(s, limit=60):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', ' ', str(s or '')).strip()
    return (s[:limit] or 'untitled').strip()

def fmt_time(ms):
    try:
        return time.strftime('%Y-%m-%d %H:%M', time.localtime(ms / 1000))
    except Exception:
        return ''

def main():
    if not os.path.isdir(SESSIONS):
        print(f'没有会话目录：{SESSIONS}')
        return 1
    os.makedirs(os.path.join(OUT, 'md'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'json'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'backup'), exist_ok=True)

    characters = []
    chars_by_id = {}
    for p in glob.glob(os.path.join(CHARS, '*.json')):
        c = load_json(p)
        if c:
            characters.append(c)
            if c.get('id'):
                chars_by_id[c['id']] = c
    sessions = []
    rows = []
    for p in sorted(glob.glob(os.path.join(SESSIONS, '*.json'))):
        if '.bak' in os.path.basename(p):
            continue
        s = load_json(p)
        if not s or not isinstance(s.get('messages'), list):
            continue
        sessions.append(s)
        sid = s.get('id', os.path.basename(p).split('.')[0])
        title = s.get('title') or (s.get('messages', [{}])[0].get('content', '')[:20]) or '未命名'
        char = chars_by_id.get(s.get('characterId')) or {}
        cname = char.get('name') or ('直连对话' if s.get('kind') == 'direct' else '未知角色')
        md = [f'# {title}', '',
              f'- 角色：{cname}', f'- 会话 ID：`{sid}`',
              f'- 创建：{fmt_time(s.get("createdAt"))}', f'- 最后更新：{fmt_time(s.get("updatedAt"))}', '', '---', '']
        for m in s['messages']:
            role = m.get('role')
            if role == 'system':
                continue
            who = '我' if role == 'user' else (m.get('speaker') or cname)
            if m.get('as'):
                who = f'我（{m["as"]}）'
            stamp = fmt_time(m.get('at')) if m.get('at') else ''
            md.append(f'**{who}**{(" · " + stamp) if stamp else ""}')
            md.append('')
            if m.get('reasoning'):
                md.append('> 💭 思考（' + str(len(m['reasoning'])) + ' 字）')
                for line in str(m['reasoning']).splitlines():
                    md.append('> ' + line)
                md.append('')
            md.append(str(m.get('content') or ''))
            md.append('')
        fn = f'{safe_name(cname)} - {safe_name(title, 40)} - {sid[:8]}.md'
        write_if_changed(os.path.join(OUT, 'md', fn), '\n'.join(md))
        # 原始 JSON 也拷一份（Windows 上能直接看/备份）
        write_if_changed(os.path.join(OUT, 'json', f'{sid}.json'),
                         json.dumps(s, ensure_ascii=False, indent=2))
        rows.append((s.get('updatedAt') or 0, cname, title, sid, fn))

    rows.sort(reverse=True)
    idx = ['# 聊天记录索引', '', f'- 导出时间：{time.strftime("%Y-%m-%d %H:%M:%S")}',
           f'- 会话数：{len(rows)}', f'- 角色数：{len(characters)}', '', '---', '']
    for _, cname, title, sid, fn in rows:
        idx.append(f'- [{title}](md/{fn.replace(" ", "%20")}) — {cname} · `{sid[:8]}`')
    write_if_changed(os.path.join(OUT, 'index.md'), '\n'.join(idx) + '\n')

    bundle = {'app': 'local-ai-workbench', 'version': 1, 'exportedAt': int(time.time() * 1000),
              'characters': characters, 'sessions': sessions}
    payload = json.dumps(bundle, ensure_ascii=False, indent=2)
    write_if_changed(os.path.join(OUT, 'backup', 'workbench-backup-latest.json'), payload)
    print(f'导出完成：{len(rows)} 个会话 → {OUT}（md/ json/ backup/ index.md）')
    return 0

if __name__ == '__main__':
    sys.exit(main())
