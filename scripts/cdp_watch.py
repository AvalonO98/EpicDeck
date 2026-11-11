#!/usr/bin/env python3
"""Watch every Steam CEF context for runtime errors while a human pokes the UI.

Usage: cdp_watch.py [seconds] [interval]

Injects a collector into each page exposed by Steam's remote debugging port,
then polls it. Prints only *new* entries, each with the target title, so a
single uncaught throw in a key handler shows up as one line instead of a wall
of noise. Heartbeats every 30s prove the watcher is still attached.

Why every page: Decky plugins render in `QuickAccess_uid2` for the QAM panel
but the full-screen library view is mounted in the main gamepad-UI page, and
`SharedJSContext` holds the shared React instance. A `ReferenceError` in
`onRootDirection` can surface in any of them, so we do not guess.

Read-only: it adds an error listener and a filtered console.error wrapper that
still calls the original. Nothing is clicked, focused, or dispatched.
"""

import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp_eval as C  # noqa: E402  (websocket plumbing lives there)

CDP_LIST = "http://127.0.0.1:8080/json/list"
LIMIT = 200

INJECT = r"""(()=>{
  if (window.__edErrV === 3) return 'already';
  window.__edErrV = 3;
  let buffer = [];
  try {
    const saved = JSON.parse(localStorage.getItem('__edErrLog') || '[]');
    if (Array.isArray(saved)) buffer = saved;
  } catch (e) { buffer = []; }
  const save = () => {
    try { localStorage.setItem('__edErrLog', JSON.stringify(buffer.slice(-%d))); } catch (e) {}
  };
  const push = (kind, value) => {
    try {
      const text = String(value);
      buffer.push(kind + ': ' + text.slice(0, 300));
      if (buffer.length > %d) buffer.splice(0, buffer.length - %d);
      save();
    } catch (e) {}
  };
  window.__edErr = buffer;
  window.addEventListener('error', e => push('error', (e && (e.message || e.error)) || '?'));
  window.addEventListener('unhandledrejection', e => push('reject', (e && e.reason) || '?'));
  const original = console.error;
  console.error = function () {
    const text = Array.prototype.join.call(arguments, ' ');
    if (/ReferenceError|is not defined|DIR_UP|Uncaught|Cannot read/.test(text)) {
      push('console', text);
    }
    return original.apply(this, arguments);
  };
  return 'installed';
})()""" % (LIMIT, LIMIT, LIMIT)

READ = "JSON.stringify(window.__edErr || null)"
# Destructive read: hand back what is pending and empty the buffer, so repeated
# one-shot calls report only what is new. Lets a foreground poll loop work
# without keeping a websocket open (the collector itself lives in the page).
DRAIN = ("(()=>{const a=window.__edErr||[];const out=a.slice(0);"
         "window.__edErr=[];try{localStorage.setItem('__edErrLog','[]')}catch(e){};"
         "return JSON.stringify(out)})()")


def pages():
    try:
        return json.load(urllib.request.urlopen(CDP_LIST, timeout=5))
    except Exception as exc:  # noqa: BLE001
        print("[warn] cannot list targets: %r" % (exc,))
        return []


def evaluate(page, expression):
    """One-shot Runtime.evaluate against a single target."""
    sock, buf = C.connect(page["webSocketDebuggerUrl"])
    try:
        C.send_text(sock, json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "awaitPromise": True,
                       "returnByValue": True},
        }))
        for _ in range(20):
            text, buf = C.recv_text(sock, buf)
            try:
                message = json.loads(text)
            except ValueError:
                continue
            if message.get("id") != 1:
                continue
            result = message.get("result", {})
            if "exceptionDetails" in result:
                return None
            return result.get("result", {}).get("value")
    finally:
        try:
            sock.close()
        except OSError:
            pass
    return None


def main():
    once = "--once" in sys.argv
    positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    seconds = int(positional[0]) if positional else 300
    interval = float(positional[1]) if len(positional) > 1 else 2.0
    started = time.time()
    print("[watch] %s, every %.0fs, limit %d entries/context"
          % ("single pass" if once else "%ds" % seconds, interval, LIMIT))

    seen = {}
    attached = set()
    fresh = 0
    last_beat = started
    while once or time.time() - started < seconds:
        for page in pages():
            title = page.get("title") or "?"
            if page.get("type") != "page":
                continue
            key = page.get("id") or title
            if key not in attached:
                if evaluate(page, INJECT) == "installed":
                    print("[watch] attached -> %s" % title)
                attached.add(key)
            raw = evaluate(page, DRAIN if once else READ)
            try:
                items = json.loads(raw) if raw else []
            except (TypeError, ValueError):
                items = []
            if not isinstance(items, list):
                continue
            count = 0 if once else seen.get(key, 0)
            for item in items[count:]:
                print("[ERR] %s | %s" % (title, item))
                fresh += 1
            seen[key] = len(items)
        if once:
            print("[drain] contexts=%d new=%d" % (len(attached), fresh))
            return 0

        now = time.time()
        if now - last_beat >= 30:
            print("[hb] +%ds alive, contexts=%d" % (int(now - started), len(attached)))
            last_beat = now
        time.sleep(interval)

    total = sum(seen.values())
    print("[watch] done, %d error(s) across %d context(s)" % (total, len(attached)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
