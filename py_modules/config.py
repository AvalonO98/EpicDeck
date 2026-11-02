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
    "install_dir": "",
    "legendary_path": "legendary",
    "refresh_token_managed": True,
    "auto_add_to_steam": False,
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
    # app_name -> extra arguments passed to `legendary launch` (also written
    # into the Steam shortcut's wrapper script). An empty string means "none",
    # which is different from "no opinion" (key absent -> import from
    # Legendary's own config.ini, where Heroic stores per-game args).
    "launch_args": {},
}


class Config:
    def __init__(self, path: str):
        self.path = path
        self._data = dict(DEFAULTS)

    def load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self._data.update(data)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            # Missing or corrupt -> keep defaults.
            pass
        return self._data

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
