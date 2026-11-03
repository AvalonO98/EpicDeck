# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

"""Legendary CLI wrapper.

Legendary (https://github.com/derrod/legendary) is an open-source
replacement for the Epic Games Launcher that provides `auth`, `list-games`,
`install`, `launch`, `uninstall` and more.

EpicDeck shells out to it instead of reimplementing Epic's private download
protocol. Login is driven by `legendary auth`, which opens the official Epic
authorization page in a browser (web-style login) and stores tokens locally.
"""

import asyncio
import datetime
import json
import os
import re
import shlex
import shutil
import time


class LegendaryError(Exception):
    pass


class LegendaryNotFound(LegendaryError):
    pass


def _loads_lenient(text: str):
    """Parse the JSON payload out of legendary output.

    Legendary mixes log lines into stdout (`[Core] WARNING: ...`), and those
    lines can contain `[` (e.g. `[Core]`), so simply slicing at the first
    bracket produces garbage. Instead, try the whole string, then attempt a
    real decode at every `{` / `[` until one parses.
    """
    if text is None:
        raise LegendaryError("legendary 没有输出")
    stripped = text.strip()
    if not stripped:
        raise LegendaryError("legendary 输出为空")

    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass

    decoder = json.JSONDecoder()
    for match in re.finditer(r"[\[{]", stripped):
        try:
            obj, _ = decoder.raw_decode(stripped[match.start():])
            return obj
        except json.JSONDecodeError:
            continue

    raise LegendaryError("无法解析 legendary 输出: %s" % stripped[:200])


def _expiry_ok(stamp, grace: float = 0.0) -> bool:
    """Is an ISO-8601 timestamp from ``user.json`` still in the future?

    Legendary writes ``2027-11-02T11:43:20.190Z``; Python 3.11 parses the
    trailing ``Z``, older builds do not, so normalise it first. Unknown or
    malformed values count as "expired" — never claim a session we cannot
    verify.
    """
    if not stamp:
        return False
    text = str(stamp).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        when = datetime.datetime.fromisoformat(text)
    except ValueError:
        return False
    if when.tzinfo is None:
        when = when.replace(tzinfo=datetime.timezone.utc)
    return when.timestamp() - grace > time.time()


