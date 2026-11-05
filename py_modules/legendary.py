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

# 体积数据的合理性下限。真实游戏不可能只有几字节,但 Epic 对部分 GOTY/合集条目
# 返回的是**残缺 manifest**:`disk_size`/`download_size` 有值、却小得荒谬
# (实测《龙腾世纪:审判》年度版 `verdi` 是 disk_size=4、download_size=1109、
# num_files=1、tag_disk_size=[])。旧代码只判「非 0 就算有效」,于是这个 4 字节
# 被当成真实体积写进缓存,详情页显示 4 B,兜底逻辑(du 实测 / 体积未知)永远不触发。
# 1 MiB 是安全门槛:最小的独立游戏也有几十 MB。
MIN_PLAUSIBLE_SIZE = 1024 * 1024


def plausible_size(value) -> int:
    """体积字段转 int,低于 MIN_PLAUSIBLE_SIZE 的一律当 0(无效)。

    调用方据此判断「这份 manifest 能不能用」,不要拿 4 字节当真实体积。
    """
    try:
        size = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return size if size >= MIN_PLAUSIBLE_SIZE else 0



def _legendary_home() -> str:
    return os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")


def _installed_path(app_name: str) -> str:
    """`install_path` for an installed title, straight from installed.json."""
    path = os.path.join(_legendary_home(), "legendary", "installed.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return ""
    entry = data.get(app_name) if isinstance(data, dict) else None
    if isinstance(entry, dict):
        return str(entry.get("install_path") or "")
    return ""


def non_installable(game: dict) -> bool:
    """True when Epic returns this entitlement with no downloadable asset.

    Such titles can only be installed by an external launcher (EA App /
    Origin): It Takes Two, The Sims 4, Mass Effect Legendary Edition, the
    Star Wars back catalogue… Measured on a 139-game library — every
    installable title had `asset_infos`, the 9 launcher-only ones had none.
    """
    return not bool(game.get("asset_infos"))


# Epic's public launcher client. These are legendary's own open-source client
# credentials, not user secrets — third-party Epic tools share them.
EPIC_OAUTH_TOKEN_URL = (
    "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token"
)
EPIC_LAUNCHER_CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a"
EPIC_LAUNCHER_SECRET = "daafbccc737745039dffe53d94fc76cf"


def oauth_error_text(payload: str) -> str:
    """Turn Epic's OAuth error JSON into something a user can act on."""
    try:
        code = str(json.loads(payload).get("errorCode") or "")
    except (ValueError, TypeError):
        return ""
    tail = code.rsplit(".", 1)[-1]
    return {
        "authorization_code_not_found": (
            "授权码无效或已过期。授权码只能用一次且很快失效，请重新打开登录页获取。"
        ),
        "authorization_code_not_for_your_client": (
            "这个授权码不是发给 EpicDeck 的，请在登录页重新确认授权。"
        ),
        "invalid_grant": "授权码无效，请重新获取。",
        "invalid_client": "Epic 客户端凭据失效，请更新插件。",
    }.get(tail, "")


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
        """Locate the legendary binary.

        Order matters for store installs: Decky downloads the binary declared in
        `package.json`'s `remote_binary` into `<plugin>/bin/`, and that copy is
        the one the loader hash-checked. The runtime copy (written by our own
        installer) is the fallback for sideloaded/scp deployments, where Decky
        never runs the remote_binary step.
        """
        # 1. Explicit absolute path.
        if self.binary and os.path.isabs(self.binary) and os.path.isfile(self.binary):
            return self.binary
        # 2. Decky's remote_binary download.
        try:
            from py_modules.paths import plugin_dir

            declared = os.path.join(plugin_dir(), "bin", "legendary")
            if os.path.isfile(declared):
                # Decky normally chmods what it downloads; be forgiving if a
                # manual copy lost the execute bit.
                if not os.access(declared, os.X_OK):
                    try:
                        os.chmod(declared, 0o755)
                    except OSError:
                        pass
                return declared
        except Exception:
            pass
        # 3. Bundled user dir (where our installer puts it).
        try:
            from py_modules.legendary_installer import default_install_dir
            bundled = os.path.join(default_install_dir(), "legendary")
            if os.path.isfile(bundled):
                return bundled
        except Exception:
            pass
        # 4. On PATH.
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
        except asyncio.CancelledError:
            # The user pressed "cancel": cancelling the awaiting task must also
            # take the child down, otherwise `legendary auth --code` keeps
            # running in the background and can log the account in after the
            # user was told the attempt was cancelled. `shield` keeps the reap
            # itself from being cancelled again.
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            except Exception:
                pass
            try:
                await asyncio.shield(proc.wait())
            except Exception:
                pass
            raise
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

    async def auth_with_code_native(self, code: str):
        """Trade an authorization code for tokens *without* `legendary auth`.

        `legendary auth` runs `check_for_updates(force=True)` before doing
        anything else. That request goes to api.legendary.gl, which is
        unreachable on many networks — and the exception is not caught inside
        `cli.auth()`, so a perfectly good authorization code dies on an
        unrelated version check (field report 2026-11-06: login failed with a
        ReadTimeout to api.legendary.gl *after* the code had been captured).
        The exchange only needs Epic's public account API, so do it here and
        write the same `user.json` legendary would have written.
        """
        import base64
        import ssl
        import urllib.error
        import urllib.parse
        import urllib.request

        # The plugin runs under systemd (plugin_loader); its environment does
        # not always resolve the system CA bundle (SSL_CERT_FILE can point at a
        # path that no longer exists after an update). On the Deck the failure
        # was "unable to get local issuer certificate" while the exact same
        # request succeeded in a login shell. Pin certifi's bundle so the hand-
        # shake never depends on the ambient environment.
        try:
            import certifi

            _cafile = certifi.where()
        except Exception:  # noqa: BLE001 - fall back to the OS default
            _cafile = None
        _ctx = None
        if _cafile:
            try:
                _ctx = ssl.create_default_context(cafile=_cafile)
            except Exception:  # noqa: BLE001
                _ctx = None

        body = urllib.parse.urlencode(
            {"grant_type": "authorization_code", "code": code, "token_type": "eg1"}
        ).encode()
        basic = base64.b64encode(
            ("%s:%s" % (EPIC_LAUNCHER_CLIENT_ID, EPIC_LAUNCHER_SECRET)).encode()
        ).decode()
        req = urllib.request.Request(
            EPIC_OAUTH_TOKEN_URL,
            data=body,
            headers={
                "Authorization": "basic " + basic,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )

        loop = asyncio.get_running_loop()

        def _post():
            return urllib.request.urlopen(req, timeout=30, context=_ctx).read()

        try:
            raw = await loop.run_in_executor(None, _post)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            raise LegendaryError(
                oauth_error_text(detail) or ("Epic 登录失败 (HTTP %s)" % e.code)
            )
        except Exception as e:  # noqa: BLE001 - network stack varies
            raise LegendaryError("连接 Epic 失败: %s" % e)

        try:
            data = json.loads(raw)
        except ValueError:
            raise LegendaryError("Epic 返回了无法解析的响应")

        account_id = str(data.get("account_id") or "")
        if not account_id or not data.get("refresh_token"):
            raise LegendaryError("Epic 未返回有效的账号信息")

        user = {
            "account_id": account_id,
            "displayName": data.get("displayName") or "",
            "access_token": data.get("access_token") or "",
            "refresh_token": data.get("refresh_token") or "",
            "expires_at": data.get("expires_at") or "",
            "refresh_expires_at": data.get("refresh_expires_at") or "",
            "app": data.get("app") or "launcher",
            "in_app_id": data.get("in_app_id") or account_id,
        }
        if data.get("device_id"):
            user["device_id"] = data["device_id"]

        path = os.path.join(self.config_dir(), "user.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(user, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        return {"account_id": account_id, "display_name": user["displayName"]}

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

    async def list_games(self, include_metadata: bool = True, force: bool = False):
        """Return the owned game library, merged with install state.

        `legendary list --json` yields a flat array whose title lives in
        `app_title` (not `title`); Unreal Engine content is excluded so the
        library only shows real games. Install state comes from a separate
        `list-installed` call, since `list` does not report it.

        `force` re-fetches the *owned games* list, not just metadata. Legendary
        answers `list` from `entitlements.json`, which it only writes at login
        time — a title bought afterwards never shows up however often the UI
        refreshes. Dropping that file makes legendary repopulate it from the
        API with the stored session (a cheap login), and the old copy is put
        back if the call fails.
        """
        ent = os.path.join(self.config_dir(), "entitlements.json")
        backup = None
        if force and os.path.isfile(ent):
            try:
                backup = ent + ".old"
                os.replace(ent, backup)
            except OSError:
                # Cannot move it — better a slightly stale list than no list.
                backup = None

        try:
            # Forced runs also download the entitlement list and any missing
            # metadata, hence the longer timeout.
            # `-T` also returns titles legendary cannot install (they must be
            # activated in EA App / Origin). They come back with `asset_infos`
            # empty and are flagged `non_installable` below, so the UI can show
            # them marked instead of hiding them — "I bought this, where is it"
            # is a worse experience than a badge (7.20).
            games = await self._run_json("list", "-T", timeout=180.0 if force else 120.0)
        except LegendaryError as e:
            if backup and not os.path.exists(ent):
                try:
                    os.replace(backup, ent)
                    backup = None
                except OSError:
                    pass
            raise LegendaryError("读取游戏库失败: %s" % e)
        finally:
            if backup:
                try:
                    os.unlink(backup)
                except OSError:
                    pass
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
                    # `title` is what the UI shows and gets overlaid with a
                    # localised name; `source_title` keeps Epic's own (English)
                    # title so switching language never needs a refetch.
                    "title": g.get("app_title")
                    or metadata.get("title")
                    or app_name,
                    "source_title": g.get("app_title")
                    or metadata.get("title")
                    or app_name,
                    "version": ins.get("version", "") or g.get("version", ""),
                    "is_installed": bool(ins),
                    # No downloadable asset => only an external launcher can
                    # install it (EA App / Origin). Every installable title in a
                    # 139-game library had `asset_infos`; the 9 extras had none.
                    "non_installable": non_installable(g),
                    "install_size": g.get("install_size", 0) or 0,
                    "installed_size": ins.get("install_size", 0) or 0,
                    "cover_url": self._extract_cover(g),
                    # Needed to ask Epic's catalog service for a localised
                    # title (its bulk endpoint is keyed by catalog item id).
                    "namespace": metadata.get("namespace", "") or "",
                    "catalog_item_id": metadata.get("id", "") or "",
                }
            )
        # Installed first, then installable-not-installed, then the ones we can
        # only list (non_installable) so they never sit between real options.
        result.sort(
            key=lambda x: (
                not x["is_installed"],
                x["non_installable"],
                (x["title"] or "").lower(),
            )
        )
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

        GOTY/bundle entries sometimes expose no manifest for the platform
        Legendary picks by default (`verdi` = Dragon Age: Inquisition GOTY is
        one), and the answer is then `{"manifest": null}` rather than an error.
        A second attempt names Windows explicitly before giving up, because
        every current Epic build is Windows-only.
        """
        sizes = await self._info_sizes(app_name, timeout=75.0)
        if sizes:
            return sizes
        # Shorter second attempt: the page waits on this call.
        sizes = await self._info_sizes(app_name, platform="Windows", timeout=45.0)
        if sizes:
            return sizes
        return None

    async def _info_sizes(self, app_name: str, platform: str = "", timeout: float = 120.0):
        args = ["info", app_name]
        if platform:
            args += ["--platform", platform]
        try:
            data = await self._run_json(*args, timeout=timeout)
        except LegendaryError:
            return None
        if not isinstance(data, dict):
            return None
        manifest = data.get("manifest") or {}
        if not isinstance(manifest, dict):
            return None
        # 4 字节、1109 字节这种「有值但荒谬」的残缺 manifest 必须当成没有,
        # 否则调用方会把它缓存起来并显示成 4 B,兜底路径永远不会走。
        disk = plausible_size(manifest.get("disk_size"))
        download = plausible_size(manifest.get("download_size"))
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
        """Install path from Legendary's own bookkeeping.

        Reading `installed.json` is instant and works offline, unlike
        `legendary info` (which also fetches a manifest).
        """
        path = _installed_path(app_name)
        if path:
            return path
        try:
            out = await self._run_json("info", app_name, timeout=60.0)
        except LegendaryError:
            return ""
        return out.get("install_path", "") if isinstance(out, dict) else ""

    # -- cloud saves (HANDOFF 7.13.3) -------------------------------------
    async def cloud_save_info(self, app_name: str):
        """Whether a title supports Epic cloud saves, and where its saves live.

        `legendary info --json` answers this directly (`cloud_saves_supported`,
        `cloud_save_folder`), which is more reliable than guessing from the
        manifest — GameBridge's `supports_cloud_saves` heuristic is unnecessary.
        """
        try:
            info = await self._run_json("info", app_name, timeout=40.0)
        except LegendaryError:
            info = {}
        game = info.get("game") if isinstance(info, dict) else None
        game = game if isinstance(game, dict) else {}
        record = self.installed_records().get(app_name) or {}
        return {
            "supported": bool(game.get("cloud_saves_supported")),
            "mac_supported": bool(game.get("cloud_saves_supported_mac")),
            "folder": str(game.get("cloud_save_folder") or ""),
            "save_path": str(record.get("save_path") or ""),
        }

    async def sync_saves(self, app_name: str, mode: str = "sync", timeout: float = 240.0):
        """Sync cloud saves. `mode` is one of sync / upload / download.

        `-y` is a *global* flag and must precede the subcommand; `--accept-path`
        is what stops Legendary from skipping a game whose save path has never
        been set (with `-y` alone it logs "skipping due to --yes" and exits 0,
        which would look like a successful sync that did nothing).
        """
        args = ["-y", "sync-saves", app_name, "--accept-path"]
        if mode == "download":
            args.append("--skip-upload")
        elif mode == "upload":
            args.append("--skip-download")
        return await self._run(*args, timeout=timeout)
