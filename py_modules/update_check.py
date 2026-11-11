# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Check GitHub for a newer release.

Deliberately forgiving: GitHub is unreliable from mainland China, and a failed
version check must never surface as an error in the UI — the user is mid-game.
Every failure path returns ``ok: False`` with a short reason and the caller shows
nothing (or the last known result) instead of an alert.

Reference: Junk-Store does the same thing; see HANDOFF 7.13.5.
"""

from __future__ import annotations

import json
import os
import re
import ssl
import time
import urllib.error
import urllib.request

REPO = "AvalonO98/EpicDeck"
API = "https://api.github.com/repos/%s/releases/latest" % REPO
TTL = 24 * 3600  # one lookup a day is plenty for a self-hosted plugin


def _ssl_context() -> ssl.SSLContext:
    """Decky's sandbox has no default CA bundle; mirror the rest of the plugin."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    try:
        return ssl.create_default_context(cafile="/etc/ssl/certs/ca-certificates.crt")
    except Exception:
        # No CA bundle we can trust. Keep verification ON and let the handshake
        # fail (fail closed) — SECURITY.md forbids CERT_NONE fallbacks, and a
        # MITM could otherwise push a fake "latest version" / title (audit 3.11).
        return ssl.create_default_context()


def normalize(version: str) -> tuple:
    """`v0.8.8-beta.4` -> ('0','8','8','beta','4') for a tolerant comparison.

    A tag can be plain (``0.8.7``) while the running build is a pre-release
    (``0.8.8-beta.5``), so numbers are compared field by field and a pre-release
    ranks *below* the matching release, as semver says.
    """
    raw = str(version or "").strip().lower().lstrip("v")
    # keep digits and the pre-release tail; drop build metadata
    raw = raw.split("+", 1)[0]
    main, _, pre = raw.partition("-")
    numbers = []
    for part in re.split(r"[._]", main):
        if part.isdigit():
            numbers.append(int(part))
        elif part:
            numbers.append(0)
    tail = tuple(re.split(r"[._]", pre)) if pre else ()
    return tuple(numbers), tail


def is_newer(latest: str, current: str) -> bool:
    """True when `latest` should prompt an update over `current`.

    One deliberate deviation from strict semver: a local pre-release such as
    ``0.8.8-beta.5`` is a *test build of that very release*, so landing on
    ``0.8.8`` must not nag its user to "update" to something older than what
    they run. Only a numerically greater release (or a later pre-release) counts.
    """
    ln, lt = normalize(latest)
    cn, ct = normalize(current)
    if ln != cn:
        return ln > cn
    if not lt or not ct:
        return False
    return lt > ct


def latest_release(timeout: float = 8.0) -> dict:
    """Fetch the newest release metadata. Never raises."""
    request = urllib.request.Request(
        API,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "EpicDeck-update-check",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context()) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as exc:
        return {"ok": False, "reason": str(exc)[:160]}

    tag = str(payload.get("tag_name") or "").strip()
    if not tag:
        return {"ok": False, "reason": "release has no tag"}

    assets = payload.get("assets") or []
    zip_url = ""
    for asset in assets:
        name = str(asset.get("name") or "")
        if name.lower().endswith(".zip"):
            zip_url = str(asset.get("browser_download_url") or "")
            break

    return {
        "ok": True,
        "tag": tag,
        "version": tag.lstrip("vV"),
        "url": str(payload.get("html_url") or ""),
        "zip_url": zip_url,
        "published_at": str(payload.get("published_at") or ""),
        "notes": str(payload.get("body") or "")[:2000],
    }


def check(current: str, cache: dict | None, force: bool = False, timeout: float = 8.0) -> dict:
    """Return the update state, using `cache` (a config dict) when it is fresh.

    `cache` is mutated in place so the caller can persist it:
        {"ts": epoch, "latest": "0.8.9", "url": ..., "zip_url": ...}
    """
    cache = cache if isinstance(cache, dict) else {}
    fresh = bool(cache.get("ts")) and (time.time() - float(cache.get("ts") or 0)) < TTL
    if fresh and not force:
        latest = str(cache.get("latest") or "")
        return {
            "ok": True,
            "cached": True,
            "current": current,
            "latest": latest,
            "has_update": bool(latest) and is_newer(latest, current),
            "url": str(cache.get("url") or ""),
            "zip_url": str(cache.get("zip_url") or ""),
            "checked_at": int(cache.get("ts") or 0),
        }

    found = latest_release(timeout=timeout)
    if not found.get("ok"):
        # Keep serving the last known answer rather than losing it to a timeout.
        latest = str(cache.get("latest") or "")
        return {
            "ok": False,
            "reason": found.get("reason", "network error"),
            "current": current,
            "latest": latest,
            "has_update": bool(latest) and is_newer(latest, current),
            "url": str(cache.get("url") or ""),
            "zip_url": str(cache.get("zip_url") or ""),
            "checked_at": int(cache.get("ts") or 0),
        }

    cache.update(
        {
            "ts": int(time.time()),
            "latest": found["version"],
            "url": found["url"],
            "zip_url": found["zip_url"],
        }
    )
    return {
        "ok": True,
        "cached": False,
        "current": current,
        "latest": found["version"],
        "has_update": is_newer(found["version"], current),
        "url": found["url"],
        "zip_url": found["zip_url"],
        "checked_at": int(cache["ts"]),
    }


def current_version(plugin_dir: str) -> str:
    """Read the version Decky sees, i.e. package.json."""
    try:
        with open(os.path.join(plugin_dir, "package.json"), encoding="utf-8") as handle:
            return str(json.load(handle).get("version") or "")
    except (OSError, ValueError):
        return ""
