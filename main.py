# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

import os
import re
import sys
import time
import asyncio
import configparser
import shutil
import shlex

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
from py_modules.legendary import Legendary, LegendaryError, LegendaryNotFound
from py_modules.steam import SteamShortcuts, SteamError, open_steam_protocol
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


class Plugin:
    async def _main(self):
        decky.logger.info("EpicDeck loaded")

        settings_dir = getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", None) or getattr(decky, "DECKY_SETTINGS_DIR", None) or os.path.join(decky.HOME, ".epicdeck")
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
        self._meta_task = None
        self._meta_done = False

        # Shortcuts created by older versions lack the locale export and the
        # "$@" forwarding; rewriting them costs nothing and fixes game language.
        try:
            self._sync_launcher_scripts()
        except Exception as e:
            decky.logger.warning("launcher sync failed: %s", e)

    async def _unload(self):
        for task in getattr(self, "_install_tasks", {}).values():
            if not task.done():
                task.cancel()
        meta = getattr(self, "_meta_task", None)
        if meta is not None and not meta.done():
            meta.cancel()
        decky.logger.info("EpicDeck unloaded")
        # Decky treats a falsy return as "keep the plugin running".
        return True

    async def _uninstall(self):
        decky.logger.info("EpicDeck uninstalled")

    # -- auth -------------------------------------------------------------
    async def auth_status(self):
        try:
            return await self.legendary.auth_status()
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
        return {
            "ok": True,
            "display_name": status.get("display_name", ""),
            "account_id": status.get("account_id", ""),
        }

    async def logout(self):
        try:
            await self.legendary.auth_logout()
            return {"ok": True}
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}

    # -- library ----------------------------------------------------------
    async def list_games(self):
        try:
            games = await self.legendary.list_games()
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}

        # Play time comes from Epic's library-service. It is a nice-to-have, so
        # a timeout or an expired token degrades to zero rather than failing
        # the whole library load.
        loop = asyncio.get_running_loop()
        try:
            playtime = await asyncio.wait_for(
                loop.run_in_executor(None, fetch_playtime), timeout=15.0
            )
        except Exception as e:
            decky.logger.warning("playtime unavailable: %s", e)
            playtime = {}

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
        try:
            in_steam = {s.app_name for s in self.steam.list_shortcuts()}
        except Exception as e:
            decky.logger.warning("shortcuts read failed: %s", e)
            in_steam = set()

        for g in games:
            g["playtime_seconds"] = playtime.get(g["app_name"], 0)
            g["in_steam"] = g["app_name"] in in_steam
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
        locale = detect_locale(self.config.get("title_locale", "auto"))
        self._apply_cached_metadata(games, locale)

        # Only advertise a pending count when a background job will actually
        # fill it in; otherwise the UI would sit on "0/138" forever.
        try:
            have_legendary = self.legendary._resolve() is not None
        except Exception:
            have_legendary = False
        can_fetch = bool(self.config.get("auto_fetch_size", True)) and have_legendary
        pending = sum(1 for g in games if not g.get("disk_size")) if can_fetch else 0
        if can_fetch:
            self._ensure_metadata_refresh(games, locale)

        return {
            "ok": True,
            "games": games,
            "locale": locale,
            "size_pending": pending,
        }

    # -- library enrichment ----------------------------------------------
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
                disk = int(cached.get("disk") or 0)
                download = int(cached.get("download") or 0)
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
            items = [
                (g["app_name"], g.get("namespace", ""), g.get("catalog_item_id", ""))
                for g in games
                if g["app_name"] not in cached
            ]
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

        # 2) Install sizes: one manifest fetch per game, throttled and cached.
        sizes = self.config.get("size_cache") or {}
        if not isinstance(sizes, dict):
            sizes = {}
        now = int(time.time())
        todo = []
        for g in games:
            cached = sizes.get(g["app_name"])
            fresh = isinstance(cached, dict) and int(cached.get("disk") or 0) > 0
            if fresh and now - int(cached.get("ts") or 0) < 30 * 86400:
                continue
            todo.append(g["app_name"])
        if not todo:
            self._meta_done = True
            await decky.emit("library_patch", {}, 0)
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
                if result:
                    sizes[app_name] = {
                        "download": result["download"],
                        "disk": result["disk"],
                        "ts": now,
                    }
                    patch[app_name] = result
                    dirty[0] = True

                # Flush in batches: per-game IPC would mean 138 events.
                due = len(patch) >= 6 or (time.time() - flush_at[0]) > 3.0
                if patch and (due or remaining[0] == 0):
                    await decky.emit("library_patch", dict(patch), remaining[0])
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
        await decky.emit("library_patch", {}, 0)
        decky.logger.info("size fetch complete (%d games)", len(todo))

    async def get_game_size(self, app_name: str):
        """On-demand size for one title, for the detail page."""
        sizes = self.config.get("size_cache") or {}
        if not isinstance(sizes, dict):
            sizes = {}
        cached = sizes.get(app_name)
        if isinstance(cached, dict) and int(cached.get("disk") or 0) > 0:
            return {"ok": True, "download": cached.get("download", 0), "disk": cached.get("disk", 0)}

        try:
            result = await self.legendary.game_size(app_name)
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:
            return {"ok": False, "error": str(e)}
        if not result:
            return {"ok": False, "error": "无法读取安装体积"}

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

        # Per-game override wins over the global default set in Settings.
        target = (install_dir or "").strip() or self.config.get("install_dir", "")
        if target:
            if not os.path.isdir(target):
                return {"ok": False, "error": "安装目录不存在: %s" % target}
            if not os.access(target, os.W_OK):
                return {"ok": False, "error": "安装目录不可写: %s" % target}

        async def _run():
            try:
                await decky.emit("install_progress", app_name, "starting", 0.0, "")
                await self._install_streaming(app_name, target)
                await decky.emit("install_progress", app_name, "done", 100.0, "")
                if self.config.get("auto_add_to_steam"):
                    await self._add_to_steam(app_name)
            except asyncio.CancelledError:
                await decky.emit("install_progress", app_name, "cancelled", 0.0, "")
                raise
            except Exception as e:
                decky.logger.error("install %s: %s", app_name, e)
                await decky.emit("install_progress", app_name, "error", 0.0, str(e))

        task = asyncio.create_task(_run())
        self._install_tasks[app_name] = task
        return {"ok": True, "install_dir": target}

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

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=self.legendary._env(),
            )
        except (OSError, PermissionError, FileNotFoundError) as e:
            raise LegendaryNotFound("无法启动 Legendary(%s): %s" % (exe, e))
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                decoded = line.decode("utf-8", errors="replace").strip()
                # Classify the activity from the log line.
                state = self._classify_activity(decoded)
                if state == "progress":
                    info = self._parse_progress(decoded)
                    await decky.emit(
                        "install_progress", app_name, "downloading",
                        info["percent"], decoded, info["speed"], info["eta"],
                    )
                elif state:
                    # Non-progress activity: verification, delta patching, etc.
                    await decky.emit(
                        "install_progress", app_name, state, -1.0, decoded, "", ""
                    )
                elif decoded:
                    await decky.emit(
                        "install_progress", app_name, "downloading", -1.0, decoded, "", ""
                    )
        finally:
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=10)
                except asyncio.TimeoutError:
                    proc.kill()
            await proc.wait()

        if proc.returncode != 0:
            raise LegendaryError("安装失败 (退出码 %s)" % proc.returncode)

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
        """Parse `Progress: xx% (a/b MiB), s MiB/s, ETA: h:mm:ss` into a dict."""
        import re
        info = {"percent": -1.0, "speed": "", "eta": ""}
        m = re.search(r"Progress:\s*([\d.]+)%", line)
        if m:
            try:
                info["percent"] = float(m.group(1))
            except ValueError:
                info["percent"] = -1.0
        s = re.search(r",\s*([\d.]+\s*\w+/s)\s*,", line)
        if s:
            info["speed"] = s.group(1)
        e = re.search(r"ETA:\s*([\d:]+)", line)
        if e:
            info["eta"] = e.group(1)
        return info

    async def launch(self, app_name: str):
        try:
            await self.legendary.launch(app_name, self._own_launch_args(app_name))
            return {"ok": True}
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}

    async def uninstall(self, app_name: str):
        try:
            await self.legendary.uninstall(app_name)
            return {"ok": True}
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}

    async def cancel_install(self, app_name: str):
        task = self._install_tasks.get(app_name)
        if task and not task.done():
            task.cancel()
        return {"ok": True}

    # -- steam integration ------------------------------------------------
    async def _add_to_steam(self, app_name: str):
        exe = await self._ensure_launcher_script(app_name)
        return self.steam.add_game(app_name, exe)

    def _launcher_dir(self):
        base = (
            getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", None)
            or getattr(decky, "DECKY_RUNTIME_DIR", None)
            or os.path.join(decky.HOME, ".epicdeck")
        )
        return os.path.join(base, "launchers")

    def _write_launcher_script(self, app_name: str, exe: str = None) -> str:
        """(Re)write the wrapper Steam points at for this game.

        Three things go in here:
          * a POSIX locale derived from Steam's language, because Game Mode
            exports no LANG and Legendary would otherwise launch every game
            in English;
          * the user's per-game arguments (or the ones Heroic left in
            Legendary's own config.ini);
          * `"$@"`, so whatever the user types into Steam's "launch options"
            box is appended to the game command line.
        """
        if exe is None:
            exe = self.legendary._resolve()
        if exe is None:
            raise LegendaryNotFound("Legendary 未安装")

        locale = steam_posix_locale()
        extra = self._own_launch_args(app_name)
        extra_shell = ""
        if extra:
            extra_shell = " " + " ".join(shlex.quote(a) for a in shlex.split(extra))

        script_dir = self._launcher_dir()
        os.makedirs(script_dir, exist_ok=True)
        script = os.path.join(script_dir, f"{app_name}.sh")
        content = (
            "#!/bin/bash\n"
            "# Generated by EpicDeck, rewritten whenever launch options change.\n"
            f'export LANG="{locale}"\n'
            f'export LC_ALL="{locale}"\n'
            f'exec {shlex.quote(exe)} launch {shlex.quote(app_name)}{extra_shell} "$@"\n'
        )
        with open(script, "w", encoding="utf-8") as f:
            f.write(content)
        os.chmod(script, 0o755)
        return script

    async def _ensure_launcher_script(self, app_name: str):
        # Let _write_launcher_script resolve the binary itself: it prefers the
        # bundled copy in data/bin, while shutil.which() only sees PATH and may
        # pick up an unrelated system-wide legendary.
        return self._write_launcher_script(app_name)

    def _sync_launcher_scripts(self):
        """Refresh wrappers created by older versions (locale + arg forwarding)."""
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
                self._write_launcher_script(app_name)
                decky.logger.info("launcher refreshed for %s", app_name)
            except Exception as e:
                decky.logger.warning("launcher refresh failed for %s: %s", entry.exe, e)

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
            if self.steam.find_game(app_name) is not None:
                self._write_launcher_script(app_name)
        except Exception as e:
            decky.logger.warning("launcher rewrite failed for %s: %s", app_name, e)
            return {"ok": True, "args": stored[app_name], "warning": str(e)}
        return {"ok": True, "args": stored[app_name]}

    async def add_to_steam(self, app_name: str):
        try:
            appid = await self._add_to_steam(app_name)
            return {"ok": True, "appid": appid}
        except (SteamError, LegendaryError) as e:
            return {"ok": False, "error": str(e)}

    async def remove_from_steam(self, app_name: str):
        try:
            self.steam.remove_game(app_name)
            return {"ok": True}
        except SteamError as e:
            return {"ok": False, "error": str(e)}

    async def is_in_steam(self, app_name: str):
        return {"in_steam": self.steam.find_game(app_name) is not None}

    async def refresh_steam(self):
        try:
            open_steam_protocol("steam://restart")
            return {"ok": True, "note": "Steam 正在重启以刷新游戏库"}
        except SteamError as e:
            return {"ok": False, "error": str(e)}

    async def launch_steam_game(self, app_name: str):
        entry = self.steam.find_game(app_name)
        if not entry:
            return {"ok": False, "error": "该游戏尚未添加到 Steam"}
        try:
            open_steam_protocol(f"steam://rungameid/{entry.appid}")
            return {"ok": True}
        except SteamError as e:
            return {"ok": False, "error": str(e)}

    # -- settings ---------------------------------------------------------
    async def get_settings(self):
        return dict(self.config._data)

    async def set_setting(self, key: str, value):
        self.config.set(key, value)
        return {"ok": True}

    async def get_install_dir_options(self):
        """Install roots the user can pick from, annotated with free space.

        The same SD card can be reachable through several paths
        (`/run/media/<label>`, `/run/media/<user>/<label>`, symlinked mounts),
        so candidates are normalised with realpath and de-duplicated, and only
        real mount points are offered — a plain directory like /run/media/deck
        is not somewhere you want games installed.
        """
        home = os.path.expanduser("~")

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
        for path in [home] + mount_points:
            real = os.path.realpath(path)
            if real in seen:
                continue
            if path != home and not os.path.ismount(path) and not os.path.ismount(real):
                continue
            seen.add(real)

            try:
                free = shutil.disk_usage(real).free
                free_label = "%0.1f GB 可用" % (free / 1024 / 1024 / 1024)
            except OSError:
                free = 0
                free_label = "空间未知"

            if path == home:
                label = "内置存储 · " + free_label
            else:
                label = "%s · %s" % (os.path.basename(real.rstrip("/")), free_label)
            options.append({"path": real, "label": label, "free": free})

        options.sort(key=lambda o: (o["path"] != home, o["path"]))
        return {"options": options, "current": self.config.get("install_dir", "")}

    # -- environment ------------------------------------------------------
    async def check_environment(self):
        """Report the runtime environment so the frontend can guide the user."""
        try:
            resolved = self.legendary._resolve()
        except Exception as e:
            decky.logger.error("check_environment: %s", e)
            resolved = None
        return {
            "legendary_installed": resolved is not None,
            "legendary_path": resolved or "",
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
            add(f"  账号 ID: {status.get('account_id', '')}")
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
        except OSError as e:
            decky.logger.error("export_logs write: %s", e)
            export_path = ""

        return {"ok": True, "logs": content, "path": export_path}
