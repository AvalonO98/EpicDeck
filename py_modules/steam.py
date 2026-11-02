# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Steam non-Steam-game shortcut integration.

Steam stores non-Steam shortcuts in `shortcuts.vdf` under
`~/.local/share/Steam/userdata/<userid>/config/`. The file uses a
Valve-proprietary binary-ish format (8-bit lengths, null-terminated
strings, 32-bit little-endian integers for the app id).

Adding a game requires:
  1. Reading the existing shortcuts (if any).
  2. Appending a new entry with a unique appid.
  3. Writing the file back.
  4. Asking Steam to reload via `steam://` (e.g. `steam://restart` or
     simply restarting Steam) so the new shortcut shows up.

We also support launching the shortcut once added through
`steam://rungameid/<appid>`.
"""

import os
import struct
import subprocess


class SteamError(Exception):
    pass


# Steam appid for non-Steam games are negative and derived from the game's
# exe path via a CRC32-ish scheme. We use a stable hash of the app_name.
def _crc32(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1))
    return crc ^ 0xFFFFFFFF


def make_appid(app_name: str) -> int:
    """Derive a stable 32-bit appid (Steam non-Steam game convention).

    Steam computes non-Steam game appids from the exe path: the high 16 bits
    are the top 16 bits of a CRC32 of the path, and the low 16 bits are a
    per-shortcut index (we use 0 for the first/only entry). This keeps the
    appid within the signed 32-bit negative range Steam expects for
    non-Steam games.
    """
    exe = f"\"{app_name}.sh\""
    crc = _crc32(exe.encode("utf-8"))
    high16 = (crc >> 16) & 0xFFFF
    return (high16 << 16) & 0xFFFFFFFF


class ShortcutEntry:
    def __init__(self, appid: int, app_name: str, exe: str, start_dir: str,
                 icon: str = "", launch_options: str = "", tags=None):
        self.appid = appid
        self.app_name = app_name
        self.exe = exe
        self.start_dir = start_dir
        self.icon = icon
        self.launch_options = launch_options
        self.tags = tags or []


def _read_byte(f):
    b = f.read(1)
    if not b:
        return None
    return b[0]


def parse_shortcuts(path: str):
    """Parse shortcuts.vdf into a list of ShortcutEntry."""
    entries = []
    if not os.path.exists(path):
        return entries
    with open(path, "rb") as f:
        raw = f.read()
    pos = 0
    n = len(raw)
    while pos < n:
        # Each entry: 3 null-terminated strings (appname, exe, startdir),
        # 1 icon string, 1 icon char(1), 1 shortcut char(1), 1 launch options
        # string, 1 char(1), tags (0x00 = none, else 0x01 + N strings), then
        # int32 appid.
        strings = []
        for _ in range(4):
            end = raw.find(b"\x00", pos)
            if end == -1:
                return entries
            strings.append(raw[pos:end].decode("utf-8", errors="replace"))
            pos = end + 1
        if pos + 2 > n:
            return entries
        # icon flag byte + shortcut flag byte
        pos += 2
        # launch options
        end = raw.find(b"\x00", pos)
        if end == -1:
            return entries
        launch_options = raw[pos:end].decode("utf-8", errors="replace")
        pos = end + 1
        # shortcut flag
        if pos >= n:
            return entries
        pos += 1
        # tags
        if pos >= n:
            return entries
        tags_flag = raw[pos]
        pos += 1
        tags = []
        if tags_flag == 0x01:
            end = raw.find(b"\x00", pos)
            if end == -1:
                return entries
            ntags = raw[pos:end].decode("utf-8", errors="replace")
            try:
                ntags_int = int(ntags)
            except ValueError:
                ntags_int = 0
            pos = end + 1
            for _ in range(ntags_int):
                end = raw.find(b"\x00", pos)
                if end == -1:
                    return entries
                tags.append(raw[pos:end].decode("utf-8", errors="replace"))
                pos = end + 1
        if pos + 4 > n:
            return entries
        appid = struct.unpack("<I", raw[pos:pos + 4])[0]
        pos += 4
        entries.append(
            ShortcutEntry(appid, strings[0], strings[1], strings[2],
                          strings[3], launch_options, tags)
        )
    return entries


def _write_string(f, s: str):
    f.write(s.encode("utf-8"))
    f.write(b"\x00")


def write_shortcuts(path: str, entries):
    with open(path, "wb") as f:
        for e in entries:
            _write_string(f, e.app_name)
            _write_string(f, e.exe)
            _write_string(f, e.start_dir)
            _write_string(f, e.icon)
            f.write(b"\x01")  # icon flag
            f.write(b"\x01")  # shortcut flag
            _write_string(f, e.launch_options)
            f.write(b"\x01")  # shortcut flag
            if e.tags:
                f.write(b"\x01")
                _write_string(f, str(len(e.tags)))
                for t in e.tags:
                    _write_string(f, t)
            else:
                f.write(b"\x00")
            f.write(struct.pack("<I", e.appid & 0xFFFFFFFF))


class SteamShortcuts:
    def __init__(self):
        self.userdata_root = os.path.expanduser(
            "~/.local/share/Steam/userdata")

    def _config_dir(self):
        """Return the first user's config dir, or None."""
        if not os.path.isdir(self.userdata_root):
            return None
        for uid in os.listdir(self.userdata_root):
            cfg = os.path.join(self.userdata_root, uid, "config")
            if os.path.isdir(cfg):
                return cfg
        return None

    def _shortcuts_path(self):
        cfg = self._config_dir()
        if not cfg:
            return None
        return os.path.join(cfg, "shortcuts.vdf")

    def list_shortcuts(self):
        path = self._shortcuts_path()
        if not path:
            return []
        return parse_shortcuts(path)

    def add_game(self, app_name: str, exe: str, start_dir: str = "",
                 icon: str = "", launch_options: str = "", tags=None):
        """Add a non-Steam game, returning its appid."""
        path = self._shortcuts_path()
        if not path:
            raise SteamError(
                "找不到 Steam 用户数据目录。请先启动过 Steam 游戏模式。"
            )
        os.makedirs(os.path.dirname(path), exist_ok=True)
        entries = parse_shortcuts(path)
        appid = make_appid(app_name)
        # Avoid duplicates: replace an entry with the same app_name.
        entries = [e for e in entries if e.app_name != app_name]
        entries.append(
            ShortcutEntry(appid, app_name, exe, start_dir or os.path.dirname(exe),
                          icon, launch_options, tags)
        )
        write_shortcuts(path, entries)
        return appid

    def remove_game(self, app_name: str):
        path = self._shortcuts_path()
        if not path:
            return
        entries = parse_shortcuts(path)
        new_entries = [e for e in entries if e.app_name != app_name]
        if len(new_entries) != len(entries):
            write_shortcuts(path, new_entries)

    def find_game(self, app_name: str):
        return next(
            (e for e in self.list_shortcuts() if e.app_name == app_name),
            None,
        )


def open_steam_protocol(uri: str):
    """Open a steam:// URI using the desktop handler (xdg-open on SteamOS)."""
    try:
        subprocess.Popen(["xdg-open", uri],
                         stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        raise SteamError("找不到 xdg-open。请确认运行在 SteamOS 环境。")
