#!/usr/bin/env python3
"""训练数据归档：热 → 冷，真人 / API生成分开存。

约定的两个目录（2026-11-01 定）：

  冷（归档，训练只从这里拿数据）
    /mnt/data4t/训练数据（归档）/
  热（暂存，浏览器「⬇ 导出聊天记录」默认落到这里，导出完就该归档）
    /home/don0ox1/下载/训练数据（热）/

冷目录结构（本脚本维护）：

  真人对话/
    会话导出/     由工作台「🧠 训练 / 导出训练数据」产生的 sess-*.jsonl、gold-*.jsonl、
                  xingye-*.jsonl、v2-*.jsonl、dpo/mini-dpo 等（真实聊天记录）
    素材导出/     手写素材导出的 script-*.jsonl（origin 不是 api/multi 的）
    聊天记录/     「⬇ 导出聊天记录」下载的 .md（从热目录自动搬进来）
  API生成/        我调 API 生成的合成样本，**单独放**，方便训练时排除或单独加权
    素材导出/     origin=api / multi 的手写素材导出（script-*.jsonl）
    style2/       新「详细但不冗长」风格样本（rows-style2-multi/single.jsonl）
    multi3/       旧多人素材（rows-duo*.jsonl 等）
  训练集/         实际喂给 QLoRA 的成品 jsonl（gemma-train*.jsonl）

用法：
  python3 tools/archive-training-data.py            # 归档一次并打印清单
  python3 tools/archive-training-data.py --dry-run  # 只看会动哪些文件
"""
import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

COLD = Path('/mnt/data4t/训练数据（归档）')
HOT = Path('/home/don0ox1/下载/训练数据（热）')
LLM_DATA = Path(os.environ.get('LLM_CHAT_DATA', '/home/don0ox1/deepseek/llm-chat/data'))
SCRIPTS = Path('/home/don0ox1/xingye-sync/scripts')

REAL_SESSION_GLOBS = [
    'sess-*.jsonl',
    'gold-*.jsonl',
    'xingye-*.jsonl',
    'v2-*.jsonl',
    'dpo-clean.jsonl',
    'mini-dpo-short.jsonl',
    'rp_sample.jsonl',
]
API_DIRS = ['style2', 'multi3']
TRAIN_GLOB = 'gemma-train*.jsonl'

MOVED = []   # (src, dst)
SKIPPED = []


def log(msg):
    print(msg, flush=True)


def move(src: Path, dst_dir: Path, dry: bool):
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / src.name
    if dst.exists():
        # 同名：加时间戳，不覆盖
        stamp = time.strftime('%Y%m%d-%H%M%S')
        dst = dst_dir / f'{src.stem}.{stamp}{src.suffix}'
    if not dry:
        shutil.move(str(src), str(dst))
    MOVED.append((src, dst))
    log(f'  {"[dry] " if dry else ""}{src}  →  {dst}')


def api_text_set():
    """工作台素材库里 origin=api / multi 的那些「台词」原文。

    导出成训练样本时 system 会被 buildMessages 改写，不能按 system 比对；
    但 user / assistant 的每一句都是从素材里原样搬过来的，所以按台词文本比对。
    """
    out = set()
    if not SCRIPTS.is_dir():
        return out
    for f in SCRIPTS.glob('*.json'):
        try:
            d = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        if str(d.get('origin') or '') not in ('api', 'multi'):
            continue
        for t in d.get('turns') or []:
            c = str((t or {}).get('content') or '').strip()
            if c:
                out.add(c)
    return out


