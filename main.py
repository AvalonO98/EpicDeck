# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

import os
import re
import sys
import json
import time
import asyncio
import configparser
import shlex
import shutil
import hashlib
from urllib.parse import quote

import decky

# Decky does not add the plugin directory to sys.path, so `from py_modules...`
# fails with ModuleNotFoundError. Add it explicitly (idempotent), mirroring
# how other Decky plugins (e.g. decky-steamgriddb) handle this.
_PLUGIN_DIR = getattr(decky, "DECKY_PLUGIN_DIR", os.path.dirname(os.path.abspath(__file__)))
if _PLUGIN_DIR and _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from py_modules.config import Config
from py_modules.epic_api import (
    detect_locale,
    fetch_localized_titles,
    fetch_playtime,
    steam_posix_locale,
)
from py_modules.legendary import Legendary, LegendaryError, LegendaryNotFound, plausible_size
from py_modules.paths import (
    default_games_dir,
    ensure_dir,
    expand as expand_path,
    free_bytes,
    pretty_free,
    runtime_dir,
)
from py_modules.steam import (
    SteamShortcuts,
    SteamError,
    appid_for,
    open_steam_protocol,
    restart_steam,
)
from py_modules import artwork, proton
from py_modules.legendary_installer import (
    InstallerError,
    default_install_dir,
    download_legendary,
    is_legendary_installed,
)

# Epic's launcher client. Legendary authenticates as this client, so the
# authorization code we hand to `legendary auth --code` must be issued for it.
EPIC_CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a"
EPIC_LOGIN_URL = (
    "https://www.epicgames.com/id/api/redirect"
    "?clientId=%s&responseType=code" % EPIC_CLIENT_ID
)

# A pasted blob may be the raw code, the redirect URL, or the whole JSON page.
# `authorizationCode` wins over `code=` in the URL, and both must be tried before
# any loose 32-hex match (the URL also contains the 32-hex client id).
_JSON_CODE_RE = re.compile(r'"authorizationCode"\s*:\s*"([0-9a-fA-F]{32})"')
_URL_CODE_RE = re.compile(r"[?&]code=([0-9a-fA-F]{32})")
_RAW_CODE_RE = re.compile(r"^[0-9a-fA-F]{32}$")

# A login session reads the clipboard every other tick; reading it opens an X11
# connection, so it is not free. Auto-capture waits at least this long after the
# page opens before pressing Ctrl+A, so it cannot interrupt a password being
# typed.
_LOGIN_FIRST_CAPTURE_DELAY = 20.0

# 诊断日志导出目录最多保留多少份。每次「导出诊断日志」都会在
# ~/epicdeck_logs/ 落一个带时间戳的 .log，若不设上限会无限累积吃满 home
# 分区；10 份（每次约几十 KB）足以回溯历史，也几乎不占空间。
EXPORT_LOG_KEEP = 10


def extract_authorization_code(raw: str) -> str:
    """Pull the 32-hex authorization code out of whatever the user pasted."""
    if not raw:
        return ""
    text = raw.strip().strip('"').strip()
    for pattern in (_JSON_CODE_RE, _URL_CODE_RE):
        m = pattern.search(text)
        if m:
            return m.group(1)
    if _RAW_CODE_RE.match(text):
        return text
    # Last resort: take the last 32-hex run (the client id appears earlier).
    hits = re.findall(r"[0-9a-fA-F]{32}", text)
    return hits[-1] if hits else ""


def _mask_personal(value: str) -> str:
    """Mask the middle of an identifier (account id / phone / email) for logs.

    How many chars survive on each side scales with length; an email keeps its
    full domain. Mirrors the frontend `maskPersonal` so both surfaces agree.
    """
    if not value:
        return ""
    s = value.strip()
    at = s.find("@")
    if at > 0:
        return _mask_personal(s[:at]) + s[at:]
    n = len(s)
    if n <= 2:
        return s
    if n <= 4:
        return s[0] + "*" * max(1, n - 2) + s[-1]
    keep = 3 if n >= 9 else 2
    return s[:keep] + "*" * max(1, n - keep * 2) + s[n - keep:]


def _hash_id(value: str) -> str:
    """One-way hash of an Epic account id for the frontend.

    The backend needs the raw id to talk to Epic and to key its own caches, but
    the frontend only needs a *stable, non-reversible* token to (a) show a
    masked identity and (b) key its library snapshot. Hashing at the boundary
    means the raw id never crosses the backend→frontend callable boundary in
    plaintext.
    """
    if not value:
        return ""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]


def _public_auth(status: dict) -> dict:
    """Rewrite an auth status dict so the raw account id never leaves the backend."""
    raw = str(status.get("account_id") or "")
    return {
        "logged_in": bool(status.get("logged_in")),
        "account_id": _hash_id(raw) if raw else "",
        "display_name": status.get("display_name", ""),
    }


# How long a library snapshot is considered fresh enough to skip the network.
# Five minutes keeps "added a game on the phone, opened the panel" responsive
# without hammering Epic's API every time the QAM is opened.
LIBRARY_TTL = 300.0
PLAYTIME_TTL = 3600.0

_AUTH_MARKERS = (
    "401",
    "unauthorized",
    "invalid_grant",
    "expired",
    "not logged in",
    "no user",
    "credentials",
)
_NETWORK_MARKERS = (
    "timed out",
    "timeout",
    "urlopen",
    "connection",
    "resolve",
    "unreachable",
    "ssl",
    "temporary failure",
    "network",
    "proxy",
    "502",
    "503",
    "504",
    "getaddrinfo",
)


_GAME_SESSION_KEYS = (
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_SESSION_TYPE",
    "PULSE_SERVER",
)


def _steam_session_vars() -> dict:
    """Session variables of the running Steam client.

    The plugin backend is a systemd child and inherits none of them, so games
    started from the plugin had no `DISPLAY` and never appeared. Reading them
    from Steam beats hardcoding `:0`: Desktop Mode uses a different display and
    a Wayland session also needs `WAYLAND_DISPLAY`. Returns {} when Steam's pid
    file is missing; callers fall back to the Game Mode defaults.
    """
    found = {}
    try:
        with open(os.path.expanduser("~/.steam/steam.pid"), "r", encoding="utf-8") as fh:
            pid = int(fh.read().strip())
    except (OSError, ValueError):
        return found
    try:
        with open("/proc/%d/environ" % pid, "rb") as fh:
            raw = fh.read()
    except OSError:
        return found
    for item in raw.split(b"\0"):
        key, sep, value = item.partition(b"=")
        if not sep:
            continue
        name = key.decode("utf-8", "replace")
        if name in _GAME_SESSION_KEYS and name not in found:
            found[name] = value.decode("utf-8", "replace")
    return found


def _posix_path(path: str) -> str:
    """Rewrite a path for the generated bash launcher.

    The launcher script is bash, but the plugin also runs on Windows during
    development, where a backslash is an escape character and `C:\\x\\y.sh`
    arrives mangled. Linux paths never contain backslashes, so this is a no-op
    on the device itself.
    """
    if not path or os.sep == "/":
        return path
    return path.replace("\\", "/")


def _valid_game_row(row) -> bool:
    """A library row we can render without blowing up.

    The snapshot on disk is shared with older builds and is editable by hand, so
    a row may lack `app_name`; indexing it later raised KeyError straight out of
    the Decky callable and the UI showed an empty library with no error.
    """
    if not isinstance(row, dict):
        return False
    app_name = row.get("app_name")
    return isinstance(app_name, str) and bool(app_name.strip())


def classify_error(exc) -> tuple:
    """Map a Legendary failure to (kind, human message).

    The QAM has to tell "you are offline" apart from "your token expired" —
    otherwise every hiccup looks like the same generic error and the user has
    no idea whether to check Wi-Fi or log in again.
    """
    text = str(exc or "").strip()
    low = text.lower()
    if any(m in low for m in _AUTH_MARKERS):
        return "auth", "Epic 登录状态已失效，请在设置里重新登录后再试。"
    if any(m in low for m in _NETWORK_MARKERS):
        return "network", "连不上 Epic 服务器：请检查网络或代理，然后重试。"
    return "unknown", text[:300] or "未知错误"


def _parse_size(value: str, unit: str):
    """Parse "123.45" + "MiB" into an integer byte count. Never raises."""
    mult = {"B": 1, "KiB": 1024, "MiB": 1024 ** 2, "GiB": 1024 ** 3}
    try:
        return int(float(value) * mult.get(unit, 1))
    except (TypeError, ValueError):
        return None


