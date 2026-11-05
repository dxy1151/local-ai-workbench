#!/usr/bin/env python3
"""星野 TUI（textual）—— 按网页 GUI 的结构重做

布局对齐网页：
  ┌─ 角色 | 会话 ──────┬─ 对话 ──────────────────┐
  │ 小琴（第一次来…）   │ 角色：娟姐（老江湖）     │
  │ 丽姐（离过婚的）    │ 娟姐: （抬眼）五百。     │
  │ 小敏（欠了钱的）    │ 你: 包宿怎么算           │
  │ 阿香（夜市上来）    │ 娟姐: （把算账本抽回来）  │
  ├────────────────────┴────────────────────────┤
  │ 输入框（Enter 发送）                          │
  └──────────────────────────────────────────────┘

标签页（对应网页左侧那三个）：
  角色   点一个角色 → 对话区显示开场白，开始新对话
  会话   点一个已有会话 → 接着聊
  直连   直连会话（不注入角色卡）

快捷键：
  F2 / F3 / F4   切标签页（角色 / 会话 / 直连）
  Ctrl+N         新会话（用当前角色）
  Ctrl+R         刷新
  Ctrl+T         思考开关
  Ctrl+C         退出
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
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import (
    Button,
    Footer,
    Header,
    Input,
    Label,
    ListItem,
    ListView,
    Static,
    TabbedContent,
    TabPane,
)

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
    def __init__(self) -> None:
        # trust_env=False：不吃 ALL_PROXY。这台机器设了 socks://127.0.0.1:7897，
        # httpx 不认 socks，会直接抛 Unknown scheme。工作台就在本机，也不用代理。
        self.client = httpx.Client(
            base_url=BASE, timeout=300.0, follow_redirects=False, trust_env=False
        )

    def login(self) -> None:
        pw = read_password()
        if not pw:
            return
        try:
            self.client.post("/", data={"password": pw})
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


class CharItem(ListItem):
    """角色列表项"""

    def __init__(self, ch: dict) -> None:
        super().__init__()
        self.ch = ch

    def compose(self) -> ComposeResult:
        t = Text()
        t.append("? ", style="cyan")
        t.append(self.ch.get("name", "?")[:22], style="white")
        tag = (self.ch.get("tagline") or "").strip()
        if tag:
            t.append(f"\n  {tag[:24]}", style="dim")
        yield Label(t)


class SessionItem(ListItem):
    """会话列表项"""

    def __init__(self, sess: dict) -> None:
        super().__init__()
        self.sess = sess

    def compose(self) -> ComposeResult:
        direct = self.sess.get("kind") == "direct"
        t = Text()
        t.append("↗ " if direct else "● ", style="cyan" if direct else "green")
        t.append((self.sess.get("title") or "无标题").replace("\n", " ")[:22], style="white")
        t.append(f"\n  {self.sess.get('messageCount', 0)} 条", style="dim")
        yield Label(t)


class XingyeTUI(App):
    CSS = """
    Screen { layout: vertical; }
    #body { height: 1fr; }

    /* 左侧：角色 / 会话 / 直连 三个标签（对应网页左侧那几个） */
    #left {
        width: 32;
        border: round $success 60%;
        border-title-color: $success;
    }
    #left TabbedContent { height: 1fr; }
    #left ListView { height: 1fr; }
    CharItem, SessionItem { padding: 0 1; height: auto; }
    CharItem.--highlight, SessionItem.--highlight { background: $accent 35%; }

    /* 右侧：对话区 */
    #right { width: 1fr; border: round $accent 60%; border-title-color: $accent; }
    #chat-wrap { height: 1fr; }
    #chat { padding: 0 1; }
    #chat-empty { padding: 2 2; color: $text-muted; }
    #greeting-tip {
        padding: 0 1;
        color: $text-muted;
        background: $panel;
    }

    /* 底部 */
    #input { dock: bottom; height: 3; border: round $warning 50%; }
    #status-bar { dock: bottom; height: 1; background: $panel; color: $text-muted; padding: 0 1; }
    """

    BINDINGS = [
        ("f2", "tab('tab-chars')", "角色"),
        ("f3", "tab('tab-sessions')", "会话"),
        ("f4", "tab('tab-direct')", "直连"),
        ("ctrl+n", "new_session", "新会话"),
        ("ctrl+r", "reload", "刷新"),
        ("ctrl+t", "toggle_think", "思考开关"),
        ("ctrl+e", "cycle_effort", "思考强度"),
        ("ctrl+c", "quit", "退出"),
    ]

    def __init__(self, initial_session: str | None = None) -> None:
        super().__init__()
        self.wb = Workbench()
        self.cfg: dict = {}
        self.chars: list[dict] = []
        self.all_sessions: list[dict] = []   # 全部角色会话（未按角色过滤）
        self.sessions: list[dict] = []       # 角色会话
        self.directs: list[dict] = []        # 直连会话
        self.cur: dict | None = None         # 当前会话（None = 还没开始）
        self.cur_char: dict | None = None    # 当前选中的角色
        self.chat_text: Text = Text()
        self.streaming = False
        self.initial_session = initial_session

    # ---------- 布局 ----------
    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal(id="body"):
            with Vertical(id="left"):
                with TabbedContent(initial="tab-chars"):
                    with TabPane("角色", id="tab-chars"):
                        yield ListView(id="char-list")
                    with TabPane("会话", id="tab-sessions"):
                        yield ListView(id="session-list")
                    with TabPane("直连", id="tab-direct"):
                        yield ListView(id="direct-list")
            with Vertical(id="right"):
                with VerticalScroll(id="chat-wrap"):
                    yield Static("", id="chat")
                yield Static("", id="greeting-tip")
        yield Static("", id="status-bar")
        yield Input(placeholder="说点什么…（Enter 发送 · Ctrl+N 新会话）", id="input")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "星野 TUI"
        self.sub_title = "本地 AI 对话工作台"
        self.wb.login()
        self.load_cfg()
        self.load_chars()
        self.load_sessions()
        self.query_one("#input", Input).focus()

    # ---------- 载入 ----------
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
    def load_chars(self) -> None:
        try:
            chars = self.wb.get("/api/characters").get("characters") or []
        except Exception as e:  # noqa: BLE001
            self.call_from_thread(self.set_status, f"读角色失败：{e}")
            return
        self.call_from_thread(self._apply_chars, chars)

    def _apply_chars(self, chars: list[dict]) -> None:
        self.chars = chars
        lv = self.query_one("#char-list", ListView)
        lv.clear()
        for c in chars:
            lv.append(CharItem(c))

    @work(thread=True)
    def load_sessions(self) -> None:
        try:
            data = self.wb.get("/api/sessions")
        except Exception as e:  # noqa: BLE001
            self.call_from_thread(self.set_status, f"读会话失败：{e}")
            return
        self.call_from_thread(self._apply_sessions, data.get("sessions") or [])

    def _apply_sessions(self, all_sessions: list[dict]) -> None:
        # 隐藏 0~1 条的空壳
        useful = [s for s in all_sessions if (s.get("messageCount") or 0) > 1]
        self.all_sessions = useful
        self.directs = [s for s in useful if s.get("kind") == "direct"]
        self.refresh_session_list()

        # 有指定会话就直接打开
        if self.initial_session:
            hit = next(
                (s for s in self.sessions + self.directs if s["id"].startswith(self.initial_session)),
                None,
            )
            if hit:
                self.open_session(hit)
        self.update_status()

    def refresh_session_list(self) -> None:
        """会话列表只显示**当前角色**的会话。

        之前不管选了哪个角色，会话标签里都是全部 72 个会话 ——
        用户要的是「点角色就能看这个角色的对话」。
        """
        cid = (self.cur_char or {}).get("id")
        if cid:
            self.sessions = [s for s in self.all_sessions if s.get("characterId") == cid]
        else:
            self.sessions = [s for s in self.all_sessions if s.get("kind") != "direct"]

        sl = self.query_one("#session-list", ListView)
        sl.clear()
        for s in self.sessions:
            sl.append(SessionItem(s))

        # 标一下标签页上有几条
        try:
            tabs = self.query_one(TabbedContent)
            if cid:
                nm = (self.cur_char or {}).get("name", "")
                tabs.get_tab("tab-sessions").label = f"会话·{nm[:6]}({len(self.sessions)})"
            else:
                tabs.get_tab("tab-sessions").label = f"会话({len(self.sessions)})"
            tabs.get_tab("tab-direct").label = f"直连({len(self.directs)})"
        except Exception:  # noqa: BLE001
            pass

    # ---------- 选角色 ----------
    @on(ListView.Selected, "#char-list")
    def on_pick_char(self, event: ListView.Selected) -> None:
        item = event.item
        if not isinstance(item, CharItem):
            return
        self.cur_char = item.ch
        self.cur = None          # 还没开会话
        name = item.ch.get("name", "?")
        self.query_one("#right").border_title = f"对话 · 角色：{name}"
        # 网页也是先给个空状态 + 开场白预览，等你说话才建会话
        greeting = (item.ch.get("greeting") or "").strip()
        self.chat_text = Text()
        if greeting:
            self.chat_text.append(f"{name}: ", style="bold yellow")
            self.chat_text.append(greeting)
            self.chat_text.append("\n")
        self.query_one("#chat", Static).update(self.chat_text)
        tip = "这是 TA 的开场白（还没开始记录）—— 说点什么，对话就开始了"
        self.query_one("#greeting-tip", Static).update(Text(tip, style="dim"))
        self.refresh_session_list()   # 会话标签页只留这个角色的
        self.set_status(f"已选角色「{name}」· 说句话就开新会话 · F3 看 TA 的会话")
        self.query_one("#input", Input).focus()

    # ---------- 选会话 ----------
    @on(ListView.Selected, "#session-list")
    def on_pick_session(self, event: ListView.Selected) -> None:
        if isinstance(event.item, SessionItem):
            self.open_session(event.item.sess)

    @on(ListView.Selected, "#direct-list")
    def on_pick_direct(self, event: ListView.Selected) -> None:
        if isinstance(event.item, SessionItem):
            self.open_session(event.item.sess)

    @work(thread=True)
    def open_session(self, sess: dict) -> None:
        try:
            full = self.wb.get(f"/api/sessions/{sess['id']}").get("session")
        except Exception as e:  # noqa: BLE001
            self.call_from_thread(self.set_status, f"打开失败：{e}")
            return
        ch = None
        if full.get("characterId"):
            try:
                chars = self.wb.get("/api/characters").get("characters") or []
                ch = next((c for c in chars if c["id"] == full["characterId"]), None)
            except Exception:  # noqa: BLE001
                ch = None
        self.call_from_thread(self._render_session, sess, full, ch)

    def _render_session(self, sess: dict, full: dict, ch: dict | None) -> None:
        direct = full.get("kind") == "direct"
        self.cur = {**sess, "direct": direct, "title": full.get("title") or sess.get("title")}
        self.cur_char = ch if not direct else None
        name = (ch or {}).get("name", "")
        title = "对话 · 直连（不注入角色卡）" if direct else f"对话 · 角色：{name}"
        self.query_one("#right").border_title = title

        self.chat_text = Text()
        msgs = full.get("messages") or []
        if not msgs:
            self.chat_text.append("（还没有消息，在下面输入框说话）", style="dim")
        for i, m in enumerate(msgs[-80:]):
            if i:
                self.chat_text.append("\n")
            self.chat_text.append_text(self.fmt(m, direct, name))
        self.query_one("#chat", Static).update(self.chat_text)
        self.query_one("#greeting-tip", Static).update("")
        self.scroll_chat_end()
        self.update_status()
        self.query_one("#input", Input).focus()

    def fmt(self, m: dict, direct: bool | None = None, name: str | None = None) -> Text:
        if direct is None:
            direct = bool((self.cur or {}).get("direct"))
        if name is None:
            name = (self.cur_char or {}).get("name", "")
        t = Text()
        if m.get("role") == "user":
            t.append("你: ", style="bold green")
        elif direct:
            t.append("模型: ", style="bold cyan")
        else:
            t.append(f"{name or '角色'}: ", style="bold yellow")
        t.append(str(m.get("content") or ""))
        return t

    # ---------- 发送 ----------
    @on(Input.Submitted, "#input")
    def on_submit(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        event.input.value = ""
        if not text:
            return
        if self.streaming:
            self.set_status("正在生成，等它说完")
            return
        # 没有会话 → 用当前角色开一个（网页也是这样：说第一句才建会话）
        if not self.cur:
            if not self.cur_char:
                self.set_status("先在左边选个角色，或者选一个会话")
                return
            self.start_new_and_send(text)
            return
        self.streaming = True
        self.append_msg(self.fmt({"role": "user", "content": text}))
        self.set_status("生成中…")
        self.do_chat(self.cur, text)

    @work(thread=True)
    def start_new_and_send(self, text: str) -> None:
        ch = self.cur_char or {}
        try:
            r = self.wb.post("/api/sessions", {"characterId": ch["id"]})
        except Exception as e:  # noqa: BLE001
            self.call_from_thread(self.set_status, f"新建会话失败：{e}")
            return
        s = r.get("session") or r
        sess = {"id": s.get("id"), "title": s.get("title"), **s}
        full = self.wb.get(f"/api/sessions/{sess['id']}").get("session")
        self.call_from_thread(self._after_new, sess, full, text)

    def _after_new(self, sess: dict, full: dict, text: str) -> None:
        self._render_session(sess, full, self.cur_char)
        self.load_sessions()
        if self.cur:
            self.streaming = True
            self.append_msg(self.fmt({"role": "user", "content": text}))
            self.set_status("生成中…")
            self.do_chat(self.cur, text)

    @work(thread=True, exclusive=True)
    def do_chat(self, cur: dict, text: str) -> None:
        path = "/api/direct/chat" if cur.get("direct") else "/api/chat"
        # 先把「角色: 」这个前缀画出来，后面的增量往里追加
        name = "模型" if cur.get("direct") else (self.cur_char or {}).get("name") or "角色"
        style = "bold cyan" if cur.get("direct") else "bold yellow"
        prefix = Text(f"{name}: ", style=style)
        self._stream_prefix_text = prefix.plain
        self.call_from_thread(self.begin_stream, prefix)
        buf: list[str] = []
        try:
            for piece in self.wb.stream(path, {"sessionId": cur["id"], "content": text}):
                if isinstance(piece, tuple):
                    tag, val = piece
                    if tag == "__replace__":
                        # 服务端做了清理/复读截断，正文要以它给的为准。
                        # 之前这里是 continue（丢掉），结果界面上还显示着
                        # 复读的原文，看着像「没治住复读」。
                        self.call_from_thread(self.replace_stream, val)
                        continue
                    if tag == "__error__":
                        self.call_from_thread(self.append_msg, Text(f"✗ {val}", style="bold red"))
                    continue
                buf.append(piece)
                if len(buf) >= 4:
                    self.call_from_thread(self.append_stream, "".join(buf))
                    buf.clear()
            if buf:
                self.call_from_thread(self.append_stream, "".join(buf))
        except Exception as e:  # noqa: BLE001
            self.call_from_thread(self.append_msg, Text(f"✗ {e}", style="bold red"))
        finally:
            self.call_from_thread(self.finish_stream)

    def begin_stream(self, prefix: Text) -> None:
        """开始一条流式回复：记下起点长度，方便服务端 replace 时回退重画。"""
        if len(self.chat_text):
            self.chat_text.append("\n")
        self._stream_start = len(self.chat_text)
        self.chat_text.append_text(prefix)
        self.query_one("#chat", Static).update(self.chat_text)
        self.scroll_chat_end()

    def replace_stream(self, full: str) -> None:
        """服务端清理/截断之后的正文：把这一条换成它。"""
        start = getattr(self, "_stream_start", None)
        if start is None:
            return
        # 只保留到流式起点，再写完整正文
        t = self.chat_text
        t.truncate(start)
        self.chat_text = t
        self.chat_text.append(self._stream_prefix_text + full)
        self.query_one("#chat", Static).update(self.chat_text)
        self.scroll_chat_end()

    def append_stream(self, text: str) -> None:
        self.chat_text.append(text)
        self.query_one("#chat", Static).update(self.chat_text)
        self.scroll_chat_end()

    def finish_stream(self) -> None:
        self.streaming = False
        self.chat_text.append("\n")
        self.query_one("#chat", Static).update(self.chat_text)
        self.scroll_chat_end()
        self.update_status()
        self.load_sessions()
        self.query_one("#input", Input).focus()

    def append_msg(self, t: Text) -> None:
        if len(self.chat_text):
            self.chat_text.append("\n")
        self.chat_text.append_text(t)
        self.query_one("#chat", Static).update(self.chat_text)
        self.scroll_chat_end()

    def scroll_chat_end(self) -> None:
        try:
            self.query_one("#chat-wrap", VerticalScroll).scroll_end(animate=False)
        except Exception:  # noqa: BLE001
            pass

    # ---------- 动作 ----------
    def action_tab(self, tab_id: str) -> None:
        try:
            self.query_one(TabbedContent).active = tab_id
        except Exception:  # noqa: BLE001
            pass

    def action_new_session(self) -> None:
        if not self.cur_char:
            self.set_status("先在「角色」标签里选一个角色")
            return
        self.cur = None
        greeting = (self.cur_char.get("greeting") or "").strip()
        name = self.cur_char.get("name", "?")
        self.chat_text = Text()
        if greeting:
            self.chat_text.append(f"{name}: ", style="bold yellow")
            self.chat_text.append(greeting)
            self.chat_text.append("\n")
        self.query_one("#chat", Static).update(self.chat_text)
        self.query_one("#greeting-tip", Static).update(
            Text("说点什么，就开一段新对话", style="dim")
        )
        self.set_status(f"准备用「{name}」开新会话")
        self.query_one("#input", Input).focus()

    def action_cycle_effort(self) -> None:
        """Ctrl+E：循环切思考强度 none → low → high → max"""
        order = ["none", "low", "high", "max"]
        cur = self.cfg.get("reasoningEffort") or "high"
        nxt = order[(order.index(cur) + 1) % len(order)] if cur in order else "high"
        try:
            self.wb.put("/api/config", {"reasoningEffort": nxt})
            self.cfg = self.wb.get("/api/config")
        except Exception as e:  # noqa: BLE001
            self.set_status(f"切换失败：{e}")
            return
        self.update_status()

    def action_reload(self) -> None:
        self.load_chars()
        self.load_sessions()
        self.set_status("已刷新")

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

    # ---------- 状态栏 ----------
    def set_status(self, msg: str) -> None:
        self.query_one("#status-bar", Static).update(Text(msg, style="dim"))

    def update_status(self) -> None:
        if not self.cfg:
            return
        # 思考状态：DeepSeek V4 这类模型认的是 reasoning_effort（none/low/high/max），
        # 和本地 Ollama 的 thinkOff 是两套机制。两个都显示，不然看不出「现在几档」。
        effort = self.cfg.get("reasoningEffort") or "high"
        think = "思考关" if self.cfg.get("thinkOff") else f"思考 {effort}"
        if self.cur:
            mode = "直连" if self.cur.get("direct") else f"角色 {(self.cur_char or {}).get('name', '?')}"
        elif self.cur_char:
            mode = f"待开新会话 · {(self.cur_char.get('name') or '?')}"
        else:
            mode = "未选"
        cid = (self.cur_char or {}).get("id")
        scope = f"本角色 {len(self.sessions)} 个会话" if cid else f"全部 {len(self.sessions)} 个会话"
        self.set_status(
            f"{self.cfg.get('model', '?')} · {think} · {mode} · "
            f"角色 {len(self.chars)} · {scope} · F2/F3/F4 切标签"
        )


def main() -> None:
    s = sys.argv[1] if len(sys.argv) > 1 else None
    XingyeTUI(initial_session=s).run()


if __name__ == "__main__":
    main()
