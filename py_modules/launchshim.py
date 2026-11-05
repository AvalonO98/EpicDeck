# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Keep the game in the foreground so Steam measures playtime correctly.

`legendary launch` starts the game with `subprocess.Popen` and returns
immediately -- it never calls `.wait()`. Steam launched our wrapper script, so
Steam watches *us*: our process exits a fraction of a second after the game
starts, and Steam marks the game as stopped. Playtime stays at zero, the
library shows the wrong "running" state, and the overlay loses its anchor.

Legendary has an escape hatch: `launch --json` prints the launch plan instead
of starting anything. We take that plan, run the game ourselves, and stay
alive until it exits. Keeping the process tree alive also gives us the exit
code (useful when a game dies during boot) and an obvious hook point for
cloud-save sync before and after the game.

If the plan cannot be obtained -- an older legendary, unexpected output,
anything at all -- we fall back to the plain `launch` behaviour. A game must
never fail to start because of this shim.
"""

import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import time

PLAN_TIMEOUT = 120.0  # seconds; the plan call also does a version check
# Per-game launch log cap. A single launch rarely writes more than a few KB,
# so 256 KB is generous headroom; once exceeded, the current file is rotated
# to `<name>.log.1` (keeping only the previous generation) and a fresh file
# starts. Worst case on disk is 2 * LOG_LIMIT = 512 KB per game. This keeps
# every game's log bounded regardless of how many times it is launched.
LOG_LIMIT = 256 * 1024

# Legendary appends Epic's EGL arguments to the game command line, and they
# carry the one-shot exchange code plus the account id. This log is written to
# disk and may be attached to an issue report, so those values are masked
# before anything is formatted. Keep this list in sync with py_modules/main.py.
_SENSITIVE_PREFIXES = ("-AUTH_PASSWORD=", "-AUTH_LOGIN=", "-epicuserid=")


def _redact(value):
    text = str(value)
    for prefix in _SENSITIVE_PREFIXES:
        if text.startswith(prefix):
            return prefix + "***"
    return text


def _redact_command(command):
    return [_redact(part) for part in command]


def _redact_plan(plan):
    redacted = dict(plan)
    if isinstance(redacted.get("egl_parameters"), list):
        redacted["egl_parameters"] = _redact_command(redacted["egl_parameters"])
    if isinstance(redacted.get("game_parameters"), list):
        redacted["game_parameters"] = _redact_command(redacted["game_parameters"])
    if isinstance(redacted.get("user_parameters"), list):
        redacted["user_parameters"] = _redact_command(redacted["user_parameters"])
    return redacted


def _shell(command):
    return " ".join(shlex.quote(part) for part in _redact_command(command))


def _timestamp():
    return time.strftime("%Y-%m-%d %H:%M:%S")


class Log:
    """Best-effort append-only log. Never raises: a game launch outranks it."""

    def __init__(self, path):
        self.path = ""
        if not path:
            return
        try:
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            self.path = path
        except OSError:
            self.path = ""

    def __call__(self, message):
        line = "%s %s\n" % (_timestamp(), message)
        if not self.path:
            sys.stderr.write(line)
            return
        try:
            if os.path.exists(self.path) and os.path.getsize(self.path) > LOG_LIMIT:
                os.replace(self.path, self.path + ".1")
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(line)
        except OSError:
            sys.stderr.write(line)


def _parse_args(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--legendary", required=True)
    parser.add_argument("--app", required=True)
    parser.add_argument("--wine", default="")
    parser.add_argument("--log", default="")
    # Diagnostics only: print the plan and the command we would run, then exit
    # without starting anything. Lets us verify the command line on a device
    # without taking over the screen with a real game.
    parser.add_argument("--plan-only", action="store_true", dest="plan_only")
    parser.add_argument("game_args", nargs=argparse.REMAINDER)
    parsed = parser.parse_args(argv)
    if parsed.game_args and parsed.game_args[0] == "--":
        parsed.game_args = parsed.game_args[1:]
    return parsed


def _plan_command(legendary, app, wine, game_args):
    """Build the `launch --json` invocation.

    `--json` has to come *before* the app name: legendary parses the trailing
    arguments with argparse.REMAINDER, so a flag placed after the app name
    would be handed to the game instead of legendary.
    """
    command = [legendary, "launch", "--json"]
    if wine:
        command += ["--wine", wine]
    command.append(app)
    command += list(game_args)
    return command


def _parse_plan(stdout):
    """Extract the launch plan object from legendary's stdout."""
    text = (stdout or "").strip()
    start = text.find("{")
    if start < 0:
        return None
    return json.loads(text[start:])


def _fallback(legendary, app, wine, game_args, log, reason):
    """Become the plain `launch` call, exactly like the old launcher script."""
    log("fallback to single-stage launch: %s" % reason)
    os.environ.pop("WINEPREFIX", None)
    command = [legendary, "launch"]
    if wine:
        command += ["--wine", wine]
    command.append(app)
    command += list(game_args)
    log("exec %s" % _shell(command))
    sys.stdout.flush()
    sys.stderr.flush()
    os.execv(legendary, command)


