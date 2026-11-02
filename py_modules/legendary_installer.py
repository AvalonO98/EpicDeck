# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Download and install the Legendary standalone binary.

SteamOS has no `pip` and its filesystem is immutable, so the standard
`pip install legendary-gl` does not work. Instead we download the official
prebuilt Linux binary (built with PyInstaller, no Python required) from
GitHub Releases into a user-writable directory.
"""

import os
import platform
import shutil
import stat
import urllib.request

# Legendary GitHub Releases API and known asset names per platform.
RELEASES_API = "https://api.github.com/repos/legendary-gl/legendary/releases/latest"

# Map (system, machine) -> asset name on the release page.
# machine is normalized to x86_64 / aarch64 before lookup.
_ASSET_MAP = {
    ("Linux", "x86_64"): "legendary_linux_x64",
    ("Linux", "aarch64"): "legendary_linux_arm64",
    ("Windows", "x86_64"): "legendary_windows_x64.exe",
    ("Darwin", "x86_64"): "legendary_macOS_x64",
    ("Darwin", "aarch64"): "legendary_macOS_arm64",
}


class InstallerError(Exception):
    pass


def default_install_dir():
    """User-writable directory for the legendary binary.

    On Steam Deck this resolves under the Decky runtime dir; elsewhere it
    falls back to ~/.local/bin (which is on many users' PATH).
    """
    import decky  # noqa: F401  (only available at runtime)

    try:
        base = decky.DECKY_PLUGIN_RUNTIME_DIR
        return os.path.join(base, "bin")
    except Exception:
        return os.path.expanduser("~/.local/bin")


def _normalize_machine(machine: str) -> str:
    m = machine.lower()
    if m in ("x86_64", "amd64"):
        return "x86_64"
    if m in ("arm64", "aarch64"):
        return "aarch64"
    return machine


def asset_name_for_platform():
    sys_name = platform.system()
    machine = _normalize_machine(platform.machine())
    key = (sys_name, machine)
    name = _ASSET_MAP.get(key)
    if name is None:
        raise InstallerError(
            "不支持的系统架构: %s / %s" % (sys_name, machine)
        )
    return name


def _http_get_json(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": "EpicDeck", "Accept": "application/vnd.github+json"}
    )
    import json
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_download_info():
    """Return (asset_name, download_url, version) for this platform."""
    asset_name = asset_name_for_platform()
    data = _http_get_json(RELEASES_API)
    version = data.get("tag_name", "")
    for asset in data.get("assets", []):
        if asset.get("name") == asset_name:
            return asset_name, asset["browser_download_url"], version
    raise InstallerError(
        "未在最新 Release 中找到 %s(平台不受支持)" % asset_name
    )


def download_legendary(dest_dir: str):
    """Download the platform-appropriate binary into dest_dir. Returns path."""
    asset_name, url, version = get_download_info()
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "legendary")
    if os.name == "nt":
        dest = os.path.join(dest_dir, "legendary.exe")

    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "EpicDeck"})
    with urllib.request.urlopen(req, timeout=300) as resp, open(tmp, "wb") as f:
        shutil.copyfileobj(resp, f)

    os.replace(tmp, dest)
    if os.name != "nt":
        os.chmod(dest, os.stat(dest).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return dest, version


def is_legendary_installed(binary_path: str) -> bool:
    """Return True if a usable legendary binary exists at binary_path or PATH."""
    if binary_path and os.path.isfile(binary_path):
        return True
    return shutil.which("legendary") is not None
