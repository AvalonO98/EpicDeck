# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Install-location helpers.

Earlier versions left the install root entirely to Legendary while the
settings dropdown displayed a *guess* (the home directory), so the UI said
"internal storage" and the games actually landed in ``~/Games``. Every place
that needs the root now asks this module instead, which keeps the displayed
path and the path handed to ``legendary install --base-path`` identical.
"""

import configparser
import os
import shutil

# Heroic and the CLI both write here; per-game args and the install root live
# in this file, so it is the best hint we have for an existing library.
LEGENDARY_CONFIG = "~/.config/legendary/config.ini"


def expand(path: str) -> str:
    """Expand ``~`` and ``$VARS`` and strip whitespace. Never raises."""
    if not path:
        return ""
    return os.path.expanduser(os.path.expandvars(str(path).strip()))


def legendary_configured_install_dir() -> str:
    """Return Legendary's own configured ``install_dir``, or "".

    Honouring it means an existing Heroic library keeps working instead of
    the plugin quietly starting a second one next to it.
    """
    try:
        # interpolation=None: paths may legitimately contain "%".
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(os.path.expanduser(LEGENDARY_CONFIG))
        value = parser.get("Legendary", "install_dir", fallback="") or ""
    except (configparser.Error, OSError):
        return ""
    return expand(value)


def default_games_dir() -> str:
    """Base path used when the user has not picked one."""
    return legendary_configured_install_dir() or os.path.expanduser("~/Games")


def free_bytes(path: str) -> int:
    """Free space for ``path``, walking up to the nearest existing directory."""
    current = path or "/"
    for _ in range(64):
        try:
            return shutil.disk_usage(current).free
        except OSError:
            parent = os.path.dirname(current)
            if not parent or parent == current:
                return 0
            current = parent
    return 0


def pretty_free(free: int) -> str:
    if free <= 0:
        return "空间未知"
    return "%0.1f GB 可用" % (free / 1024 / 1024 / 1024)


def ensure_dir(path: str):
    """Create ``path`` if needed and verify it is writable.

    Returns ``(realpath, error)`` where ``error`` is a user-facing message or
    an empty string on success. Used for paths the user typed in by hand, so
    "does not exist yet" is a normal case rather than a failure.
    """
    target = expand(path)
    if not target:
        return "", "安装目录为空"
    if not os.path.isabs(target):
        return "", "请填写绝对路径（以 / 开头）"
    try:
        os.makedirs(target, exist_ok=True)
    except PermissionError:
        return "", "没有权限创建目录: %s" % target
    except OSError as e:
        return "", "无法创建目录（%s）: %s" % (e.strerror or e, target)
    if not os.path.isdir(target):
        return "", "该路径不是文件夹: %s" % target
    if not os.access(target, os.W_OK):
        return "", "目录不可写: %s" % target
    return os.path.realpath(target), ""


def plugin_dir() -> str:
    """The installed plugin directory (``~/homebrew/plugins/<Name>``).

    Decky puts binaries declared in `package.json`'s `remote_binary` here, under
    `bin/`; that copy is what store installs should use, because it is the one
    the loader verified against the declared SHA-256.
    """
    try:
        import decky

        return getattr(decky, "DECKY_PLUGIN_DIR", "") or os.path.dirname(
            os.path.dirname(os.path.abspath(__file__))
        )
    except Exception:
        return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def runtime_dir() -> str:
    """Writable per-plugin data dir (``~/homebrew/data/<Name>``).

    Decky's uninstall only removes ``plugins/<Name>``, so anything that has to
    outlive the plugin — launch scripts, the Proton wrapper, the legendary
    binary — lives here. Every module that writes into it asks this function,
    because two different fallback chains used to disagree when
    ``DECKY_PLUGIN_RUNTIME_DIR`` was missing.
    """
    try:
        import decky

        return (
            getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", None)
            or getattr(decky, "DECKY_RUNTIME_DIR", None)
            or os.path.join(getattr(decky, "HOME", os.path.expanduser("~")), ".epicdeck")
        )
    except Exception:
        return os.path.expanduser("~/.epicdeck")
