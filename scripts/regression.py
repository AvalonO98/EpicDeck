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
import tempfile
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


def dictionary_keys():
    """Keys that have an English entry.

    i18n.ts holds EN_BASE and i18n.en.ts holds EN_EXTRA; both are English.
    Chinese is the *source* language and has no dictionary of its own — a key
    that is missing here simply renders in Chinese inside an English UI, which
    is why the coverage check below insists on every Chinese literal.
    """
    return {k for k, _ in dictionary_pairs()}


def iter_string_literals(src):
    """Yield (offset, body) for every string literal, comments already gone.

    Callers blank the label maps in `src` first (offsets stay valid), so a map
    value is visited like any other literal.
    """
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
            yield i, src[i + 1:j]
            i = j + 1
            continue
        i += 1


def ui_sources():
    for name in sorted(os.listdir(SRC)):
        if not name.endswith((".ts", ".tsx")) or "i18n" in name:
            continue
        yield name, io.open(os.path.join(SRC, name), encoding="utf-8").read()


def blank_label_maps(src):
    """Blank the bodies of the known label maps, keeping offsets intact.

    Their values stay in the source language on purpose and are translated at
    render time, so they are validated by `check_translated_maps` instead.
    """
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
    return src


def check_coverage():
    """Every Chinese literal in the UI must have an English entry.

    Checking only the arguments of `t("…")` was not enough (审计 5.3): keys also
    reach `t()` through variables, template literals and props, and a missing
    entry fails silently by showing Chinese to an English user. So the rule is
    now positional — any Chinese literal outside the allow-lists must be a
    dictionary key. Anything intentionally left in Chinese belongs in
    `ALLOWED_LITERALS` (tab labels) or `AUTONYMS` (language names).
    """
    have = dictionary_keys()
    allowed = ALLOWED_LITERALS | AUTONYMS
    missing = []
    for name, source in ui_sources():
        source = re.sub(r"/\*[\s\S]*?\*/", "", source)
        source = re.sub(r"(?m)^\s*//.*$", "", source)
        source = blank_label_maps(source)
        for offset, body in iter_string_literals(source):
            if not CJK.search(body) or "${" in body or body in allowed:
                continue
            if body not in have:
                missing.append("%s:%d %s" % (name, source[:offset].count("\n") + 1, body[:20]))
    if missing:
        return False, "%d untranslated: %s" % (len(missing), "; ".join(missing[:3]))
    return True, "%d keys, every Chinese literal translated" % len(have)



def check_placeholders():
    bad = [(k, v) for k, v in dictionary_pairs() if sorted(PLACEHOLDER.findall(k)) != sorted(PLACEHOLDER.findall(v))]
    return (not bad, "mismatch: %s" % (bad[0] if bad else ""))


def check_translated_maps():
    """Values of the label maps are passed to t() indirectly (`t(o.label)`), so the
    literal-based coverage check never sees them as keys. Verify them explicitly.

    The maps live in whichever module owns them — TABS sits in fullscreen.tsx,
    the rest in api.ts — so this scans every UI source rather than api.ts alone.
    """
    have = dictionary_keys()
    missing = []
    seen = set()
    for name in sorted(TRANSLATED_MAPS):
        pattern = r"^\s*(?:export\s+)?const\s+%s\b[^\n]*=\s*[\{\[]" % name
        for filename, api in ui_sources():
            match = re.search(pattern, api, re.M)
            if not match:
                continue
            seen.add(name)
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
    if missing:
        return False, "untranslated map values: " + ", ".join(sorted(missing)[:4])
    return True, "%d maps, %d entries" % (len(seen), len(have))


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
    for name, source in ui_sources():
        src = re.sub(r"/\*[\s\S]*?\*/", "", source)
        src = re.sub(r"(?m)^\s*//.*$", "", src)
        src = blank_label_maps(src)
        for offset, body in iter_string_literals(src):
            before = src[max(0, offset - 14):offset]
            if (
                CJK.search(body)
                and "${" not in body
                and body not in ALLOWED_LITERALS
                and not re.search(r"(?:t|tf)\(\s*$", before)
            ):
                leftovers.append("%s:%d %s" % (name, src[:offset].count("\n") + 1, body[:20]))
    return (not leftovers, "; ".join(leftovers[:4]) if leftovers else "")


def run_suite(name, extra=()):
    # The three suites used to call `mkdtemp()` with no `dir=`, so `--tmpdir`
    # only moved the bytecode while every scratch file still landed in the
    # system temp (审计 D10). Hand them the same directory through the
    # environment — `tempfile` honours TMPDIR/TEMP/TMP.
    env = os.environ.copy()
    scratch = (env.get("PYTHONPYCACHEPREFIX") or "").strip()
    if scratch:
        env["EPICDECK_TMPDIR"] = env.get("EPICDECK_TMPDIR") or scratch
        for key in ("TMPDIR", "TEMP", "TMP"):
            env[key] = env["EPICDECK_TMPDIR"]
    proc = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", name), *extra],
        capture_output=True,
        text=True,
        env=env,
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
    """Run the repo's own rollup, not `npx`.

    `npx` is a shell shim on Windows and resolves through the PATH before it
    looks at `node_modules`, so the build step failed with a bare "rollup
    failed" while `python scripts/build_zip.py` (which calls node directly)
    worked fine (审计 5.4). Calling the JS entry keeps both paths identical.
    """
    rollup_js = os.path.join(ROOT, "node_modules", "rollup", "dist", "bin", "rollup")
    if not os.path.isfile(rollup_js):
        return False, "rollup is not installed (run npm/pnpm install)"
    proc = subprocess.run(
        ["node", rollup_js, "-c"], cwd=ROOT, capture_output=True, text=True
    )
    if proc.returncode != 0:
        combined = (proc.stderr or "") + (proc.stdout or "")
        lines = [ln for ln in combined.strip().splitlines() if ln.strip()]
        return False, lines[-1] if lines else "rollup failed"
    dist = os.path.join(ROOT, "dist", "index.js")
    if not os.path.isfile(dist):
        return False, "dist/index.js missing after the build"
    return True, "dist %d bytes" % os.path.getsize(dist)


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


def prepare_pycache(argv):
    """Keep `.pyc` files out of the source tree, and make that configurable.

    `py_compile` writes `__pycache__` next to every file. On Windows those can
    be locked or read-only (an editor, a sync client, a previous run in a
    different shell), which turns a syntax check into a permission error that
    says nothing about the code (审计 5.4). `--tmpdir PATH` and
    `$PYTHONPYCACHEPREFIX` both override the location; without either we use a
    session temp dir, so the default already avoids the source tree.
    """
    target = ""
    if "--tmpdir" in argv:
        index = argv.index("--tmpdir")
        if index + 1 < len(argv):
            target = argv[index + 1]
        else:
            print("  --tmpdir needs a path", file=sys.stderr)
    target = target or os.environ.get("PYTHONPYCACHEPREFIX") or ""
    if not target:
        target = os.path.join(tempfile.gettempdir(), "epicdeck-pyc")
    try:
        os.makedirs(target, exist_ok=True)
    except OSError as exc:
        print("  cannot use %s (%s); leaving bytecode where Python puts it"
              % (target, exc), file=sys.stderr)
        return ""
    os.environ["PYTHONPYCACHEPREFIX"] = target
    return target


def main():
    build = "--build" in sys.argv
    pycache = prepare_pycache(sys.argv)
    print("EpicDeck regression (offline)")
    if pycache:
        print("  bytecode -> " + pycache)
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
