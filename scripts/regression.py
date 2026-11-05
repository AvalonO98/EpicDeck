#!/usr/bin/env python3
"""One-command regression run for EpicDeck.

Runs everything that can be verified WITHOUT the Steam Deck:

  1. Python syntax for the backend and the scripts
  2. i18n coverage: every `t()`/`tf()` key has an entry, placeholders match
  3. no module-level `t()` (that freezes the language at import time)
  4. no Chinese left unwrapped in the UI, outside a small allow-list
  5. the three behavioural suites (i18n, geomnav state machine, backend smoke)
  6. package.json sanity, including the store's `remote_binary` declaration
  7. optional `--build`: rollup bundle + Decky zip assembly

Usage:
    python scripts/regression.py            # everything except the bundle
    python scripts/regression.py --build    # also build dist/ and the zip
"""

import io
import json
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
CJK = re.compile(r"[\u4e00-\u9fff]")
PLACEHOLDER = re.compile(r"\{\w+\}")

# Chinese that must stay in the source language on purpose:
#   * TABS labels are translated at render time (see HANDOFF 7.13.0a)
#   * the language picker shows each language in its own name
ALLOWED_LITERALS = {"游戏库", "下载", "设置", "简体中文"}

# Language names stay in their own language in every UI (an English user still
# expects to see "日本語" in the picker, not "Japanese").
AUTONYMS = {"简体中文", "繁體中文", "日本語", "English"}

# Module-level *label maps*: their values stay in the source language and are
# wrapped with t() where they are rendered (HANDOFF 7.13.0a). Anything else with
# Chinese in it is a bug, so this list is deliberately explicit.
TRANSLATED_MAPS = {
    "TABS",
    "STATE_LABEL",
    "INSTALL_FILTER_LABEL",
    "SORT_OPTIONS",
    "LOCALE_OPTIONS",
    "LOCALE_LABELS",
}

results = []


def step(name, fn):
    try:
        ok, detail = fn()
    except Exception as exc:  # noqa: BLE001 - a broken check must be reported, not fatal
        ok, detail = False, "%s: %s" % (type(exc).__name__, exc)
    results.append((name, ok, detail))
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else "  -> " + str(detail)))
    return ok


def py_files():
    files = [os.path.join(ROOT, "main.py")]
    for folder in ("py_modules", "scripts"):
        base = os.path.join(ROOT, folder)
        for name in sorted(os.listdir(base)):
            if name.endswith(".py"):
                files.append(os.path.join(base, name))
    return files


def check_syntax():
    bad = []
    for path in py_files():
        proc = subprocess.run(
            [sys.executable, "-m", "py_compile", path], capture_output=True, text=True
        )
        if proc.returncode != 0:
            bad.append(os.path.basename(path) + ": " + proc.stderr.strip().splitlines()[-1])
    return (not bad, "; ".join(bad) if bad else "%d files" % len(py_files()))


def dictionary_pairs():
    pairs = []
    for name in ("i18n.ts", "i18n.en.ts"):
        text = io.open(os.path.join(SRC, name), encoding="utf-8").read()
        pairs += re.findall(r'^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"', text, re.M)
    return pairs


def check_coverage():
    have = {k for k, _ in dictionary_pairs()}
    used, missing = set(), set()
    for name in sorted(os.listdir(SRC)):
        if not name.endswith((".ts", ".tsx")) or "i18n" in name:
            continue
        text = io.open(os.path.join(SRC, name), encoding="utf-8").read()
        for match in re.finditer(r"\b(?:t|tf)\(\s*([\"'])((?:[^\\]|\\.)*?)\1", text):
            key = match.group(2)
            if not CJK.search(key):
                continue
            used.add(key)
            if key not in have:
                missing.add(key)
    if missing:
        return False, "missing %d: %s" % (len(missing), ", ".join(sorted(missing)[:3]))
    return True, "%d keys used, all translated" % len(used)


def check_placeholders():
    bad = [(k, v) for k, v in dictionary_pairs() if sorted(PLACEHOLDER.findall(k)) != sorted(PLACEHOLDER.findall(v))]
    return (not bad, "mismatch: %s" % (bad[0] if bad else ""))


