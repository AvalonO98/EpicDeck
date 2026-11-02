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
