"""Bootstrap password SSH to a Steam Deck, then switch to key auth.

A fresh Deck has no `authorized_keys` entry for this machine, so `scp`/`ssh`
cannot be used to install one. This uses password auth once (paramiko), appends
the public key, and from then on the normal tooling (`ssh -i …`) works.

    pip install paramiko
    python scripts/install_deck_key.py                     # generate key if missing, install it
    python scripts/install_deck_key.py --probe             # only show host / ip / os
    python scripts/install_deck_key.py --run 'uname -a'    # run one command over password auth

Options / environment:

    --host   (DECK_HOST)      default steamdeck.local — mDNS is flaky, an IP works too
    --user   (DECK_USER)      default deck
    --key                     default ~/.ssh/epicdeck_steamdeck
    --password (DECK_PASSWORD) default: try the two well-known SteamOS values

SteamOS ships with a known default password; passing it via environment keeps
it out of shell history.
"""
import argparse
import os
import subprocess
import sys

DEFAULT_KEY = "~/.ssh/epicdeck_steamdeck"
KNOWN_PASSWORDS = ("steamdeck", "deck")


def ensure_key(path: str) -> str:
    """Create an ed25519 key at `path` if there is none; return the public key."""
    path = os.path.expanduser(path)
    pub = path + ".pub"
    if not os.path.isfile(path):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        node = os.uname().nodename if hasattr(os, "uname") else "dev"
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "epicdeck@" + node, "-f", path],
            check=True,
            capture_output=True,
        )
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    if not os.path.isfile(pub):
        # `ssh-keygen -y` prints the public key; `-f` cannot write it alone.
        out = subprocess.run(
            ["ssh-keygen", "-y", "-f", path], check=True, capture_output=True, text=True
        ).stdout
        with open(pub, "w", encoding="utf-8") as fh:
            fh.write(out)
    with open(pub, encoding="utf-8") as fh:
        return fh.read().strip()


def connect(host: str, user: str, password: str | None):
    try:
        import paramiko
    except ImportError:
        sys.exit("paramiko is not installed — `pip install paramiko`")

    candidates = [password] if password else list(KNOWN_PASSWORDS)
    last = None
    for candidate in candidates:
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(host, username=user, password=candidate, timeout=10,
                           allow_agent=False, look_for_keys=False)
            print("[ok] password auth accepted")
            return client
        except Exception as exc:  # noqa: BLE001 - report, then try the next one
            last = exc
            print("[--] password rejected: %s" % type(exc).__name__)
    sys.exit("cannot connect to %s: %s" % (host, last))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=os.environ.get("DECK_HOST", "steamdeck.local"))
    ap.add_argument("--user", default=os.environ.get("DECK_USER", "deck"))
    ap.add_argument("--key", default=DEFAULT_KEY)
    ap.add_argument("--password", default=os.environ.get("DECK_PASSWORD"))
    ap.add_argument("--probe", action="store_true", help="print hostname / os / ip")
    ap.add_argument("--run", metavar="CMD", help="run one command over password auth")
    args = ap.parse_args()

    client = connect(args.host, args.user, args.password)
    try:
        if args.probe:
            for cmd in ("hostname", "cat /etc/os-release | head -2",
                        "ip -4 addr show | grep 'inet '"):
                _, out, _ = client.exec_command(cmd)
                print(out.read().decode().strip())
            return 0
        if args.run:
            _, out, err = client.exec_command(args.run, timeout=180)
            sys.stdout.write(out.read().decode())
            sys.stderr.write(err.read().decode())
            return out.channel.recv_exit_status()

        pub = ensure_key(args.key)
        quoted = pub.replace("'", "'\\''")
        cmd = (
            "mkdir -p ~/.ssh && chmod 700 ~/.ssh && "
            "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && "
            "grep -qF '%s' ~/.ssh/authorized_keys || echo '%s' >> ~/.ssh/authorized_keys; "
            "wc -l < ~/.ssh/authorized_keys" % (quoted, quoted)
        )
        _, out, err = client.exec_command(cmd)
        print("authorized_keys lines: " + out.read().decode().strip())
        print("key: " + os.path.expanduser(args.key))
        print("now try: ssh -i %s %s@%s echo ok" % (args.key, args.user, args.host))
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
