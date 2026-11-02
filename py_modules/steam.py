# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Steam non-Steam-game shortcut integration.

`shortcuts.vdf` lives in `~/.local/share/Steam/userdata/<userid>/config/` and
uses Valve's KeyValues **binary** format, which looks like this:

    \\x00 "shortcuts" \\x00
        \\x00 "0" \\x00
            \\x02 "appid"   \\x00 <int32>
            \\x01 "AppName" \\x00 <utf8> \\x00
            \\x01 "Exe"     \\x00 <utf8> \\x00
            ...
            \\x00 "tags" \\x00 \\x01 "0" \\x00 <utf8> \\x00 \\x08
        \\x08                     # end of entry block
    \\x08                         # end of root

An earlier version of this module wrote a hand-rolled "null-terminated
strings in a row" layout instead. Steam cannot parse that, treats the whole
file as corrupt and drops *every* non-Steam shortcut the user had. This
implementation therefore:

  * parses the real format into a nested dict and keeps fields it does not
    understand, so nothing is lost on a round trip;
  * refuses to write when the existing file cannot be parsed (fail closed
    rather than clobber it);
  * keeps a timestamped backup before every write;
  * re-parses its own output and compares entry counts before swapping the
    file in with an atomic rename.
"""

import os
import shutil
import struct
import subprocess
import time
import zlib

TYPE_BLOCK = 0x00
TYPE_STRING = 0x01
TYPE_INT32 = 0x02
TYPE_FLOAT32 = 0x03
TYPE_UINT64 = 0x07
TYPE_END = 0x08

MAX_BACKUPS = 8


class SteamError(Exception):
    pass


class VdfError(SteamError):
    pass


# ---------------------------------------------------------------- vdf codec

def vdf_loads(raw: bytes) -> dict:
    """Parse KeyValues binary data into a nested dict."""
    pos = 0
    n = len(raw)

    def read_cstr():
        nonlocal pos
        end = raw.find(b"\x00", pos)
        if end < 0:
            raise VdfError("字符串未终止 (offset %d)" % pos)
        value = raw[pos:end].decode("utf-8", "replace")
        pos = end + 1
        return value

    def parse_block(depth: int = 0) -> dict:
        nonlocal pos
        if depth > 32:
            raise VdfError("嵌套层级过深")
        out = {}
        while True:
            if pos >= n:
                raise VdfError("文件意外结束 (offset %d)" % pos)
            kind = raw[pos]
            pos += 1
            if kind == TYPE_END:
                return out
            key = read_cstr()
            if kind == TYPE_BLOCK:
                out[key] = parse_block(depth + 1)
            elif kind == TYPE_STRING:
                out[key] = read_cstr()
            elif kind == TYPE_INT32:
                if pos + 4 > n:
                    raise VdfError("int32 越界")
                out[key] = struct.unpack("<i", raw[pos:pos + 4])[0]
                pos += 4
            elif kind == TYPE_UINT64:
                if pos + 8 > n:
                    raise VdfError("uint64 越界")
                out[key] = struct.unpack("<Q", raw[pos:pos + 8])[0]
                pos += 8
            elif kind == TYPE_FLOAT32:
                if pos + 4 > n:
                    raise VdfError("float32 越界")
                out[key] = struct.unpack("<f", raw[pos:pos + 4])[0]
                pos += 4
            else:
                raise VdfError("不支持的字段类型 0x%02x (key=%r)" % (kind, key))

    if not raw:
        return {}
    data = parse_block()
    return data


def vdf_dumps(data: dict) -> bytes:
    """Serialise a nested dict into KeyValues binary data."""
    buf = bytearray()

    def write_block(node, depth: int = 0):
        if depth > 32:
            raise VdfError("嵌套层级过深")
        for key, value in node.items():
            k = str(key).encode("utf-8") + b"\x00"
            if isinstance(value, dict):
                buf.extend(bytes([TYPE_BLOCK]) + k)
                write_block(value, depth + 1)
                buf.extend(bytes([TYPE_END]))
            elif isinstance(value, bool):
                buf.extend(bytes([TYPE_INT32]) + k + struct.pack("<i", 1 if value else 0))
            elif isinstance(value, int):
                v = value
                if v < -0x80000000 or v > 0xFFFFFFFF:
                    raise VdfError("整数越界: %r" % value)
                if v > 0x7FFFFFFF:  # store large ids as signed int32
                    v -= 0x100000000
                buf.extend(bytes([TYPE_INT32]) + k + struct.pack("<i", v))
            elif isinstance(value, float):
                buf.extend(bytes([TYPE_FLOAT32]) + k + struct.pack("<f", value))
            else:
                buf.extend(
                    bytes([TYPE_STRING]) + k + str(value).encode("utf-8") + b"\x00"
                )

    write_block(data)
    buf.extend(bytes([TYPE_END]))
    return bytes(buf)


# ----------------------------------------------------------------- shortcuts

def make_appid(exe: str, app_name: str) -> int:
    """Derive a stable unsigned appid the way Steam does for non-Steam games.

    Steam hashes `<exe><name>` with CRC32 and forces the top bit, which lands
    the value in the 2^31..2^32 range. Only the low 31 bits distinguish
    entries, so collisions are rare enough for a library of a few hundred.
    """
    key = "%s%s" % (exe, app_name)
    crc = zlib.crc32(key.encode("utf-8")) & 0xFFFFFFFF
    return crc | 0x80000000


def _unquote(value) -> str:
    s = str(value or "").strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return s[1:-1]
    return s


def _quote(value: str) -> str:
    s = str(value or "").strip()
    if not s:
        return ""
    if s[0] == '"' and s[-1] == '"':
        return s
    return '"%s"' % s


class ShortcutEntry:
    def __init__(self, appid: int, app_name: str, exe: str, start_dir: str,
                 icon: str = "", launch_options: str = "", tags=None):
        self.appid = appid          # unsigned 32-bit, as Steam URLs use it
        self.app_name = app_name
        self.exe = exe
        self.start_dir = start_dir
        self.icon = icon
        self.launch_options = launch_options
        self.tags = list(tags or [])


def _entry_from_dict(node: dict) -> ShortcutEntry:
    tags = node.get("tags")
    tag_list = []
    if isinstance(tags, dict):
        for k in sorted(tags, key=lambda x: str(x)):
            tag_list.append(str(tags[k]))
    return ShortcutEntry(
        appid=int(node.get("appid", 0)) & 0xFFFFFFFF,
        app_name=str(node.get("AppName", "")),
        exe=_unquote(node.get("Exe")),
        start_dir=_unquote(node.get("StartDir")),
        icon=str(node.get("icon", "") or ""),
        launch_options=str(node.get("LaunchOptions", "") or ""),
        tags=tag_list,
    )


class SteamShortcuts:
    def __init__(self):
        self.userdata_root = os.path.expanduser(
            "~/.local/share/Steam/userdata")

    # -- account dir selection -------------------------------------------
    def _config_dir(self):
        """Pick the config dir of the account Steam actually uses.

        `userdata` can contain several numeric ids, including `0` (a stub
        directory for the "no account" case). Choosing the first one blindly
        used to send shortcuts to `userdata/0/config`, where Steam never looks.
        """
        if not os.path.isdir(self.userdata_root):
            return None
        candidates = []
        try:
            uids = os.listdir(self.userdata_root)
        except OSError:
            return None
        for uid in uids:
            if not uid.isdigit():
                continue
            cfg = os.path.join(self.userdata_root, uid, "config")
            if not os.path.isdir(cfg):
                continue
            score = 0
            if os.path.isfile(os.path.join(cfg, "shortcuts.vdf")):
                score += 10
            if os.path.isfile(os.path.join(cfg, "localconfig.vdf")):
                score += 5
            if uid == "0":
                score -= 100
            try:
                score += min(os.path.getmtime(cfg) / 1e9, 1)
            except OSError:
                pass
            candidates.append((score, cfg))
        if not candidates:
            return None
        candidates.sort(key=lambda c: c[0], reverse=True)
        return candidates[0][1]

    def _shortcuts_path(self):
        cfg = self._config_dir()
        if not cfg:
            return None
        return os.path.join(cfg, "shortcuts.vdf")

    # -- load / save ------------------------------------------------------
    def _load_tree(self, path: str) -> dict:
        if not os.path.isfile(path):
            return {"shortcuts": {}}
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError as e:
            raise SteamError("读取 shortcuts.vdf 失败: %s" % e)
        if not raw:
            return {"shortcuts": {}}
        try:
            data = vdf_loads(raw)
        except VdfError as e:
            # Fail closed: overwriting an unparseable file would destroy the
            # user's shortcuts for good.
            raise SteamError(
                "shortcuts.vdf 无法解析，已中止写入以免覆盖原有快捷方式（%s）" % e
            )
        if not isinstance(data.get("shortcuts"), dict):
            data["shortcuts"] = {}
        return data

    def _backup(self, path: str):
        if not os.path.isfile(path):
            return
        stamp = time.strftime("%Y%m%d-%H%M%S")
        target = "%s.epicdeck-backup-%s" % (path, stamp)
        try:
            shutil.copy2(path, target)
        except OSError:
            return
        backups = sorted(
            [p for p in os.listdir(os.path.dirname(path))
             if os.path.basename(p).startswith(os.path.basename(path) + ".epicdeck-backup-")]
        )
        for old in backups[:-MAX_BACKUPS]:
            try:
                os.remove(os.path.join(os.path.dirname(path), old))
            except OSError:
                pass

    def _save_tree(self, path: str, data: dict):
        expected = len(data.get("shortcuts") or {})
        try:
            blob = vdf_dumps(data)
        except SteamError:
            raise
        except Exception as e:
            raise SteamError("生成 shortcuts.vdf 失败: %s" % e)

        # Self-check: our own output must parse back with the same entry count
        # before we let it near the real file.
        try:
            check = vdf_loads(blob)
            got = len(check.get("shortcuts") or {})
        except VdfError as e:
            raise SteamError("生成的 shortcuts.vdf 无法回读，已中止: %s" % e)
        if got != expected:
            raise SteamError(
                "生成的 shortcuts.vdf 条目数不一致 (%d != %d)，已中止"
                % (got, expected)
            )

        self._backup(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".epicdeck.tmp"
        with open(tmp, "wb") as f:
            f.write(blob)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    # -- public API -------------------------------------------------------
    def backfill_icons(self, launcher_dir: str, icon: str) -> int:
        """Give shortcuts written by older versions an icon if they lack one.

        Steam resolves a shortcut icon by extracting it from the target when the
        `icon` field is empty; our targets are shell scripts, so that lookup is
        both wasted work on the non-Steam page and a missing picture. Writing
        the field once fixes both.
        """
        if not icon or not os.path.isfile(icon):
            return 0
        path = self._shortcuts_path()
        if not path:
            return 0
        target = os.path.realpath(launcher_dir)
        data = self._load_tree(path)
        changed = 0
        for node in (data.get("shortcuts") or {}).values():
            if not isinstance(node, dict):
                continue
            exe = _unquote(node.get("Exe"))
            if not exe or os.path.realpath(os.path.dirname(exe)) != target:
                continue
            if str(node.get("icon") or ""):
                continue
            node["icon"] = icon
            changed += 1
        if changed:
            self._save_tree(path, data)
        return changed

    def list_shortcuts(self):
        path = self._shortcuts_path()
        if not path:
            return []
        try:
            data = self._load_tree(path)
        except SteamError:
            return []
        shortcuts = data.get("shortcuts") or {}
        entries = []
        # Numeric order: plain string sorting would put "10" before "2".
        def _idx(key):
            try:
                return (0, int(str(key)))
            except (TypeError, ValueError):
                return (1, str(key))
        for key in sorted(shortcuts, key=_idx):
            node = shortcuts[key]
            if isinstance(node, dict):
                entries.append(_entry_from_dict(node))
        return entries

    def add_game(self, app_name: str, exe: str, start_dir: str = "",
                 icon: str = "", launch_options: str = "", tags=None,
                 title: str = ""):
        """Add or update a non-Steam game. Returns the unsigned appid.

        `app_name` is Legendary's opaque id (the wrapper script is named after
        it); `title` is what the library should display. Steam derives a
        shortcut's identity from (exe, AppName), so passing the id as the
        display name would put a 32-character hash in the user's library.
        """
        path = self._shortcuts_path()
        if not path:
            raise SteamError(
                "找不到 Steam 用户数据目录。请先启动过 Steam 游戏模式。"
            )
        display = (title or "").strip() or app_name
        data = self._load_tree(path)
        shortcuts = data.setdefault("shortcuts", {})

        exe_q = _quote(exe)
        start_dir_q = _quote(start_dir or os.path.dirname(exe))
        target_exe = _unquote(exe_q)
        appid = make_appid(target_exe, display)

        # Match on Exe first: the wrapper path comes from app_name and never
        # changes, while AppName follows the localised title and can be edited
        # by the user later.
        target_key = None
        for key, node in shortcuts.items():
            if isinstance(node, dict) and _unquote(node.get("Exe")) == target_exe:
                target_key = key
                break
        if target_key is None:
            for key, node in shortcuts.items():
                if isinstance(node, dict) and str(node.get("AppName", "")) == display:
                    target_key = key
                    break

        if target_key is None:
            numeric = []
            for key in shortcuts:
                try:
                    numeric.append(int(str(key)))
                except (TypeError, ValueError):
                    continue
            target_key = str(max(numeric) + 1 if numeric else 0)
            shortcuts[target_key] = {}

        entry = shortcuts[target_key]
        if not isinstance(entry, dict):
            entry = {}
            shortcuts[target_key] = entry

        tag_map = {}
        for i, tag in enumerate(tags or []):
            tag_map[str(i)] = str(tag)

        # Keep whatever Steam or another plugin already stored, only touch the
        # fields we own.
        entry["appid"] = appid
        entry["AppName"] = display
        entry["Exe"] = exe_q
        entry["StartDir"] = start_dir_q
        # An icon we supply must win over the empty placeholder earlier
        # versions wrote, otherwise Steam keeps trying to extract one from the
        # launcher script on every library render.
        if icon:
            entry["icon"] = icon
        else:
            entry.setdefault("icon", "")
        entry.setdefault("ShortcutPath", "")
        entry["LaunchOptions"] = launch_options or ""
        entry.setdefault("IsHidden", 0)
        entry.setdefault("AllowDesktopConfig", 1)
        entry.setdefault("AllowOverlay", 1)
        entry.setdefault("OpenVR", 0)
        entry.setdefault("Devkit", 0)
        entry.setdefault("DevkitGameID", "")
        entry.setdefault("DevkitOverrideAppID", 0)
        entry.setdefault("LastPlayTime", 0)
        entry.setdefault("FlatpakAppID", "")
        # Steam writes this itself; without it the entry still shows, but the
        # sort key falls back to AppName and the library order can look odd.
        entry.setdefault("sortas", "")
        if tag_map:
            entry["tags"] = tag_map
        else:
            entry.setdefault("tags", {})

        self._save_tree(path, data)
        return appid

    def remove_game(self, app_name: str) -> bool:
        path = self._shortcuts_path()
        if not path:
            return False
        data = self._load_tree(path)
        shortcuts = data.setdefault("shortcuts", {})
        keep = []
        removed = False
        for key in sorted(shortcuts, key=lambda k: int(str(k)) if str(k).isdigit() else 0):
            node = shortcuts[key]
            if isinstance(node, dict) and str(node.get("AppName", "")) == app_name:
                removed = True
                continue
            keep.append(node)
        if not removed:
            return False
        # Steam expects consecutive numeric keys starting at 0.
        data["shortcuts"] = {str(i): node for i, node in enumerate(keep)}
        self._save_tree(path, data)
        return True

    def find_game(self, app_name: str):
        return next(
            (e for e in self.list_shortcuts() if e.app_name == app_name),
            None,
        )

    def find_by_exe(self, exe: str):
        """Look a shortcut up by its executable — for us, the wrapper script.

        The wrapper path is derived from Legendary's app_name and is stable,
        which makes it a better key than AppName (the localised title).
        """
        target = os.path.realpath(_unquote(exe)) if exe else ""
        if not target:
            return None
        for entry in self.list_shortcuts():
            if entry.exe and os.path.realpath(entry.exe) == target:
                return entry
        return None

    def remove_by_exe(self, exe: str) -> bool:
        target = os.path.realpath(_unquote(exe)) if exe else ""
        if not target:
            return False
        path = self._shortcuts_path()
        if not path:
            return False
        data = self._load_tree(path)
        shortcuts = data.setdefault("shortcuts", {})
        keep = []
        removed = False
        for key in sorted(shortcuts, key=lambda k: int(str(k)) if str(k).isdigit() else 0):
            node = shortcuts[key]
            if isinstance(node, dict) and os.path.realpath(_unquote(node.get("Exe"))) == target:
                removed = True
                continue
            keep.append(node)
        if not removed:
            return False
        data["shortcuts"] = {str(i): node for i, node in enumerate(keep)}
        self._save_tree(path, data)
        return True


def open_steam_protocol(uri: str):
    """Open a steam:// URI using the desktop handler (xdg-open on SteamOS)."""
    try:
        subprocess.Popen(["xdg-open", uri],
                         stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        raise SteamError("找不到 xdg-open。请确认运行在 SteamOS 环境。")
