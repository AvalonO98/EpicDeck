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
import json
import os
import re
import shutil


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

        Legendary 0.21.x exposes a non-interactive `status --json` command that
        reports the current account. (`auth --status` does not exist and would
        drop into the interactive login flow.)
        """
        try:
            out = await self._run_json("status", timeout=15.0)
        except LegendaryError:
            return {"logged_in": False, "account_id": "", "display_name": ""}
        if not isinstance(out, dict):
            return {"logged_in": False, "account_id": "", "display_name": ""}
        account = out.get("account", "")
        logged_in = bool(account) and account != "<not logged in>"
        return {
            "logged_in": logged_in,
            "account_id": account if logged_in else "",
            "display_name": account if logged_in else "",
        }

    async def auth_logout(self):
        return await self._run("auth", "--delete")

    # -- library ----------------------------------------------------------
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

        installed = {}
        try:
            inst = await self._run_json("list-installed", timeout=45.0)
            if isinstance(inst, dict):
                inst = inst.get("games", [])
            for item in inst or []:
                if item.get("app_name"):
                    installed[item["app_name"]] = item
        except LegendaryError:
            # A broken install manifest should never hide the whole library.
            pass

        result = []
        for g in games or []:
            metadata = g.get("metadata") or {}
            app_name = g.get("app_name")
            if not app_name:
                continue
            ins = installed.get(app_name) or {}
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

    async def launch(self, app_name: str):
        return await self._run("launch", app_name, timeout=60.0)

    async def uninstall(self, app_name: str):
        return await self._run("uninstall", app_name, "-y", timeout=120.0)

    async def get_install_dir(self, app_name: str):
        try:
            out = await self._run_json("info", app_name, timeout=30.0)
        except LegendaryError:
            return ""
        return out.get("install_path", "") if isinstance(out, dict) else ""
