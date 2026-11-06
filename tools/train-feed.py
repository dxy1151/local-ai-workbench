#!/usr/bin/env python3
"""把训练进度写成 RSS feed，手机/平板的阅读器直接订阅。

为什么用 RSS：训练要跑 9 小时，人不可能一直盯着终端。
RSS 阅读器每隔一段时间自动拉一次，有新进展就推通知，
手机锁屏也能看到，不用给我开任何账号权限。

用法：
  # 手动生成一次
  python3 tools/train-feed.py --out /mnt/data4t/xingye-chat-portable/public/train.xml

  # 后台每 5 分钟刷新
  python3 tools/train-feed.py --watch --interval 300

数据来源：
  /tmp/auto-v13.log        v13 流程日志
  /tmp/auto-v12m.log       v12m 流程日志
  /tmp/bench-*.log         归档测试日志
  ~/训练归档/summary-*.md   已完成的对比表

输出：
  <out> 指定的 XML 文件（同时写一份 feed-status.json 方便排查）
"""
import argparse
import glob
import html
import json
import os
import re
import time
from datetime import datetime, timezone, timedelta
from email.utils import format_datetime
from pathlib import Path

TZ = timezone(timedelta(hours=8))
SRC = Path.home() / 'xingye-chat'

# 要盯的日志：(显示名, 路径, 标签)
LOGS = [
    ('v13 训练（rounds 50 长对话）', '/tmp/auto-v13.log', 'v13'),
    ('v12m 训练（rounds 20）', '/tmp/auto-v12m.log', 'v12m'),
    ('v11k 归档测试', '/tmp/bench-v11k.log', 'v11k'),
]

# 关键事件：命中就单独成一条 RSS item
KEY = re.compile(r'(✅|❌|🔔|🎉|训练完成|部署完成|合并完成|量化完成|训练已启动|开始监控|全流程完成)')

SUMMARY_GLOB = str(Path.home() / '训练归档' / 'summary-*.md')


def read_tail(path: str, n: int = 40) -> list[str]:
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
        return [l.rstrip('\n') for l in lines[-n:]]
    except OSError:
        return []


def parse_ts(line: str):
    """从 '[11-06 05:30:22] ...' 这样的行里取时间。"""
    m = re.match(r'\[(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]', line)
    if not m:
        return None
    now = datetime.now(TZ)
    mo, d, h, mi, s = (int(x) for x in m.groups())
    try:
        dt = now.replace(month=mo, day=d, hour=h, minute=mi, second=s, microsecond=0)
    except ValueError:
        return None
    # 跨月修正：如果解析出来的比现在晚很多，说明是上个月的
    if dt > now + timedelta(days=1):
        dt = dt.replace(year=dt.year - 1)
    return dt


OK_PAT = re.compile(r'(✅|🎉|训练完成|部署完成|全流程完成|下载完成|合并完成|量化完成)')
BAD_PAT = re.compile(r'(❌|失败|error|Error|Traceback|can.t open|No such file|超时|stopped|STOPPED)')


def health() -> tuple[bool, str]:
    """只看「有没有问题」，不铺开细节。

    为什么这样：RSS 阅读器是拿来快速扫一眼的，一行结论就够。
    真有问题我自己连过来看日志，不需要在手机上读几十行 traceback。
    """
    issues = []
    oks = []
    for title, path, tag in LOGS:
        lines = read_tail(path, 40)
        if not lines:
            issues.append(f'{tag}: 日志是空的，流程可能没起来')
            continue
        txt = '\n'.join(lines)
        # 只看**最后一条**状态行：老日志里留着已经修掉的报错，
        # 拿它判断会把「现在好好的」误报成「有问题」。
        tail_lines = [l.strip() for l in lines if l.strip()]
        bad = [l for l in tail_lines[-3:] if BAD_PAT.search(l)]
        if bad:
            issues.append(f'{tag}: ' + bad[-1][:60])
        # 进程还活着吗（本地流程用 systemd 单元名判断）
        elif OK_PAT.search(txt):
            oks.append(tag)
    if issues:
        return False, '有问题：' + '；'.join(issues[:3])
    return True, '正常：' + ('、'.join(oks) if oks else '流程在跑') + '，没检测到报错'


