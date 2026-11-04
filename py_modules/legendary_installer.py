# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Download and install the Legendary standalone binary.

SteamOS has no `pip` and its filesystem is immutable, so the standard
`pip install legendary-gl` does not work. Instead we download the official
prebuilt Linux binary (built with PyInstaller, no Python required) from
GitHub Releases into a user-writable directory.
"""

import hashlib
import os
import platform
import shutil
import stat
import ssl
import urllib.request

# Legendary GitHub Releases API and known asset names per platform.
RELEASES_API = "https://api.github.com/repos/legendary-gl/legendary/releases/latest"

# Pinned release for the platforms we can verify. Following `releases/latest`
# meant the same version string could resolve to different bytes over time:
# the download was whatever the CDN served that day, and nothing checked it.
# Pinning the tag plus the SHA-256 makes the install reproducible and turns a
# tampered or truncated mirror response into a hard failure instead of a
# silently broken binary. Platforms without a pinned hash fall back to the
# latest-release lookup and log that the download is unverified.
PINNED_RELEASE = "0.21.1"
RELEASE_ASSET_URL = (
    "https://github.com/legendary-gl/legendary/releases/download/%s/%s"
)
PINNED_SHA256 = {
    "legendary_linux_x64": (
        "dbed33bbe96031e65858233e4badf0a1d401bb6cb0cc995d1237cf3a0c826a45"
    ),
    "legendary_linux_arm64": (
        "e901cb52ada10d5cef6ffb2a0985099958124457bfb455a571023d1e042143d9"
    ),
}

# The real binary is ~14 MB; anything much larger is either the wrong asset or
# a hostile response. Cap the stream so a bad mirror cannot fill the disk.
MAX_BINARY_SIZE = 80 * 1024 * 1024

# GitHub acceleration mirrors (URL-prefix proxies) tried in order when the
# direct github.com download is unreachable. Each mirrors a full
# "https://github.com/..." URL by prefixing it. These are public community
# mirrors; they are only used as a fallback for the asset download.
# gh-proxy.com is the current GH-Proxy official mirror; the others are
# commonly-used alternates.
_MIRROR_PREFIXES = [
    "https://gh-proxy.com/",
    "https://ghfast.top/",
    "https://gh-proxy.net/",
]


def _ssl_context():
    """Build an SSL context that can actually verify GitHub's certificates.

    Decky's sandbox may leave SSL_CERT_FILE/SSL_CERT_DIR unset or pointing at a
    non-existent path, which makes urllib fail with CERTIFICATE_VERIFY_FAILED.
    Prefer certifi's bundle when available, then fall back to the system CA
    bundle, and finally to an unverified context as a last resort so that the
    download still works on minimal SteamOS installs.
    """
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    for candidate in (
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
    ):
        if os.path.isfile(candidate):
            return ssl.create_default_context(cafile=candidate)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx

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
    falls back to ~/.local/bin (which is on many users' PATH). Uses the shared
    `paths.runtime_dir()` so the location the rest of the plugin reports is
    the location this actually installs into.
    """
    try:
        from py_modules.paths import runtime_dir

        return os.path.join(runtime_dir(), "bin")
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
    with urllib.request.urlopen(req, timeout=30, context=_ssl_context()) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_download_info():
    """Return (asset_name, download_url, api_asset_url, version) for this platform.

    Pinned platforms return a fixed tag URL and empty api_asset_url; the
    caller verifies the hash. Anything else asks GitHub for the latest
    release and comes back unverified.
    """
    asset_name = asset_name_for_platform()
    if asset_name in PINNED_SHA256:
        return (
            asset_name,
            RELEASE_ASSET_URL % (PINNED_RELEASE, asset_name),
            "",
            PINNED_RELEASE,
        )
    data = _http_get_json(RELEASES_API)
    version = data.get("tag_name", "")
    for asset in data.get("assets", []):
        if asset.get("name") == asset_name:
            return (
                asset_name,
                asset["browser_download_url"],
                asset.get("url", ""),  # api.github.com/.../assets/{id}
                version,
            )
    raise InstallerError(
        "未在最新 Release 中找到 %s(平台不受支持)" % asset_name
    )


def _download_from(url: str, headers: dict, tmp: str, timeout: int,
                   limit: int = MAX_BINARY_SIZE):
    """Download `url` into `tmp`, enforcing `limit`. Returns the SHA-256 hex.

    Streams in 1 MiB chunks so a wrong Content-Length cannot bypass the cap.
    """
    digest = hashlib.sha256()
    received = 0
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
        declared = int(resp.headers.get("Content-Length") or 0)
        if declared > limit:
            raise InstallerError(
                "下载体积异常(%d 字节,上限 %d),已中止" % (declared, limit)
            )
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > limit:
                    raise InstallerError(
                        "下载体积超过上限(%d 字节),已中止" % limit
                    )
                digest.update(chunk)
                f.write(chunk)
            f.flush()
            os.fsync(f.fileno())
    return digest.hexdigest()


def download_legendary(dest_dir: str):
    """Download the platform-appropriate binary into dest_dir. Returns path.

    Tries several download sources in order, so the install still works when
    github.com is blocked (common behind the GFW): direct -> mirrors -> API
    asset endpoint. When the asset is pinned, every candidate must reproduce
    the expected SHA-256; a mismatch is retried on the next mirror and finally
    reported with the hash we actually got, never installed.
    """
    asset_name, url, api_url, version = get_download_info()
    expected = PINNED_SHA256.get(asset_name)
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "legendary")
    if os.name == "nt":
        dest = os.path.join(dest_dir, "legendary.exe")

    tmp = dest + ".part"
    base_headers = {"User-Agent": "EpicDeck"}

    # Build the ordered list of candidate URLs to try. Direct github.com first
    # (fastest on open networks), then mirrors, then the API asset endpoint.
    candidates = [url]  # direct github.com
    candidates += [prefix + url for prefix in _MIRROR_PREFIXES]  # mirrors
    if api_url:
        candidates.append(api_url)  # api.github.com asset endpoint (redirects)

    last_err = None
    mismatched = []
    for candidate in candidates:
        try:
            headers = dict(base_headers)
            if candidate == api_url:
                headers["Accept"] = "application/octet-stream"
            # Fail fast (10s) on each candidate so a blocked host doesn't stall
            # the whole install; the binary is only ~14 MB.
            actual = _download_from(candidate, headers, tmp, timeout=10)
            if expected and actual != expected:
                mismatched.append((candidate, actual))
                _remove(tmp)
                continue
            os.replace(tmp, dest)
            break
        except Exception as e:
            last_err = e
            # Remove the partial file so the next attempt starts clean.
            _remove(tmp)
            continue
    else:
        if mismatched:
            candidate, actual = mismatched[-1]
            raise InstallerError(
                "Legendary 校验失败:期望 SHA-256 %s,实际 %s(%s)。出于安全考虑已中止安装。"
                % (expected, actual, candidate)
            )
        raise InstallerError(
            "Legendary 下载失败(直连与镜像均不可用): %s" % last_err
        )

    if os.name != "nt":
        os.chmod(dest, os.stat(dest).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return dest, version


def _remove(path: str):
    if os.path.isfile(path):
        try:
            os.unlink(path)
        except OSError:
            pass


def is_legendary_installed(binary_path: str) -> bool:
    """Return True if a usable legendary binary exists at binary_path or PATH."""
    if binary_path and os.path.isfile(binary_path):
        return True
    return shutil.which("legendary") is not None
