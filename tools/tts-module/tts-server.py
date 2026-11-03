#!/usr/bin/env python3
# ============================================================================
#  本地 TTS 服务（OpenAI 兼容 /v1/audio/speech）—— piper + 中文音色，纯 CPU
#
#  工作台「朗读」直接填 http://127.0.0.1:18099/v1 就能用；不占显卡，和聊天/ComfyUI 互不影响。
#  音色在 ~/tts/voices/*.onnx（默认 huayan 女声、chaowen 男声）。
#
#  用法：venv/bin/python tools/tts-server.py [--port 18099] [--voices ~/tts/voices]
# ============================================================================
import argparse
import io
import json
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VOICES_DIR = os.environ.get('XINGYE_TTS_VOICES', os.path.expanduser('~/tts/voices'))
DEFAULT_VOICE = os.environ.get('XINGYE_TTS_DEFAULT', 'zh_CN-huayan-medium')

_lock = threading.Lock()
_voices = {}          # name -> (PiperVoice, lock)
_loaded_at = {}


def voice_usable(name):
    """pinyin 类型的音色（如 chaowen）需要 g2pW 中文查表数据，没装就标注不可用。"""
    try:
        meta = json.load(open(os.path.join(VOICES_DIR, f'{name}.onnx.json'), encoding='utf-8'))
    except Exception:
        return False
    if str(meta.get('phoneme_type', 'espeak')).lower() != 'pinyin':
        return True
    try:
        import importlib.util
        spec = importlib.util.find_spec('g2pw')
        return bool(getattr(spec, 'submodule_search_locations', None))
    except Exception:
        return False


def list_voices(usable_only=False):
    out = []
    try:
        for f in sorted(os.listdir(VOICES_DIR)):
            if f.endswith('.onnx'):
                name = f[:-5]
                if usable_only and not voice_usable(name):
                    continue
                out.append(name)
    except FileNotFoundError:
        pass
    return out


def resolve_voice(name):
    """把 model/voice 里填的名字解析成音色；支持别名、fuzzy 前缀。"""
    name = (name or '').strip()
    voices = list_voices(usable_only=True) or list_voices()
    if not voices:
        raise RuntimeError(f'没有找到任何音色：{VOICES_DIR}')
    aliases = {
        'alloy': DEFAULT_VOICE, 'default': DEFAULT_VOICE, 'female': DEFAULT_VOICE,
        'huayan': 'zh_CN-huayan-medium', 'chaowen': 'zh_CN-chaowen-medium',
        'male': 'zh_CN-chaowen-medium',
        'tts-1': DEFAULT_VOICE, 'piper': DEFAULT_VOICE,
    }
    key = name.lower()
    if key in aliases:
        name = aliases[key]
    usable = list_voices(usable_only=True)
    if name in usable:
        return name
    for v in usable:
        if v.lower() == name.lower() or v.lower().startswith(name.lower()):
            return v
    fallback = DEFAULT_VOICE if DEFAULT_VOICE in usable else (usable[0] if usable else DEFAULT_VOICE)
    if name != fallback:
        print(f'[tts] 音色 {name!r} 不可用（缺 g2pW 数据或没下载），回退到 {fallback}', flush=True)
    return fallback


def get_voice(name):
    name = resolve_voice(name)
    with _lock:
        if name not in _voices:
            from piper.voice import PiperVoice
            path = os.path.join(VOICES_DIR, f'{name}.onnx')
            t0 = time.time()
            _voices[name] = (PiperVoice.load(path), threading.Lock())
            _loaded_at[name] = time.time() - t0
            print(f'[tts] 已加载音色 {name}（{_loaded_at[name]:.1f}s）', flush=True)
        return name, _voices[name]


