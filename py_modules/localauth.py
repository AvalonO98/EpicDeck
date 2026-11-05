# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Phone-assisted Epic login, served from the Deck's own LAN address.

Why not a redirect back to the Deck: Epic's launcher OAuth does **not** accept
an arbitrary `redirectUrl` — every third-party implementation (Legendary,
Heroic, and the various MCP tools) ends up asking the user to copy the code out
of the JSON page by hand. So a phone cannot hand the code back automatically.

What it *can* do is keep the whole flow inside **one** browser. This module
serves a small page on the Deck's LAN IP; the user opens it on the phone (scan
the QR code shown on the Deck), taps through to Epic, signs in, then pastes the
code into that same page. The painful part was never the copy — it was carrying
a 32-character code from the phone back to the handheld.

Design notes
------------
* One-shot: the server starts on demand, collects exactly one code, and is
  expected to be stopped by the caller.
* The URL carries a random token (`?k=...`) so another device on the same
  network cannot post junk into a session it did not start.
* Only the authorization code is accepted; nothing else is read or stored.
"""

from __future__ import annotations

import html
import http.server
import secrets
import socket
import threading
import time
import urllib.parse

DEFAULT_PORT = 8899
PORT_ATTEMPTS = 8

_PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>EpicDeck 登录</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 18px 40px;
    background: #10151c; color: #e6edf3;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 1.45em; margin: 0 0 6px; }
  .sub { opacity: .6; font-size: .9em; margin-bottom: 22px; }
  .step {
    background: #171e27; border: 1px solid #232c38; border-radius: 12px;
    padding: 16px; margin-bottom: 14px;
  }
  .step .n {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 50%;
    background: #2a6df4; color: #fff; font-size: .78em; font-weight: 700;
    margin-right: 8px; vertical-align: 1px;
  }
  .step .t { font-weight: 600; }
  .hint { font-size: .85em; opacity: .65; margin-top: 8px; line-height: 1.55; }
  a.btn, button {
    display: block; width: 100%; margin-top: 12px;
    padding: 13px 16px; border-radius: 10px; border: 0;
    background: #2a6df4; color: #fff; font-size: 1em; font-weight: 600;
    text-align: center; text-decoration: none; cursor: pointer;
  }
  button:active, a.btn:active { background: #1f57c9; }
  textarea {
    width: 100%; min-height: 92px; margin-top: 12px; padding: 12px;
    border-radius: 10px; border: 1px solid #2b3646;
    background: #0d1219; color: #e6edf3; font-size: .92em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    resize: vertical;
  }
  .ok { color: #7ee2a8; }
  .err { color: #ff9b9b; }
  .done { text-align: center; padding: 40px 0; }
  .done .big { font-size: 3em; margin-bottom: 12px; }
  code { background: #0d1219; padding: 1px 5px; border-radius: 4px; font-size: .9em; }
</style>
</head>
<body>
<div class="wrap">
__BODY__
</div>
</body>
</html>
"""

_FORM_BODY = """
  <h1>EpicDeck 登录</h1>
  <div class="sub">在这个页面里完成，不用把授权码传回 Steam Deck</div>

  <div class="step">
    <div><span class="n">1</span><span class="t">登录 Epic</span></div>
    <div class="hint">点下面的按钮，登录你的 Epic 账号。登录成功后，页面会显示一段 JSON。</div>
    <a class="btn" href="__EPIC_URL__" target="_blank" rel="noopener">打开 Epic 登录页</a>
  </div>

  <div class="step">
    <div><span class="n">2</span><span class="t">复制授权码</span></div>
    <div class="hint">在 JSON 页面里找到 <code>authorizationCode</code>，长按复制它的值。
      也可以把整段 JSON 全选复制，粘贴进来即可。</div>
  </div>

  <div class="step">
    <div><span class="n">3</span><span class="t">粘贴并完成</span></div>
    <form method="post" action="/submit">
      <input type="hidden" name="k" value="__TOKEN__">
      <textarea name="code" placeholder="在这里粘贴授权码或整段 JSON" autofocus></textarea>
      <button type="submit">完成登录</button>
    </form>
    <div class="hint">提交后 Steam Deck 会立刻登录，这个页面可以直接关掉。</div>
  </div>
"""

_OK_BODY = """
  <div class="done">
    <div class="big">✅</div>
    <h1 class="ok">已发送到 Steam Deck</h1>
    <div class="sub">登录正在完成，这个页面可以关掉了。</div>
  </div>
"""

_FAIL_BODY = """
  <div class="done">
    <div class="big">⚠️</div>
    <h1 class="err">没有识别到授权码</h1>
    <div class="sub">请回到上一步，重新复制 <code>authorizationCode</code> 的值。</div>
  </div>
  <a class="btn" href="/?k=__TOKEN__">返回重试</a>
"""


