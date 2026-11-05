# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""ProtonDB compatibility tier for an Epic title.

Pipeline (see HANDOFF 7.13.2):
    title -> Steam appid  : store.steampowered.com/api/storesearch
    Steam appid -> tier   : protondb.com/api/v1/reports/summaries/<appid>.json

Two things bite here:

* The store answers with a **localised** name (``猫咪斗恶龙 Cat Quest``), so a
  plain difflib ratio against ``Cat Quest`` scores ~0.75 and would reject the
  correct hit. Matching therefore also tries CJK-stripped forms and substring
  containment.
* ProtonDB answers **HTTP 200 with an HTML page** for unknown appids, so the
  body has to be parsed, not trusted by status code.

All network failures are non-fatal: the caller just gets ``ok: False`` and the
UI hides the badge.
"""

from __future__ import annotations

import difflib
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

SEARCH_URL = "https://store.steampowered.com/api/storesearch/"
SUMMARY_URL = "https://www.protondb.com/api/v1/reports/summaries/%d.json"
TTL = 7 * 24 * 3600
MIN_RATIO = 0.86

#: After the store endpoint fails completely, stop trying for a while. Being
#: unable to reach it is usually a network-level block, not a per-title problem,
#: and each attempt costs ~25 s (two 12 s timeouts); a dozen detail pages would
#: otherwise pin every worker in the default executor.
BLOCK_COOLDOWN = 600
#: Consecutive failures needed before the cooldown starts. One cold lookup after
#: a plugin reload can time out even on a healthy connection, and disabling the
#: feature for ten minutes because of that is worse than one extra attempt.
BLOCK_AFTER_FAILURES = 2
_blocked_until = 0.0
_fail_streak = 0
#: Last transport error, surfaced to the caller so a failure is diagnosable
#: instead of just "no tier".
_last_error = ""


def _blocked() -> bool:
    return time.time() < _blocked_until


def _note_failure() -> None:
    global _blocked_until, _fail_streak
    _fail_streak += 1
    if _fail_streak >= BLOCK_AFTER_FAILURES:
        _blocked_until = time.time() + BLOCK_COOLDOWN

# CJK ideographs, kana and hangul: stripped when comparing an English query
# against a localised store name.
CJK_RE = re.compile(r"[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]")
NUM_RE = re.compile(r"\d+")
# Roman numerals of length >= 2 only: single "v"/"x" are usually letters in a
# title ("Mega Man X"), not a sequel marker. An explicit set is less error-prone
# than a pattern here.
ROMAN_VALUE = {
    "ii": "2", "iii": "3", "iv": "4", "vi": "6", "vii": "7",
    "viii": "8", "ix": "9", "xi": "11", "xii": "12",
}
# Extra words that mean "same game, different SKU" rather than a different title.
EDITION_WORDS = {
    "edition", "ultimate", "definitive", "deluxe", "goty", "complete",
    "remastered", "enhanced", "premium", "gold", "hd",
}


def _numbers(text: str) -> list:
    """Sequel markers in a title: digits and roman numerals (``Cat Quest 2``,
    ``Hades II``). Two titles with different markers are different games — this
    is the guard that difflib alone cannot provide."""
    found = []
    for token in re.split(r"[^0-9a-z]+", str(text or "").lower()):
        if not token:
            continue
        if token.isdigit():
            found.append(token)
        elif token in ROMAN_VALUE:
            found.append(ROMAN_VALUE[token])
    return sorted(found)


def _edition_only_extra(short: str, long: str) -> bool:
    """True when `long` is just `short` plus edition words (same game)."""
    extra = [t for t in long.split() if t not in short.split()]
    return bool(extra) and all(t in EDITION_WORDS for t in extra)

TIER_LABELS = {
    "platinum": "白金",
    "gold": "黄金",
    "silver": "白银",
    "bronze": "青铜",
    "borked": "不可用",
    "pending": "待定",
}


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    try:
        return ssl.create_default_context(cafile="/etc/ssl/certs/ca-certificates.crt")
    except Exception:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^0-9a-z\u3000-\u9fff\uac00-\ud7af]+", " ", str(text or "").lower())).strip()


def _ascii_only(text: str) -> str:
    # Strip CJK, then normalise punctuation away as well: a localised name often
    # looks like "控制 - 终极合辑 / Control Ultimate Edition", and leftovers such
    # as "-" or "/" would defeat the edition-word check below.
    return _normalise(CJK_RE.sub(" ", str(text or "")))


def similarity(query: str, candidate: str) -> float:
    """How likely `candidate` is the same game as `query` (0..1).

    Localised store names are the norm, so the plain ratio is only one of several
    signals. The order matters:

    1. **Sequels first**: if the numbers in the two names differ, they are
       different games — ``Cat Quest`` vs ``Cat Quest 2`` scores 0.9 on difflib,
       which no threshold can separate from a genuine match.
    2. Then exactness, CJK-stripped exactness, containment, token containment,
       and finally the edit ratio.
    """
    q, c = _normalise(query), _normalise(candidate)
    if not q or not c:
        return 0.0
    if _numbers(query) != _numbers(candidate):
        return 0.4
    if q == c:
        return 1.0

    qa, ca = _ascii_only(query), _ascii_only(candidate)
    if qa and ca:
        if qa == ca:
            return 1.0
        if len(qa) >= 3 and (qa in ca or ca in qa):
            shorter, longer = sorted((len(qa), len(ca)))
            # "Control Ultimate Edition" is the same game; "… Deluxe" too.
            if _edition_only_extra(qa, ca) or _edition_only_extra(ca, qa):
                return 0.95
            # A subtitle is a weaker signal than an exact hit.
            return 0.95 if shorter / longer >= 0.6 else 0.8
        q_tokens = [t for t in qa.split() if len(t) >= 2]
        if q_tokens and set(q_tokens) == set(ca.split()):
            return 0.9
        return difflib.SequenceMatcher(None, qa, ca).ratio()

    # Pure-CJK query: there is no ASCII form to compare, so containment on the
    # raw strings is the best available signal (sequels already excluded above).
    if len(q) >= 2 and (q in c or c in q):
        return 0.9
    return difflib.SequenceMatcher(None, q, c).ratio()


def _get_json(url: str, timeout: float) -> tuple[bool, object, str]:
    global _last_error
    request = urllib.request.Request(url, headers={"User-Agent": "EpicDeck-protondb"})
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context()) as response:
            body = response.read().decode("utf-8", "replace")
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        _last_error = "%s: %s" % (type(exc).__name__, str(exc)[:140])
        return False, None, _last_error
    try:
        payload = json.loads(body)
    except ValueError:
        # ProtonDB serves an HTML page for unknown ids; Steam sometimes does too.
        _last_error = "not json (%d bytes)" % len(body)
        return False, None, _last_error
    global _fail_streak
    _fail_streak = 0
    return True, payload, ""


def search_appid(title: str, timeout: float = 12.0) -> tuple[int, str, float]:
    """Best Steam appid for a title: (appid, matched_name, confidence).

    The store endpoint is blocked or throttled on some networks (observed:
    every request timing out for minutes while protondb.com still answers), so a
    single failure is retried once before giving up. A miss is not cached, so the
    next visit tries again.
    """
    global _last_error
    if _blocked():
        _last_error = "cooling down after earlier failures"
        return 0, "", 0.0

    query = urllib.parse.urlencode({"term": title, "l": "schinese", "cc": "CN"})
    url = SEARCH_URL + "?" + query

    best_id, best_name, best_score = 0, "", 0.0
    for attempt in range(2):
        ok, payload, _ = _get_json(url, timeout)
        if ok and isinstance(payload, dict):
            for item in payload.get("items") or []:
                if not isinstance(item, dict) or item.get("type") != "app":
                    continue
                name = str(item.get("name") or "")
                score = similarity(title, name)
                if score > best_score:
                    try:
                        appid = int(item.get("id"))
                    except (TypeError, ValueError):
                        continue
                    best_id, best_name, best_score = appid, name, score
            break
        if attempt == 0:
            time.sleep(1.0)
        else:
            # Both attempts failed: assume the endpoint is unreachable.
            _note_failure()

    if best_score < MIN_RATIO:
        return 0, best_name, best_score
    return best_id, best_name, best_score


def fetch_tier(appid: int, timeout: float = 12.0) -> dict:
    """ProtonDB summary for a Steam appid. Empty dict when unknown."""
    ok, payload, _ = _get_json(SUMMARY_URL % appid, timeout)
    if not ok or not isinstance(payload, dict):
        return {}
    tier = str(payload.get("tier") or "")
    if tier not in TIER_LABELS:
        return {}
    return {
        "tier": tier,
        "label": TIER_LABELS[tier],
        "total": int(payload.get("total") or 0),
        "score": payload.get("score"),
        "best_tier": str(payload.get("bestReportedTier") or ""),
        "report_confidence": str(payload.get("confidence") or ""),
    }


def lookup(title: str, cached: dict | None, override_appid: int = 0,
           force: bool = False, timeout: float = 12.0) -> dict:
    """Resolve `title` to a ProtonDB tier, reusing `cached` when it is fresh.

    `cached` is a single config entry:
        {"appid": 593280, "tier": "platinum", "total": 10, "ts": epoch}
    """
    cached = cached if isinstance(cached, dict) else {}
    fresh = bool(cached.get("ts")) and (time.time() - float(cached.get("ts") or 0)) < TTL
    if fresh and not force and cached.get("tier"):
        return {"ok": True, "cached": True, **cached}

    appid = int(override_appid or cached.get("appid") or 0)
    matched = ""
    confidence = 1.0 if appid else 0.0
    if not appid:
        appid, matched, confidence = search_appid(title, timeout=timeout)
        if not appid:
            return {
                "ok": False,
                # An empty name means the request itself failed (timeout, DNS,
                # rate limit); a name with a low score means the store answered
                # but nothing looked like the same game. The UI hides the badge
                # either way, but the log should say which.
                "reason": "Steam 检索失败或超时" if not matched else "没有足够相似的 Steam 结果",
                "detail": _last_error,
                "matched": matched,
                "confidence": round(confidence, 2),
            }

    tier = fetch_tier(appid, timeout=timeout)
    if not tier:
        return {"ok": False, "reason": "no ProtonDB report", "appid": appid, "matched": matched}

    entry = {
        "appid": appid,
        "matched": matched,
        "confidence": round(confidence, 2),
        "ts": int(time.time()),
        **tier,
    }
    return {"ok": True, "cached": False, **entry}
