#!/usr/bin/env python3
"""Exercise the focus-ownership state machine in `src/geomnav.ts`.

This is the part of the navigation fix that decides whether a `focusin` came
from us or from Steam's own nav layer. It is pure logic — no layout, no DOM —
so it can be asserted without a Steam Deck, which is exactly what we want
before touching the device.

Usage: python scripts/test_geomnav.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
TSC_JS = os.path.join(ROOT, "node_modules", "typescript", "bin", "tsc")

RUNNER = r"""
const path = require('path');
const m = require('./geomnav.js');

// Minimal stand-ins: settleFocus only needs focus() and contains().
function el(name) {
  return {
    name,
    isConnected: true,
    focus() { this.focusedByUs = globalThis.now; globalThis.lastFocused = this.name; },
  };
}
const root = { contains: (e) => !!e && e.name !== 'outside' };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const check = (name, cond, detail) => out.push([name, !!cond, detail || '']);

(async () => {
  // 1. Cold start: nothing remembered, so whatever receives focus is adopted.
  m.rememberFocus(null);
  let a = el('a');
  check('cold start adopts the target', m.settleFocus(a, root) === a);

  // 2. Our own move: anchor first, then the focusin it triggers is ours.
  let b = el('b');
  m.focusOwned(b);
  check('our own move returns its target', m.settleFocus(b, root) === b);

  // 3. Steam moves focus right after us (same key press). That must NOT become
  //    the new anchor, or the cursor staircases one tile per press.
  //    NOTE: this used to be decided by a 300 ms window, which failed in the
  //    real world because people press slower than that (2026-11-05 22:1x).
  //    Now it is "one move absorbs one foreign focusin", with no timing.
  let c = el('c');
  const settled = m.settleFocus(c, root);
  check('foreign focus after our move is rejected', settled === b, 'got ' + settled.name);
  check('rejected focus is put back on the anchor', globalThisLastFocus() === 'b', globalThisLastFocus());

  // 4. A genuine later change (click, tab switch) is adopted again — and it
  //    must be adopted *immediately*, not only after a timeout.
  let d = el('d');
  check('next focus change after the absorbed one is adopted', m.settleFocus(d, root) === d);

  // 4b. No timing dependency: a slow user (600 ms between presses) must behave
  //     exactly like a fast one. Old code failed here.
  let slow1 = el('slow1');
  m.focusOwned(slow1);
  await wait(600);
  let slow2 = el('slow2');
  check('slow press still rejects the foreign move', m.settleFocus(slow2, root) === slow1);

  // 4c. reverifyFocus pulls focus back when Steam moved it without a focusin.
  const fakeDoc = { activeElement: null, defaultView: null };
  const exp = el('exp');
  exp.focus = function () {
    globalThis.lastFocused = this.name;
    fakeDoc.activeElement = this;
  };
  const fakeRoot = { contains: () => true, ownerDocument: fakeDoc };
  m.focusOwned(exp);
  fakeDoc.activeElement = el('stolen'); // Steam moved it behind our back
  m.reverifyFocus(exp, fakeRoot, 0);
  check(
    'reverifyFocus puts focus back',
    fakeDoc.activeElement === exp,
    String(fakeDoc.activeElement && fakeDoc.activeElement.name)
  );

  // 5. Navigator never anchors on an element outside its root.
  m.rememberFocus(null);
  let gone = el('outside');
  check('element outside root is still adopted (no anchor yet)', m.settleFocus(gone, root) === gone);

  const bad = out.filter((r) => !r[1]).length;
  for (const [name, ok, detail] of out) {
    console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok ? '' : '  [' + detail + ']'));
  }
  console.log('\n' + (out.length - bad) + '/' + out.length + ' passed');
  process.exit(bad ? 1 : 0);
})();

function globalThisLastFocus() {
  return globalThis.lastFocused;
}
"""


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="epicdeck-geomnav-")
    try:
        shutil.copy(os.path.join(SRC, "geomnav.ts"), os.path.join(tmp, "geomnav.ts"))
        subprocess.run(
            ["node", TSC_JS, "geomnav.ts", "--module", "commonjs",
             "--target", "es2020", "--skipLibCheck"],
            cwd=tmp,
            check=True,
            capture_output=True,
        )
        runner = os.path.join(tmp, "run.js")
        open(runner, "w", encoding="utf-8").write(RUNNER)
        result = subprocess.run(["node", runner], cwd=tmp, capture_output=True, text=True)
        sys.stdout.write(result.stdout)
        if result.returncode != 0:
            sys.stdout.write(result.stderr)
        return result.returncode
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
