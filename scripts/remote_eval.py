"""Run a JS snippet inside a Steam Deck CEF page, without shell-quoting pain.

The Deck's Steam client exposes a CDP port, and `scripts/cdp_eval.py` (which
runs *on the device*) talks to it. Passing a multi-line snippet through `ssh`
means fighting three levels of quoting — this wraps that: the snippet is piped
over stdin, written to `/tmp/_probe.js`, and evaluated there.

    python scripts/remote_eval.py probe.js                 # Steam 大屏幕模式
    python scripts/remote_eval.py probe.js SharedJSContext
    echo 'document.title' | python scripts/remote_eval.py -  # stdin

Environment overrides (no need to edit the file per machine):

    DECK_HOST   default steamdeck.local
    DECK_USER   default deck
    DECK_KEY    default ~/.ssh/epicdeck_steamdeck

If `cdp_eval.py` is not on the device yet, the local copy is uploaded first.
"""
import os
import shlex
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.path.expanduser(os.environ.get("DECK_KEY") or "~/.ssh/epicdeck_steamdeck")
USER = os.environ.get("DECK_USER", "deck")
HOST = os.environ.get("DECK_HOST", "steamdeck.local")
TARGET = USER + "@" + HOST


def ssh(cmd: str, stdin: str | None = None, timeout: int = 180):
    return subprocess.run(
        [
            "ssh", "-i", KEY,
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ConnectTimeout=10",
            TARGET, cmd,
        ],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def ensure_helper() -> None:
    """Upload `cdp_eval.py` when the device does not have it yet."""
    probe = ssh("test -f /tmp/cdp_eval.py && echo yes || echo no")
    if "yes" in (probe.stdout or ""):
        return
    local = os.path.join(ROOT, "scripts", "cdp_eval.py")
    with open(local, encoding="utf-8") as fh:
        payload = fh.read()
    up = ssh("cat > /tmp/cdp_eval.py", stdin=payload)
    if up.returncode != 0:
        sys.exit("cannot upload cdp_eval.py: " + (up.stderr or "").strip())


def main() -> int:
    arg = sys.argv[1] if len(sys.argv) > 1 else "-"
    if arg != "-":
        with open(arg, encoding="utf-8") as fh:
            src = fh.read()
    else:
        src = sys.stdin.read()
    page = sys.argv[2] if len(sys.argv) > 2 else "Steam 大屏幕模式"

    up = ssh("cat > /tmp/_probe.js", stdin=src)
    if up.returncode != 0:
        print("upload failed: " + (up.stderr or "").strip(), file=sys.stderr)
        return 1

    ensure_helper()
    # `$(cat …)` keeps the snippet out of the remote shell's quoting rules.
    cmd = "cd /tmp && python3 cdp_eval.py \"$(cat /tmp/_probe.js)\" " + shlex.quote(page)
    out = ssh(cmd)
    sys.stdout.write(out.stdout or "")
    if (out.stderr or "").strip():
        sys.stderr.write(out.stderr)
    return out.returncode


if __name__ == "__main__":
    sys.exit(main())