def _forward_signals(proc, log):
    """Relay Steam's stop signal to the game's process group.

    The game is started in its own session so a stray Ctrl-C in a terminal
    does not hit it, which means we have to forward termination ourselves.
    """

    def handler(signum, _frame):
        log("signal %d -> game process group" % signum)
        try:
            os.killpg(proc.pid, signum)
        except OSError:
            pass

    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        signum = getattr(signal, name, None)
        if signum is None:
            continue
        try:
            signal.signal(signum, handler)
        except (ValueError, OSError):
            pass


def _build_command(plan):
    """Turn a launch plan into (command, cwd, environment).

    Legendary returns the executable relative to the game directory, and the
    EGL parameters carry the one-shot auth code, so the order matters:
    `<launcher prefix> <exe> <game args> <user args> <egl args>`.
    """
    launch_command = list(plan.get("launch_command") or [])
    game_directory = plan.get("game_directory") or ""
    executable = plan.get("game_executable") or ""
    if not executable:
        raise RuntimeError("launch plan has no game_executable")
    if not os.path.isabs(executable):
        executable = os.path.join(game_directory, executable)

    command = launch_command + [executable]
    command += list(plan.get("game_parameters") or [])
    command += list(plan.get("user_parameters") or [])
    command += list(plan.get("egl_parameters") or [])

    working_directory = plan.get("working_directory") or game_directory or None
    environment = os.environ.copy()
    for key, value in (plan.get("environment") or {}).items():
        if value is not None:
            environment[str(key)] = str(value)
    return command, working_directory, environment


def _run_plan(plan, log):
    """Start the game from a launch plan and block until it exits."""
    command, working_directory, environment = _build_command(plan)

    pre_launch = plan.get("pre_launch_command") or ""
    if pre_launch:
        try:
            log("pre-launch: %s" % pre_launch)
            pre = subprocess.Popen(shlex.split(pre_launch), env=environment)
            if plan.get("pre_launch_wait"):
                pre.wait()
        except Exception as exc:  # noqa: BLE001 - must not block the launch
            log("pre-launch failed: %r" % exc)

    log("exec %s" % _shell(command))
    log("cwd %s" % working_directory)
    proc = subprocess.Popen(command, cwd=working_directory, env=environment,
                            start_new_session=True)
    _forward_signals(proc, log)
    return proc.wait()


def main(argv=None):
    arguments = _parse_args(sys.argv[1:] if argv is None else argv)
    log = Log(arguments.log)
    log("--- launch %s (wine=%s, args=%s)"
        % (arguments.app, arguments.wine or "-", " ".join(arguments.game_args) or "-"))

    try:
        plan_run = subprocess.run(
            _plan_command(arguments.legendary, arguments.app, arguments.wine,
                          arguments.game_args),
            capture_output=True, text=True, timeout=PLAN_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001
        _fallback(arguments.legendary, arguments.app, arguments.wine,
                  arguments.game_args, log, "plan call failed: %r" % exc)

    if plan_run.returncode != 0:
        tail = (plan_run.stderr or "").strip().splitlines()[-3:]
        _fallback(arguments.legendary, arguments.app, arguments.wine,
                  arguments.game_args, log,
                  "plan exit %d: %s" % (plan_run.returncode, " / ".join(tail)))

    try:
        plan = _parse_plan(plan_run.stdout)
    except ValueError as exc:
        _fallback(arguments.legendary, arguments.app, arguments.wine,
                  arguments.game_args, log, "plan is not JSON: %r" % exc)

    if not isinstance(plan, dict) or not plan.get("game_executable"):
        _fallback(arguments.legendary, arguments.app, arguments.wine,
                  arguments.game_args, log, "plan is missing game_executable")

    if arguments.plan_only:
        try:
            command, working_directory, _ = _build_command(plan)
        except RuntimeError as exc:
            print("plan_invalid: %s" % exc)
            return 1
        print("plan: %s" % json.dumps(_redact_plan(plan), ensure_ascii=False))
        print("cwd: %s" % working_directory)
        print("command: %s" % _shell(command))
        log("plan-only: %d argv entries" % len(command))
        return 0

    try:
        code = _run_plan(plan, log)
    except OSError as exc:
        _fallback(arguments.legendary, arguments.app, arguments.wine,
                  arguments.game_args, log, "game could not start: %r" % exc)

    log("game exited with %s" % code)
    return code


if __name__ == "__main__":
    # Exit code 90 tells the generated launcher script "no game was started",
    # which makes it fall through to the plain `legendary launch` path. Any
    # other code is a real game exit status and must be passed through
    # untouched, so only failures that never reached the game map to 90.
    try:
        status = main()
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001
        sys.stderr.write("launchshim failed: %r\n" % (exc,))
        status = 90
    sys.exit(status)
