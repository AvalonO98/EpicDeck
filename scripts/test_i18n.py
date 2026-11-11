#!/usr/bin/env python3
"""Compile the i18n modules to JS and assert the translation behaviour.

`t()` falls back to the Chinese source, `tf()` keeps unresolved placeholders,
and Steam language tags map onto the two supported UI languages. Runs with the
repo's own TypeScript and Node — no extra tooling.

Usage: python scripts/test_i18n.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
# `node_modules/.bin/tsc` is a shell shim on Windows; run the real JS entry.
TSC_JS = os.path.join(ROOT, "node_modules", "typescript", "bin", "tsc")

# (name, language, fn, args, expected)
CASES = [
    ("zh passthrough t(游戏库)", "zh", "t", ("游戏库",), "游戏库"),
    ("en t(游戏库)", "en", "t", ("游戏库",), "Library"),
    ("en t(设置)", "en", "t", ("设置",), "Settings"),
    ("en unknown falls back", "en", "t", ("这条没有翻译",), "这条没有翻译"),
    ("tf placeholders", "en", "tf", ("{0} 小时 {1} 分", 2, 30), "2 h 30 m"),
    ("tf keeps missing placeholder", "en", "tf", ("已添加 {0} 个。{1}", 3), "Added 3. {1}"),
    ("en t(已安装)", "en", "t", ("已安装",), "Installed"),
]


def build(tmp):
    source = open(os.path.join(SRC, "i18n.ts"), encoding="utf-8").read()
    # React is only needed for the hook; drop it so plain Node can run the rest.
    source = source.replace('import { useEffect, useState } from "react";\n', "")
    source = re.sub(r"/\*\*\n \* Re-render the calling component.*?\n\}\n", "", source, flags=re.S)
    open(os.path.join(tmp, "i18n.ts"), "w", encoding="utf-8").write(source)
    shutil.copy(os.path.join(SRC, "i18n.en.ts"), os.path.join(tmp, "i18n.en.ts"))
    subprocess.run(
        ["node", TSC_JS, "i18n.ts", "i18n.en.ts", "--module", "commonjs", "--target", "es2020", "--skipLibCheck"],
        cwd=tmp,
        check=True,
        capture_output=True,
    )


def run(tmp):
    script = """
const m = require('./i18n.js');
const cases = %s;
const out = [];
for (const [name, lang, fn, args, want] of cases) {
  m.setLang(lang);
  const got = m[fn](...args);
  out.push([name, got, want]);
}
out.push(['steam schinese', m.langFromSteam('schinese'), 'zh']);
out.push(['steam english', m.langFromSteam('english'), 'en']);
console.log(JSON.stringify(out));
""" % json.dumps(CASES, ensure_ascii=False)
    result = subprocess.run(
        ["node", "-e", script], cwd=tmp, check=True, capture_output=True, text=True
    )
    return json.loads(result.stdout)


def main():
    tmp = tempfile.mkdtemp(
    prefix="epicdeck-i18n-", dir=os.environ.get("EPICDECK_TMPDIR") or None
)
    try:
        build(tmp)
        rows = run(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    failed = 0
    for name, got, want in rows:
        ok = got == want
        failed += 0 if ok else 1
        print(("  OK   " if ok else "  FAIL ") + name + "  => " + json.dumps(got, ensure_ascii=False))
    print("\n%d/%d passed" % (len(rows) - failed, len(rows)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
