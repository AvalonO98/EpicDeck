"""Wrap Chinese UI strings with t()/tf() for the i18n layer.

Only literal strings and JSX text nodes are touched; comments, identifiers and
comparisons are left alone. Run with `--check` to see what would change.

Deliberately conservative:
  * lines containing comparison operators are skipped (a Chinese string used as a
    value to compare against must not be translated);
  * `api.ts` is not processed at all — its label maps are evaluated at import
    time, so `t()` there would freeze the language; those are wrapped at the use
    site instead.
"""

from __future__ import annotations

import io
import os
import re
import sys

CJK = re.compile(r"[\u4e00-\u9fff]")
SKIP_LINE = re.compile(r"===|!==|\.includes\(|\.startsWith\(|\.indexOf\(|^\s*case\s|^\s*import\s")
SKIP_FILES = {"api.ts", "i18n.ts"}

FILES = [
    "src/fullscreen.tsx",
    "src/components.tsx",
    "src/login.tsx",
    "src/qam.tsx",
    "src/index.tsx",
    "src/steammenu.tsx",
    "src/store.ts",
]


def convert_strings(src: str) -> tuple[str, int]:
    """Walk the file and wrap quoted literals that contain CJK."""
    out = []
    i = 0
    n = len(src)
    changed = 0
    line_start = 0

    while i < n:
        ch = src[i]
        # comments -------------------------------------------------------
        if ch == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(src[i:j])
            i = j
            continue
        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(src[i:j])
            i = j
            continue
        # quoted strings -------------------------------------------------
        if ch in "\"'":
            quote = ch
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == quote:
                    break
                j += 1
            body = src[i + 1:j]
            line = src[line_start:i]
            already = re.search(r'(?:^|[^\w.])(?:t|tf)\(\s*$', line) is not None
            if CJK.search(body) and not SKIP_LINE.search(line) and "${" not in body and not already:
                # A JSX attribute value needs braces: label={t("…")}
                k = i - 1
                while k >= 0 and src[k] in " \t":
                    k -= 1
                is_attr = src[k] == "=" if k >= 0 else False
                if is_attr and k >= 1 and src[k - 1] in "=!<>":
                    is_attr = False
                wrapped = "t(%s%s%s)" % (quote, body, quote)
                out.append("{%s}" % wrapped if is_attr else wrapped)
                changed += 1
            else:
                out.append(src[i:j + 1])
            i = j + 1
            continue
        # template strings -----------------------------------------------
        if ch == "`":
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "`":
                    break
                j += 1
            body = src[i + 1:j]
            line = src[line_start:i]
            if CJK.search(body) and "${" not in body and "\\" not in body and not SKIP_LINE.search(line):
                out.append('t("%s")' % body)
                changed += 1
            else:
                out.append(src[i:j + 1])
            i = j + 1
            continue

        out.append(ch)
        if ch == "\n":
            line_start = i + 1
        i += 1

    return "".join(out), changed


def convert_jsx_text(src: str) -> tuple[str, int]:
    """`>中文<` -> `>{t("中文")}<` (only glyphs, no braces or tags)."""
    count = 0

    def repl(match: re.Match) -> str:
        nonlocal count
        text = match.group(1)
        stripped = text.strip()
        if not stripped or not CJK.search(stripped):
            return match.group(0)
        if "=>" in text or "{" in text or "}" in text:
            return match.group(0)
        lead = text[: len(text) - len(text.lstrip())]
        tail = text[len(text.rstrip()):]
        count += 1
        return ">%s{t(%r)}%s<" % (lead, stripped, tail)

    out = re.sub(r">([^<>{}]*[\u4e00-\u9fff][^<>{}]*)<", repl, src)
    return out, count


def ensure_import(src: str, need_tf: bool) -> str:
    names = ["t"] + (["tf"] if need_tf else [])
    if re.search(r'import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*"\./i18n"', src):
        return src
    stmt = 'import { %s } from "./i18n";\n' % ", ".join(names)
    # after the last top-level import line
    lines = src.splitlines(keepends=True)
    idx = 0
    in_import = False
    for n, line in enumerate(lines):
        stripped = line.strip()
        if in_import:
            if stripped.endswith(";"):
                in_import = False
                idx = n + 1
            continue
        if line.startswith("import "):
            if stripped.endswith(";"):
                idx = n + 1
            else:
                in_import = True
    lines.insert(idx, stmt)
    return "".join(lines)


def main() -> int:
    check = "--check" in sys.argv
    total = 0
    for rel in FILES:
        if not os.path.isfile(rel):
            continue
        if os.path.basename(rel) in SKIP_FILES:
            continue
        src = io.open(rel, encoding="utf-8").read()
        out, n1 = convert_strings(src)
        out, n2 = convert_jsx_text(out)
        if n1 or n2:
            out = ensure_import(out, need_tf=False)
        total += n1 + n2
        print("%-24s literals=%-4d jsx=%-3d" % (os.path.basename(rel), n1, n2))
        if not check:
            io.open(rel, "w", encoding="utf-8").write(out)
    print("total:", total, "(check only)" if check else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
