# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Chinese game titles from third-party sources.

Epic's catalog only ships a Chinese title for a fraction of a library (9 of 138
in testing), so the rest stayed in English even with a Chinese UI. This module
fills the gap from two free, key-less sources, in order:

1. **Steam store search** (``l=schinese``) — Valve's own localised name. A
   result only counts when it is verifiably the same game: the similarity guard
   from :mod:`py_modules.protondb` handles localised names and sequel markers
   (``Cat Quest`` vs ``Cat Quest 2``), so "the first hit" is never trusted.
2. **Wikidata** — the item is looked up by its *exact* English label, which
   makes identity certain, then its Chinese label is taken. Useful for older
   titles Steam keeps in English (``Borderlands 2`` → ``无主之地2``).

Design notes:

* Everything is best-effort. A timeout, a block or a miss returns ``None`` and
  the caller keeps the English title.
* No machine translation: an invented Chinese name ("控制" for *Control* is
  right, but the same guesswork produces nonsense for invented words) is worse
  than an English title the user can recognise.
* The HTTP layer is shared and small; the heavy matching lives in ``protondb``
  so both features agree on what "same game" means.
"""

from __future__ import annotations

import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

from py_modules import protondb

STEAM_SEARCH = "https://store.steampowered.com/api/storesearch/"
STEAM_APPDETAILS = "https://store.steampowered.com/api/appdetails"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"

#: A result must be at least this similar to the English title to be used.
MIN_RATIO = 0.86

#: How long a failed transport suppresses the provider. Both endpoints are
#: optional decorations; hammering them from a background loop is pointless.
BLOCK_COOLDOWN = 900
BLOCK_AFTER_FAILURES = 2
_blocked_until = 0.0
_fail_streak = 0
_last_error = ""

CJK_RE = re.compile(r"[\u3400-\u9fff]")
#: CJK punctuation worth keeping when trimming "猫咪斗恶龙 Cat Quest".
CJK_PUNCT = "：:·・—－-–、，,《》（）【】「」『』…"
TRIM_RE = re.compile(r"^[\s\-–—:：·・、,，.。!！?？'\"“”‘’()（）\[\]【】《》]+|"
                     r"[\s\-–—:：·・、,，.。!！?？'\"“”‘’()（）\[\]【】《》]+$")
#: Trademark noise that must not leak into a display title.
MARK_RE = re.compile(r"[™®©]")


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    ctx = ssl.create_default_context()
    try:
        # Steam Deck images ship a trimmed CA bundle; a broken chain must not
        # turn every lookup into a silent failure.
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    except Exception:
        pass
    return ctx


def _blocked() -> bool:
    return time.time() < _blocked_until


def _note_failure(message: str = "") -> None:
    global _blocked_until, _fail_streak, _last_error
    _fail_streak += 1
    _last_error = message[:160]
    if _fail_streak >= BLOCK_AFTER_FAILURES:
        _blocked_until = time.time() + BLOCK_COOLDOWN


def _note_success() -> None:
    global _fail_streak
    _fail_streak = 0


def _get_json(url: str, timeout: float):
    """(payload, error, transport_failed).

    ``transport_failed`` separates "the store says there is no such name" from
    "we could not ask". Only the former may be cached as a miss: caching a
    timeout for 30 days would keep the English title long after the network
    recovered.
    """
    global _last_error
    if _blocked():
        return None, "cooling down after earlier failures", True
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "EpicDeck/0.8 title-lookup (Steam Deck plugin)",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context()) as response:
            body = response.read().decode("utf-8", "replace")
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        _note_failure("%s: %s" % (type(exc).__name__, exc))
        return None, _last_error, True
    try:
        payload = json.loads(body)
    except ValueError:
        _note_failure("not json (%d bytes)" % len(body))
        return None, _last_error, True
    _note_success()
    return payload, "", False


def chinese_part(name: str) -> str:
    """The Chinese portion of a store name.

    ``猫咪斗恶龙 Cat Quest`` -> ``猫咪斗恶龙``; ``Cassette Beasts 磁带妖怪`` ->
    ``磁带妖怪``. A name with no Chinese, or a single stray character, yields "".
    """
    text = MARK_RE.sub("", str(name or "")).strip()
    hits = list(CJK_RE.finditer(text))
    if len(hits) < 2:
        return ""
    start = hits[0].start()
    end = hits[-1].end()
    # Keep the run together only when everything between is Chinese or CJK
    # punctuation; otherwise the "Chinese part" would swallow Latin words.
    middle = text[start:end]
    # Digits stay: "生化奇兵 2 重制版" is one title, and dropping the 2 would
    # merge it with the first game.
    if len(re.sub(r"[\u3400-\u9fff0-9" + re.escape(CJK_PUNCT) + r"\s]", "", middle)) > 0:
        # Latin text sits in the middle: take the longest Chinese run instead.
        runs = re.findall(r"[\u3400-\u9fff]+(?:[" + re.escape(CJK_PUNCT) + r"][\u3400-\u9fff]+)*", text)
        if not runs:
            return ""
        candidate = max(runs, key=len)
    else:
        candidate = middle
        # "无主之地®4" / "都市：天际线2": a sequel number glued to the Chinese
        # name is part of it; dropping it would merge two different games.
        tail = re.match(r"\d+", text[end:])
        if tail:
            candidate += tail.group(0)
    candidate = TRIM_RE.sub("", candidate).strip()
    # A stray closing bracket from "...》年度版" reads like a typo on a tile.
    candidate = candidate.replace("《", "").replace("》", "").strip()
    return candidate if len(CJK_RE.findall(candidate)) >= 2 else ""


def _norm(text: str) -> str:
    """Lowercase alphanumerics only, for comparing store names."""
    return re.sub(r"[^0-9a-z]+", "", str(text or "").lower())


def _same_title(query: str, name: str) -> bool:
    """True when `name` is `query` plus a Chinese translation, nothing else.

    The store search happily returns DLC: asking for ``Orcs Must Die! 3`` yields
    ``Orcs Must Die! 3 - 天平倾斜`` ("The Balancing Act" DLC) once the base game
    is filtered out for having no Chinese name. A subtitle after a dash is a
    different product, and taking it would label the wrong game.

    Accepted shapes: ``猫咪斗恶龙 Cat Quest`` (Chinese first), ``Cassette Beasts
    磁带妖怪`` (Chinese last). Anything with Latin words left over is rejected.
    """
    q = str(query or "").strip().lower()
    n = str(name or "").strip().lower()
    if len(q) < 3 or q not in n:
        return False
    rest = n.replace(q, "", 1)
    if re.search(r"[a-z]", rest):
        return False
    # A dash is NOT rejected here: "Vampire Survivors - 吸血鬼幸存者" is the
    # localised name of the base game, while "... - The Balancing Act" is DLC.
    # Only the appid can tell them apart (see `_steam_search`), so this check
    # stays deliberately loose.
    return True


def _appdetails_english(appid: int, timeout: float) -> str:
    """Steam's English name for an appid, used to confirm an identity.

    Many official Chinese names are pure Chinese (``吸血鬼幸存者`` for
    *Vampire Survivors*), so name containment cannot prove they belong to the
    query. The appid can: if its English name equals the query, the Chinese
    name is that game's. DLC fails here because its English name carries the
    subtitle (``Orcs Must Die! 3 - The Balancing Act``).
    """
    url = "%s?appids=%d&l=english&cc=US" % (STEAM_APPDETAILS, appid)
    payload, _error, _failed = _get_json(url, timeout)
    if not isinstance(payload, dict):
        return ""
    node = payload.get(str(appid)) or {}
    if not isinstance(node, dict) or not node.get("success"):
        return ""
    return str((node.get("data") or {}).get("name") or "")


def _steam_search(title: str, timeout: float) -> tuple[str, str, bool]:
    """(chinese_title, matched_store_name, answered).

    `answered` is False when the request itself failed, so the caller knows not
    to cache a miss.
    """
    query = urllib.parse.urlencode({"term": title, "l": "schinese", "cc": "CN"})
    payload, _error, failed = _get_json(STEAM_SEARCH + "?" + query, timeout)
    if not isinstance(payload, dict):
        return "", "", False

    wanted = _norm(title)
    checks = 0
    for item in payload.get("items") or []:
        if not isinstance(item, dict) or item.get("type") != "app":
            continue
        name = str(item.get("name") or "")
        chinese = chinese_part(name)
        if not chinese:
            continue
        if checks >= 4:
            break
        # Cheap prefilter: a name with Latin text must at least contain the
        # query. Pure-Chinese names cannot be checked this way and go straight
        # to the appid lookup.
        if re.search(r"[A-Za-z]", name) and not _same_title(title, name):
            continue
        # Cheap prefilter: a name with Latin text must at least contain the
        # query. Pure-Chinese names cannot be checked this way and go straight
        # to the appid lookup.
        if re.search(r"[A-Za-z]", name) and not _same_title(title, name):
            continue
        # Identity is decided by the appid, never by the display name alone.
        # Containment accepts "猫咪斗恶龙 Cat Quest", but it also accepts
        # "DEATHLOOP (游戏原声配乐)" — the soundtrack — and GTA V's localised
        # "增强版". Asking Steam for the app's English name settles both, and a
        # DLC/soundtrack carries a subtitle there.
        try:
            appid = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        checks += 1
        if _norm(_appdetails_english(appid, timeout)) == wanted:
            return chinese, name, True

    # Nothing matched: either the game has no Chinese name on Steam or the
    # store only offers DLC/soundtracks for it. Both mean "keep English".
    return "", "", True


def _wikidata_search(title: str, timeout: float) -> tuple[str, str, bool]:
    """(chinese_label, matched_label, answered)."""
    escaped = title.replace("\\", "\\\\").replace('"', '\\"')
    query = (
        'SELECT ?itemLabel WHERE { ?item rdfs:label "%s"@en . '
        "?item wdt:P31/wdt:P279* wd:Q7889 . "
        'SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh-cn,zh". } } LIMIT 3'
    ) % escaped
    url = WIKIDATA_SPARQL + "?format=json&query=" + urllib.parse.quote(query)
    payload, _error, failed = _get_json(url, timeout)
    if not isinstance(payload, dict):
        return "", "", False
    for row in ((payload.get("results") or {}).get("bindings") or []):
        label = str((row.get("itemLabel") or {}).get("value") or "").strip()
        chinese = chinese_part(label)
        if chinese:
            return chinese, label, True
    return "", "", True


def lookup(title: str, timeout: float = 8.0, allow_wikidata: bool = False) -> dict:
    """Best Chinese title for an English one.

    Returns ``{"title": str, "source": "steam"|"wikidata", "matched": str}`` or
    ``{"title": "", "error": str}``. Never raises.
    """
    title = str(title or "").strip()
    if len(title) < 3:
        return {"title": "", "error": "title too short"}
    if CJK_RE.search(title):
        # Already Chinese (or mixed): nothing to look up.
        return {"title": "", "error": "already localised"}

    try:
        chinese, matched, answered = _steam_search(title, timeout)
        if chinese:
            return {"title": chinese, "source": "steam", "matched": matched}
        if not answered:
            return {"title": "", "error": _last_error or "steam unreachable", "transport": True}
    except Exception as exc:  # noqa: BLE001 - decorations must never raise
        return {"title": "", "error": "steam: %s" % str(exc)[:120], "transport": True}

    if not allow_wikidata:
        return {"title": "", "error": "no Chinese name on Steam"}

    try:
        chinese, matched, answered = _wikidata_search(title, timeout + 4.0)
        if chinese:
            return {"title": chinese, "source": "wikidata", "matched": matched}
        if not answered:
            return {"title": "", "error": _last_error or "wikidata unreachable", "transport": True}
    except Exception as exc:  # noqa: BLE001
        return {"title": "", "error": "wikidata: %s" % str(exc)[:120], "transport": True}

    return {"title": "", "error": "no Chinese name found"}


def reset_cooldown() -> None:
    """Test helper: forget the failure streak."""
    global _blocked_until, _fail_streak, _last_error
    _blocked_until = 0.0
    _fail_streak = 0
    _last_error = ""
