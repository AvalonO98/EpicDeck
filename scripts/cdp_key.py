#!/usr/bin/env python3
"""Send real key events to a Steam window over CDP.

Why this exists: `__epicdeckNav()` bypasses Steam's input stack, so it can prove
the geometry math but not that a physical button reaches the page. This sends
trusted (Input-domain) key events, which Steam's focus system treats like the
d-pad — the same path a controller press takes once Steam Input maps it.

Usage:
    cdp_key.py down 4          # press Down four times, 120 ms apart
    cdp_key.py enter
    cdp_key.py escape
    cdp_key.py right 2 --page "Steam 大屏幕模式"
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp_eval  # noqa: E402

KEYS = {
    "up": (38, "ArrowUp"),
    "down": (40, "ArrowDown"),
    "left": (37, "ArrowLeft"),
    "right": (39, "ArrowRight"),
    "enter": (13, "Enter"),
    "escape": (27, "Escape"),
    "l1": (33, "PageUp"),
    "r1": (34, "PageDown"),
}


def call(page, message_id, method, params):
    sock, tail = cdp_eval.connect(page["webSocketDebuggerUrl"])
    try:
        cdp_eval.send_text(sock, json.dumps(
            {"id": message_id, "method": method, "params": params}))
        buf = tail
        for _ in range(20):
            text, buf = cdp_eval.recv_text(sock, buf)
            try:
                message = json.loads(text)
            except ValueError:
                continue
            if message.get("id") == message_id:
                return message
        return {"error": "no response"}
    finally:
        sock.close()


def focus_label(page):
    result = call(page, 99, "Runtime.evaluate", {
        "expression": "(()=>{const e=document.activeElement;return e?String(e.innerText||e.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ').slice(0,28):null})()",
        "returnByValue": True,
    })
    return result.get("result", {}).get("result", {}).get("value")


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in KEYS:
        print(__doc__)
        return 2
    name = sys.argv[1]
    count = 1
    if len(sys.argv) > 2 and sys.argv[2].isdigit():
        count = int(sys.argv[2])
    page_want = "Steam 大屏幕模式"
    if "--page" in sys.argv:
        page_want = sys.argv[sys.argv.index("--page") + 1]
    page = cdp_eval.find_page(page_want)
    if page is None:
        print("NO_PAGE")
        return 1

    vk, key = KEYS[name]
    for i in range(count):
        for kind in ("rawKeyDown", "keyUp"):
            call(page, 1, "Input.dispatchKeyEvent", {
                "type": kind,
                "windowsVirtualKeyCode": vk,
                "nativeVirtualKeyCode": vk,
                "key": key,
                "code": key,
            })
        time.sleep(0.18)
        print("%s %d -> %s" % (name, i + 1, focus_label(page)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