def collect_items() -> list[dict]:
    items: list[dict] = []

    for title, path, tag in LOGS:
        lines = read_tail(path, 60)
        if not lines:
            continue
        # 最后一行当"当前状态"
        last = next((l for l in reversed(lines) if l.strip()), '')
        state = last.strip() or '（无输出）'
        when = parse_ts(last) or datetime.now(TZ)
        items.append({
            'title': f'[{title}] {state[:80]}',
            'desc': '\n'.join(lines[-25:]),
            'at': when,
            'guid': f'{tag}-state-{when.strftime("%Y%m%d%H%M")}',
            'category': tag,
        })
        # 关键事件单独出条目
        for l in lines:
            if not KEY.search(l):
                continue
            ts = parse_ts(l)
            if not ts:
                continue
            items.append({
                'title': f'[{title}] {l.strip()[:90]}',
                'desc': l.strip(),
                'at': ts,
                'guid': f'{tag}-ev-{hash(l) & 0xffffff}',
                'category': tag,
            })

    # 已完成的对比表
    for p in sorted(glob.glob(SUMMARY_GLOB))[-3:]:
        try:
            text = Path(p).read_text(encoding='utf-8')
        except OSError:
            continue
        mtime = datetime.fromtimestamp(os.path.getmtime(p), TZ)
        items.append({
            'title': f'[对比报告] {Path(p).name}',
            'desc': text,
            'at': mtime,
            'guid': f'summary-{Path(p).name}',
            'category': 'report',
        })

    # 去重 + 按时间倒序
    seen = set()
    uniq = []
    for it in sorted(items, key=lambda x: x['at'], reverse=True):
        if it['guid'] in seen:
            continue
        seen.add(it['guid'])
        uniq.append(it)

    # 只留一条：当前健康状态。RSS 是扫一眼用的，不需要流水账。
    ok, msg = health()
    now = datetime.now(TZ)
    head = {
        'title': ('✅ ' if ok else '⚠️ ') + msg,
        'desc': msg,
        'at': now,
        'guid': f"health-{now.strftime('%Y%m%d%H%M')}",
        'category': 'ok' if ok else 'issue',
    }
    return [head]


def build_xml(items: list[dict], base_url: str) -> str:
    now = datetime.now(TZ)
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        '<channel>',
        '<title>星野训练监测</title>',
        f'<link>{html.escape(base_url)}</link>',
        '<description>本地训练进度：v12m / v13 / 归档测试</description>',
        '<language>zh-CN</language>',
        f'<lastBuildDate>{format_datetime(now)}</lastBuildDate>',
        f'<atom:link href="{html.escape(base_url)}" rel="self" type="application/rss+xml"/>',
    ]
    for it in items:
        parts += [
            '<item>',
            f'<title>{html.escape(it["title"])}</title>',
            f'<description><![CDATA[{it["desc"]}]]></description>',
            f'<pubDate>{format_datetime(it["at"])}</pubDate>',
            f'<guid isPermaLink="false">{html.escape(it["guid"])}</guid>',
            f'<category>{html.escape(it["category"])}</category>',
            '</item>',
        ]
    parts += ['</channel>', '</rss>']
    return '\n'.join(parts)


def write_once(out: str, base_url: str) -> int:
    items = collect_items()
    xml = build_xml(items, base_url)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    tmp = out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(xml)
    os.replace(tmp, out)          # 原子替换，阅读器不会读到半个文件
    # 附一份 JSON 便于排查
    with open(out.replace('.xml', '.json'), 'w', encoding='utf-8') as f:
        json.dump([{**i, 'at': i['at'].isoformat()} for i in items], f,
                  ensure_ascii=False, indent=1)
    return len(items)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='/mnt/data4t/xingye-chat-portable/public/train.xml')
    ap.add_argument('--base-url', default='http://127.0.0.1:5178/train.xml')
    ap.add_argument('--watch', action='store_true')
    ap.add_argument('--interval', type=int, default=300)
    args = ap.parse_args()

    while True:
        try:
            n = write_once(args.out, args.base_url)
            print(f'[{datetime.now(TZ):%H:%M:%S}] 写入 {n} 条 → {args.out}', flush=True)
        except Exception as e:  # noqa: BLE001
            print(f'[{datetime.now(TZ):%H:%M:%S}] ❌ {e}', flush=True)
        if not args.watch:
            break
        time.sleep(args.interval)


if __name__ == '__main__':
    main()