def lan_ip() -> str:
    """Best-effort LAN address of this machine (empty when offline)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No packet is actually sent; connect() only picks the outbound route.
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        return "" if ip.startswith("127.") else ip
    except OSError:
        return ""
    finally:
        sock.close()


class LocalAuthServer:
    """Collects one authorization code over HTTP on the LAN."""

    def __init__(self, epic_login_url: str, port: int = DEFAULT_PORT):
        self.epic_login_url = epic_login_url
        self.port = port
        self.token = secrets.token_urlsafe(12)
        self.code = ""
        self._httpd = None
        self._thread = None
        self._ip = ""

    # -- lifecycle --------------------------------------------------------
    @property
    def url(self) -> str:
        return "http://%s:%d/?k=%s" % (self._ip, self.port, self.token)

    def start(self) -> str:
        """Start serving and return the URL to show as a QR code."""
        ip = lan_ip()
        if not ip:
            raise RuntimeError("Steam Deck 没有连上局域网（请连同一个 WiFi）")
        self._ip = ip

        handler = _make_handler(self)
        last_error: Exception | None = None
        for offset in range(PORT_ATTEMPTS):
            port = self.port + offset
            try:
                httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)
            except OSError as e:  # port taken
                last_error = e
                continue
            httpd.daemon_threads = True
            self._httpd = httpd
            self.port = port
            self._thread = threading.Thread(
                target=httpd.serve_forever, kwargs={"poll_interval": 0.3}, daemon=True
            )
            self._thread.start()
            return self.url

        raise RuntimeError("本地端口全被占用：%s" % last_error)

    def stop(self) -> None:
        httpd, self._httpd = self._httpd, None
        if httpd is not None:
            try:
                httpd.shutdown()
            except Exception:
                pass
            try:
                httpd.server_close()
            except Exception:
                pass

    # -- helpers ----------------------------------------------------------
    def _page(self, body: str) -> bytes:
        return _PAGE.replace("__BODY__", body).encode("utf-8")

    def render_form(self, error: str = "") -> bytes:
        body = _FORM_BODY.replace("__EPIC_URL__", html.escape(self.epic_login_url))
        body = body.replace("__TOKEN__", html.escape(self.token))
        if error:
            body = ('<div class="step"><div class="err">%s</div></div>\n%s'
                    % (html.escape(error), body))
        return self._page(body)

    def render_ok(self) -> bytes:
        return self._page(_OK_BODY)

    def render_bad_code(self) -> bytes:
        return self._page(_FAIL_BODY.replace("__TOKEN__", html.escape(self.token)))


def _make_handler(ctx: LocalAuthServer):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "EpicDeckLocalAuth"
        protocol_version = "HTTP/1.1"

        # Silence the default stderr access log; it would spam the plugin log.
        def log_message(self, *args):  # noqa: D401, A003
            return

        def _send(self, status: int, payload: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):  # noqa: N802 - stdlib naming
            parsed = urllib.parse.urlparse(self.path)
            token = urllib.parse.parse_qs(parsed.query).get("k", [""])[0]
            if parsed.path != "/" or token != ctx.token:
                self._send(404, b"not found")
                return
            self._send(200, ctx.render_form())

        def do_POST(self):  # noqa: N802 - stdlib naming
            if urllib.parse.urlparse(self.path).path != "/submit":
                self._send(404, b"not found")
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > 64 * 1024:
                self._send(413, ctx.render_bad_code())
                return
            raw = self.rfile.read(length).decode("utf-8", "replace")
            form = urllib.parse.parse_qs(raw)
            if form.get("k", [""])[0] != ctx.token:
                self._send(403, b"forbidden")
                return
            code = (form.get("code", [""])[0] or "").strip()
            extracted = extract_code(code)
            if not extracted:
                self._send(200, ctx.render_bad_code())
                return
            ctx.code = extracted
            self._send(200, ctx.render_ok())

    return Handler


def extract_code(raw: str) -> str:
    """Pull the authorization code out of whatever the user pasted.

    Accepts the bare code, a JSON blob from Epic's redirect page, or the whole
    URL. Kept here (not only in main.py) so the HTTP handler can validate
    before answering the phone.
    """
    import json
    import re

    text = (raw or "").strip()
    if not text:
        return ""

    if "{" in text:
        start = text.find("{")
        end = text.rfind("}")
        if end > start:
            try:
                data = json.loads(text[start:end + 1])
            except ValueError:
                data = None
            if isinstance(data, dict):
                for key in ("authorizationCode", "authorization_code", "code"):
                    value = data.get(key)
                    if isinstance(value, str) and value.strip():
                        return value.strip()

    match = re.search(r"[?&]code=([A-Za-z0-9]{8,})", text)
    if match:
        return match.group(1)

    # A bare code: Epic's are hex, typically 32 chars.
    if re.fullmatch(r"[A-Za-z0-9]{16,64}", text):
        return text
    return ""


async def wait_for_code(server: LocalAuthServer, timeout: float) -> str:
    """Await the code the phone submits (polling; the handler runs in a thread)."""
    import asyncio

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server.code:
            return server.code
        await asyncio.sleep(0.4)
    return ""