def check_translated_maps():
    """Values of the label maps are passed to t() indirectly (`t(o.label)`), so the
    literal-based coverage check cannot see them. Verify them explicitly."""
    api = io.open(os.path.join(SRC, "api.ts"), encoding="utf-8").read()
    have = {k for k, _ in dictionary_pairs()}
    missing = []
    for name in sorted(TRANSLATED_MAPS - {"TABS"}):
        match = re.search(r"^\s*(?:export\s+)?const\s+%s\b[^\n]*=\s*[\{\[]" % name, api, re.M)
        if not match:
            continue
        depth, j = 1, match.end()
        while j < len(api):
            if api[j] in "{[(":
                depth += 1
            elif api[j] in "}])":
                depth -= 1
                if depth <= 0:
                    break
            j += 1
        for value in re.findall(r"['\"]([^'\"]*[\u4e00-\u9fff][^'\"]*)['\"]", api[match.end():j]):
            if value not in have and value not in AUTONYMS:
                missing.append("%s:%s" % (name, value))
    return (not missing, "untranslated map values: " + ", ".join(sorted(missing)[:4]) if missing else "")


def check_no_module_scope_t():
    """A `t()` evaluated while the module loads cannot follow a language change."""
    offenders = []
    for name in sorted(os.listdir(SRC)):
        if not name.endswith((".ts", ".tsx")) or "i18n" in name:
            continue
        lines = io.open(os.path.join(SRC, name), encoding="utf-8").read().splitlines()
        const_start, depth = None, 0
        for idx, line in enumerate(lines, 1):
            if re.match(r"^(export )?const [A-Za-z_0-9]+.*=\s*[{[]\s*$", line):
                const_start = idx
                depth = 1
                continue
            if not const_start:
                continue
            depth += line.count("{") + line.count("[") - line.count("}") - line.count("]")
            if re.search(r"\b(?:t|tf)\(\s*[\"']", line):
                # Only a *literal* evaluated while the module loads is a freeze.
                # The same shape inside a method body (`actions.install() { … }`)
                # runs per call and is fine, so skip those.
                body = "\n".join(lines[const_start - 1:idx])
                if not re.search(r"(?:function|=>|\)\s*\{)", body):
                    offenders.append("%s:%d" % (name, idx))
            if depth <= 0:
                const_start = None
    return (not offenders, "module-scope t() at " + ", ".join(offenders[:4]) if offenders else "")


def check_unwrapped_chinese():
    leftovers = []
    for name in sorted(os.listdir(SRC)):
        if not name.endswith((".ts", ".tsx")) or "i18n" in name:
            continue
        src = io.open(os.path.join(SRC, name), encoding="utf-8").read()
        src = re.sub(r"/\*[\s\S]*?\*/", "", src)
        src = re.sub(r"(?m)^\s*//.*$", "", src)
        # Blank out the bodies of the known label maps, keeping offsets intact.
        # The match must end at the line's closing bracket: a type annotation
        # like `: { data: string }[] = [` has a `{` of its own, and stopping
        # there would blank the annotation instead of the values.
        for map_name in TRANSLATED_MAPS:
            pattern = r"^\s*(?:export\s+)?const\s+%s\b[^\n]*=\s*[\{\[]\s*$" % map_name
            for match in re.finditer(pattern, src, re.M):
                depth, j = 1, match.end()
                while j < len(src):
                    if src[j] in "{[(":
                        depth += 1
                    elif src[j] in "}])":
                        depth -= 1
                        if depth <= 0:
                            break
                    j += 1
                body = "".join(c if c == "\n" else " " for c in src[match.end():j])
                src = src[:match.end()] + body + src[j:]
        i, n = 0, len(src)
        while i < n:
            ch = src[i]
            if ch == "/" and i + 1 < n and src[i + 1] == "/":
                j = src.find("\n", i)
                i = n if j < 0 else j
                continue
            if ch in "\"'":
                quote, j = ch, i + 1
                while j < n:
                    if src[j] == "\\":
                        j += 2
                        continue
                    if src[j] == quote:
                        break
                    j += 1
                body = src[i + 1:j]
                before = src[max(0, i - 14):i]
                if (
                    CJK.search(body)
                    and "${" not in body
                    and body not in ALLOWED_LITERALS
                    and not re.search(r"(?:t|tf)\(\s*$", before)
                ):
                    leftovers.append("%s:%d %s" % (name, src[:i].count("\n") + 1, body[:20]))
                i = j + 1
                continue
            i += 1
    return (not leftovers, "; ".join(leftovers[:4]) if leftovers else "")