class Legendary:
    def __init__(self, binary: str = "legendary", env_prefix: str = ""):
        self.binary = binary
        self.env_prefix = env_prefix

    def _resolve(self):
        """Locate the legendary binary: absolute path, then PATH, then bundled dir."""
        # 1. Explicit absolute path.
        if self.binary and os.path.isabs(self.binary) and os.path.isfile(self.binary):
            return self.binary
        # 2. Bundled user dir (where the installer puts it).
        try:
            from py_modules.legendary_installer import default_install_dir
            bundled = os.path.join(default_install_dir(), "legendary")
            if os.path.isfile(bundled):
                return bundled
        except Exception:
            pass
        # 3. On PATH.
        exe = shutil.which(self.binary)
        if exe:
            return exe
        return None

    def _env(self):
        env = os.environ.copy()
        if self.env_prefix:
            env["LEGENDARY_CONFIG_PATH"] = self.env_prefix
        # Game Mode has no LANG at all, which makes Legendary's locale lookup
        # fail ("Getting locale failed ... falling back to using en-US") and
        # every game launches in English. Derive it from Steam's own setting.
        if not env.get("LANG"):
            try:
                from py_modules.epic_api import steam_posix_locale
                locale = steam_posix_locale()
            except Exception:
                locale = "en_US.UTF-8"
            env["LANG"] = locale
            env.setdefault("LC_ALL", locale)
        return env

    async def _run(self, *args, timeout: float = 120.0):
        exe = self._resolve()
        if exe is None:
            raise LegendaryNotFound(
                "Legendary 未安装。请在插件设置中点击「一键安装 Legendary」。"
            )
        cmd = [exe, *args]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=self._env(),
            )
        except (OSError, PermissionError, FileNotFoundError) as e:
            raise LegendaryNotFound(
                "无法启动 Legendary(%s): %s" % (exe, e)
            )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise LegendaryError("命令执行超时: %s" % " ".join(args))
        text = out.decode("utf-8", errors="replace")
        if proc.returncode != 0:
            raise LegendaryError(text.strip() or ("命令失败: %s" % " ".join(args)))
        return text

    async def _run_json(self, *args, timeout: float = 120.0):
        text = await self._run(*args, "--json", timeout=timeout)
        return _loads_lenient(text)

    # -- auth -------------------------------------------------------------
    async def auth_login(self):
        """Launch interactive browser login."""
        return await self._run("auth", timeout=60.0)

    async def auth_with_code(self, code: str):
        """Authenticate using an authorization code from the device flow."""
        return await self._run("auth", "--code", code, timeout=120.0)

    async def auth_status(self):
        """Return dict describing auth state: logged_in, account_id, display_name.

        Read from legendary's own ``user.json`` instead of shelling out to
        ``legendary status``: that command refreshes the session over the
        network and took 26 seconds on a bad connection (it also asks
        api.legendary.gl about updates, which times out here), while the
        plugin's UI gives up after 15 — a signed-in user was shown the login
        screen. The stored file already carries everything the UI needs.
        """
        session = self.local_session()
        if session is None:
            # Legendary writes this file as part of logging in; no file means
            # no session. Do not fall back to the CLI: that is where the slow
            # path lived, and it never knows more than the file does.
            return {"logged_in": False, "account_id": "", "display_name": ""}

        # A refresh token is what keeps the session alive; the access token is
        # short-lived and appears "expired" for most of a normal session.
        account_id = str(session.get("account_id") or "")
        display_name = str(session.get("displayName") or "")
        logged_in = bool(
            session.get("refresh_token")
            and _expiry_ok(session.get("refresh_expires_at"), grace=60.0)
            and account_id
        )
        return {
            "logged_in": logged_in,
            "account_id": account_id if logged_in else "",
            "display_name": display_name if logged_in else "",
        }

    def config_dir(self) -> str:
        if self.env_prefix:
            return self.env_prefix
        override = os.environ.get("LEGENDARY_CONFIG_PATH")
        if override:
            return override
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
        return os.path.join(base, "legendary")

    def installed_records(self) -> dict:
        """Legendary's own ``installed.json``, read without a subprocess.

        Called on every launcher sync, so it must not shell out: the file is a
        plain ``{app_name: record}`` map and reading it costs microseconds.
        """
        path = os.path.join(self.config_dir(), "installed.json")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def installed_platform(self, app_name: str) -> str:
        """'Windows' / 'Mac' / '' for an installed title."""
        record = self.installed_records().get(app_name) or {}
        if not isinstance(record, dict):
            return ""
        return str(record.get("platform") or "")

    def local_session(self):
        """Parse ``user.json`` without touching the network.

        Returns ``None`` when the file is missing or unreadable, so callers can
        tell "not logged in" apart from "cannot read the store".
        """
        path = os.path.join(self.config_dir(), "user.json")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    async def auth_logout(self):
        return await self._run("auth", "--delete")

    # -- library ----------------------------------------------------------
    async def list_installed(self):
        """Return Legendary's own install records (fast, no network calls).

        A broken manifest must never hide the whole library, so failures
        degrade to an empty list instead of raising.
        """
        try:
            inst = await self._run_json("list-installed", timeout=45.0)
        except LegendaryError:
            return []
        if isinstance(inst, dict):
            inst = inst.get("games", [])
        return [item for item in (inst or []) if isinstance(item, dict)]

    async def list_games(self, include_metadata: bool = True):
        """Return the owned game library, merged with install state.

        `legendary list --json` yields a flat array whose title lives in
        `app_title` (not `title`); Unreal Engine content is excluded so the
        library only shows real games. Install state comes from a separate
        `list-installed` call, since `list` does not report it.
        """
        try:
            games = await self._run_json("list", timeout=90.0)
        except LegendaryError as e:
            raise LegendaryError("读取游戏库失败: %s" % e)
        if isinstance(games, dict):
            games = games.get("games", [])

        installed = await self.list_installed()
        by_name = {item["app_name"]: item for item in installed if item.get("app_name")}

        result = []
        for g in games or []:
            metadata = g.get("metadata") or {}
            app_name = g.get("app_name")
            if not app_name:
                continue
            ins = by_name.get(app_name) or {}
            result.append(
                {
                    "app_name": app_name,
                    "title": g.get("app_title")
                    or metadata.get("title")
                    or app_name,
                    "version": ins.get("version", "") or g.get("version", ""),
                    "is_installed": bool(ins),
                    "install_size": g.get("install_size", 0) or 0,
                    "installed_size": ins.get("install_size", 0) or 0,
                    "cover_url": self._extract_cover(g),
                    # Needed to ask Epic's catalog service for a localised
                    # title (its bulk endpoint is keyed by catalog item id).
                    "namespace": metadata.get("namespace", "") or "",
                    "catalog_item_id": metadata.get("id", "") or "",
                }
            )
        result.sort(key=lambda x: (not x["is_installed"], (x["title"] or "").lower()))
        return result

    @staticmethod
    def _extract_cover(game: dict) -> str:
        """Extract a tall cover art URL from a game's metadata, if available."""
        metadata = game.get("metadata") or {}
        key_images = metadata.get("keyImages") or []
        # Prefer the tall box art (DieselGameBoxTall), fall back to others.
        preferred = ("DieselGameBoxTall", "DieselGameBox", "OfferImageTall",
                     "DieselStoreFrontWide", "Featured", "Thumbnail")
        images = {img.get("type"): img for img in key_images if img.get("type")}
        for t in preferred:
            img = images.get(t)
            if img and img.get("url"):
                return img["url"]
        # Some metadata nests images differently.
        for img in key_images:
            if img.get("url"):
                return img["url"]
        return ""

    async def key_images(self):
        """Return ``{app_name: {image_type: url}}`` for the whole library.

        Epic ships a full set of artwork per title (tall box, wide box, hero),
        which is exactly what Steam's grid directory wants. One `list` call
        returns all of it, so this is a single shot rather than per-game work.
        """
        try:
            games = await self._run_json("list", timeout=90.0)
        except LegendaryError:
            return {}
        if isinstance(games, dict):
            games = games.get("games", [])
        out = {}
        for g in games or []:
            name = g.get("app_name")
            metadata = g.get("metadata") or {}
            images = {}
            for img in metadata.get("keyImages") or []:
                kind = img.get("type")
                url = img.get("url")
                if kind and url:
                    images[kind] = url
            if name and images:
                out[name] = images
        return out

    # -- install / launch / uninstall ------------------------------------
    async def game_size(self, app_name: str):
        """Return {'download': bytes, 'disk': bytes} for a title.

        `legendary list` never reports sizes: the only source is the build
        manifest, which `legendary info --json` fetches (a couple of MB each).
        That is why callers cache the result instead of asking per render.
        """
        data = await self._run_json("info", app_name, timeout=90.0)
        if not isinstance(data, dict):
            return None
        manifest = data.get("manifest") or {}
        disk = int(manifest.get("disk_size") or 0)
        download = int(manifest.get("download_size") or 0)
        if not disk and not download:
            return None
        return {"download": download, "disk": disk}

    async def install(self, app_name: str, install_dir: str = "", base_path: str = ""):
        args = ["install", app_name]
        if install_dir:
            args += ["--base-path", install_dir]
        elif base_path:
            args += ["--base-path", base_path]
        args += ["-y"]  # assume yes to any prompt
        return await self._run(*args, timeout=3600.0)

    async def launch(self, app_name: str, extra_args: str = "", wine: str = ""):
        """Launch an installed title.

        Arguments after the app name go straight to the game (Legendary uses
        REMAINDER), which is how per-game compatibility flags reach it.

        `wine` is the "binary" Legendary puts in front of the game executable.
        It does not have to be wine at all — any command works — which is how
        Windows titles are handed to Steam's Proton (see py_modules/proton.py).
        """
        cmd = ["launch"]
        if wine:
            cmd += ["--wine", wine]
        cmd.append(app_name)
        if extra_args and extra_args.strip():
            cmd += shlex.split(extra_args)
        return await self._run(*cmd, timeout=60.0)

    async def uninstall(self, app_name: str):
        return await self._run("uninstall", app_name, "-y", timeout=120.0)

    async def get_install_dir(self, app_name: str):
        try:
            out = await self._run_json("info", app_name, timeout=30.0)
        except LegendaryError:
            return ""
        return out.get("install_path", "") if isinstance(out, dict) else ""
