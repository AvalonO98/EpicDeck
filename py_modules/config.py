# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""EpicDeck configuration persistence.

Stores plugin state as JSON in the Decky settings directory. Handles
defaults, atomic writes, and safe reads (corrupt file -> fall back to
defaults).
"""

import json
import os
import shutil
import tempfile


DEFAULTS = {
    # Absolute path games are installed under. Empty means "not chosen yet";
    # the backend then falls back to py_modules.paths.default_games_dir().
    "install_dir": "",
    # Set once the first-run prompt (choose a download folder) is answered, so
    # it is shown exactly once per install.
    "first_run_done": False,
    "legendary_path": "legendary",
    "refresh_token_managed": True,
    # Add to Steam right after a successful install. On by default: a game the
    # user cannot see in their library looks like a failed install.
    "auto_add_to_steam": True,
    # app_name -> unix timestamp of when it first appeared in the library.
    # Epic's API has no "date added", so we track it ourselves for sorting.
    "first_seen": {},
    # "auto" follows the Steam UI language; otherwise a BCP-47 tag such as
    # "zh-Hans" / "en-US". Titles fall back to English when untranslated.
    "title_locale": "auto",
    # Sizes need one manifest download per game (~4 s, a few MB each), so this
    # can be switched off on a metered connection. Results are cached 30 days.
    "auto_fetch_size": True,
    # app_name -> {"download": bytes, "disk": bytes, "ts": unix time}
    "size_cache": {},
    # locale -> {app_name: localised title}
    "title_cache": {},
    # Ask the Steam store for the official Chinese name of games Epic leaves in
    # English (~20% of a typical library; the rest have no Chinese name at all).
    "third_party_titles": True,
    # app_name -> unix time of a "no Chinese name found" answer, so the same 80
    # untranslated games are not re-queried on every refresh.
    "title_misses": {},
    # app_name -> extra arguments passed to `legendary launch` (also written
    # into the Steam shortcut's wrapper script). An empty string means "none",
    # which is different from "no opinion" (key absent -> import from
    # Legendary's own config.ini, where Heroic stores per-game args).
    "launch_args": {},
    # Windows titles are run through Steam's Proton: SteamOS has no wine, and
    # without it the launch dies before the game starts.
    "use_proton": True,
    # "" = pick the best installed build automatically (GE-Proton first).
    "proton_path": "",
    # Download Epic's box art into Steam's grid folder, so non-Steam entries
    # get a real cover instead of a grey tile.
    "auto_cover": True,
    # Legendary download concurrency. 0 means "let Legendary pick"
    # (min(2*CPU, 16)). Lower values are the only lever Legendary exposes to
    # slow a download down (it has no rate-limit flag), so this doubles as a
    # coarse "speed limiter": 1 worker ~ 2-4 MiB/s, 16 workers ~ 25-30 MiB/s
    # on a good CDN. See HANDOFF for the measured table.
    "max_workers": 0,
    # Preferred CDN hostname ("" = let Legendary/Epic pick). On machines that
    # get a slow international node, forcing a known-fast domestic host can
    # help; the value must be a bare hostname like "epicgames-download1-...".
    "preferred_cdn": "",
    # Download over plaintext HTTP. The domestic CDN Epic assigns is already
    # http; forcing this on an https node can dodge some TLS stalls but is
    # also less safe (no integrity for the transport, though chunks are still
    # hash-verified by Legendary).
    "no_https": False,
    # Global default for the Lossless Scaling Frame Gen (Decky LSFG-VK) wrapper.
    # When on, launcher scripts run `~/lsfg <game>` so the game is wrapped in
    # the plugin's frame-gen layer. Per-game override lives in `lsfg` below.
    "lsfg_default": False,
    # app_name -> bool, per-game override of `lsfg_default`. Absent key means
    # "follow the global default"; this is what makes "some games on, some off"
    # possible without a tri-state.
    "lsfg": {},
    # Last GitHub release lookup: {"ts": epoch, "latest": "0.8.9", "url": ...}.
    # One lookup a day; a failed lookup keeps the previous answer (HANDOFF 7.13.5).
    "update_check": {},
    # "auto" follows Steam's UI language; "zh"/"en" force one (HANDOFF 7.13.0a).
    "ui_language": "auto",
    # Show a ProtonDB tier for installed games (HANDOFF 7.13.2).
    "auto_protondb": True,
    # app_name -> {"appid","tier","total","ts",...}; 7-day TTL.
    "protondb": {},
    # app_name -> Steam appid, for titles the store search gets wrong (sequels,
    # localised names). User-editable escape hatch.
    "protondb_appid": {},
}


class Config:
    def __init__(self, path: str):
        self.path = path
        self._data = dict(DEFAULTS)
        self._corrupt = False

    def load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self._data.update(data)
            self._corrupt = False
        except FileNotFoundError:
            self._corrupt = False
        except (json.JSONDecodeError, OSError):
            # Missing or corrupt -> keep defaults, but keep the broken file
            # around: the next `set()` writes defaults over it, which would
            # otherwise silently drop install_dir / first_seen / caches with no
            # way back.
            self._corrupt = True
            self._quarantine()
        return self._data

    def _quarantine(self):
        """Copy an unreadable config aside before defaults overwrite it."""
        try:
            if not os.path.isfile(self.path):
                return
            backup = self.path + ".corrupt"
            if not os.path.exists(backup):
                shutil.copy2(self.path, backup)
        except OSError:
            pass

    def get(self, key, default=None):
        return self._data.get(key, default)

    def set(self, key, value):
        self._data[key] = value
        self.save()

    def update(self, mapping: dict):
        self._data.update(mapping)
        self.save()

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self._data, f, indent=2)
            shutil.move(tmp, self.path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