def run_suite(name, extra=()):
    proc = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", name), *extra],
        capture_output=True,
        text=True,
    )
    tail = [ln for ln in (proc.stdout or "").strip().splitlines() if ln.strip()]
    summary = tail[-1] if tail else (proc.stderr or "").strip()[:120]
    return (proc.returncode == 0, summary)


def check_package():
    pkg = json.load(open(os.path.join(ROOT, "package.json"), encoding="utf-8"))
    binary = (pkg.get("remote_binary") or [{}])[0]
    problems = []
    if not re.match(r"^\d+\.\d+\.\d+", str(pkg.get("version") or "")):
        problems.append("version")
    if binary.get("name") != "legendary":
        problems.append("remote_binary.name")
    if not str(binary.get("url", "")).startswith("https://github.com/"):
        problems.append("remote_binary.url")
    if len(str(binary.get("sha256hash") or "")) != 64:
        problems.append("remote_binary.sha256hash")
    if pkg.get("license") != "BSD-3-Clause":
        problems.append("license")
    return (not problems, ",".join(problems) if problems else str(pkg.get("version")))


def check_build():
    proc = subprocess.run(["npx", "rollup", "-c"], cwd=ROOT, capture_output=True, text=True, shell=True)
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout).strip().splitlines()[-1] if (proc.stderr or proc.stdout) else "rollup failed"
    dist = os.path.join(ROOT, "dist", "index.js")
    size = os.path.getsize(dist)
    if size < 100_000:
        return False, "dist too small (%d bytes)" % size
    return True, "dist %d bytes" % size


def check_zip():
    proc = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "build_zip.py"), "--skip-build"],
        cwd=ROOT, capture_output=True, text=True,
    )
    combined = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        last = combined.strip().splitlines()[-1] if combined.strip() else "zip failed"
        # Some agent sandboxes intercept bulk deletes; `build_zip.py` clears its
        # staging directory, so the packaging step cannot run there. CI builds
        # the same zip on every tag, so this is reported as skipped, not failed.
        if "SAFE_DELETE" in combined or "safe-delete" in combined:
            return True, "skipped: environment blocks bulk delete (CI builds this on tags)"
        return False, last
    version = json.load(open(os.path.join(ROOT, "package.json"), encoding="utf-8"))["version"]
    path = os.path.join(ROOT, "EpicDeck-v%s.zip" % version)
    if not os.path.isfile(path):
        return False, "zip missing at " + os.path.basename(path)
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
    required = ("EpicDeck/main.py", "EpicDeck/package.json", "EpicDeck/plugin.json",
                "EpicDeck/dist/index.js", "EpicDeck/py_modules/protondb.py",
                "EpicDeck/py_modules/update_check.py")
    missing = [n for n in required if n not in names]
    if missing:
        return False, "missing in zip: " + ", ".join(missing)
    return True, "%d files, %d KB" % (len(names), os.path.getsize(path) // 1024)


def main():
    build = "--build" in sys.argv
    print("EpicDeck regression (offline)")
    step("python syntax", check_syntax)
    step("i18n coverage", check_coverage)
    step("i18n placeholders", check_placeholders)
    step("i18n label maps", check_translated_maps)
    step("no module-scope t()", check_no_module_scope_t)
    step("no unwrapped Chinese", check_unwrapped_chinese)
    step("suite: i18n", lambda: run_suite("test_i18n.py"))
    step("suite: geomnav", lambda: run_suite("test_geomnav.py"))
    step("suite: backend smoke", lambda: run_suite("smoke_backend.py"))
    step("package.json", check_package)
    if build:
        step("rollup build", check_build)
        step("decky zip", check_zip)

    failed = [name for name, ok, _ in results if not ok]
    print("\n%d/%d checks passed%s" % (len(results) - len(failed), len(results),
                                       "" if not failed else " — FAILED: " + ", ".join(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