class Plugin:
    async def _main(self):
        decky.logger.info("EpicDeck loaded")

        settings_dir = getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", None) or getattr(decky, "DECKY_SETTINGS_DIR", None) or os.path.join(decky.HOME, ".epicdeck")
        self._settings_dir = settings_dir
        self.config = Config(
            os.path.join(settings_dir, "epicdeck.json")
        )
        self.config.load()

        self.legendary = Legendary(
            binary=self.config.get("legendary_path", "legendary")
        )
        self.steam = SteamShortcuts()

        # app_name -> asyncio.Task for active installs.
        self._install_tasks = {}
        # app_name -> subprocess.Process for the running legendary install, so
        # pause/cancel can stop the actual downloader (not just the task).
        self._install_procs = {}
        # app_name set of installs being soft-paused (vs cancelled outright);
        # the _run() cancellation handler checks this to emit the right state.
        self._pausing = set()
        # Background waiters for games started from the plugin, so a finished
        # game does not stay a zombie while the callable returns immediately.
        self._launch_reapers = set()
        self._meta_task = None
        self._meta_done = False
        # app_name -> {image_type: url}; one `legendary list` fills it for the
        # whole library, so artwork for several games costs one call.
        self._image_cache = None

        # Library snapshot cache. The QAM is torn down every time it closes,
        # so without this every open pays for `legendary list` + a playtime
        # request before the first row appears.
        self._lib_cache = None
        self._lib_cache_at = 0.0
        self._lib_locale = ""
        # Which Epic account the caches belong to. `app_name` is global, but the
        # library, playtime and installed state are per account, so switching
        # accounts must not serve the previous one's snapshot.
        self._account = ""
        self._lib_account = ""
        self._lib_task = None
        self._playtime_task = None
        self._load_library_cache()

        # Shortcuts created by older versions lack the locale export and the
        # "$@" forwarding; rewriting them costs nothing and fixes game language.
        try:
            self._sync_launcher_scripts()
        except Exception as e:
            decky.logger.warning("launcher sync failed: %s", e)

        # Warm the cache right after load so the first panel open is instant.
        # Keep a reference: an unreferenced task cannot be cancelled on unload
        # and would keep emitting events / writing the cache after the plugin
        # is gone (two instances writing the same library.json).
        self._unloaded = False
        self._warm_task = asyncio.create_task(self._warm_library())

    async def _unload(self):
        # Flip the flag first: background jobs check it before each emit / write,
        # so nothing from this instance touches the cache once we are gone.
        self._unloaded = True
        for task in getattr(self, "_install_tasks", {}).values():
            if not task.done():
                task.cancel()
        for name in ("_meta_task", "_lib_task", "_playtime_task", "_warm_task"):
            task = getattr(self, name, None)
            if task is not None and not task.done():
                task.cancel()
        await self._stop_login_session()
        decky.logger.info("EpicDeck unloaded")
        # Decky treats a falsy return as "keep the plugin running".
        return True

    async def _uninstall(self):
        decky.logger.info("EpicDeck uninstalled")

    # -- auth -------------------------------------------------------------
    async def auth_status(self):
        try:
            status = await self.legendary.auth_status()
            self._set_account(status.get("account_id"))
            return _public_auth(status)
        except Exception as e:
            decky.logger.error("auth_status: %s", e)
            return {"logged_in": False, "account_id": "", "display_name": ""}

    async def login(self):
        """Start interactive browser login (opens Epic authorization page).

        Only usable in desktop mode; game mode has no browser to hand off to.
        """
        try:
            # Browser login requires Legendary; give a clear error otherwise.
            if self.legendary._resolve() is None:
                return {"ok": False, "error": "Legendary 未安装,请先在设置中点击「一键安装 Legendary」"}
            await asyncio.wait_for(self.legendary.auth_login(), timeout=60.0)
            self._account = ""
            self._clear_library_cache()
            self.config.set("playtime_cache", {})
            self._meta_done = False
            return {"ok": True}
        except asyncio.TimeoutError:
            return {"ok": False, "error": "浏览器登录超时。游戏模式下请改用「手机/电脑授权码登录」"}
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}

    # -- authorization-code login -----------------------------------------
    async def get_login_url(self):
        """The Epic page that yields an authorization code usable by Legendary."""
        return {"ok": True, "url": EPIC_LOGIN_URL}

    async def login_with_code(self, raw: str = ""):
        """Finish login with an authorization code obtained from the Epic page.

        Why not the device-code flow: Epic binds an authorization code to the
        client that requested it, and Legendary redeems with its own launcher
        client. A code minted by `fortniteNewSwitchGameClient` is therefore
        always rejected (`authorization_code_not_for_your_client`).
        """
        if self.legendary._resolve() is None:
            return {"ok": False, "error": "Legendary 未安装,请先点击「一键安装 Legendary」"}

        code = extract_authorization_code(raw)
        if not code:
            return {
                "ok": False,
                "error": "没有识别到授权码。请粘贴 authorizationCode 的值,或直接粘贴整段 JSON/网址。",
            }

        try:
            await asyncio.wait_for(
                self.legendary.auth_with_code(code), timeout=120.0
            )
        except asyncio.TimeoutError:
            return {"ok": False, "error": "登录超时,请检查网络后重试"}
        except LegendaryError as e:
            msg = str(e)
            low = msg.lower()
            if "not_found" in low:
                return {
                    "ok": False,
                    "error": "授权码已失效。它有效期很短且只能用一次,请重新打开登录页并立即粘贴。",
                }
            if "not_for_your_client" in low:
                return {
                    "ok": False,
                    "error": "授权码不属于 EpicDeck 的客户端。请用插件里给出的那个链接登录。",
                }
            decky.logger.error("login_with_code: %s", msg)
            return {"ok": False, "error": msg}

        status = await self.legendary.auth_status()
        if not status.get("logged_in"):
            return {"ok": False, "error": "登录命令已执行但未确认成功,请导出日志排查。"}
        # Signing in replaces Legendary's stored credentials, so whatever we
        # cached may belong to the previous account. Drop it unconditionally:
        # a wrong library is worse than one extra fetch.
        self._account = ""
        self._clear_library_cache()
        self.config.set("playtime_cache", {})
        self._meta_done = False
        self._set_account(status.get("account_id"))
        return {
            "ok": True,
            "display_name": status.get("display_name", ""),
            "account_id": _hash_id(str(status.get("account_id") or "")),
        }

    async def logout(self):
        try:
            await self.legendary.auth_logout()
            # The snapshot belongs to the account that just signed out.
            self._account = ""
            self._clear_library_cache()
            self.config.set("playtime_cache", {})
            self._meta_done = False
            return {"ok": True}
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}

    async def open_login_browser(self):
        """Open Epic's login page in Steam's built-in browser.

        Game Mode has no system browser, and sending the user to desktop mode
        just to copy a code defeats the purpose. Steam's CEF overlay is an
        ordinary X11 clipboard client, so whatever it copies is readable via
        py_modules.clipboard once we get the page in front of the user.
        """
        url = "steam://openurl/" + EPIC_LOGIN_URL
        env = os.environ.copy()
        # plugin_loader is a systemd service: it does not inherit the desktop
        # session, so pointing it at Steam's X server has to be explicit.
        env.setdefault("DISPLAY", ":0")
        env.setdefault("XDG_RUNTIME_DIR", "/run/user/%d" % os.getuid())
        for cmd in (["xdg-open", url], ["steam", url]):
            exe = shutil.which(cmd[0])
            if not exe:
                continue
            try:
                await asyncio.create_subprocess_exec(
                    *cmd, env=env,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                decky.logger.info("opened login page via %s", cmd[0])
                return {"ok": True, "url": EPIC_LOGIN_URL}
            except (OSError, PermissionError) as e:
                decky.logger.warning("%s failed: %s", cmd[0], e)
        return {"ok": False, "error": "找不到可用的浏览器，请改用手机扫码登录"}

    async def login_with_clipboard(self):
        """Read an authorization code from the clipboard and log in with it.

        This is the "I already logged in in Steam's browser" button: the user
        selects the JSON page's content once and the plugin does the rest.
        """
        from py_modules.clipboard import read_clipboard

        try:
            raw = await asyncio.get_running_loop().run_in_executor(None, read_clipboard)
        except Exception as e:
            decky.logger.warning("clipboard read failed: %s", e)
            raw = ""

        if not raw.strip():
            return {
                "ok": False,
                "error": "剪贴板是空的。请在 Steam 浏览器里登录完成后，全选页面内容并复制。",
            }

        code = extract_authorization_code(raw)
        if not code:
            preview = raw.strip()[:80].replace("\n", " ")
            return {
                "ok": False,
                "error": "剪贴板内容里没有授权码（读到：%s…）。请复制登录后显示的那整段内容。" % preview,
            }

        result = await self.login_with_code(code)
        if result.get("ok"):
            decky.logger.info("logged in from clipboard")
        return result

    # -- hands-off login ---------------------------------------------------
    #
    # The user's complaint about the code flow was never the code itself, it was
    # that copying it on a handheld means fighting the on-screen keyboard.
    #
    # Epic only sends the browser back to redirect URLs registered on the
    # launcher client (legendary's own `epicgames.com/id/api/redirect`), so a
    # loopback callback is refused and the page simply parks on that JSON —
    # which is exactly what an earlier version got wrong. Instead of asking the
    # browser to hand the code to us, the session takes it:
    #
    #   begin_login()  -> open Epic's page and start watching
    #   login_poll()   -> the QAM panel polls this until the code arrives
    #
    # Watching means two things: the clipboard (in case the user copies the
    # text by hand) and, once the screen has been idle for a moment, a
    # synthetic Ctrl+A / Ctrl+C on whatever Steam is showing. The JSON page's
    # body is plain text, so that selection *is* the payload, and it lands on
    # the same X11 clipboard this plugin already reads.

    def _login_page_url(self) -> str:
        """Epic's sign-in page, returning to the page that yields a code."""
        return "https://www.epicgames.com/id/login?redirectUrl=%s" % quote(
            EPIC_LOGIN_URL, safe=""
        )

    async def _open_in_steam(self, url: str) -> bool:
        """Hand a URL to Steam's built-in browser (the only one in Game Mode)."""
        env = os.environ.copy()
        # plugin_loader is a systemd service: it does not inherit the desktop
        # session, so pointing it at Steam's X server has to be explicit.
        env.setdefault("DISPLAY", ":0")
        env.setdefault("XDG_RUNTIME_DIR", "/run/user/%d" % os.getuid())
        candidates = (["xdg-open", "steam://openurl/" + url], ["steam", "steam://openurl/" + url])
        for cmd in candidates:
            exe = shutil.which(cmd[0])
            if not exe:
                continue
            try:
                await asyncio.create_subprocess_exec(
                    *cmd,
                    env=env,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                decky.logger.info("handed URL to Steam via %s", cmd[0])
                return True
            except (OSError, PermissionError) as e:
                decky.logger.warning("%s failed: %s", cmd[0], e)
        return False

    async def _read_clipboard_async(self) -> str:
        from py_modules.clipboard import read_clipboard

        try:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, read_clipboard)
        except Exception as e:
            decky.logger.debug("clipboard read failed: %s", e)
            return ""

    async def _stop_login_session(self):
        task = getattr(self, "_login_task", None)
        self._login_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    def _login_state_or_idle(self) -> dict:
        state = getattr(self, "_login_state", None)
        if isinstance(state, dict):
            return state
        return {"state": "idle", "message": "", "display_name": "", "auto_copied": False}

    async def begin_login(self):
        """Start a login session that finishes without any copying."""
        if self.legendary._resolve() is None:
            return {"ok": False, "error": "Legendary 未安装,请先点「一键安装 Legendary」"}

        # Already signed in (e.g. the panel was reopened after a successful
        # login): do not open a browser or a clipboard watcher.
        try:
            status = await asyncio.wait_for(self.legendary.auth_status(), timeout=20.0)
        except Exception as e:
            decky.logger.debug("begin_login status probe failed: %s", e)
            status = {}
        if status.get("logged_in"):
            self._login_state = {
                "state": "ok",
                "message": "",
                "display_name": status.get("display_name", ""),
                "auto_copied": False,
            }
            return {
                "ok": True,
                "already_logged_in": True,
                "url": "",
                "opened": False,
            }

        await self._stop_login_session()

        url = self._login_page_url()
        # Baseline: whatever is already on the clipboard must not be mistaken
        # for a fresh code (a previous attempt's JSON often lingers).
        self._login_baseline = await self._read_clipboard_async()
        self._login_state = {
            "state": "waiting",
            "message": "",
            "display_name": "",
            "auto_copied": False,
        }

        opened = await self._open_in_steam(url)
        self._login_task = asyncio.create_task(self._run_login_session())
        decky.logger.info("login session started: opened=%s", opened)
        return {
            "ok": True,
            "url": url,
            "opened": opened,
            "message": "" if opened else "没能自动打开浏览器，请手动打开上面的链接",
        }

    async def _auto_copy_async(self) -> bool:
        """Select the whole page in Steam's browser and copy it.

        Runs off the event loop: the helper sleeps between key events so
        Chromium can finish the selection before Ctrl+C arrives.
        """
        try:
            from py_modules import xkey
        except Exception as e:
            decky.logger.debug("xkey unavailable: %s", e)
            return False
        try:
            loop = asyncio.get_running_loop()
            ok = await loop.run_in_executor(None, xkey.select_all_and_copy)
        except Exception as e:
            decky.logger.debug("auto copy failed: %s", e)
            return False
        if ok:
            decky.logger.info("sent Ctrl+A / Ctrl+C to Steam's browser")
        return ok

    async def _run_login_session(self):
        """Wait for the authorization code to reach the clipboard."""
        baseline = getattr(self, "_login_baseline", "")
        start = time.monotonic()
        deadline = start + 600.0  # 10 minutes is plenty to sign in
        # Signing in (password, captcha) takes a while; do not start pressing
        # keys in the middle of it.
        next_capture = start + _LOGIN_FIRST_CAPTURE_DELAY
        # Back off between attempts: signing in can take a couple of minutes,
        # and pressing Ctrl+A once every 8 seconds in that window would be a
        # nuisance if the screen happened to pause on a half-filled form.
        capture_gap = 8.0

        last_clip = baseline
        ticks = 0
        watch = None
        try:
            from py_modules.xkey import ActivityWatch

            watch = ActivityWatch()
            if not watch.start():
                # Without raw input events we cannot tell whether somebody is
                # typing, so the capture stays off and the user finishes by
                # hand (the waiting screen offers that).
                decky.logger.warning("activity watch unavailable: auto capture disabled")
                watch = None

            while time.monotonic() < deadline:
                await asyncio.sleep(0.7)
                if self._login_state.get("state") in ("ok", "error", "timeout"):
                    return

                # Reading the clipboard opens an X11 connection, so it runs on
                # a slow cadence; only a *new* value can carry a fresh code.
                ticks += 1
                raw = ""
                if ticks % 2 == 0:
                    text = await self._read_clipboard_async()
                    if text and text != last_clip:
                        last_clip = text
                        if extract_authorization_code(text):
                            raw = text

                # Nobody is typing and Epic's code page should be up: take the
                # page ourselves. Ctrl+A while a password field is focused
                # would select (and Ctrl+C would copy) it, which is why this
                # waits for a quiet screen instead of running on a timer.
                if not raw and watch is not None and time.monotonic() >= next_capture:
                    capture_gap = min(30.0, capture_gap * 1.5)
                    next_capture = time.monotonic() + capture_gap
                    if watch.idle_seconds() >= 6.0 and await self._auto_copy_async():
                        await asyncio.sleep(0.6)
                        text = await self._read_clipboard_async()
                        if text and extract_authorization_code(text):
                            raw = text
                            last_clip = text
                            self._login_state["auto_copied"] = True

                if not raw:
                    continue

                code = extract_authorization_code(raw)
                if not code:
                    continue

                self._login_state["state"] = "finishing"
                decky.logger.info("authorization code captured")
                result = await self.login_with_code(code)
                self._login_baseline = ""
                if result.get("ok"):
                    self._login_state = {
                        "state": "ok",
                        "message": "",
                        "display_name": result.get("display_name", ""),
                        "auto_copied": self._login_state.get("auto_copied", False),
                    }
                else:
                    self._login_state = {
                        "state": "error",
                        "message": result.get("error", "登录失败"),
                        "display_name": "",
                        "auto_copied": self._login_state.get("auto_copied", False),
                    }
                return

            self._login_state = {
                "state": "timeout",
                "message": "等待登录超时，请重试。",
                "display_name": "",
                "auto_copied": self._login_state.get("auto_copied", False),
            }
        except asyncio.CancelledError:
            raise
        except Exception as e:  # a broken session must never kill the plugin
            decky.logger.error("login session crashed: %s", e)
            self._login_state = {
                "state": "error",
                "message": "登录过程出错: %s" % e,
                "display_name": "",
                "auto_copied": False,
            }
        finally:
            if watch is not None:
                watch.stop()
            # The identity check keeps a slow teardown from clobbering the
            # state of a session that was already restarted behind it.
            if getattr(self, "_login_task", None) is asyncio.current_task():
                self._login_task = None
                self._login_baseline = ""

    async def login_poll(self):
        """Current state of the running login session.

        Read-only: the session coroutine owns its own lifecycle, so polling
        never races with it. `ok` mirrors the state for callers that only care
        about the outcome.
        """
        state = dict(self._login_state_or_idle())
        state["ok"] = state.get("state") == "ok"
        return state

    async def cancel_login(self):
        await self._stop_login_session()
        self._login_state = {
            "state": "idle",
            "message": "",
            "display_name": "",
            "auto_copied": False,
        }
        return {"ok": True}

    # -- library ----------------------------------------------------------
    async def list_games(self, force: bool = False):
        """Return the library, cache-first.

        Decky tears the QAM content down every time it closes, so this used to
        re-run `legendary list` plus a playtime request on every open — several
        seconds of blank panel. A snapshot (memory + JSON on disk) is served
        immediately now, and a background refresh patches the rows in.
        """
        cached = getattr(self, "_lib_cache", None)
        # A snapshot written by another Epic account must never be served, even
        # if the panel opens before auth_status has run.
        if cached and self._lib_account and self._account and self._lib_account != self._account:
            decky.logger.info("library snapshot belongs to another account, dropping it")
            self._clear_library_cache()
            cached = None
        age = time.time() - getattr(self, "_lib_cache_at", 0.0)
        # A clock that jumped backwards (VM restore, manual edit) makes `age`
        # negative, and `age < TTL` would then hold forever: the snapshot would
        # never refresh and newly bought games would never show up.
        if age < 0:
            age = LIBRARY_TTL + 1.0

        if cached and not force and age < LIBRARY_TTL:
            if self._lib_locale and self._lib_locale != self._effective_title_locale():
                # The snapshot was built for another language (the user just
                # switched the UI): titles are re-picked from the cache right
                # away, and a rebuild fixes anything not cached for this locale.
                self._ensure_library_refresh()
                try:
                    return self._library_payload(cached, stale=True)
                except Exception:
                    pass
            try:
                return self._library_payload(cached)
            except Exception as e:  # noqa: BLE001 - a bad snapshot must not kill the panel
                # One malformed row (older format, hand-edited file) used to
                # raise out of the callable, which made the UI show an empty
                # library with no error at all. Drop the snapshot and refetch.
                decky.logger.warning("library cache unusable, refetching: %s", e)
                self._lib_cache = None
                cached = None

        # Stale but usable: never make the user wait for the network.
        if cached and not force:
            self._ensure_library_refresh()
            return self._library_payload(cached, stale=True)

        try:
            games = await self._fetch_library()
        except LegendaryError as e:
            kind, message = classify_error(e)
            decky.logger.warning("library load failed (%s): %s", kind, e)
            if cached:
                # Keep showing the last known library instead of an error page
                # just because the network blinked.
                self._ensure_library_refresh()
                payload = self._library_payload(cached, stale=True)
                payload["warning"] = message
                payload["error_kind"] = kind
                return payload
            return {"ok": False, "error": message, "error_kind": kind}
        except Exception as e:  # noqa: BLE001 - never leave the QAM blank
            kind, message = classify_error(e)
            decky.logger.exception("library load crashed")
            if cached:
                payload = self._library_payload(cached, stale=True)
                payload["warning"] = message
                payload["error_kind"] = kind
                return payload
            return {"ok": False, "error": message, "error_kind": kind}

        self._store_library(games)
        return self._library_payload(games)

    async def _fetch_library(self):
        """Hit Epic and build a fresh game list (slow path, network involved)."""
        games = await self.legendary.list_games()

        # Epic exposes no "date added", so we record when each title first
        # showed up in this plugin's library. Everything seen on the first run
        # shares one timestamp; later acquisitions sort above them.
        first_seen = self.config.get("first_seen") or {}
        if not isinstance(first_seen, dict):
            first_seen = {}
        now = int(time.time())
        changed = False

        # Read shortcuts.vdf once instead of one `is_in_steam` callable per row
        # (the old per-row call meant 138 IPC round-trips on every render).
        # Keyed by the wrapper script name: AppName is the display title now.
        try:
            in_steam = {
                os.path.basename(s.exe) for s in self.steam.list_shortcuts() if s.exe
            }
        except Exception as e:
            decky.logger.warning("shortcuts read failed: %s", e)
            in_steam = set()

        for g in games:
            g["in_steam"] = ("%s.sh" % g["app_name"]) in in_steam
            seen = first_seen.get(g["app_name"])
            if not isinstance(seen, int):
                first_seen[g["app_name"]] = now
                seen = now
                changed = True
            g["first_seen"] = seen

        if changed:
            try:
                self.config.set("first_seen", first_seen)
            except OSError as e:
                decky.logger.warning("first_seen save failed: %s", e)

        # Titles and sizes are enriched separately: localised titles come from
        # one catalog call, sizes need a per-game manifest download (seconds
        # each), so both are cached and filled in by a background task that
        # patches the list through events.
        locale = self._effective_title_locale()
        self._lib_locale = locale
        self._apply_cached_metadata(games, locale)

        if bool(self.config.get("auto_fetch_size", True)):
            self._ensure_metadata_refresh(games, locale)

        # Playtime is a nice-to-have: it used to block the whole library on a
        # 15s request. Serve the cached numbers and refresh them quietly.
        self._ensure_playtime_refresh()
        return games

    # -- library cache ---------------------------------------------------
    def _library_cache_path(self):
        return os.path.join(self._settings_dir, "library.json")

    def _load_library_cache(self):
        path = self._library_cache_path()
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict) or data.get("version") != 1:
                return
            games = data.get("games")
            if not isinstance(games, list):
                return
            self._lib_cache = [g for g in games if _valid_game_row(g)]
            self._lib_cache_at = float(data.get("ts") or 0)
            self._lib_locale = str(data.get("locale") or "")
            self._lib_account = str(data.get("account") or "")
            decky.logger.info("library cache: %d games", len(self._lib_cache))
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as e:
            decky.logger.warning("library cache unreadable: %s", e)

    def _store_library(self, games):
        self._lib_cache = games
        self._lib_cache_at = time.time()
        try:
            tmp = self._library_cache_path() + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "version": 1,
                        "ts": int(self._lib_cache_at),
                        "locale": self._lib_locale,
                        "account": self._account,
                        "games": games,
                    },
                    f,
                    ensure_ascii=False,
                )
            os.replace(tmp, self._library_cache_path())
        except OSError as e:
            decky.logger.warning("library cache save failed: %s", e)

    def _clear_library_cache(self):
        """Forget the snapshot — used on logout so accounts never mix."""
        self._lib_cache = None
        self._lib_cache_at = 0.0
        self._lib_locale = ""
        self._lib_account = ""
        try:
            os.remove(self._library_cache_path())
        except FileNotFoundError:
            pass
        except OSError as e:
            decky.logger.warning("library cache clear failed: %s", e)

    def _set_account(self, account_id) -> None:
        """Remember which Epic account is signed in; drop caches on a switch.

        Called anywhere the account is learnt (auth_status, login, logout). A
        different account means a different library, playtime and ownership, so
        the snapshot must go — otherwise the new account briefly sees the old
        account's games, which is both confusing and a privacy leak between
        users of the same Deck.
        """
        raw = str(account_id or "")
        account = _hash_id(raw) if raw else ""
        previous = getattr(self, "_account", "")
        self._account = account
        snapshot_account = getattr(self, "_lib_account", "")

        switched = bool(account) and (
            (bool(previous) and previous != account)
            or (bool(snapshot_account) and snapshot_account != account)
        )
        if not switched:
            return
        decky.logger.info("epic account changed, dropping account-scoped caches")
        self._clear_library_cache()
        # Playtime is per account; titles and sizes are keyed by Epic's global
        # app_name and stay useful across accounts.
        self.config.set("playtime_cache", {})
        self._meta_done = False
        self._image_cache = None

    def _playtime_map(self):
        data = self.config.get("playtime_cache") or {}
        return data if isinstance(data, dict) else {}

    def _library_payload(self, games, stale: bool = False):
        playtime = self._playtime_map()
        locale = self._effective_title_locale()
        # Pick the title for the *current* language on every render. The snapshot
        # stores `source_title` (Epic's own, English) separately from `title`, so
        # switching language is instant and never shows a stale translation.
        titles = (self.config.get("title_cache") or {}).get(locale) or {}
        if not isinstance(titles, dict):
            titles = {}

        out = []
        for g in games:
            if not _valid_game_row(g):
                continue
            item = dict(g)
            name = g["app_name"]
            item["playtime_seconds"] = int(playtime.get(name) or 0)
            localized = titles.get(name)
            if isinstance(localized, str) and localized.strip():
                item["title"] = localized.strip()
            else:
                fallback = str(g.get("source_title") or item.get("title") or "").strip()
                item["title"] = fallback or name
            out.append(item)
        # A refresh may have landed new titles/sizes since the snapshot.
        self._apply_cached_metadata(out, locale)

        try:
            have_legendary = self.legendary._resolve() is not None
        except Exception:
            have_legendary = False
        can_fetch = bool(self.config.get("auto_fetch_size", True)) and have_legendary
        pending = sum(1 for g in out if not g.get("disk_size")) if can_fetch else 0
        if can_fetch:
            self._ensure_metadata_refresh(out, locale)

        return {
            "ok": True,
            "games": out,
            "locale": locale,
            "size_pending": pending,
            "stale": bool(stale),
            "cached_at": int(self._lib_cache_at or 0),
        }

    def _ensure_library_refresh(self):
        task = getattr(self, "_lib_task", None)
        if task is not None and not task.done():
            return
        self._lib_task = asyncio.create_task(self._refresh_library_background())

    async def _refresh_library_background(self):
        if getattr(self, "_unloaded", False):
            return
        try:
            games = await self._fetch_library()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - background job, log and move on
            kind, message = classify_error(e)
            decky.logger.warning("background refresh failed (%s): %s", kind, e)
            try:
                await decky.emit("library_error", message, kind)
            except Exception:
                pass
            return
        if getattr(self, "_unloaded", False):
            return
        self._store_library(games)
        try:
            await decky.emit("library_full", self._library_payload(games))
        except Exception as e:
            decky.logger.warning("library_full emit failed: %s", e)

    async def _warm_library(self):
        """Prime the cache after plugin load so the first open is instant."""
        await asyncio.sleep(1.0)
        if getattr(self, "_unloaded", False):
            return
        try:
            status = await self.legendary.auth_status()
        except Exception:
            return
        if getattr(self, "_unloaded", False):
            return
        if not status.get("logged_in"):
            return
        if self._lib_cache is None:
            await self._refresh_library_background()
        else:
            self._ensure_playtime_refresh()
            self._ensure_library_refresh()

    # -- playtime --------------------------------------------------------
    def _ensure_playtime_refresh(self):
        cached = self._playtime_map()
        if time.time() - float(cached.get("__ts") or 0) < PLAYTIME_TTL:
            return
        task = getattr(self, "_playtime_task", None)
        if task is not None and not task.done():
            return
        self._playtime_task = asyncio.create_task(self._refresh_playtime())

    async def _refresh_playtime(self):
        loop = asyncio.get_running_loop()
        try:
            data = await asyncio.wait_for(
                loop.run_in_executor(None, fetch_playtime), timeout=25.0
            )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            decky.logger.warning("playtime unavailable: %s", e)
            return
        if not isinstance(data, dict) or not data:
            return
        cache = dict(data)
        cache["__ts"] = int(time.time())
        try:
            self.config.set("playtime_cache", cache)
        except OSError as e:
            decky.logger.warning("playtime cache save failed: %s", e)
        patch = {k: {"playtime_seconds": int(v or 0)} for k, v in data.items()}
        try:
            await decky.emit("library_patch", patch, -1)
        except Exception as e:
            decky.logger.warning("playtime patch failed: %s", e)

    # -- library enrichment ----------------------------------------------
    def _effective_title_locale(self) -> str:
        """Language game titles should use.

        `title_locale=auto` follows the *interface* language, not raw Steam:
        a user who switched the UI to English expects English titles, and the
        library used to stay Chinese because Steam itself was still Chinese.
        An explicit `title_locale` always wins, so "English UI + Chinese titles"
        is still possible.
        """
        setting = str(self.config.get("title_locale", "auto") or "auto")
        if setting != "auto":
            return setting
        ui = str(self.config.get("ui_language", "auto") or "auto")
        if ui == "en":
            return "en-US"
        if ui == "zh":
            return "zh-Hans"
        return detect_locale("auto")

    def _title_for(self, app_name: str) -> str:
        """Best known display title for an app_name, without a network call."""
        locale = self._effective_title_locale()
        cache = self.config.get("title_cache") or {}
        if isinstance(cache, dict):
            titles = cache.get(locale) or {}
            if isinstance(titles, dict):
                title = titles.get(app_name)
                if isinstance(title, str) and title.strip():
                    return title.strip()
            # Any locale beats the 32-char hash.
            for other in cache.values():
                if isinstance(other, dict):
                    title = other.get(app_name)
                    if isinstance(title, str) and title.strip():
                        return title.strip()
        return ""

    def _apply_cached_metadata(self, games, locale):
        """Overlay cached localised titles and cached install sizes."""
        titles = (self.config.get("title_cache") or {}).get(locale) or {}
        sizes = self.config.get("size_cache") or {}
        if not isinstance(titles, dict):
            titles = {}
        if not isinstance(sizes, dict):
            sizes = {}

        for g in games:
            title = titles.get(g["app_name"])
            if isinstance(title, str) and title.strip():
                g["title"] = title.strip()
                g["localized_title"] = True

            cached = sizes.get(g["app_name"])
            if isinstance(cached, dict):
                # plausible_size: 残缺 manifest 写进来的 4 字节要当成没有,
                # 否则列表里会显示成 "4 B" 且永远不会被重新测量。
                disk = plausible_size(cached.get("disk"))
                download = plausible_size(cached.get("download"))
                if disk or download:
                    g["download_size"] = download
                    g["disk_size"] = disk
                    # `install_size` is what the UI has always shown; keep it
                    # meaning "bytes to download".
                    g["install_size"] = download or disk

    def _ensure_metadata_refresh(self, games, locale):
        if not self.config.get("auto_fetch_size", True):
            return
        task = getattr(self, "_meta_task", None)
        if task is not None and not task.done():
            return
        if getattr(self, "_meta_locale", "") == locale and getattr(self, "_meta_done", False):
            return
        self._meta_task = asyncio.create_task(self._refresh_metadata(games, locale))

    #: How long a "no Chinese title anywhere" answer is trusted before retrying.
    TITLE_MISS_TTL = 30 * 24 * 3600

    def _save_titles(self, locale: str, added: dict, misses: dict) -> None:
        """Merge new titles into the cache, recording where each came from."""
        cache = self.config.get("title_cache") or {}
        if not isinstance(cache, dict):
            cache = {}
        bucket = cache.get(locale)
        if not isinstance(bucket, dict):
            bucket = {}
        bucket.update(added)
        cache[locale] = bucket
        self.config.set("title_cache", cache)
        self.config.set("title_misses", misses)

    async def _fill_missing_titles(self, games, locale, cached):
        """Third-party Chinese titles for the games Epic leaves in English.

        Epic's catalog only translates a fraction of a library (9 of 138 in
        testing). The Steam store knows the official Chinese name for many more;
        lookups run in the background, throttled, and patches are emitted as
        results arrive so the grid fills in without a reload.

        Misses are remembered for 30 days: without that, every library refresh
        would re-ask the store about the same 80 untranslated games.
        """
        from py_modules import title_sources

        if not str(locale).lower().startswith("zh"):
            return
        if not self.config.get("third_party_titles", True):
            return

        misses = self.config.get("title_misses") or {}
        if not isinstance(misses, dict):
            misses = {}
        now = int(time.time())
        todo = []
        for g in games:
            name = str(g.get("app_name") or "")
            if not name or name in cached or name in misses and now - int(misses[name]) < self.TITLE_MISS_TTL:
                continue
            title = str(g.get("source_title") or g.get("title") or "").strip()
            # A 32-char app_name is a hash, not something worth searching for.
            if len(title) < 3 or title == name:
                continue
            todo.append((name, title))
        if not todo:
            return

        loop = asyncio.get_running_loop()
        added = {}
        transport_failures = 0
        processed = 0
        for app_name, title in todo:
            if getattr(self, "_unloaded", False):
                return
            try:
                result = await loop.run_in_executor(None, title_sources.lookup, title, 6.0)
            except Exception as e:  # noqa: BLE001 - decorations must not break a refresh
                decky.logger.warning("title lookup failed: %s", e)
                result = {"transport": True}
            processed += 1
            if result.get("title"):
                transport_failures = 0
                added[app_name] = result["title"]
                decky.logger.info(
                    "title from %s: %s -> %s", result.get("source"), title, result["title"]
                )
            elif result.get("transport"):
                # Unreachable, not untranslated: do NOT cache this as a miss, or
                # the game keeps its English title for a month after a hiccup.
                transport_failures += 1
                if transport_failures >= 3:
                    decky.logger.info("title lookup: store unreachable, will retry later")
                    break
            else:
                transport_failures = 0
                misses[app_name] = now
            # The store is a shared service and this loop can run over a hundred
            # titles; a small gap keeps it from looking like a scraper.
            await asyncio.sleep(0.3)
            # Flush on progress, not only on hits: a library with few translated
            # titles would otherwise sit silent for minutes.
            if processed % 25 == 0:
                self._save_titles(locale, dict(added), misses)
                if added:
                    await decky.emit("library_patch", dict(added), 0)
                    added.clear()
        if added:
            self._save_titles(locale, added, misses)
            await decky.emit("library_patch", dict(added), 0)
        else:
            self.config.set("title_misses", misses)

    async def _refresh_metadata(self, games, locale):
        """Fill in localised titles, then sizes, emitting patches as it goes."""
        loop = asyncio.get_running_loop()
        self._meta_locale = locale
        self._meta_done = False

        # 1) Localised titles: a few catalog calls, done in one go.
        try:
            cache = self.config.get("title_cache") or {}
            if not isinstance(cache, dict):
                cache = {}
            cached = cache.get(locale) or {}
            # English titles already come from `app_title`; asking the catalog
            # for 138 of them would be pure waste.
            items = (
                []
                if locale.lower().startswith("en")
                else [
                    (g["app_name"], g.get("namespace", ""), g.get("catalog_item_id", ""))
                    for g in games
                    if g["app_name"] not in cached
                ]
            )
            if items:
                got = await loop.run_in_executor(None, fetch_localized_titles, items, locale)
                if got:
                    cached.update(got)
                    cache[locale] = cached
                    self.config.set("title_cache", cache)
                    await decky.emit("library_patch", got, 0)
                    decky.logger.info("localized titles: %d added for %s", len(got), locale)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            decky.logger.warning("localized titles failed: %s", e)

        # 1b) Chinese titles Epic does not translate (Steam store / Wikidata).
        titles = (self.config.get("title_cache") or {}).get(locale) or {}
        await self._fill_missing_titles(games, locale, titles if isinstance(titles, dict) else {})

        # 2) Install sizes: one manifest fetch per game, throttled and cached.
        sizes = self.config.get("size_cache") or {}
        if not isinstance(sizes, dict):
            sizes = {}
        now = int(time.time())
        todo = []
        for g in games:
            cached = sizes.get(g["app_name"])
            # 用 plausible_size 判「有效」: 残缺 manifest 的 4 字节不算有效,
            # 否则这条会一直被当成 fresh 缓存,永远不重新测量。
            fresh = isinstance(cached, dict) and plausible_size(cached.get("disk")) > 0
            if fresh and now - int(cached.get("ts") or 0) < 30 * 86400:
                continue
            # A recent failure is not retried on every panel open: each attempt
            # costs a manifest download (and some apps never return one).
            failed_at = int(cached.get("failed") or 0) if isinstance(cached, dict) else 0
            if not fresh and failed_at and now - failed_at < self.SIZE_FAIL_TTL:
                continue
            todo.append(g["app_name"])
        if not todo:
            self._meta_done = True
            try:
                await decky.emit("library_patch", {}, 0)
            except Exception as e:
                decky.logger.warning("library_patch emit failed: %s", e)
            return

        decky.logger.info("fetching sizes for %d games", len(todo))
        sem = asyncio.Semaphore(3)
        patch = {}
        remaining = [len(todo)]
        dirty = [False]
        flush_at = [time.time()]

        async def fetch_one(app_name):
            async with sem:
                try:
                    result = await self.legendary.game_size(app_name)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    decky.logger.warning("size %s failed: %s", app_name, e)
                    result = None
                remaining[0] -= 1
                if not result:
                    # No manifest: an installed game still has a real size on
                    # disk, and that is what the user is looking at.
                    disk = await self._measure_install(app_name)
                    if disk:
                        result = {"download": 0, "disk": disk, "measured": True}
                        decky.logger.info(
                            "size %s: no manifest, measured %d bytes on disk", app_name, disk
                        )
                if result:
                    sizes[app_name] = {
                        "download": result["download"],
                        "disk": result["disk"],
                        "ts": now,
                    }
                    patch[app_name] = {
                        "download": result["download"],
                        "disk": result["disk"],
                    }
                    dirty[0] = True
                else:
                    sizes[app_name] = {"failed": now}
                    dirty[0] = True

                # Flush in batches: per-game IPC would mean 138 events.
                due = len(patch) >= 6 or (time.time() - flush_at[0]) > 3.0
                if patch and (due or remaining[0] == 0):
                    try:
                        await decky.emit("library_patch", dict(patch), remaining[0])
                    except Exception as e:  # noqa: BLE001 - the panel may be gone
                        # Swallowing this used to tear down the whole gather on
                        # a transient bridge hiccup, leaving `_meta_done` false
                        # and re-downloading every manifest on the next open.
                        decky.logger.warning("library_patch emit failed: %s", e)
                    patch.clear()
                    flush_at[0] = time.time()
                    if dirty[0]:
                        try:
                            self.config.set("size_cache", sizes)
                            dirty[0] = False
                        except OSError as e:
                            decky.logger.warning("size cache save failed: %s", e)

        try:
            await asyncio.gather(*[fetch_one(app) for app in todo])
        except asyncio.CancelledError:
            try:
                self.config.set("size_cache", sizes)
            except OSError:
                pass
            raise

        try:
            self.config.set("size_cache", sizes)
        except OSError as e:
            decky.logger.warning("size cache save failed: %s", e)
        self._meta_done = True
        try:
            await decky.emit("library_patch", {}, 0)
        except Exception as e:
            decky.logger.warning("library_patch emit failed: %s", e)
        decky.logger.info("size fetch complete (%d games)", len(todo))

    #: A failed size lookup is retried after this long. Short enough to recover
    #: from a network blip, long enough not to re-fetch a 90 s manifest every
    #: time the panel opens.
    SIZE_FAIL_TTL = 6 * 3600

    async def _measure_install(self, app_name: str) -> int:
        """Bytes actually used by an installed game, via `du`.

        Manifest data is the preferred source, but some apps return no manifest
        at all (GOTY/bundle entries). For those, the folder on disk is the
        honest answer — and it is what "已占用" means anyway.
        """
        try:
            path = await self.legendary.get_install_dir(app_name)
        except Exception:
            return 0
        if not path or not os.path.isdir(path):
            return 0
        try:
            proc = await asyncio.create_subprocess_exec(
                "du", "-sb", path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=45.0)
        except (OSError, asyncio.TimeoutError):
            return 0
        try:
            return int(out.split()[0])
        except (IndexError, ValueError):
            return 0

    async def get_game_size(self, app_name: str):
        """On-demand size for one title, for the detail page."""
        sizes = self.config.get("size_cache") or {}
        if not isinstance(sizes, dict):
            sizes = {}
        cached = sizes.get(app_name)
        # 脏缓存自愈: 之前版本把残缺 manifest 的 4 字节写了进来,这里必须
        # 用 plausible_size 判定,否则一进详情页就直接返回那个假体积。
        if isinstance(cached, dict) and plausible_size(cached.get("disk")) > 0:
            return {"ok": True, "download": cached.get("download", 0), "disk": cached.get("disk", 0)}
        # Respect the failure window here too: without this, every open of the
        # detail page would block on two manifest timeouts (up to ~4 minutes).
        failed_at = int(cached.get("failed") or 0) if isinstance(cached, dict) else 0
        if failed_at and time.time() - failed_at < self.SIZE_FAIL_TTL:
            return {"ok": False, "unknown": True, "error": "没有可用的体积数据"}

        try:
            result = await self.legendary.game_size(app_name)
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:
            return {"ok": False, "error": str(e)}
        if not result:
            # No manifest (GOTY/bundle entries): fall back to what is on disk.
            disk = await self._measure_install(app_name)
            if disk:
                result = {"download": 0, "disk": disk, "measured": True}
                decky.logger.info("size %s: no manifest, measured %d bytes on disk", app_name, disk)
            else:
                # Remember the miss so the UI can say "未知" instead of showing
                # "读取中…" forever (see SIZE_FAIL_TTL).
                sizes[app_name] = {"failed": int(time.time())}
                try:
                    self.config.set("size_cache", sizes)
                except OSError:
                    pass
                return {"ok": False, "unknown": True, "error": "没有可用的体积数据"}

        sizes[app_name] = {
            "download": result["download"],
            "disk": result["disk"],
            "ts": int(time.time()),
        }
        try:
            self.config.set("size_cache", sizes)
        except OSError:
            pass
        await decky.emit("library_patch", {app_name: result}, 0)
        return {"ok": True, **result}

    # -- install / launch / uninstall ------------------------------------
    async def install(self, app_name: str, install_dir: str = ""):
        if app_name in self._install_tasks and not self._install_tasks[app_name].done():
            return {"ok": False, "error": "该游戏正在下载中"}
        # Fail before the UI shows "开始下载": otherwise the row flips from
        # starting to error ~0.1s later and the user cannot tell what happened.
        if self.legendary._resolve() is None:
            return {
                "ok": False,
                "error": "Legendary 未安装，请先在设置里点「一键安装 Legendary」",
            }

        # Per-game override wins over the global default set in Settings.
        target = (install_dir or "").strip() or (self.config.get("install_dir") or "").strip()
        if target:
            if not os.path.isdir(target):
                return {"ok": False, "error": "安装目录不存在: %s" % target}
            if not os.access(target, os.W_OK):
                return {"ok": False, "error": "安装目录不可写: %s" % target}
        else:
            # Nothing configured: use the same root the settings dropdown
            # advertises. Leaving it to Legendary's own default looked fine but
            # let the UI (which showed ~) drift away from the real target
            # (~/Games), and a missing default dir made the very first install
            # fail on a machine that had never run Legendary before.
            target, err = ensure_dir(default_games_dir())
            if err:
                return {"ok": False, "error": err}
            decky.logger.info("install %s: no dir configured, using %s", app_name, target)

        async def _run():
            try:
                await decky.emit("install_progress", app_name, "starting", 0.0, "")
                await self._install_streaming(app_name, target)
                await decky.emit("install_progress", app_name, "done", 100.0, "")
                if self.config.get("auto_add_to_steam") and await self._still_logged_in():
                    await self._add_to_steam(app_name, await self._installed_title(app_name))
            except asyncio.CancelledError:
                if app_name in self._pausing:
                    self._pausing.discard(app_name)
                    await decky.emit("install_progress", app_name, "paused", 0.0, "已暂停，可稍后继续")
                else:
                    await decky.emit("install_progress", app_name, "cancelled", 0.0, "")
                raise
            except Exception as e:
                decky.logger.error("install %s: %s", app_name, e)
                await decky.emit("install_progress", app_name, "error", 0.0, str(e))

        task = asyncio.create_task(_run())
        self._install_tasks[app_name] = task
        return {"ok": True, "install_dir": target}

    async def _still_logged_in(self) -> bool:
        """True when the account that started the download is still signed in.

        A logout (or account switch) in the middle of an install used to still
        end with a shortcut written under the *new* account's library, complete
        with the old account's title and cover.
        """
        try:
            status = await self.legendary.auth_status()
        except Exception as e:
            decky.logger.warning("install: auth re-check failed: %s", e)
            return False
        return bool(status.get("logged_in"))

    async def _install_streaming(self, app_name: str, install_dir: str):
        # Must go through _resolve(): the plugin ships its own legendary in
        # data/bin, which is never on PATH, so shutil.which() always returns
        # None here and every install would fail with "Legendary 未安装".
        exe = self.legendary._resolve()
        if exe is None:
            raise LegendaryNotFound("Legendary 未安装")

        cmd = [exe, "install", app_name, "-y"]
        if install_dir:
            cmd += ["--base-path", install_dir]
        # Optional download concurrency. 0 = Legendary's default. This is also
        # the plugin's coarse "speed limit": Legendary has no rate-limit flag,
        # so fewer workers is the only way to slow a download down.
        try:
            workers = int(self.config.get("max_workers") or 0)
        except (TypeError, ValueError):
            workers = 0
        if workers > 0:
            cmd += ["--max-workers", str(workers)]
        # Optional CDN override and plaintext toggle.
        cdn = (self.config.get("preferred_cdn") or "").strip()
        if cdn:
            cmd += ["--preferred-cdn", cdn]
        if self.config.get("no_https"):
            cmd += ["--no-https"]

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=self.legendary._env(),
            )
        except (OSError, PermissionError, FileNotFoundError) as e:
            raise LegendaryNotFound("无法启动 Legendary(%s): %s" % (exe, e))
        self._install_procs[app_name] = proc
        last_error = ""
        downloaded_bytes = None
        total_bytes = None
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                decoded = line.decode("utf-8", errors="replace").strip()
                if "error" in decoded.lower():
                    # Keep the most specific line legendary gave us: "Not
                    # enough free disk space" tells the user what to fix,
                    # "退出码 1" does not.
                    last_error = decoded
                # Classify the activity from the log line.
                state = self._classify_activity(decoded)
                if state == "progress":
                    info = self._parse_progress(decoded)
                    # The byte figures arrive on lines of their own; keep the
                    # latest value until it is overwritten by a newer line.
                    if info["downloaded_bytes"] is not None:
                        downloaded_bytes = info["downloaded_bytes"]
                    if info["total_bytes"] is not None:
                        total_bytes = info["total_bytes"]
                    await decky.emit(
                        "install_progress", app_name, "downloading",
                        info["percent"], decoded, info["speed"], info["eta"],
                        downloaded_bytes, total_bytes,
                    )
                elif state:
                    # Non-progress activity: verification, delta patching, etc.
                    await decky.emit(
                        "install_progress", app_name, state, -1.0, decoded, "", "",
                        downloaded_bytes, total_bytes,
                    )
                elif decoded:
                    # A non-Progress line may still carry the byte figures
                    # ("Downloaded: x MiB" or "Download size: y MiB").
                    info = self._parse_progress(decoded)
                    if info["downloaded_bytes"] is not None:
                        downloaded_bytes = info["downloaded_bytes"]
                    if info["total_bytes"] is not None:
                        total_bytes = info["total_bytes"]
                    await decky.emit(
                        "install_progress", app_name, "downloading", -1.0, decoded, "", "",
                        downloaded_bytes, total_bytes,
                    )
        finally:
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=10)
                except asyncio.TimeoutError:
                    proc.kill()
            await proc.wait()
            self._install_procs.pop(app_name, None)

        if proc.returncode != 0:
            detail = last_error.strip()
            raise LegendaryError(
                "安装失败 (退出码 %s)%s" % (proc.returncode, ": " + detail if detail else "")
            )

    @staticmethod
    def _classify_activity(line: str):
        """Map a legendary log line to an activity state (or '' for nothing)."""
        lower = line.lower()
        if "Progress:" in line:
            return "progress"
        if any(k in lower for k in ("verifying", "verification")):
            return "verifying"
        if any(k in lower for k in ("patching", "delta patch", "applying patch")):
            return "patching"
        if any(k in lower for k in ("prerequisite", "prereq", "setup")):
            return "prereq"
        return ""

    @staticmethod
    def _parse_progress(line: str):
        """Parse a Legendary `Progress:` line into a dict.

        Legendary prints two kinds of progress line:

          = Progress: 42.00% (123/456), Running for 00:00:12, ETA: 00:00:30
            - Downloaded: 123.45 MiB, Written: 120.00 MiB
            + Download - 12.34 MiB/s (raw) / 12.00 MiB/s (decompressed)

        The byte figures ("Downloaded"/"Written") land on a *separate* line
        from the percentage, so the caller accumulates them across lines. This
        parser returns the fields it can see on a single line; the caller keeps
        `downloaded_bytes` / `total_bytes` running until the next line updates
        them.
        """
        import re
        info = {"percent": -1.0, "speed": "", "eta": "",
                "downloaded_bytes": None, "total_bytes": None}
        m = re.search(r"Progress:\s*([\d.]+)%", line)
        if m:
            try:
                info["percent"] = float(m.group(1))
            except ValueError:
                info["percent"] = -1.0
        # "Progress: 42.00% (123/456)" — the (a/b) pair is chunk counts, not
        # bytes, so it is only useful when nothing better is available.
        m = re.search(r"\(\s*([\d.]+)\s*MiB\s*/\s*([\d.]+)\s*MiB\s*\)", line)
        if m:
            try:
                info["downloaded_bytes"] = float(m.group(1)) * 1024 * 1024
                info["total_bytes"] = float(m.group(2)) * 1024 * 1024
            except ValueError:
                pass
        m = re.search(r"Downloaded:\s*([\d.]+)\s*(MiB|GiB|KiB|B)", line)
        if m:
            info["downloaded_bytes"] = _parse_size(m.group(1), m.group(2))
        m = re.search(r"Download size:\s*([\d.]+)\s*(MiB|GiB|KiB|B)", line)
        if m:
            info["total_bytes"] = _parse_size(m.group(1), m.group(2))
        # Speed: newer Legendary prints "+ Download - 26.45 MiB/s (raw) / ..."
        # on its own line; older builds embedded it as ", 26.45 MiB/s," on the
        # Progress line. Match both.
        s = re.search(r"Download\s*-\s*([\d.]+\s*\w+/s)\s*\(raw\)", line)
        if s:
            info["speed"] = s.group(1)
        if not info["speed"]:
            s = re.search(r",\s*([\d.]+\s*\w+/s)\s*,", line)
            if s:
                info["speed"] = s.group(1)
        e = re.search(r"ETA:\s*([\d:]+)", line)
        if e:
            info["eta"] = e.group(1)
        return info

    async def launch(self, app_name: str, direct: bool = False):
        """Prepare a launch. By default Steam starts the game, not us.

        Steam has to be the one that spawns it: gamescope only switches the
        session when Steam believes a game is running. Starting the wrapper
        from this backend did launch the game — sound and all — but the screen
        stayed on the Steam UI, because nothing told the compositor to switch.
        So the normal path returns the shortcut's appid and the frontend calls
        `SteamClient.Apps.RunGame`, which is exactly what pressing play in the
        library does.

        `direct=True` keeps the old behaviour (run the wrapper ourselves) as a
        fallback for when that API is unavailable. The game works, it just does
        not take over the screen.
        """
        try:
            title = await self._installed_title(app_name) or app_name
            appid = self.steam_appid(app_name, title)
            wine = self._wine_wrapper(app_name, appid)
            script = await self._ensure_launcher_script(app_name, title)
            note = ""
            if wine and not os.path.isdir(os.path.join(proton.compatdata_dir(appid), "pfx")):
                note = "首次通过 Proton 启动要初始化兼容层，可能黑屏 1~2 分钟，请耐心等"

            if not direct:
                decky.logger.info("launch %s -> steam appid %s", app_name, appid)
                return {
                    "ok": True, "appid": appid, "via": "steam",
                    "note": note, "proton": bool(wine),
                }

            env = self._game_session_env(appid)
            proc = await asyncio.create_subprocess_exec(
                "/bin/bash", script,
                env=env,
                cwd=os.path.expanduser("~"),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                # Own session: closing the QAM or reloading the plugin must not
                # take the game down with it (same reason the shim forwards
                # signals itself).
                start_new_session=True,
            )
            # Reap it in the background so a finished game does not linger as a
            # zombie, but never block this callable on it.
            reaper = asyncio.ensure_future(self._reap(proc))
            self._launch_reapers.add(reaper)
            reaper.add_done_callback(self._launch_reapers.discard)
            decky.logger.info("launch %s direct via %s (pid=%s)", app_name, script,
                              getattr(proc, "pid", "?"))
            return {
                "ok": True, "appid": appid, "via": "direct",
                "note": note, "proton": bool(wine),
            }
        except (LegendaryError, OSError) as e:
            # Writing the Proton wrapper can fail on a full/read-only disk; that
            # used to escape the callable and leave the button dead.
            return {"ok": False, "error": str(e)}

    async def _reap(self, proc):
        try:
            await proc.wait()
        except Exception:
            pass

    def _game_session_env(self, appid: int) -> dict:
        """Environment for a game started from the plugin.

        Steam sets these when it launches the shortcut itself; a systemd child
        has none of them. Values come from the running Steam client when
        possible so Desktop Mode / Wayland sessions work too, with the Game Mode
        values as a fallback (that is what the login page already relies on).
        """
        env = os.environ.copy()
        uid = os.getuid()
        env.setdefault("DISPLAY", ":0")
        env.setdefault("XDG_RUNTIME_DIR", "/run/user/%d" % uid)
        env.setdefault("XDG_SESSION_TYPE", "x11")
        env.setdefault("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/%d/bus" % uid)
        for key, value in _steam_session_vars().items():
            env.setdefault(key, value)
        env["SteamAppId"] = str(appid)
        env["SteamGameId"] = str(appid)
        env["SteamDeck"] = "1"
        return env

    async def uninstall(self, app_name: str):
        try:
            await self.legendary.uninstall(app_name)
            return {"ok": True}
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}

    async def cancel_install(self, app_name: str, delete: bool = False):
        """Stop an install task.

        ``delete=False`` (pause) keeps the downloaded chunks and Legendary's
        ``.resume`` state, so a later ``install`` picks up where it left off —
        this is the "soft pause". ``delete=True`` additionally removes the
        partial download so a retry starts from scratch.
        """
        task = self._install_tasks.get(app_name)
        if task and not task.done():
            task.cancel()
        proc = self._install_procs.get(app_name)
        if proc is not None and proc.returncode is None:
            proc.terminate()
        if delete:
            await self._clear_partial_download(app_name)
        return {"ok": True}

    async def pause_install(self, app_name: str):
        """Soft-pause: stop the downloader but keep the partial state."""
        self._pausing.add(app_name)
        return await self.cancel_install(app_name, delete=False)

    async def resume_install(self, app_name: str, install_dir: str = ""):
        """Resume a paused download. Legendary reuses the on-disk chunks."""
        # Drop the paused marker so install() will accept a new task.
        self._install_tasks.pop(app_name, None)
        return await self.install(app_name, install_dir)

    async def _clear_partial_download(self, app_name: str):
        """Remove Legendary's partial-download state for a title.

        The game chunks live inside the install directory (not a central tmp
        dir), so clearing them means removing the half-written game folder.
        Legendary's own ``.resume`` file under ``<config>/tmp`` is what tracks
        which chunks are already there; delete both so a retry is a clean
        download rather than a resume.
        """
        try:
            record = self.legendary.installed_records().get(app_name) or {}
            install_path = (record.get("install_path") or "").strip()
            # Only delete the half-finished folder if Legendary knows about it;
            # otherwise the title never started downloading and there is
            # nothing to clear.
            if install_path and os.path.isdir(install_path):
                # A completed game also has an install_path. Never delete a
                # directory that looks like a finished install.
                done = record.get("version") and os.path.exists(
                    os.path.join(install_path, ".egstore")
                )
                if not done:
                    import shutil
                    shutil.rmtree(install_path, ignore_errors=True)
            # Remove the .resume file(s) that reference this app's chunks.
            tmp_dir = os.path.join(self.legendary.config_dir(), "tmp")
            if os.path.isdir(tmp_dir):
                for name in os.listdir(tmp_dir):
                    if name.endswith(".resume") and app_name[:12].lower() in name.lower():
                        try:
                            os.unlink(os.path.join(tmp_dir, name))
                        except OSError:
                            pass
        except Exception as e:
            decky.logger.warning("clear_partial_download %s: %s", app_name, e)

    async def clear_download_cache(self):
        """Remove Legendary's leftover tmp/.resume files (all titles).

        Safe to run when nothing is downloading: it only touches the ``tmp``
        dir where Legendary keeps resume state and partial manifests, never a
        game's actual files.
        """
        removed = 0
        try:
            tmp_dir = os.path.join(self.legendary.config_dir(), "tmp")
            if os.path.isdir(tmp_dir):
                for name in os.listdir(tmp_dir):
                    try:
                        os.unlink(os.path.join(tmp_dir, name))
                        removed += 1
                    except OSError:
                        pass
        except Exception as e:
            decky.logger.warning("clear_download_cache: %s", e)
            return {"ok": False, "error": str(e)}
        return {"ok": True, "removed": removed}

    # -- steam integration ------------------------------------------------
    def _proton_dir(self) -> str:
        """Where the per-game Proton wrappers live (next to the launchers)."""
        return os.path.join(os.path.dirname(self._launcher_dir()), "proton")

    def steam_appid(self, app_name: str, title: str = "") -> int:
        """appid of this game's shortcut, or the one it is about to get.

        An existing entry wins: its appid was fixed when it was written and the
        user may since have renamed the shortcut in Steam.
        """
        entry = self.steam.find_by_exe(self._launcher_script_path(app_name))
        if entry is not None:
            return entry.appid
        display = (title or "").strip() or app_name
        return appid_for(self._launcher_script_path(app_name), display)

    def _wine_wrapper(self, app_name: str, appid: int) -> str:
        """Path to a Proton wrapper for a Windows title, or "" when not needed.

        Linux-native titles keep using the plain launcher: handing them to
        Proton would only add a container (and a broken one).
        """
        try:
            if not proton.is_windows(self.legendary.installed_platform(app_name)):
                return ""
            if not self.config.get("use_proton", True):
                return ""
            binary = proton.choose_proton(self.config.get("proton_path", ""))
            if not binary:
                decky.logger.warning(
                    "%s is a Windows title but no Proton build was found", app_name
                )
                return ""
            path = os.path.join(self._proton_dir(), "%s.sh" % app_name)
            return proton.write_wrapper(path, appid, binary)
        except Exception as e:
            decky.logger.error("proton wrapper for %s failed: %s", app_name, e)
            return ""

    async def _ensure_image_cache(self):
        """Load Epic's per-game artwork URLs once per session."""
        if self._image_cache is not None:
            return
        try:
            self._image_cache = await self.legendary.key_images()
        except Exception as e:
            decky.logger.warning("artwork metadata unavailable: %s", e)
            self._image_cache = {}

    async def _apply_artwork(self, app_name: str, appid: int, overwrite: bool = False):
        """Download Epic's art into Steam's grid folder.

        Returns ``{"icon": path, "written": n}``: the icon path is what the
        shortcut's `icon` field should point at, and `written` tells callers
        whether anything actually changed on disk.
        """
        empty = {"icon": "", "written": 0}
        if not self.config.get("auto_cover", True) or not appid:
            return empty
        grid = self.steam.grid_dir()
        if not grid:
            decky.logger.warning("no Steam userdata dir; artwork skipped")
            return empty

        # Every slot already on disk: nothing to download, nothing to rewrite.
        # Only the missing ones are fetched below, so a resync is cheap.
        if not overwrite:
            existing = [
                artwork.find_existing(grid, appid, suffix) for suffix, _ in artwork.SLOTS
            ]
            if all(existing):
                return {"icon": existing[-1] or existing[0], "written": 0}

        await self._ensure_image_cache()
        images = (self._image_cache or {}).get(app_name) or {}
        if not images:
            return empty

        loop = asyncio.get_running_loop()
        try:
            result = await loop.run_in_executor(
                None, artwork.ensure_artwork, grid, appid, images, overwrite
            )
        except Exception as e:
            decky.logger.warning("artwork for %s failed: %s", app_name, e)
            return empty
        if result.get("written"):
            decky.logger.info(
                "artwork: %d file(s) for %s", len(result["written"]), app_name
            )
        return {"icon": result.get("icon") or "", "written": len(result.get("written") or [])}

    async def _add_to_steam(self, app_name: str, title: str = ""):
        display = (title or "").strip() or await self._installed_title(app_name) or app_name
        appid = self.steam_appid(app_name, display)
        # The wrapper has to exist before the shortcut does: Steam starts the
        # launcher script, and the script is what carries `--wine`.
        wine = self._wine_wrapper(app_name, appid)
        exe = self._write_launcher_script(
            app_name, title=display, wine=wine,
            lsfg=self._lsfg_enabled(app_name),
        )
        art = await self._apply_artwork(app_name, appid)
        icon = art.get("icon") or self._steam_icon()
        return self.steam.add_game(app_name, exe, title=display, icon=icon)

    def _steam_icon(self) -> str:
        """Absolute path to the icon Steam should show for our shortcuts.

        Without one, Steam falls back to extracting the icon out of the target
        executable — and our target is a shell script, which has none. That
        extraction runs while the non-Steam page renders, so a real image file
        keeps that page snappy and gives the entries a recognisable icon.
        """
        try:
            base = (
                getattr(decky, "DECKY_PLUGIN_DIR", "")
                or os.path.dirname(os.path.abspath(__file__))
            )
            path = os.path.join(base, "assets", "icon.png")
            return path if os.path.isfile(path) else ""
        except Exception:
            return ""

    async def _installed_title(self, app_name: str) -> str:
        """Title to show in Steam's library for an installed game."""
        try:
            for item in await self.legendary.list_installed():
                if item.get("app_name") == app_name:
                    return item.get("title") or ""
        except LegendaryError:
            pass
        return ""

    async def sync_installed_to_steam(self, app_name: str = ""):
        """Register installed Epic games as non-Steam shortcuts.

        Writes into Steam's own shortcuts.vdf, i.e. the exact same place the
        "Add a Non-Steam Game" dialog writes, so the entries show up under
        the library's non-Steam filter. Steam only reads that file at startup,
        hence the reminder in the response.
        """
        try:
            if app_name:
                targets = [
                    {"app_name": app_name, "title": await self._installed_title(app_name)}
                ]
            else:
                targets = await self.legendary.list_installed()
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}

        if not targets:
            return {"ok": True, "added": 0, "failed": [], "note": "没有已安装的 Epic 游戏"}

        added, failed = 0, []
        for item in targets:
            name = item.get("app_name") or ""
            if not name:
                continue
            try:
                await self._add_to_steam(name, item.get("title") or "")
                added += 1
            except Exception as e:
                decky.logger.error("sync_to_steam %s: %s", name, e)
                failed.append({"title": item.get("title") or name, "error": str(e)})

        decky.logger.info("sync_to_steam: %d added, %d failed", added, len(failed))
        return {
            "ok": True,
            "added": added,
            "failed": failed,
            "note": "重启 Steam 后才会出现在库中（库 → 非 Steam 游戏）",
        }

    def _runtime_dir(self):
        """Writable per-plugin data dir (``~/homebrew/data/<Name>``).

        Everything Steam points at lives here rather than in the plugin dir:
        Decky's uninstall only removes ``plugins/<Name>``, so anything kept
        here keeps working after the plugin is gone (see HANDOFF 14). The
        resolution itself lives in `paths.runtime_dir()` because the legendary
        installer needs the exact same answer.
        """
        return runtime_dir()

    def _launcher_dir(self):
        return os.path.join(self._runtime_dir(), "launchers")

    def _launcher_script_path(self, app_name: str) -> str:
        """Path of the wrapper Steam launches for this game.

        `_write_launcher_script` uses the same name, so this doubles as the
        stable key when looking a shortcut up in shortcuts.vdf.
        """
        return os.path.join(self._launcher_dir(), "%s.sh" % app_name)

    def _launch_helper_path(self):
        """Path of the launch shim inside the runtime dir.

        Deliberately *not* the copy under the plugin directory: Steam's
        launcher scripts outlive an uninstall, and a missing shim makes them
        fall back to the single-stage launch (no playtime, no exit code, no
        hook for cloud saves). `_stage_launch_helper()` keeps this file fresh.
        """
        return os.path.join(self._runtime_dir(), "bin", "launchshim.py")

    def _stage_launch_helper(self) -> str:
        """Copy the bundled shim next to the runtime dir, return the path.

        Rewritten only when the bytes differ, so a plugin update picks up the
        new shim without touching the file on every launch.

        There is deliberately no in-memory cache: the content comparison
        already makes a repeat call a single 11 KB read, and a cached path
        would go stale if the staged file is deleted underneath us.
        """
        source = os.path.join(_PLUGIN_DIR, "py_modules", "launchshim.py")
        target = self._launch_helper_path()
        # Per-pid name: a plugin reload can have the old and the new instance
        # writing at the same time, and they would otherwise share one temp file.
        tmp = "%s.%d.part" % (target, os.getpid())
        try:
            with open(source, "rb") as fh:
                data = fh.read()
            try:
                with open(target, "rb") as fh:
                    if fh.read() == data:
                        return target
            except OSError:
                pass
            os.makedirs(os.path.dirname(target), exist_ok=True)
            try:
                with open(tmp, "wb") as fh:
                    fh.write(data)
                    # os.replace() is atomic but says nothing about the bytes
                    # reaching the disk. Without the flush a power cut can
                    # leave a zero-length shim behind — python "runs" it fine
                    # (exit 0), so Steam would believe the game started and
                    # quit immediately, with nothing in the log to explain it.
                    fh.flush()
                    os.fsync(fh.fileno())
                written = os.path.getsize(tmp)
                if written != len(data):
                    raise OSError("short write: %d of %d bytes" % (written, len(data)))
                os.replace(tmp, target)
            finally:
                # A crash between write and replace must not litter the bin dir.
                if os.path.isfile(tmp):
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
            return target
        except OSError as e:
            # A stale-but-present shim beats no shim: the launcher script tests
            # `-f` at run time and silently degrades to the single-stage launch
            # when it is missing (no playtime, no exit code, nothing in the log).
            if os.path.isfile(target):
                decky.logger.warning(
                    "launch shim not refreshed (%s), keeping the staged copy", e
                )
                return target
            decky.logger.warning(
                "launch shim missing (%s), falling back to the bundled path", e
            )
            return source

    def _launch_log_path(self, app_name: str) -> str:
        return os.path.join(
            self._runtime_dir(), "logs", "launch-%s.log" % app_name
        )

    def _write_launcher_script(self, app_name: str, exe: str = None,
                               title: str = "", wine: str = "",
                               lsfg: bool = False) -> str:
        """(Re)write the wrapper Steam points at for this game.

        Four things go in here:
          * a POSIX locale derived from Steam's language, because Game Mode
            exports no LANG and Legendary would otherwise launch every game
            in English;
          * the user's per-game arguments (or the ones Heroic left in
            Legendary's own config.ini);
          * `--wine <proton wrapper>` for Windows titles, because SteamOS has
            no wine (see py_modules/proton.py);
          * `"$@"`, so whatever the user types into Steam's "launch options"
            box is appended to the game command line;
          * when `lsfg` is set, the final launch is wrapped in `~/lsfg` so the
            Decky LSFG-VK frame-gen layer kicks in. This must be the
            *outermost* layer (`~/lsfg` -> shim -> legendary -> proton -> game)
            because `LSFG_PROCESS` is an env var that has to be inherited all
            the way down. We call the user's `~/lsfg` script rather than
            hardcoding its env vars: the plugin regenerates that script when
            the user changes their profile, so calling it is the only way to
            stay in sync.
        """
        if exe is None:
            exe = self.legendary._resolve()
        if exe is None:
            raise LegendaryNotFound("Legendary 未安装")
        exe = _posix_path(exe)

        locale = steam_posix_locale()
        extra = self._own_launch_args(app_name)
        extra_shell = ""
        if extra:
            extra_shell = " " + " ".join(shlex.quote(a) for a in shlex.split(extra))

        wine_shell = " --wine %s" % shlex.quote(wine) if wine else ""

        # Two-stage launch: `legendary launch` returns as soon as the game is
        # spawned, so Steam (which is watching this script) thinks the game
        # stopped immediately and never counts playtime. The shim asks
        # legendary for the `--json` launch plan, starts the game itself and
        # waits for it. Everything it needs is written in here, because the
        # script runs outside the plugin process.
        helper = _posix_path(self._stage_launch_helper())
        helper_shell = "--legendary %s --app %s" % (
            shlex.quote(exe), shlex.quote(app_name),
        )
        if wine:
            helper_shell += " --wine %s" % shlex.quote(_posix_path(wine))
        helper_shell += " --log %s" % shlex.quote(_posix_path(self._launch_log_path(app_name)))

        # The shim command and the plain-launch fallback both get wrapped in
        # `~/lsfg` when frame-gen is on. We write the wrapper as a *function*
        # `launch()` so an empty `LSFG` (plugin installed after the toggle was
        # set, or removed later) degrades to a direct launch instead of bash
        # trying to run `""` as a command. The function is only defined when
        # lsfg is requested; otherwise the script stays byte-for-byte plain.
        # When it does wrap, it appends one line to the same log file the shim
        # writes, so "is LSFG active?" is answerable from the launch log
        # instead of only by inspecting the script.
        lsfg_prologue = ""
        lsfg_prefix = ""
        if lsfg:
            lsfg_log = shlex.quote(_posix_path(self._launch_log_path(app_name)))
            lsfg_prologue = (
                '# Decky LSFG-VK frame-gen wrapper: `~/lsfg` sets the env and\n'
                '# execs its argument. It is the OUTERMOST layer so LSFG_PROCESS\n'
                '# is inherited all the way into the game. Guarded against the\n'
                '# plugin being absent: then LSFG is empty and launch() runs the\n'
                '# command directly.\n'
                'if [ -x "$HOME/lsfg" ]; then\n'
                '  LSFG="$HOME/lsfg"\n'
                'else\n'
                '  LSFG=""\n'
                'fi\n'
                'launch() {\n'
                '  if [ -n "$LSFG" ]; then\n'
                f'    echo "$(date \'+%F %T\') [lsfg] wrapping launch via $LSFG" >> {lsfg_log}\n'
                '    "$LSFG" "$@"\n'
                '  else\n'
                '    "$@"\n'
                '  fi\n'
                '}\n'
            )
            lsfg_prefix = 'launch '

        script_dir = self._launcher_dir()
        os.makedirs(script_dir, exist_ok=True)
        script = os.path.join(script_dir, f"{app_name}.sh")
        content = (
            "#!/bin/bash\n"
            "# Generated by EpicDeck, rewritten whenever launch options change.\n"
            f'export LANG="{locale}"\n'
            f'export LC_ALL="{locale}"\n'
            # Quoted, not just wrapped in double quotes: a path containing `$`
            # or a backtick would otherwise be expanded by bash at run time.
            f'EPICDECK_SHIM={shlex.quote(helper)}\n'
            + lsfg_prologue +
            'for EPICDECK_PY in /usr/bin/python3 /usr/bin/python3.11 /usr/bin/python; do\n'
            '  if [ -x "$EPICDECK_PY" ] && [ -f "$EPICDECK_SHIM" ]; then\n'
            f'    {lsfg_prefix}"$EPICDECK_PY" "$EPICDECK_SHIM" {helper_shell} --{extra_shell} "$@"\n'
            '    EPICDECK_RC=$?\n'
            '    # 90 means the shim never started a game; fall through to the plain\n'
            '    # launch below instead of leaving the user with a dead entry.\n'
            '    [ "$EPICDECK_RC" -eq 90 ] || exit "$EPICDECK_RC"\n'
            '    break\n'
            '  fi\n'
            'done\n'
            f'{lsfg_prefix}exec {shlex.quote(exe)} launch{wine_shell} {shlex.quote(app_name)}'
            f'{extra_shell} "$@"\n'
        )
        with open(script, "w", encoding="utf-8") as f:
            f.write(content)
        os.chmod(script, 0o755)
        return script

    async def _ensure_launcher_script(self, app_name: str, title: str = ""):
        # Let _write_launcher_script resolve the binary itself: it prefers the
        # bundled copy in data/bin, while shutil.which() only sees PATH and may
        # pick up an unrelated system-wide legendary.
        appid = self.steam_appid(app_name, title)
        return self._write_launcher_script(
            app_name, title=title, wine=self._wine_wrapper(app_name, appid),
            lsfg=self._lsfg_enabled(app_name),
        )

    def _sync_launcher_scripts(self):
        """Refresh wrappers created by older versions.

        Two things changed since those were written: the locale/args handling,
        and the Proton wrapper for Windows titles. Both are idempotent, so a
        rewrite on every load is the cheapest way to keep them honest.
        """
        try:
            entries = self.steam.list_shortcuts()
        except Exception as e:
            decky.logger.warning("launcher sync skipped: %s", e)
            return
        launchers = os.path.realpath(self._launcher_dir())
        for entry in entries:
            try:
                if os.path.realpath(os.path.dirname(entry.exe)) != launchers:
                    continue
                app_name = os.path.splitext(os.path.basename(entry.exe))[0]
                wine = self._wine_wrapper(app_name, entry.appid)
                self._write_launcher_script(
                    app_name, title=entry.app_name, wine=wine,
                    lsfg=self._lsfg_enabled(app_name),
                )
                decky.logger.info(
                    "launcher refreshed for %s (proton=%s)", app_name, bool(wine)
                )
            except Exception as e:
                decky.logger.warning("launcher refresh failed for %s: %s", entry.exe, e)

        try:
            patched = self.steam.backfill_icons(launchers, self._steam_icon())
            if patched:
                decky.logger.info("shortcut icon backfilled for %d entry(ies)", patched)
        except Exception as e:
            decky.logger.warning("icon backfill skipped: %s", e)

    # -- launch options ---------------------------------------------------
    def _legendary_ini_args(self, app_name: str) -> str:
        """Per-game args stored in Legendary's own config.ini (Heroic writes these)."""
        env = os.environ.get("LEGENDARY_CONFIG_PATH")
        base = env or os.path.join(os.path.expanduser("~"), ".config", "legendary")
        path = os.path.join(base, "config.ini")
        if not os.path.isfile(path):
            return ""
        parser = configparser.RawConfigParser(strict=False)
        try:
            parser.read(path, encoding="utf-8")
        except (OSError, configparser.Error):
            return ""
        if not parser.has_section(app_name):
            return ""
        for key in ("args", "game_args"):
            if parser.has_option(app_name, key):
                return (parser.get(app_name, key) or "").strip()
        return ""

    def _own_launch_args(self, app_name: str) -> str:
        """Arguments the user set in this plugin (what we actually pass along)."""
        stored = self.config.get("launch_args") or {}
        if isinstance(stored, dict):
            value = stored.get(app_name)
            if isinstance(value, str):
                return value.strip()
        return ""

    def _lsfg_enabled(self, app_name: str) -> bool:
        """Whether this game should be wrapped in `~/lsfg` (Decky LSFG-VK).

        Per-game override wins over the global default; an absent key means
        "follow the default", so the user can turn it on for one game without
        a tri-state toggle. `~/lsfg` only exists when that plugin is installed,
        so the generated script guards with `[ -x "$HOME/lsfg" ]` and the
        wrapper is a no-op otherwise.
        """
        per_game = self.config.get("lsfg") or {}
        if isinstance(per_game, dict) and app_name in per_game:
            return bool(per_game.get(app_name))
        return bool(self.config.get("lsfg_default", False))

    def _effective_launch_args(self, app_name: str) -> str:
        """What to show in the UI: our own value, else Legendary's config.ini.

        Only `_own_launch_args` is passed on the command line — Legendary
        already applies the args from its own config.ini by itself, and
        passing them twice would duplicate every flag.
        """
        stored = self.config.get("launch_args") or {}
        if isinstance(stored, dict) and app_name in stored:
            return self._own_launch_args(app_name)
        return self._legendary_ini_args(app_name)

    async def get_launch_args(self, app_name: str):
        stored = self.config.get("launch_args") or {}
        has_own = isinstance(stored, dict) and app_name in stored
        return {
            "ok": True,
            "args": self._effective_launch_args(app_name),
            "own": has_own,
            "from_legendary": not has_own and bool(self._legendary_ini_args(app_name)),
        }

    async def set_launch_args(self, app_name: str, args: str):
        stored = self.config.get("launch_args") or {}
        if not isinstance(stored, dict):
            stored = {}
        stored[app_name] = (args or "").strip()
        try:
            self.config.set("launch_args", stored)
        except OSError as e:
            return {"ok": False, "error": "保存失败: %s" % e}

        # Keep the Steam wrapper in sync so the next launch uses the new args.
        try:
            await self._ensure_launcher_script(app_name)
        except Exception as e:
            decky.logger.warning("launcher rewrite failed for %s: %s", app_name, e)
            return {"ok": True, "args": stored[app_name], "warning": str(e)}
        return {"ok": True, "args": stored[app_name]}

    async def get_lsfg(self, app_name: str = ""):
        """LSFG-VK frame-gen state: global default + per-game override."""
        per_game = self.config.get("lsfg") or {}
        has_own = isinstance(per_game, dict) and app_name in per_game
        # Whether `~/lsfg` exists on this machine at all (the Decky LSFG-VK
        # plugin creates it); the frontend hides the toggle when it is absent.
        lsfg_available = os.path.isfile(os.path.expanduser("~/lsfg"))
        return {
            "ok": True,
            "available": lsfg_available,
            "default": bool(self.config.get("lsfg_default", False)),
            "enabled": self._lsfg_enabled(app_name) if app_name else False,
            "own": has_own,
        }

    async def set_lsfg(self, app_name: str, enabled: bool):
        """Set the per-game LSFG override (empty app_name = the global default)."""
        if not app_name:
            self.config.set("lsfg_default", bool(enabled))
        else:
            per_game = self.config.get("lsfg") or {}
            if not isinstance(per_game, dict):
                per_game = {}
            per_game[app_name] = bool(enabled)
            self.config.set("lsfg", per_game)

        # Rewrite the launcher script(s) so the change takes effect on the
        # next launch. Empty app_name = flip every game's script.
        try:
            if app_name:
                await self._ensure_launcher_script(app_name)
            else:
                self._sync_launcher_scripts()
        except Exception as e:
            decky.logger.warning("launcher rewrite failed for lsfg: %s", e)
            return {"ok": True, "warning": str(e)}
        return {"ok": True, "enabled": bool(enabled)}

    async def add_to_steam(self, app_name: str):
        try:
            appid = await self._add_to_steam(app_name, await self._installed_title(app_name))
            return {"ok": True, "appid": appid}
        except (SteamError, LegendaryError) as e:
            return {"ok": False, "error": str(e)}
        except OSError as e:
            # Disk full / read-only mount / a file squatting on launchers: an
            # escaping OSError rejects the Decky call, the UI's `finally` never
            # runs and the button stays on "正在添加…" forever.
            decky.logger.error("add_to_steam %s: %s", app_name, e)
            return {"ok": False, "error": "写入失败: %s" % e}

    async def remove_from_steam(self, app_name: str):
        try:
            removed = self.steam.remove_by_exe(self._launcher_script_path(app_name))
        except (SteamError, OSError) as e:
            return {"ok": False, "error": str(e)}
        if not removed:
            # Nothing matched (already gone, or the user rewrote Exe). Reporting
            # ok made the UI flip to "未在 Steam 中" while the shortcut stayed.
            return {"ok": False, "error": "没有找到这个游戏的 Steam 快捷方式"}
        return {"ok": True}

    async def is_in_steam(self, app_name: str):
        return {
            "in_steam": self.steam.find_by_exe(self._launcher_script_path(app_name)) is not None
        }

    async def refresh_steam(self):
        try:
            restart_steam()
            return {"ok": True, "note": "Steam 正在重启以刷新游戏库"}
        except SteamError as e:
            return {"ok": False, "error": str(e)}

    async def launch_steam_game(self, app_name: str):
        entry = self.steam.find_by_exe(self._launcher_script_path(app_name))
        if not entry:
            return {"ok": False, "error": "该游戏尚未添加到 Steam"}
        try:
            open_steam_protocol(f"steam://rungameid/{entry.appid}")
            return {"ok": True}
        except SteamError as e:
            return {"ok": False, "error": str(e)}

    # -- proton / artwork --------------------------------------------------
    async def get_proton_options(self):
        """Proton builds available on this device, for the settings dropdown."""
        try:
            builds = proton.find_protons()
        except Exception as e:
            decky.logger.warning("proton scan failed: %s", e)
            builds = []
        auto_label = (
            "自动（%s）" % builds[0]["name"] if builds else "自动（未找到 Proton）"
        )
        options = [{"data": "", "label": auto_label}]
        options += [{"data": b["path"], "label": b["name"]} for b in builds]
        return {
            "ok": True,
            "options": options,
            "current": (self.config.get("proton_path") or "").strip(),
            "found": len(builds),
        }

    async def refresh_artwork(self, app_name: str = ""):
        """Fill in missing cover art for games that are already in Steam.

        Only missing slots are downloaded, so this is safe to run again after
        adding games or after a Steam update cleared the cache.
        """
        try:
            entries = self.steam.list_shortcuts()
        except SteamError as e:
            return {"ok": False, "error": str(e)}

        launchers = os.path.realpath(self._launcher_dir())
        targets = []
        for entry in entries:
            try:
                if os.path.realpath(os.path.dirname(entry.exe)) != launchers:
                    continue
            except Exception:
                continue
            name = os.path.splitext(os.path.basename(entry.exe))[0]
            if app_name and name != app_name:
                continue
            targets.append((name, entry))
        if not targets:
            return {
                "ok": True,
                "updated": 0,
                "note": "Steam 里还没有 Epic 游戏，先添加一个再来",
            }

        await self._ensure_image_cache()
        icons = {}
        updated = 0
        for name, entry in targets:
            art = await self._apply_artwork(name, entry.appid)
            if art.get("written"):
                updated += 1
            if art.get("icon"):
                icons[entry.appid] = art["icon"]

        # One write for all icons: 20 shortcuts should not mean 20 rewrites of
        # shortcuts.vdf (each one takes a backup and re-parses the file).
        changed = 0
        if icons:
            try:
                changed = self.steam.set_icons(icons)
            except SteamError as e:
                decky.logger.warning("icon update failed: %s", e)

        return {
            "ok": True,
            "updated": updated,
            "icons": changed,
            "total": len(targets),
            "note": "重启 Steam 后封面才会显示" if updated else "封面都已齐全",
        }

    # -- settings ---------------------------------------------------------
    async def get_settings(self):
        return dict(self.config._data)

    async def set_setting(self, key: str, value):
        self.config.set(key, value)
        return {"ok": True}

    # -- interface language (HANDOFF 7.13.0a) ------------------------------
    async def get_ui_language(self):
        """Which language the UI should use.

        Game Mode has no `LANG`, so Steam's own setting (`registry.vdf`) is the
        only signal; the user can override it explicitly in Settings. Returning
        both lets the settings row show what "follow Steam" resolved to.
        """
        try:
            from py_modules.epic_api import _steam_language
        except Exception:
            _steam_language = lambda: ""  # noqa: E731

        steam = ""
        try:
            steam = str(_steam_language() or "")
        except Exception:
            steam = ""

        setting = str(self.config.get("ui_language", "auto") or "auto")
        if setting in ("zh", "en"):
            return {"ok": True, "lang": setting, "steam": steam, "source": "setting"}

        lang = "zh" if steam.startswith(("schinese", "tchinese", "zh")) else ("en" if steam else "zh")
        return {"ok": True, "lang": lang, "steam": steam, "source": "steam"}

    # -- update check (HANDOFF 7.13.5) -------------------------------------
    async def check_update(self, force: bool = False):
        """Compare the running version with the newest GitHub release.

        Never raises and never blocks the UI: on a bad connection the answer is
        simply `ok: False` with the previous known version, and the settings row
        shows nothing new. One lookup a day unless `force`.
        """
        from py_modules import update_check

        plugin_dir = getattr(
            decky, "DECKY_PLUGIN_DIR", os.path.dirname(os.path.abspath(__file__))
        )
        current = update_check.current_version(plugin_dir)
        cache = self.config.get("update_check") or {}
        if not isinstance(cache, dict):
            cache = {}
        loop = asyncio.get_running_loop()
        try:
            result = await loop.run_in_executor(
                None, lambda: update_check.check(current, cache, force)
            )
        except Exception as exc:  # noqa: BLE001 - a version check must never break the panel
            decky.logger.warning("update check failed: %s", exc)
            return {"ok": False, "reason": str(exc)[:160], "current": current}
        if cache.get("ts"):
            self.config.set("update_check", cache)
        return result

    async def open_url(self, url: str):
        """Open a release/changelog link in Steam's browser.

        Game Mode has no other browser, and `window.open` inside the plugin's
        hidden window does nothing. Restricted to http(s) so a bad value cannot
        turn into `file://` or a shell-looking scheme.
        """
        target = str(url or "").strip()
        if not target.lower().startswith(("http://", "https://")):
            return {"ok": False, "error": "只支持 http(s) 链接"}
        opened = await self._open_in_steam(target)
        return {"ok": opened, "error": "" if opened else "无法打开浏览器"}

    # -- ProtonDB tier (HANDOFF 7.13.2) ------------------------------------
    def _protondb_title(self, app_name: str) -> str:
        """Title to search Steam with: English first, since the store's own
        search matches localised names anyway and English survives them best."""
        cache = self.config.get("title_cache") or {}
        if isinstance(cache, dict):
            for locale in ("en-US", "en", "en-GB"):
                titles = cache.get(locale)
                if isinstance(titles, dict):
                    title = titles.get(app_name)
                    if isinstance(title, str) and title.strip():
                        return title.strip()
        title = self._title_for(app_name)
        if title:
            return title
        # The title cache only holds locales that were fetched; a game added by a
        # background refresh can be missing from it. The library snapshot always
        # has the title that is on screen.
        for row in getattr(self, "_lib_cache", None) or []:
            if isinstance(row, dict) and row.get("app_name") == app_name:
                fallback = str(row.get("title") or "").strip()
                if fallback:
                    return fallback
        return app_name

    # -- cloud saves (HANDOFF 7.13.3) --------------------------------------
    async def get_cloud_saves(self, app_name: str):
        """Does this title use Epic cloud saves, and where do they live?"""
        try:
            info = await self.legendary.cloud_save_info(app_name)
        except Exception as exc:  # noqa: BLE001 - reading a flag must never break the page
            return {"ok": False, "error": str(exc)[:160]}
        return {"ok": True, **info}

    async def sync_cloud_saves(self, app_name: str, mode: str = "sync"):
        """Manual cloud-save sync. Deliberately *not* hooked into launch.

        Auto-syncing on every launch would add minutes on a bad connection and
        can overwrite newer local saves; the user asks for it explicitly here.
        """
        if mode not in ("sync", "upload", "download"):
            return {"ok": False, "error": "无效的同步方向"}
        try:
            output = await self.legendary.sync_saves(app_name, mode)
        except LegendaryError as exc:
            return {"ok": False, "error": str(exc)[:400]}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)[:400]}
        return {"ok": True, "output": output[-2000:]}

    #: How long a *failed* ProtonDB lookup suppresses retries. The Steam store
    #: endpoint takes ~12 s to time out on a blocked network, and retrying it on
    #: every detail-page open would keep a pointless request in flight forever.
    PROTONDB_FAIL_TTL = 3600

    async def get_protondb(self, app_name: str, force: bool = False):
        """ProtonDB tier for one game (detail page). Cached 7 days."""
        from py_modules import protondb

        cache = self.config.get("protondb") or {}
        if not isinstance(cache, dict):
            cache = {}
        entry = cache.get(app_name) if isinstance(cache.get(app_name), dict) else None

        # Recent failure and no tier yet: stay quiet instead of hammering the API.
        if (
            not force
            and isinstance(entry, dict)
            and not entry.get("tier")
            and time.time() - float(entry.get("failed_ts") or 0) < self.PROTONDB_FAIL_TTL
        ):
            return {"ok": False, "reason": "recent failure", "title": self._protondb_title(app_name)}
        overrides = self.config.get("protondb_appid") or {}
        try:
            override = int(overrides.get(app_name) or 0) if isinstance(overrides, dict) else 0
        except (TypeError, ValueError):
            override = 0

        title = self._protondb_title(app_name)
        # A 32-character app_name is not a searchable title: skip the network
        # entirely instead of asking Steam about a hash.
        if title == app_name and len(app_name) >= 24:
            return {"ok": False, "reason": "no display title", "title": title}
        loop = asyncio.get_running_loop()
        try:
            result = await loop.run_in_executor(
                None, lambda: protondb.lookup(title, entry, override, force)
            )
        except Exception as exc:  # noqa: BLE001
            decky.logger.warning("protondb lookup failed for %s: %s", app_name, exc)
            return {"ok": False, "reason": str(exc)[:160], "title": title}

        if not result.get("ok"):
            # Keep the reason in the log: "no tier" alone is undiagnosable.
            decky.logger.info(
                "protondb %s: %s%s (title=%r)",
                app_name,
                result.get("reason"),
                (" (" + str(result.get("detail")) + ")") if result.get("detail") else "",
                title,
            )
        if result.get("ok") and not result.get("cached"):
            cache[app_name] = {
                key: result.get(key)
                for key in ("appid", "tier", "label", "total", "ts", "matched",
                            "score", "best_tier", "report_confidence")
            }
            self.config.set("protondb", cache)
        elif not result.get("ok"):
            # Remember the miss for an hour (see PROTONDB_FAIL_TTL). Never
            # overwrite a known-good entry with a failure.
            if not isinstance(cache.get(app_name), dict) or not cache[app_name].get("tier"):
                cache[app_name] = {"failed_ts": int(time.time())}
                self.config.set("protondb", cache)
        result["title"] = title
        return result

    async def get_protondb_cached(self, app_names=None):
        """Cached tiers only — no network. Used for library badges, where 138
        lookups would be absurd; the detail page fills the cache lazily."""
        cache = self.config.get("protondb") or {}
        if not isinstance(cache, dict):
            cache = {}
        wanted = app_names if isinstance(app_names, (list, tuple)) else list(cache.keys())
        out = {}
        for name in wanted:
            entry = cache.get(name)
            if isinstance(entry, dict) and entry.get("tier"):
                out[name] = {
                    "tier": entry.get("tier"),
                    "label": entry.get("label") or "",
                    "total": entry.get("total") or 0,
                    "appid": entry.get("appid") or 0,
                }
        return out

    async def get_install_dir_options(self):
        """Install roots the user can pick from, annotated with free space.

        The first entry is the *real* default (``~/Games`` unless Legendary's
        config.ini says otherwise) rather than the home directory, so the
        selected default is also the path that ends up on the install command
        line. `current` never comes back empty for the same reason.

        The same SD card can be reachable through several paths
        (`/run/media/<label>`, `/run/media/<user>/<label>`, symlinked mounts),
        so candidates are normalised with realpath and de-duplicated, and only
        real mount points are offered — a plain directory like /run/media/deck
        is not somewhere you want games installed.
        """
        home = os.path.expanduser("~")
        default_dir = os.path.realpath(default_games_dir())

        mount_points = []
        try:
            with open("/proc/mounts", "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) < 2:
                        continue
                    mp = parts[1].replace("\\040", " ")
                    if mp.startswith(("/run/media/", "/media/")):
                        mount_points.append(mp)
        except OSError:
            mount_points = []

        seen = set()
        options = []
        for path, is_default in [(default_dir, True)] + [(mp, False) for mp in mount_points]:
            real = os.path.realpath(path)
            if real in seen:
                continue
            if not is_default and not os.path.ismount(path) and not os.path.ismount(real):
                continue
            seen.add(real)

            free = free_bytes(real)
            free_label = pretty_free(free)

            if not is_default:
                label = "%s · %s" % (os.path.basename(real.rstrip("/")), free_label)
            elif real == os.path.realpath(home) or real.startswith(os.path.realpath(home) + os.sep):
                label = "内置存储 · " + free_label
            else:
                label = "默认位置 · " + free_label
            options.append({"path": real, "label": label, "free": free, "is_default": is_default})

        options.sort(key=lambda o: (not o["is_default"], o["path"]))
        return {"options": options, "current": (self.config.get("install_dir") or "").strip() or default_dir}

    async def resolve_install_dir(self, path: str = ""):
        """Validate a hand-typed install path and create it if missing.

        Called from the UI before saving, so a typo is reported here instead of
        failing later with a half-finished download.
        """
        resolved, err = ensure_dir((path or "").strip() or default_games_dir())
        if err:
            return {"ok": False, "error": err}
        return {"ok": True, "path": resolved, "free": free_bytes(resolved)}

    async def complete_first_run(self, install_dir: str = ""):
        """Persist the folder chosen in the first-run prompt.

        An empty string means "just use the default", and the resolved default
        is written to config anyway: that way a later edit of Legendary's own
        config.ini can never silently relocate an existing library.
        """
        resolved, err = ensure_dir((install_dir or "").strip() or default_games_dir())
        if err:
            return {"ok": False, "error": err}
        self.config.update({"install_dir": resolved, "first_run_done": True})
        decky.logger.info("first run: install dir set to %s", resolved)
        return {"ok": True, "install_dir": resolved}

    # -- environment ------------------------------------------------------
    async def check_environment(self):
        """Report the runtime environment so the frontend can guide the user."""
        try:
            resolved = self.legendary._resolve()
        except Exception as e:
            decky.logger.error("check_environment: %s", e)
            resolved = None
        try:
            proton_bin = proton.choose_proton(self.config.get("proton_path", ""))
        except Exception:
            proton_bin = ""
        return {
            "legendary_installed": resolved is not None,
            "legendary_path": resolved or "",
            "proton_path": proton_bin,
            "proton_installed": bool(proton_bin),
            "use_proton": bool(self.config.get("use_proton", True)),
        }

    async def data_locations(self):
        """The main directories this plugin owns or reads, for the settings page.

        Not exhaustive — Steam's own userdata/grid is left out on purpose — but
        it covers what a user needs to find their games, back something up, or
        clean up after an uninstall (HANDOFF 14).
        """
        try:
            # A hand-edited epicdeck.json can hold a number or an object here;
            # str() keeps that from turning the whole callable into a rejection.
            raw = str(self.config.get("install_dir") or "").strip()
            games = expand_path(raw) or default_games_dir()
            runtime = self._runtime_dir()
            settings = getattr(self, "_settings_dir", "")
            logs = os.path.join(getattr(decky, "HOME", os.path.expanduser("~")), "epicdeck_logs")
            saves = os.path.join(proton.steam_root(), "steamapps", "compatdata")
            epic = self.legendary.config_dir()
        except Exception as e:
            # This is a read-only info panel; failing it must not look like the
            # backend is broken.
            decky.logger.warning("data_locations: %s", e)
            return {"ok": False, "items": []}
        items = [
            ("games", "游戏安装目录", games, "游戏本体在这里，卸载插件通常不会删除"),
            ("saves", "存档 / 兼容层", saves, "每个游戏一个 appid 子目录；仅默认库，SD 卡库在卡上"),
            ("runtime", "插件数据", runtime, "启动脚本、legendary、Proton wrapper、启动日志"),
            ("settings", "插件设置", settings, "设置与库缓存"),
            ("logs", "导出的诊断日志", logs, "「导出诊断日志」写到这里"),
            ("legendary", "Epic 登录与安装记录", epic, "删掉会丢失登录态和安装记录"),
        ]
        return {
            "ok": True,
            "items": [
                {"key": k, "label": l, "path": p, "note": n}
                for k, l, p, n in items
                if p
            ],
        }

    async def install_legendary(self):
        """Download the standalone Legendary binary into the user dir."""
        try:
            dest_dir = default_install_dir()
            path, version = await asyncio.get_running_loop().run_in_executor(
                None, download_legendary, dest_dir
            )
            decky.logger.info("legendary installed: %s (%s)", path, version)
            # Update config so future launches use the bundled binary.
            self.config.set("legendary_path", path)
            self.legendary.binary = path
            return {"ok": True, "path": path, "version": version}
        except InstallerError as e:
            decky.logger.error("install_legendary: %s", e)
            return {"ok": False, "error": str(e)}
        except Exception as e:
            decky.logger.error("install_legendary: %s", e)
            return {"ok": False, "error": "下载失败: %s" % e}

    async def get_legendary_version(self):
        """Return the installed Legendary version string, if available."""
        try:
            out = await self.legendary._run("--version", timeout=30.0)
            return {"ok": True, "version": out.strip()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- logs -------------------------------------------------------------
    async def export_logs(self):
        """Collect diagnostic info into a single text blob for troubleshooting."""
        import datetime
        import platform
        import shutil as _shutil

        lines = []
        add = lines.append

        add("=" * 60)
        add("EpicDeck 诊断日志")
        add(f"生成时间: {datetime.datetime.now().isoformat()}")
        add("=" * 60)
        add("")

        # 环境信息
        add("[环境信息]")
        add(f"  Decky 版本: {getattr(decky, 'DECKY_VERSION', '未知')}")
        add(f"  插件版本: {getattr(decky, 'DECKY_PLUGIN_VERSION', '未知')}")
        add(f"  用户: {getattr(decky, 'DECKY_USER', '未知')}")
        add(f"  Python: {platform.python_version()}")
        add(f"  系统: {platform.system()} {platform.release()}")
        try:
            import distro  # type: ignore
            add(f"  发行版: {distro.name()} {distro.version()}")
        except Exception:
            pass
        legendary_path = self.legendary._resolve()
        add(f"  Legendary 路径: {legendary_path or '未找到'}")
        add("")

        # 登录状态
        add("[登录状态]")
        try:
            status = await self.legendary.auth_status()
            add(f"  已登录: {status.get('logged_in', False)}")
            add(f"  账号 ID: {_mask_personal(str(status.get('account_id', '')))}")
            add(f"  显示名: {status.get('display_name', '')}")
        except Exception as e:
            add(f"  读取失败: {e}")
        add("")

        # 插件配置(脱敏)
        add("[插件配置]")
        for k, v in sorted(self.config._data.items()):
            add(f"  {k}: {v!r}")
        add("")

        # 插件日志
        add("[插件日志 (最近 200 行)]")
        log_path = getattr(decky, "DECKY_PLUGIN_LOG", "")
        if log_path and os.path.isfile(log_path):
            try:
                with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                    tail = f.readlines()[-200:]
                for line in tail:
                    add(line.rstrip())
            except OSError as e:
                add(f"  读取日志失败: {e}")
        else:
            add(f"  日志文件不存在: {log_path or '(路径未提供)'}")

        add("")
        add("=" * 60)
        add("(请将以上内容粘贴到 GitHub Issue 或反馈渠道,勿包含敏感信息)")
        add("=" * 60)

        content = "\n".join(lines)

        # 同时写入用户可访问的导出文件
        export_path = ""
        try:
            export_dir = os.path.join(getattr(decky, "HOME", os.path.expanduser("~")), "epicdeck_logs")
            os.makedirs(export_dir, exist_ok=True)
            stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            export_path = os.path.join(export_dir, f"epicdeck_{stamp}.log")
            with open(export_path, "w", encoding="utf-8") as f:
                f.write(content)
            # 导出目录会随每次诊断无限累积，只保留最近 EXPORT_LOG_KEEP 份，
            # 超出删除最旧的，避免把用户 home 分区慢慢吃满。
            try:
                exports = sorted(
                    (p for p in os.listdir(export_dir) if p.startswith("epicdeck_") and p.endswith(".log")),
                    key=lambda n: os.path.getmtime(os.path.join(export_dir, n)),
                    reverse=True,
                )
                for stale in exports[EXPORT_LOG_KEEP:]:
                    try:
                        os.unlink(os.path.join(export_dir, stale))
                    except OSError:
                        pass
            except OSError:
                pass
        except OSError as e:
            decky.logger.error("export_logs write: %s", e)
            export_path = ""

        return {"ok": True, "logs": content, "path": export_path}
