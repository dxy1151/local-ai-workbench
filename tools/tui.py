#!/usr/bin/env python3
"""星野 TUI（textual 版）—— 尽量对齐网页 GUI 的终端界面

为什么换 textual：blessed 是 2015 年的老库，滚动/清空/焦点一堆坑
（实测：点会话右侧不刷新、回车第二次就死）。textual 是现代框架，
自带 CSS 布局、鼠标、滚动容器、焦点管理。

布局（和网页一致）：
  ┌────────────┬──────────────────────────────┐
  │ 会话列表    │  对话区                       │
  │ （点击切换） │  （滚轮滚动、流式输出）        │
  │            │                              │
  ├────────────┴──────────────────────────────┤
  │ 输入框（Enter 发送 · 多行用 Shift+Enter）    │
  └───────────────────────────────────────────┘

用法：
  .venv-tui/bin/python tools/tui.py            # 进界面
  .venv-tui/bin/python tools/tui.py <会话id>    # 直接进
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx
from rich.text import Text
from textual import on, work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import Footer, Header, Input, Label, ListItem, ListView, Static

BASE = os.environ.get("WB_URL", "http://127.0.0.1:5178")
ENV_FILE = Path.home() / ".config/xingye-tunnel/env"


def read_password() -> str:
    if os.environ.get("WB_PASSWORD"):
        return os.environ["WB_PASSWORD"]
    try:
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("WORKBENCH_PASSWORD="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


class Workbench:
    """工作台的 HTTP 客户端（同步版，够用）。"""

    def __init__(self) -> None:
        # trust_env=False：不吃 ALL_PROXY 那些环境变量。
        # 这台机器设了 socks://127.0.0.1:7897，httpx 不认 socks 会直接抛
        # 「Unknown scheme for proxy URL」。工作台就在本机，本来也不需要代理。
        self.client = httpx.Client(
            base_url=BASE, timeout=300.0, follow_redirects=False, trust_env=False
        )
        self.logged_in = False

    def login(self) -> None:
        pw = read_password()
        if not pw:
            return
        try:
            r = self.client.post("/", data={"password": pw})
            # 登录成功会塞 cookie，httpx 自动存
            self.logged_in = r.status_code in (200, 302)
        except httpx.HTTPError:
            pass

    def get(self, path: str) -> dict:
        r = self.client.get(path)
        r.raise_for_status()
        return r.json()

    def put(self, path: str, body: dict) -> dict:
        r = self.client.put(path, json=body)
        r.raise_for_status()
        return r.json()

    def post(self, path: str, body: dict) -> dict:
        r = self.client.post(path, json=body)
        r.raise_for_status()
        return r.json()

    def stream(self, path: str, body: dict):
        """流式请求，逐块 yield 文本。"""
        with self.client.stream("POST", path, json=body) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                try:
                    d = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                if "text" in d:
                    yield d["text"]
                elif "replace" in d and d["replace"].get("text") is not None:
                    yield ("__replace__", d["replace"]["text"])
                elif "error" in d:
                    yield ("__error__", d["error"])


class SessionItem(ListItem):
    def __init__(self, sess: dict) -> None:
        super().__init__()
        self.sess = sess

    def compose(self) -> ComposeResult:
        direct = self.sess.get("kind") == "direct"
        icon = "↗" if direct else "●"
        title = (self.sess.get("title") or "无标题").replace("\n", " ")[:20]
        n = self.sess.get("messageCount", 0)
        t = Text()
        t.append(f"{icon} ", style="cyan" if direct else "green")
        t.append(title, style="white")
        t.append(f"  {n}", style="dim")
        yield Label(t)


class XingyeTUI(App):
    CSS = """
    Screen { layout: vertical; }
    #body { height: 1fr; }
    #left {
        width: 30;
        border: round $success;
        border-title-color: $success;
    }
    #chat-wrap {
        width: 1fr;
        border: round $accent;
        border-title-color: $accent;
    }
    #chat-scroll { height: 1fr; }
    #input {
        dock: bottom;
        height: 3;
        border: round $warning 50%;
        border-title-color: $warning;
    }
    #status-bar {
        dock: bottom;
        height: 1;
        background: $panel;
        color: $text-muted;
        padding: 0 1;
    }
    SessionItem { padding: 0 1; }
    SessionItem.--highlight { background: $accent 30%; }
    .msg-user { color: $success; }
    .msg-role { color: $warning; }
    .msg-meta { color: $text-muted; }
    """

    BINDINGS = [
        ("ctrl+c", "quit", "退出"),
        ("ctrl+r", "reload", "刷新列表"),
        ("ctrl+t", "toggle_think", "思考开关"),
        ("f1", "help", "帮助"),
    ]

    def __init__(self, initial_session: str | None = None) -> None:
        super().__init__()
        self.wb = Workbench()
        self.cfg: dict = {}
        self.sessions: list[dict] = []
        self.cur: dict | None = None
        self.streaming = False
        self.initial_session = initial_session
        # 自己维护聊天区的 Text 全文 —— 不去读 Static 的内部渲染值
        self.chat_text: Text = Text()

    # ---------- 界面 ----------
    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal(id="body"):
            with VerticalScroll(id="left"):
                yield ListView(id="sessions")
            with VerticalScroll(id="chat-wrap"):
                yield Static("", id="chat-scroll")
        yield Static("", id="status-bar")
        yield Input(placeholder="说点什么…（Enter 发送）", id="input")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "星野 TUI"
        self.wb.login()
        self.load_cfg()
        self.load_sessions()
        self.query_one("#input", Input).focus()

    # ---------- 数据 ----------
    @work(thread=True)
    def load_cfg(self) -> None:
        try:
            cfg = self.wb.get("/api/config")
        except Exception as e:  # noqa: BLE001
            self.call_from_thread(self.set_status, f"读配置失败：{e}")
            return
        self.call_from_thread(self._apply_cfg, cfg)

    def _apply_cfg(self, cfg: dict) -> None:
        self.cfg = cfg
        self.update_status()

    @work(thread=True)
    def load_sessions(self) -> None:
        try:
            data = self.wb.get("/api/sessions")
        except Exception as e:  # noqa: BLE001
            self.call_from_thread(self.set_status, f"读会话失败：{e}")
            return
        self.call_from_thread(self._apply_sessions, data.get("sessions") or [])

    def _apply_sessions(self, sessions: list[dict]) -> None:
        # 隐藏 0~1 条的空壳会话
        self.sessions = [s for s in sessions if (s.get("messageCount") or 0) > 1]
        lv = self.query_one("#sessions", ListView)
        lv.clear()
        for s in self.sessions:
            lv.append(SessionItem(s))

        target = None
        if self.initial_session:
            target = next(
                (s for s in self.sessions if s["id"].startswith(self.initial_session)),
                None,
            )
        if target is None and self.sessions:
            target = self.sessions[0]
        if target:
            lv.index = self.sessions.index(target)
            self.select_session(target)
        self.update_status()

    @work(thread=True)
    def select_session(self, sess: dict) -> None:
        try:
            full = self.wb.get(f"/api/sessions/{sess['id']}").get("session")
        except Exception as e:  # noqa: BLE001
            self.call_from_thread(self.set_status, f"打开失败：{e}")
            return
        try:
            chars = self.wb.get("/api/characters").get("characters") or []
        except Exception:  # noqa: BLE001
            chars = []
        ch = next((c for c in chars if c["id"] == full.get("characterId")), None)
        self.call_from_thread(self._render_session, sess, full, ch)

    def _render_session(self, sess: dict, full: dict, ch: dict | None) -> None:
        self.cur = {
            **sess,
            "direct": full.get("kind") == "direct",
            "characterName": (ch or {}).get("name", ""),
            "characterId": (ch or {}).get("id", ""),
            "title": full.get("title") or sess.get("title"),
        }
        box = self.query_one("#chat-wrap")
        direct = self.cur["direct"]
        box.border_title = "对话 · 直连（不注入角色卡）" if direct else f"对话 · 角色：{self.cur['characterName'] or '?'}"

        msgs = full.get("messages") or []
        self.chat_text = Text()
        if not msgs:
            self.chat_text.append("（还没有消息，在下面输入框说话）", style="dim")
        for i, m in enumerate(msgs[-60:]):
            if i:
                self.chat_text.append("\n")
            self.chat_text.append_text(self.format_msg(m))
        self.query_one("#chat-scroll", Static).update(self.chat_text)
        self.update_status()

    def format_msg(self, m: dict) -> Text:
        t = Text()
        who = m.get("role") == "user"
        if who:
            t.append("你: ", style="bold green")
        elif self.cur and self.cur["direct"]:
            t.append("模型: ", style="bold cyan")
        else:
            name = (self.cur or {}).get("characterName") or "角色"
            t.append(f"{name}: ", style="bold yellow")
        t.append(str(m.get("content") or ""))
        return t

    # ---------- 发送 ----------
    @on(Input.Submitted, "#input")
    def on_submit(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        event.input.value = ""
        if not text:
            return
        if not self.cur:
            self.set_status("先选个会话")
            return
        if self.streaming:
            self.set_status("正在生成，等它说完")
            return
        self.streaming = True
        self.append_text(self.format_msg({"role": "user", "content": text}))
        self.set_status("生成中…")
        self.do_chat(text)

    @work(thread=True, exclusive=True)
    def do_chat(self, text: str) -> None:
        cur = self.cur or {}
        path = "/api/direct/chat" if cur.get("direct") else "/api/chat"
        acc = ""
        chunks: list[str] = []
        try:
            for piece in self.wb.stream(path, {"sessionId": cur["id"], "content": text}):
                if isinstance(piece, tuple):
                    tag, val = piece
                    if tag == "__replace__":
                        acc = val
                    elif tag == "__error__":
                        self.call_from_thread(self.append_text, Text(f"✗ {val}", style="bold red"))
                    continue
                acc += piece
                chunks.append(piece)
                # 每攒够一点就推一次，避免每个字都刷新
                if len(chunks) >= 4:
                    joined = "".join(chunks)
                    chunks.clear()
                    self.call_from_thread(self.append_stream, joined)
            if chunks:
                self.call_from_thread(self.append_stream, "".join(chunks))
            self.call_from_thread(self.finish_stream)
        except Exception as e:  # noqa: BLE001
            self.call_from_thread(self.append_text, Text(f"✗ {e}", style="bold red"))
            self.call_from_thread(self.finish_stream)

    def append_stream(self, text: str) -> None:
        self.chat_text.append(text)
        self.query_one("#chat-scroll", Static).update(self.chat_text)

    def finish_stream(self) -> None:
        self.streaming = False
        self.chat_text.append("\n")
        self.query_one("#chat-scroll", Static).update(self.chat_text)
        self.update_status()
        self.query_one("#input", Input).focus()

    def append_text(self, t: Text) -> None:
        if len(self.chat_text):
            self.chat_text.append("\n")
        self.chat_text.append_text(t)
        static = self.query_one("#chat-scroll", Static)
        static.update(self.chat_text)
        static.scroll_end(animate=False)

    # ---------- 事件 ----------
    @on(ListView.Selected, "#sessions")
    def on_pick(self, event: ListView.Selected) -> None:
        item = event.item
        if isinstance(item, SessionItem):
            self.select_session(item.sess)

    def action_reload(self) -> None:
        self.load_sessions()
        self.set_status("已刷新会话列表")

    def action_toggle_think(self) -> None:
        if not self.cfg:
            return
        nxt = not self.cfg.get("thinkOff", False)
        try:
            self.wb.put("/api/config", {"thinkOff": nxt})
            self.cfg = self.wb.get("/api/config")
        except Exception as e:  # noqa: BLE001
            self.set_status(f"切换失败：{e}")
            return
        self.update_status()

    def action_help(self) -> None:
        self.set_status("Tab 切焦点 · 点会话切换 · Ctrl+R 刷新 · Ctrl+T 思考开关 · Ctrl+C 退出")

    # ---------- 状态栏 ----------
    def set_status(self, msg: str) -> None:
        self.query_one("#status-bar", Static).update(Text(msg, style="dim"))

    def update_status(self) -> None:
        if not self.cfg:
            return
        think = "思考关" if self.cfg.get("thinkOff") else "思考开"
        mode = ""
        if self.cur:
            mode = "直连" if self.cur.get("direct") else f"角色 {self.cur.get('characterName') or '?'}"
        self.set_status(
            f"{self.cfg.get('model', '?')} · {think} · {mode} · "
            f"{len(self.sessions)} 个会话 · Ctrl+T 思考 · Ctrl+R 刷新"
        )


def main() -> None:
    s = sys.argv[1] if len(sys.argv) > 1 else None
    XingyeTUI(initial_session=s).run()


if __name__ == "__main__":
    main()
