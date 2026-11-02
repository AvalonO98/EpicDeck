# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Epic library-service helpers.

Legendary reports the library and install state, but it has no notion of play
time — that lives behind Epic's library-service REST API, authenticated with
the very same access token Legendary stores after login. Everything here is
best effort: a failure only means "no play time", never a broken library.
"""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from py_modules.legendary_installer import _ssl_context as ssl_context

PLAYTIME_URL = (
    "https://library-service.live.use1a.on.epicgames.com"
    "/library/api/public/playtime/account/%s/all"
)
CATALOG_BULK_URL = (
    "https://catalog-public-service-prod06.ol.epicgames.com"
    "/catalog/api/shared/bulk/items"
)

# Steam language -> POSIX locale. Legendary reads the system locale to decide
# which language to launch a game in, and SteamOS Game Mode runs with an empty
# LANG, so without this every game would start in English.
STEAM_LANG_TO_POSIX = {
    "schinese": "zh_CN.UTF-8",
    "tchinese": "zh_TW.UTF-8",
    "english": "en_US.UTF-8",
    "japanese": "ja_JP.UTF-8",
    "koreana": "ko_KR.UTF-8",
    "russian": "ru_RU.UTF-8",
    "german": "de_DE.UTF-8",
    "french": "fr_FR.UTF-8",
    "spanish": "es_ES.UTF-8",
    "latam": "es_MX.UTF-8",
    "portuguese": "pt_BR.UTF-8",
    "brazilian": "pt_BR.UTF-8",
    "italian": "it_IT.UTF-8",
    "polish": "pl_PL.UTF-8",
    "ukrainian": "uk_UA.UTF-8",
    "turkish": "tr_TR.UTF-8",
    "thai": "th_TH.UTF-8",
    "vietnamese": "vi_VN.UTF-8",
    "czech": "cs_CZ.UTF-8",
    "danish": "da_DK.UTF-8",
    "dutch": "nl_NL.UTF-8",
    "finnish": "fi_FI.UTF-8",
    "norwegian": "nb_NO.UTF-8",
    "swedish": "sv_SE.UTF-8",
    "hungarian": "hu_HU.UTF-8",
    "romanian": "ro_RO.UTF-8",
    "bulgarian": "bg_BG.UTF-8",
    "greek": "el_GR.UTF-8",
    "indonesian": "id_ID.UTF-8",
}

TIMEOUT = 12.0

# Steam spells languages in its own dialect; Epic's catalog wants BCP-47.
STEAM_LANG_TO_EPIC = {
    "schinese": "zh-Hans",
    "tchinese": "zh-Hant",
    "english": "en-US",
    "japanese": "ja",
    "koreana": "ko",
    "russian": "ru",
    "german": "de",
    "french": "fr",
    "spanish": "es-ES",
    "latam": "es-419",
    "portuguese": "pt-BR",
    "brazilian": "pt-BR",
    "italian": "it",
    "polish": "pl",
    "ukrainian": "uk",
    "turkish": "tr",
    "thai": "th",
    "vietnamese": "vi",
    "czech": "cs",
    "danish": "da",
    "dutch": "nl",
    "finnish": "fi",
    "norwegian": "no",
    "swedish": "sv",
    "hungarian": "hu",
    "romanian": "ro",
    "bulgarian": "bg",
    "greek": "el",
    "indonesian": "id",
}

# POSIX locale -> Epic locale, used when Steam's own setting is unreadable.
POSIX_LANG_TO_EPIC = {
    "zh_cn": "zh-Hans",
    "zh_sg": "zh-Hans",
    "zh_tw": "zh-Hant",
    "zh_hk": "zh-Hant",
    "ja": "ja",
    "ko": "ko",
    "ru": "ru",
    "de": "de",
    "fr": "fr",
    "es": "es-ES",
    "pt": "pt-BR",
    "it": "it",
    "pl": "pl",
    "uk": "uk",
    "tr": "tr",
    "th": "th",
    "vi": "vi",
    "cs": "cs",
    "da": "da",
    "nl": "nl",
    "fi": "fi",
    "no": "no",
    "sv": "sv",
    "hu": "hu",
    "ro": "ro",
    "bg": "bg",
    "el": "el",
    "id": "id",
}

LOCALE_CHOICES = [
    "auto",
    "zh-Hans",
    "zh-Hant",
    "en-US",
    "ja",
    "ko",
    "ru",
    "de",
    "fr",
    "es-ES",
    "pt-BR",
]


def _steam_language() -> str:
    """Steam's UI language, e.g. "schinese", from ~/.steam/registry.vdf.

    In Game Mode there is usually no LANG in the environment — SteamOS boots
    with POSIX and GAMESCOPE sets the language through Steam itself — so the
    Steam setting is the only reliable signal (registry.vdf, key "language").
    """
    for path in (
        os.path.join(os.path.expanduser("~"), ".steam", "registry.vdf"),
        os.path.join(os.path.expanduser("~"), ".local", "share", "Steam", "registry.vdf"),
    ):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read(200000)
        except OSError:
            continue
        match = re.search(r'"language"\s+"([A-Za-z_-]+)"', text)
        if match:
            return match.group(1).lower()
    return ""


def steam_posix_locale() -> str:
    """POSIX locale string (e.g. "zh_CN.UTF-8") for the current Steam language."""
    lang = _steam_language()
    if lang in STEAM_LANG_TO_POSIX:
        return STEAM_LANG_TO_POSIX[lang]
    raw = os.environ.get("LC_ALL") or os.environ.get("LANG") or ""
    if raw and "." in raw:
        return raw
    return "en_US.UTF-8"


def detect_locale(setting: str = "auto") -> str:
    """Resolve the locale used for titles: explicit setting, Steam, then POSIX."""
    if setting and setting != "auto":
        return setting

    steam = _steam_language()
    if steam in STEAM_LANG_TO_EPIC:
        return STEAM_LANG_TO_EPIC[steam]

    raw = (
        os.environ.get("LANGUAGE", "")
        or os.environ.get("LC_ALL", "")
        or os.environ.get("LANG", "")
    )
    if raw:
        head = raw.split(":")[0].split(".")[0].strip().lower()
        if head in POSIX_LANG_TO_EPIC:
            return POSIX_LANG_TO_EPIC[head]
        short = head.split("_")[0]
        if short in POSIX_LANG_TO_EPIC:
            return POSIX_LANG_TO_EPIC[short]
    return "en-US"


def _has_script(title: str, locale: str) -> bool:
    """True when `title` really looks translated into `locale`'s script.

    Epic often returns the English name wrapped in localized punctuation
    ("《Cursed to Golf》") or the name of a different edition. Requiring the
    target script keeps those from replacing a perfectly good English title.
    """
    if not title:
        return False
    cjk = any("\u4e00" <= ch <= "\u9fff" for ch in title)
    kana = any("\u3040" <= ch <= "\u30ff" for ch in title)
    hangul = any("\uac00" <= ch <= "\ud7af" for ch in title)
    cyrillic = any("\u0400" <= ch <= "\u04ff" for ch in title)

    if locale.startswith("zh"):
        return cjk
    if locale == "ja":
        return kana or cjk
    if locale == "ko":
        return hangul
    if locale in ("ru", "uk", "bg"):
        return cyrillic
    # Latin-script locales: any difference from the English title is a real
    # localisation, so no script check applies.
    return True


def fetch_localized_titles(items, locale: str = "zh-Hans", country: str = "US") -> dict:
    """Return {app_name: localized_title} via Epic's catalog bulk endpoint.

    `items` is a list of (app_name, namespace, catalog_item_id). The endpoint
    accepts ids across namespaces, so a handful of chunked requests cover the
    whole library. Titles that are not actually translated into the target
    script are dropped, leaving the English title in place.
    """
    creds = read_user_credentials()
    if not creds or not items:
        return {}

    by_app = {}
    for app_name, _ns, item_id in items:
        if app_name and item_id:
            by_app[item_id] = app_name

    ids = list(by_app.keys())
    result = {}
    chunk = 40  # keeps the query string comfortably under ~2 KB
    for start in range(0, len(ids), chunk):
        batch = ids[start:start + chunk]
        query = "&".join("id=" + urllib.parse.quote(i) for i in batch)
        url = "%s?country=%s&locale=%s&allowCountries=%s&%s" % (
            CATALOG_BULK_URL,
            country,
            locale,
            country,
            query,
        )
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": "Bearer " + creds["access_token"],
                "User-Agent": "EpicDeck/0.1.5",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT * 2, context=ssl_context()) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="replace"))
        except (urllib.error.URLError, OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        for item_id, payload in data.items():
            app_name = by_app.get(item_id)
            title = (payload or {}).get("title") if isinstance(payload, dict) else None
            if app_name and isinstance(title, str) and _has_script(title.strip(), locale):
                result[app_name] = title.strip()
    return result



def legendary_config_dir() -> str:
    """Where Legendary keeps its state (honours LEGENDARY_CONFIG_PATH)."""
    env = os.environ.get("LEGENDARY_CONFIG_PATH")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), ".config", "legendary")


def read_user_credentials():
    """Return {account_id, access_token} from Legendary's user.json, or None."""
    path = os.path.join(legendary_config_dir(), "user.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    account_id = data.get("account_id") or ""
    token = data.get("access_token") or ""
    if not account_id or not token:
        return None
    return {"account_id": account_id, "access_token": token}


def fetch_playtime() -> dict:
    """Return {app_name: seconds_played}.

    Epic returns a flat list of records keyed by `artifactId`, which is the
    same identifier Legendary exposes as `app_name`. Any network/auth problem
    yields an empty mapping rather than an exception.
    """
    creds = read_user_credentials()
    if not creds:
        return {}

    url = PLAYTIME_URL % creds["account_id"]
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + creds["access_token"],
            "User-Agent": "EpicDeck/0.1.4",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl_context()) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except (urllib.error.URLError, OSError, ValueError):
        return {}

    if not isinstance(data, list):
        return {}

    result = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        app_id = item.get("artifactId")
        seconds = item.get("totalTime")
        if app_id and isinstance(seconds, (int, float)) and seconds > 0:
            result[app_id] = int(seconds)
    return result