def split_script_export(path: Path, api_texts: set):
    """把一份 script-*.jsonl 拆成（API生成行, 手写行）。

    一行 = 一份素材导出的训练样本。它的每一句台词都能在 API 素材里找到 → API 生成；
    否则就是自己手写（或从别处来的）样本。
    """
    api_rows, real_rows = [], []
    try:
        with path.open(encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                said = [str(m.get('content') or '').strip() for m in (row.get('messages') or [])
                        if m.get('role') in ('user', 'assistant')]
                if said and all(x in api_texts for x in said):
                    api_rows.append(row)
                else:
                    real_rows.append(row)
    except Exception as e:
        log(f'  ⚠️ 读不了 {path.name}：{e}')
        return [], []
    return api_rows, real_rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    dry = args.dry_run

    if not COLD.is_dir():
        sys.exit(f'冷目录不存在（/mnt/data4t 没挂？）：{COLD}')

    real_sess = COLD / '真人对话' / '会话导出'
    real_scrib = COLD / '真人对话' / '素材导出'
    real_md = COLD / '真人对话' / '聊天记录'
    api_scrib = COLD / 'API生成' / '素材导出'
    api_style2 = COLD / 'API生成' / 'style2'
    api_multi3 = COLD / 'API生成' / 'multi3'
    train_sets = COLD / '训练集'
    for d in (real_sess, real_scrib, real_md, api_scrib, api_style2, api_multi3, train_sets):
        d.mkdir(parents=True, exist_ok=True)

    # 1) 热目录：浏览器导出的 .md 聊天记录 → 冷/真人对话/聊天记录
    log(f'\n[1] 热目录 → 冷/真人对话/聊天记录：{HOT}')
    if HOT.is_dir():
        for f in sorted(HOT.iterdir()):
            if f.is_file() and f.suffix.lower() in ('.md', '.txt'):
                move(f, real_md, dry)
    else:
        log(f'  （热目录不存在，跳过）')

    # 2) llm-chat/data 里工作台导出的训练样本
    log(f'\n[2] 工作台导出 → 冷/真人对话/会话导出：{LLM_DATA}')
    api_texts = api_text_set()
    log(f'  素材库里 API 生成的台词共 {len(api_texts)} 条，用于逐行区分 API / 手写')
    for pattern in REAL_SESSION_GLOBS:
        for f in sorted(LLM_DATA.glob(pattern)):
            if f.is_file():
                move(f, real_sess, dry)
    for f in sorted(LLM_DATA.glob('script-*.jsonl')):
        if not f.is_file():
            continue
        api_rows, real_rows = split_script_export(f, api_texts)
        written = []
        if api_rows:
            dst = api_scrib / f.name
            if not dry:
                dst.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in api_rows) + '\n', encoding='utf-8')
            written.append(dst)
            MOVED.append((f, dst))
        if real_rows:
            dst = real_scrib / f.name
            if not dry:
                dst.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in real_rows) + '\n', encoding='utf-8')
            written.append(dst)
            MOVED.append((f, dst))
        log(f'  {"[dry] " if dry else ""}{f.name} → API {len(api_rows)} 行 / 手写 {len(real_rows)} 行')
        if written and not dry:
            f.unlink()

    # 3) API 生成的原始素材目录
    log('\n[3] API 生成素材 → 冷/API生成/')
    for name, dst in (('style2', api_style2), ('multi3', api_multi3)):
        d = LLM_DATA / name
        if d.is_dir():
            for f in sorted(d.iterdir()):
                if f.is_file():
                    move(f, dst, dry)

    # 4) 成品训练集
    log('\n[4] 成品训练集 → 冷/训练集/')
    for f in sorted(LLM_DATA.glob(TRAIN_GLOB)):
        if f.is_file():
            move(f, train_sets, dry)

    # 5) 清单
    log('\n[5] 清单：')
    manifest = ['# 训练数据归档清单', '', f'更新时间：{time.strftime("%Y-%m-%d %H:%M:%S")}', '',
                '冷目录只放数据；训练脚本从这里读，API 生成的合成数据单独放在 API生成/。', '']
    for label, d in [('真人对话/会话导出', real_sess), ('真人对话/素材导出', real_scrib),
                     ('真人对话/聊天记录', real_md), ('API生成/素材导出', api_scrib),
                     ('API生成/style2', api_style2), ('API生成/multi3', api_multi3),
                     ('训练集', train_sets)]:
        files = sorted(p for p in d.iterdir()) if d.is_dir() else []
        size = sum(p.stat().st_size for p in files)
        log(f'  {label}: {len(files)} 个文件, {size / 1048576:.1f} MB')
        manifest.append(f'- `{label}`：{len(files)} 个文件，{size / 1048576:.1f} MB')
        for p in files[:200]:
            manifest.append(f'  - {p.name}')
        if len(files) > 200:
            manifest.append(f'  - …（另有 {len(files) - 200} 个）')
    if not dry:
        try:
            (COLD / 'MANIFEST.md').write_text('\n'.join(manifest) + '\n', encoding='utf-8')
            log(f'\n已写 {COLD / "MANIFEST.md"}')
        except Exception as e:
            log(f'写清单失败（不影响数据）：{e}')

    log(f'\n完成：移动 {len(MOVED)} 个文件{ "（dry-run，没有真的动）" if dry else "" }')


if __name__ == '__main__':
    main()
