#!/usr/bin/env python3
"""Walk the focus down a page with real key events and log what the scroll does.

Usage:
    cdp_scrolltest.py down 30          # press Down 30 times, 220 ms apart
    cdp_scrolltest.py up 30 --page "Steam 大屏幕模式"

Why: a focus/scroll bug is a *sequence* problem — "the last row is unreachable"
or "the page stops scrolling while the cursor keeps moving" only shows up as a
trajectory. This prints one line per press: the focused element, where it sits
on screen, and the scroll container's offset, so a stuck cursor or a scroll
that freezes mid-page is visible as a flat column.

Read-only in the sense that it only presses arrow keys; it never clicks, types,
or opens anything.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp_eval  # noqa: E402
import cdp_key  # noqa: E402

STATE = r"""(()=>{
  const a = document.activeElement;
  const scroller = [...document.querySelectorAll('*')].find(
    e => e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 200);
  const r = a ? a.getBoundingClientRect() : null;
  const c = scroller ? scroller.getBoundingClientRect() : null;
  const text = a ? String(a.innerText || a.getAttribute('aria-label') || '')
      .trim().replace(/\s+/g, ' ').slice(0, 26) : null;
  return JSON.stringify({
    t: text,
    id: a ? (a.tagName + '.' + String(a.className || '').split(' ').slice(0, 2).join('.')) : null,
    html: a ? String(a.outerHTML || '').replace(/\s+/g, ' ').slice(0, 70) : null,
    top: r ? Math.round(r.top) : null,
    bot: r ? Math.round(r.bottom) : null,
    sc: scroller ? Math.round(scroller.scrollTop) : 0,
    max: scroller ? Math.round(scroller.scrollHeight - scroller.clientHeight) : 0,
    cTop: c ? Math.round(c.top) : null,
    cBot: c ? Math.round(c.bottom) : null,
  })})()"""


def state(page):
    result = cdp_key.call(page, 98, "Runtime.evaluate", {
        "expression": STATE, "returnByValue": True,
    })
    raw = result.get("result", {}).get("result", {}).get("value")
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return {}


def press(page, vk, key):
    for kind in ("rawKeyDown", "keyUp"):
        cdp_key.call(page, 1, "Input.dispatchKeyEvent", {
            "type": kind,
            "windowsVirtualKeyCode": vk,
            "nativeVirtualKeyCode": vk,
            "key": key,
            "code": key,
        })


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    direction = sys.argv[1]
    count = int(sys.argv[2])
    page_want = "Steam 大屏幕模式"
    if "--page" in sys.argv:
        page_want = sys.argv[sys.argv.index("--page") + 1]
    if direction not in ("down", "up"):
        print("direction must be down or up")
        return 2
    page = cdp_eval.find_page(page_want)
    if page is None:
        print("NO_PAGE")
        return 1

    vk, key = cdp_key.KEYS[direction]
    first = state(page)
    print("view %s..%s  scroll=%s/%s  start=%s"
          % (first.get("cTop"), first.get("cBot"), first.get("sc"),
             first.get("max"), first.get("t")))
    print(" %-3s %-26s %-10s %s" % ("#", "focus", "top..bot", "scroll"))
    prev = None
    stalls = 0
    for i in range(count):
        press(page, vk, key)
        time.sleep(0.22)
        cur = state(page)
        same = cur.get("t") == prev
        stalls = stalls + 1 if same else 0
        if cur.get("t"):
            label = cur.get("t")
        else:
            # No text: this is the "cursor landed on nothing" case. Show what it
            # actually is, otherwise the log is a row of `?` and proves nothing.
            label = "<%s>" % (cur.get("id") or "?")
        print(" %-3d %-26s %-10s %s%s"
              % (i + 1, label[:26],
                 "%s..%s" % (cur.get("top"), cur.get("bot")),
                 "%s/%s" % (cur.get("sc"), cur.get("max")),
                 "   <-- stuck" if stalls else ""))
        if not cur.get("t") and cur.get("html"):
            print("      %s" % cur["html"][:70])
        prev = cur.get("t")
    return 0


if __name__ == "__main__":
    sys.exit(main())
