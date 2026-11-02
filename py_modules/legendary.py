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
import shutil


class LegendaryError(Exception):
    pass


class LegendaryNotFound(LegendaryError):
    pass


class Legendary:
    def __init__(self, binary: str = "legendary", env_prefix: str = ""):
        self.binary = binary
        self.env_prefix = env_prefix

    def _env(self):
        env = os.environ.copy()
        if self.env_prefix:
            env["LEGENDARY_CONFIG_PATH"] = self.env_prefix
        return env

    async def _run(self, *args, timeout: float = 120.0):
        exe = shutil.which(self.binary)
        if exe is None:
            raise LegendaryNotFound(
                "Legendary 未安装。请在桌面模式运行:\n"
                "pip install legendary-gl 或从 Heroic/Flatpak 安装。"
            )
        cmd = [exe, *args]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=self._env(),
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
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Some legendary versions print warnings before the JSON payload.
            # Grab the first '[' or '{' and parse from there.
            start = min(
                (i for i in (text.find("["), text.find("{")) if i != -1),
                default=-1,
            )
            if start != -1:
                return json.loads(text[start:])
            raise LegendaryError("无法解析 legendary 输出: %s" % text[:200])

    # -- auth -------------------------------------------------------------
    async def auth_login(self):
        """Launch interactive browser login."""
        return await self._run("auth")

    async def auth_with_code(self, code: str):
        """Authenticate using an authorization code from the device flow."""
        return await self._run("auth", "--code", code, timeout=120.0)

    async def auth_status(self):
        """Return dict describing auth state: logged_in, account_id, display_name."""
        try:
            out = await self._run_json("auth", "--status", timeout=30.0)
        except LegendaryError:
            return {"logged_in": False, "account_id": "", "display_name": ""}
        if isinstance(out, dict) and out.get("account_id"):
            return {
                "logged_in": True,
                "account_id": out.get("account_id", ""),
                "display_name": out.get("display_name", ""),
            }
        return {"logged_in": False, "account_id": "", "display_name": ""}

    async def auth_logout(self):
        return await self._run("auth", "--delete")

    # -- library ----------------------------------------------------------
    async def list_games(self, include_metadata: bool = True):
        """Return the installed + owned game library, with cover art if present."""
        try:
            games = await self._run_json("list-games", "--include-ue", timeout=60.0)
        except LegendaryError as e:
            raise LegendaryError("读取游戏库失败: %s" % e)
        if isinstance(games, dict):
            games = games.get("games", [])
        result = []
        for g in games or []:
            result.append(
                {
                    "app_name": g.get("app_name"),
                    "title": g.get("title") or g.get("app_name"),
                    "version": g.get("version", ""),
                    "is_installed": bool(g.get("is_installed")),
                    "install_size": g.get("install_size", 0),
                    "installed_size": g.get("installed_size", 0),
                    "cover_url": self._extract_cover(g),
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
