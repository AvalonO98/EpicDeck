# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Artwork for non-Steam shortcuts.

Steam keeps custom art in ``userdata/<uid>/config/grid`` and looks files up by
the shortcut's appid:

    <appid>p.<ext>      portrait capsule (library shelf)
    <appid>.<ext>       landscape capsule / header
    <appid>_hero.<ext>  wide banner (game page)
    <appid>_logo.<ext>  transparent logo (we have none from Epic)
    <appid>_icon.<ext>  the small icon

Steam never fetches any of it for a shortcut — that is SteamGridDB's job — so
without these files the entry shows a grey tile forever. Epic's own library
metadata carries a full set (`DieselGameBoxTall`, `DieselGameBox`,
`DieselStoreFrontWide`), so the plugin can simply download them.

No transcoding happens here: Steam picks the decoder from the file extension,
and the device has no Pillow anyway. The extension is sniffed from the magic
bytes so a CDN that serves PNG behind a `.jpg` URL still lands on a name Steam
can decode.
"""

import os
import urllib.request

from py_modules.legendary_installer import _ssl_context as ssl_context

# suffix appended to the appid, candidate keyImage types (best first)
SLOTS = (
    ("p", ("DieselGameBoxTall", "OfferImageTall", "Thumbnail")),
    ("", ("DieselGameBox", "DieselStoreFrontWide", "Featured")),
    ("_hero", ("DieselStoreFrontWide", "Featured", "DieselGameBox")),
    ("_icon", ("Thumbnail", "OfferImageTall", "DieselGameBoxTall")),
)

ART_SUFFIXES = tuple(slot[0] for slot in SLOTS)
IMAGE_EXTS = (".jpg", ".png", ".webp", ".gif")

TIMEOUT = 25.0
MAX_BYTES = 16 * 1024 * 1024


def _sniff_ext(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    return ""


def fetch_image(url: str):
    """Download one image and return ``(bytes, extension)``, or ``None``."""
    if not url:
        return None
    request = urllib.request.Request(
        url,
        headers={
            # The CDN 403s an empty agent often enough to matter.
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) EpicDeck/0.7",
            "Accept": "image/*",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT, context=ssl_context()) as resp:
            data = resp.read(MAX_BYTES + 1)
    except Exception:
        return None
    if not data or len(data) > MAX_BYTES:
        return None
    ext = _sniff_ext(data)
    if not ext:
        return None
    return data, ext


def find_existing(grid_dir: str, appid: int, suffix: str) -> str:
    """Path of an already-present artwork file for this slot, if any."""
    for ext in IMAGE_EXTS:
        candidate = os.path.join(grid_dir, "%d%s%s" % (int(appid), suffix, ext))
        try:
            if os.path.getsize(candidate) > 512:
                return candidate
        except OSError:
            continue
    return ""


def _pick(images: dict, types) -> str:
    for kind in types:
        url = images.get(kind)
        if url:
            return url
    return ""


def ensure_artwork(grid_dir: str, appid: int, images: dict, overwrite: bool = False):
    """Make sure every slot exists for ``appid``.

    Returns ``{"written": [...paths], "icon": path, "missing": [suffix...]}``.
    Network failures are reported, never raised: artwork is decoration and must
    not turn a working library into a broken one.
    """
    result = {"written": [], "icon": "", "missing": [], "errors": []}
    if not grid_dir or not appid or not images:
        return result
    try:
        os.makedirs(grid_dir, exist_ok=True)
    except OSError as e:
        result["errors"].append(str(e))
        return result

    # One download per URL even when two slots share it (wide box is both the
    # capsule and the hero for most Epic titles).
    cache = {}
    for suffix, types in SLOTS:
        existing = "" if overwrite else find_existing(grid_dir, appid, suffix)
        if existing:
            if suffix == "_icon":
                result["icon"] = existing
            continue

        url = _pick(images, types)
        if not url:
            result["missing"].append(suffix)
            continue
        if url not in cache:
            cache[url] = fetch_image(url)
        got = cache[url]
        if not got:
            result["missing"].append(suffix)
            continue

        data, ext = got
        target = os.path.join(grid_dir, "%d%s%s" % (int(appid), suffix, ext))
        tmp = target + ".epicdeck.tmp"
        try:
            with open(tmp, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, target)
        except OSError as e:
            result["errors"].append(str(e))
            try:
                os.unlink(tmp)
            except OSError:
                pass
            continue

        result["written"].append(target)
        if suffix == "_icon":
            result["icon"] = target

    # Icon is worth a fallback: with no `Thumbnail` in the metadata, reuse the
    # portrait so the shortcut still gets its own picture.
    if not result["icon"]:
        result["icon"] = find_existing(grid_dir, appid, "_icon") or find_existing(
            grid_dir, appid, "p"
        )
    return result
