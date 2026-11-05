#!/usr/bin/env python3
"""Dump the geometry that `geomnav.moveFocus` sees, so a wrong-direction bug can
be explained instead of guessed.

Why this exists: HANDOFF 7.12.2-b — vertical moves drift right on the way down
and left on the way up, on every page. Two very different causes produce that
same symptom:

  a) `moveFocus` returns false, `onRootDirection` does not swallow the key, and
     Steam's own nav walks DOM order (down = next sibling = the tile to the
     right). The nav log will show `moved: false`.
  b) `moveFocus` does move, but the tile directly below is rejected by the
     "same column" test and a diagonal one wins. The candidate table will show
     `strict: false` for the element straight below.

This prints both, from the Big Picture window (where the DOM actually lives —
the plugin's own window is a 1x1 SharedJSContext, see HANDOFF 5.10).

Usage:
    cdp_nav_probe.py                 # dump current focus + candidates + nav log
    cdp_nav_probe.py --press 10      # then press DOWN through the real path
    cdp_nav_probe.py --press 9       # UP
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp_eval  # noqa: E402  (reuse the hand-rolled websocket client)

CDP_LIST = "http://127.0.0.1:8080/json/list"

# Mirrors geomnav.ts: same selector, same thresholds, same two rounds.
JS_PROBE = r"""
(() => {
  const root = document.querySelector('.ed-surface');
  if (!root) return { error: 'no .ed-surface in this document' };

  const SEL = '[tabindex]:not([tabindex="-1"]),button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]';
  const isLeaf = (el) => { try { return !el.querySelector(SEL); } catch (e) { return true; } };
  const visible = (el) => {
    if (!el.isConnected) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const label = (el) => String(el.innerText || el.getAttribute('aria-label') || el.className || '')
    .trim().replace(/\s+/g, ' ').slice(0, 24);

  // "remembered" is module state inside the bundle; the DOM focus is the next
  // best thing and matches it whenever the last move succeeded.
  const active = document.activeElement;
  if (!active || !root.contains(active)) {
    return { error: 'focus is not inside .ed-surface', active: active ? label(active) : null };
  }
  const from = active.getBoundingClientRect();
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;

  const rows = [];
  for (const el of Array.from(root.querySelectorAll(SEL))) {
    if (el === active || active.contains(el) || el.contains(active)) continue;
    if (!isLeaf(el) || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cx - fx, dy = cy - fy;
    const overlap = Math.min(from.right, r.right) - Math.max(from.left, r.left);
    const narrower = Math.min(from.width, r.width);
    const band = Math.max(10, Math.min(from.height, r.height) * 0.5);
    rows.push({
      text: label(el),
      level: (el.closest('[data-ed-level]') || {}).getAttribute
        ? el.closest('[data-ed-level]').getAttribute('data-ed-level') : '',
      dx: Math.round(dx), dy: Math.round(dy),
      w: Math.round(r.width), h: Math.round(r.height),
      overlap: Math.round(overlap), narrower: Math.round(narrower),
      sameCol: narrower > 0 && overlap >= narrower * 0.5,
      sameRow: Math.abs(dy) <= band,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
    });
  }
  rows.sort((a, b) => Math.abs(a.dy) - Math.abs(b.dy) || Math.abs(a.dx) - Math.abs(b.dx));

  const view = document.defaultView || window;
  return {
    from: {
      text: label(active),
      rect: [Math.round(from.left), Math.round(from.top), Math.round(from.right), Math.round(from.bottom)],
      w: Math.round(from.width), h: Math.round(from.height),
      transform: getComputedStyle(active).transform,
      level: (active.closest('[data-ed-level]') || {}).getAttribute
        ? active.closest('[data-ed-level]').getAttribute('data-ed-level') : '',
    },
    // only the neighbours that matter: 2 rows above/below, 2 columns either side
    near: rows.filter((r) => Math.abs(r.dy) < 400 && Math.abs(r.dx) < 420).slice(0, 24),
    navLog: (view.__epicdeckNavLog || []).slice(-12),
    hasNav: typeof view.__epicdeckNav === 'function',
  };
})()
"""

JS_PRESS = r"""
(() => {
  const view = document.defaultView || window;
  const before = document.activeElement;
  const ok = view.__epicdeckNav(%d);
  const after = document.activeElement;
  const label = (el) => el ? String(el.innerText || el.className || '').trim().replace(/\s+/g, ' ').slice(0, 24) : null;
  return { moved: ok, before: label(before), after: label(after) };
})()
"""


def evaluate(page, expression):
    sock, tail = cdp_eval.connect(page["webSocketDebuggerUrl"])
    try:
        cdp_eval.send_text(sock, json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "awaitPromise": True, "returnByValue": True},
        }))
        buf = tail
        for _ in range(20):
            text, buf = cdp_eval.recv_text(sock, buf)
            try:
                message = json.loads(text)
            except ValueError:
                continue
            if message.get("id") != 1:
                continue
            result = message.get("result", {})
            if "exceptionDetails" in result:
                return {"exception": json.dumps(result["exceptionDetails"])[:400]}
            return result.get("result", {}).get("value")
        return {"error": "no response"}
    finally:
        try:
            sock.close()
        except OSError:
            pass


def pick_bpm_page():
    """The page that actually holds `.ed-surface` (the BPM window)."""
    pages = json.load(cdp_eval.urllib.request.urlopen(CDP_LIST, timeout=5))
    for page in pages:
        value = evaluate(page, "!!document.querySelector('.ed-surface')")
        if value is True:
            return page
    return None


def main():
    press = None
    if "--press" in sys.argv:
        press = int(sys.argv[sys.argv.index("--press") + 1])

    page = pick_bpm_page()
    if page is None:
        print(json.dumps({"error": "no CDP page has .ed-surface — open the plugin's full-screen page first"},
                         ensure_ascii=False))
        return 1
    print("page:", page.get("title"))

    if press is not None:
        print("press:", json.dumps(evaluate(page, JS_PRESS % press), ensure_ascii=False))

    print(json.dumps(evaluate(page, JS_PROBE), ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
