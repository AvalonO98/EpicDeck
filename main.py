# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, EpicDeck Contributors

import os
import sys
import asyncio
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
from py_modules.legendary import Legendary, LegendaryError, LegendaryNotFound
from py_modules.steam import SteamShortcuts, SteamError, open_steam_protocol
from py_modules.epic_oauth import (
    DeviceCodeFlow,
    EpicOAuthError,
    run_device_code_poll,
)
from py_modules.legendary_installer import (
    InstallerError,
    default_install_dir,
    download_legendary,
    is_legendary_installed,
)


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

        # Device code login state.
        self._device_flow = DeviceCodeFlow()
        self._device_poll_task = None
        self._device_code_info = None

    async def _unload(self):
        for task in self._install_tasks.values():
            if not task.done():
                task.cancel()
        decky.logger.info("EpicDeck unloaded")

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
        """Start interactive browser login (opens Epic authorization page)."""
        try:
            # Browser login requires Legendary; give a clear error otherwise.
            if self.legendary._resolve() is None:
                return {"ok": False, "error": "Legendary 未安装,请先在设置中点击「一键安装 Legendary」"}
            await asyncio.wait_for(self.legendary.auth_login(), timeout=60.0)
            return {"ok": True}
        except asyncio.TimeoutError:
            return {"ok": False, "error": "浏览器登录超时。游戏模式下建议改用「扫码/验证码登录」"}
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}

    # -- device code login ------------------------------------------------
    async def device_code_start(self):
        """Begin the device code flow. Returns user_code + URL to show in UI."""
        if self._device_poll_task and not self._device_poll_task.done():
            return {"ok": False, "error": "已有登录流程在进行中"}

        loop = asyncio.get_running_loop()
        try:
            info = await asyncio.wait_for(
                loop.run_in_executor(
                    None, self._device_flow.start_device_code
                ),
                timeout=45.0,
            )
        except asyncio.TimeoutError:
            return {"ok": False, "error": "连接 Epic 服务器超时,请检查网络后重试"}
        except EpicOAuthError as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:
            decky.logger.error("device_code_start: %s", e)
            return {"ok": False, "error": "发起登录失败: %s" % e}

        self._device_code_info = info

        def on_pending():
            decky.emit("device_code_status", "pending", "")

        def on_success(result):
            # Exchange the access_token for an authorization code, then hand
            # it to Legendary via `legendary auth --code`.
            async def _finish():
                access_token = result.get("access_token", "")
                code = result.get("code", "")
                try:
                    if not code and access_token:
                        code = await asyncio.get_running_loop().run_in_executor(
                            None, self._device_flow.exchange_for_code, access_token
                        )
                    if not code:
                        await decky.emit("device_code_status", "error", "未获取到授权码")
                        return
                    await self.legendary.auth_with_code(code)
                    await decky.emit("device_code_status", "success",
                                     result.get("display_name", ""))
                except (LegendaryError, EpicOAuthError) as e:
                    await decky.emit("device_code_status", "error", str(e))

            asyncio.get_running_loop().create_task(_finish())

        def on_error(exc):
            decky.emit("device_code_status", "error", str(exc))

        self._device_poll_task = asyncio.get_running_loop().create_task(
            run_device_code_poll(
                self._device_flow,
                info["device_code"],
                on_pending=on_pending,
                on_success=on_success,
                on_error=on_error,
                poll_interval=max(3.0, float(info.get("interval", 5))),
                max_wait=float(info.get("expires_in", 600)),
            )
        )

        return {
            "ok": True,
            "user_code": info["user_code"],
            "verification_uri": info["verification_uri"],
            "verification_uri_complete": info.get("verification_uri_complete", ""),
            "expires_in": info.get("expires_in", 600),
        }

    async def device_code_cancel(self):
        if self._device_poll_task and not self._device_poll_task.done():
            self._device_poll_task.cancel()
        self._device_code_info = None
        return {"ok": True}

    async def logout(self):
        try:
            await self.legendary.auth_logout()
            return {"ok": True}
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}

    # -- library ----------------------------------------------------------
    async def list_games(self):
        try:
            return {"ok": True, "games": await self.legendary.list_games()}
        except LegendaryError as e:
            return {"ok": False, "error": str(e)}

    # -- install / launch / uninstall ------------------------------------
    async def install(self, app_name: str):
        if app_name in self._install_tasks and not self._install_tasks[app_name].done():
            return {"ok": False, "error": "该游戏正在下载中"}

        install_dir = self.config.get("install_dir", "")

        async def _run():
            try:
                await decky.emit("install_progress", app_name, "starting", 0.0, "")
                await self._install_streaming(app_name, install_dir)
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
        return {"ok": True}

    async def _install_streaming(self, app_name: str, install_dir: str):
        exe = shutil.which(self.legendary.binary)
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
            await self.legendary.launch(app_name)
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

    async def _ensure_launcher_script(self, app_name: str):
        exe = shutil.which(self.legendary.binary)
        if exe is None:
            raise LegendaryNotFound("Legendary 未安装")
        script_dir = os.path.join(
            getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", None) or getattr(decky, "DECKY_RUNTIME_DIR", None) or os.path.join(decky.HOME, ".epicdeck"),
            "launchers",
        )
        os.makedirs(script_dir, exist_ok=True)
        script = os.path.join(script_dir, f"{app_name}.sh")
        content = (
            "#!/bin/bash\n"
            "# Generated by EpicDeck\n"
            f'exec {shlex.quote(exe)} launch "{app_name}"\n'
        )
        with open(script, "w", encoding="utf-8") as f:
            f.write(content)
        os.chmod(script, 0o755)
        return script

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
        options = []
        for base in ["/run/media", "/home/deck"]:
            if os.path.isdir(base):
                try:
                    for name in os.listdir(base):
                        full = os.path.join(base, name)
                        if os.path.isdir(full):
                            options.append(full)
                except OSError:
                    continue
        home = os.path.expanduser("~")
        if home not in options:
            options.insert(0, home)
        return {"options": options}

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
        legendary_path = _shutil.which(self.legendary.binary)
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