def synthesize_wav(text, voice_name, speed=1.0):
    from piper import SynthesisConfig
    name, (voice, vlock) = get_voice(voice_name)
    speed = max(0.5, min(2.0, float(speed or 1.0)))
    cfg = SynthesisConfig(length_scale=1.0 / speed)
    with vlock:
        chunks = list(voice.synthesize(text, syn_config=cfg))
    if not chunks:
        raise RuntimeError('模型没有生成任何音频')
    first = chunks[0]
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wav:
        wav.setnchannels(first.sample_channels)
        wav.setsampwidth(first.sample_width)
        wav.setframerate(first.sample_rate)
        wav.writeframes(b''.join(c.audio_int16_bytes for c in chunks))
    return buf.getvalue(), name


class Handler(BaseHTTPRequestHandler):
    server_version = 'xingye-tts-local/1.0'

    def log_message(self, fmt, *args):
        print(f'[{time.strftime("%H:%M:%S")}] ' + (fmt % args), flush=True)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0].rstrip('/')
        if path in ('/health', '/v1/health'):
            return self._json(200, {'ok': True, 'voices': list_voices(), 'usable': list_voices(usable_only=True), 'default': DEFAULT_VOICE})
        if path in ('/v1/models', '/models'):
            return self._json(200, {'object': 'list', 'data': [
                {'id': n, 'object': 'model', 'owned_by': 'local-piper',
                 'name': n, 'language': 'zh-CN', 'backend': 'piper-cpu'} for n in list_voices()
            ]})
        if path in ('/voices', '/v1/voices'):
            return self._json(200, {'voices': list_voices(), 'default': DEFAULT_VOICE})
        return self._json(404, {'error': {'message': f'unknown path {self.path}'}})

    def do_POST(self):
        path = self.path.split('?')[0]
        if not re.search(r'/audio/speech$', path):
            return self._json(404, {'error': {'message': f'unknown path {self.path}'}})
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > 2 * 1024 * 1024:
            return self._json(400, {'error': {'message': '请求体为空或太大'}})
        try:
            body = json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception as e:
            return self._json(400, {'error': {'message': f'JSON 解析失败：{e}'}})
        # OpenAI 字段：input / text；model / voice 二选一都能指定音色
        text = str(body.get('input') or body.get('text') or '').strip()
        if not text:
            return self._json(400, {'error': {'message': 'input 为空'}})
        # 去掉太长的一句话，避免一次合成几十秒（工作台已经按句切了，这里只兜底）
        if len(text) > 2000:
            text = text[:2000]
        voice_name = str(body.get('voice') or body.get('model') or DEFAULT_VOICE)
        speed = body.get('speed') or 1.0
        t0 = time.time()
        try:
            wav, used = synthesize_wav(text, voice_name, speed)
        except Exception as e:
            print(f'[tts] 合成失败：{e}', flush=True)
            return self._json(500, {'error': {'message': f'合成失败：{e}'}})
        self.send_response(200)
        # 工作台按 response_format 取的 Content-Type 只用来给 blob 打标；
        # 这里永远回 WAV（无损、不用额外编码器），浏览器都能直接播。
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('Content-Length', str(len(wav)))
        self.send_header('X-TTS-Voice', used)
        self.send_header('X-TTS-Seconds', f'{time.time() - t0:.2f}')
        self.end_headers()
        self.wfile.write(wav)
        print(f'[tts] {used} · {len(text)} 字 → {len(wav) / 1024:.0f} KB，{time.time() - t0:.2f}s', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=int(os.environ.get('XINGYE_TTS_PORT', '18099')))
    ap.add_argument('--host', default=os.environ.get('XINGYE_TTS_HOST', '127.0.0.1'))
    ap.add_argument('--voices', default=None)
    args = ap.parse_args()
    global VOICES_DIR
    if args.voices:
        VOICES_DIR = args.voices
    print(f'[tts] piper 本地 TTS 启动：http://{args.host}:{args.port}/v1  （音色目录 {VOICES_DIR}）', flush=True)
    print(f'[tts] 可用音色：{", ".join(list_voices()) or "（空）"}', flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
