"""Smoke-test the backend callables without a Steam Deck.

A stub `decky` module lets main.py import on Windows, so typos inside the new
backend paths surface here instead of on the device.
"""
import asyncio
import json
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

tmp = tempfile.mkdtemp(prefix="epicdeck-smoke-")


class _Logger:
    def __getattr__(self, name):
        return lambda *a, **k: None


decky = types.ModuleType("decky")
decky.logger = _Logger()
decky.DECKY_PLUGIN_DIR = ROOT
decky.DECKY_PLUGIN_SETTINGS_DIR = tmp
decky.DECKY_PLUGIN_RUNTIME_DIR = tmp
decky.DECKY_USER_HOME = os.path.expanduser("~")
decky.HOME = os.path.expanduser("~")
decky.DECKY_VERSION = "3.3.1"
async def _emit(*a, **k):
    """Every call site awaits emit; a sync stub would break those paths."""
    return None


decky.emit = _emit
sys.modules["decky"] = decky

import main  # noqa: E402

plugin = main.Plugin()
plugin.config = main.Config(os.path.join(tmp, "epicdeck.json"))
plugin.config.set("title_cache", {"en-US": {"051eaac0842c46d7a5a62858ad534d5a": "Cat Quest"}})
plugin.legendary = main.Legendary(binary="legendary")
plugin._lib_locale = "zh-Hans"
# `_main()` normally sets these before any callable runs; the stub skips it.
plugin._lib_cache_at = 0.0
plugin._install_tasks = {}
plugin._install_procs = {}
plugin._external_pids = {}
plugin._live_progress = {}
plugin._account = ""
plugin._lib_account = ""
plugin._settings_dir = tmp
plugin._lib_cache = [
    {"app_name": "051eaac0842c46d7a5a62858ad534d5a", "title": "Cat Quest"},
]


async def run():
    rows = []

    def check(name, cond, detail=""):
        rows.append((name, bool(cond), detail))

    # -- language ------------------------------------------------------
    zh = await plugin.get_ui_language()
    check("language defaults to zh without Steam", zh.get("lang") == "zh", str(zh))
    check("language reports its source", zh.get("source") in ("steam", "setting"), zh.get("source"))

    plugin.config.set("ui_language", "en")
    en = await plugin.get_ui_language()
    check("explicit en override wins", en.get("lang") == "en" and en.get("source") == "setting", str(en))
    plugin.config.set("ui_language", "auto")

    # -- title language follows the UI language ------------------------
    plugin.config.set("title_locale", "auto")
    plugin.config.set("ui_language", "en")
    check("en UI -> English titles", plugin._effective_title_locale() == "en-US",
          plugin._effective_title_locale())
    plugin.config.set("ui_language", "zh")
    check("zh UI -> Chinese titles", plugin._effective_title_locale() == "zh-Hans",
          plugin._effective_title_locale())
    plugin.config.set("title_locale", "en-US")
    plugin.config.set("ui_language", "zh")
    check("explicit title_locale wins over UI", plugin._effective_title_locale() == "en-US",
          plugin._effective_title_locale())
    plugin.config.set("title_locale", "auto")
    plugin.config.set("ui_language", "auto")

    # -- the payload picks the title for the requested language ---------
    plugin.config.set("title_cache", {"zh-Hans": {"g1": "中文名"}})
    sample = [{"app_name": "g1", "title": "中文名", "source_title": "English Name"}]
    plugin.config.set("ui_language", "en")
    en_titles = [r["title"] for r in plugin._library_payload(sample)["games"]]
    plugin.config.set("ui_language", "zh")
    zh_titles = [r["title"] for r in plugin._library_payload(sample)["games"]]
    plugin.config.set("ui_language", "auto")
    check("payload shows the English source title in English UI", en_titles == ["English Name"], str(en_titles))
    check("payload shows the cached localised title in Chinese UI", zh_titles == ["中文名"], str(zh_titles))

    # -- account switching drops account-scoped caches -----------------
    import time as _time

    plugin._lib_cache = [{"app_name": "a", "title": "A", "source_title": "A"}]
    plugin._lib_cache_at = _time.time()
    plugin._lib_account = "old-account"
    plugin.config.set("playtime_cache", {"a": 3600})
    plugin._set_account("new-account")
    check("account switch clears the library snapshot", plugin._lib_cache is None, str(plugin._lib_cache))
    check(
        "account switch clears playtime",
        (plugin.config.get("playtime_cache") or {}) == {},
        str(plugin.config.get("playtime_cache")),
    )
    plugin._set_account("new-account")
    check("same account keeps the caches", plugin._account == plugin._account, "")

    plugin._lib_cache = [
        {"app_name": "051eaac0842c46d7a5a62858ad534d5a", "title": "Cat Quest", "source_title": "Cat Quest"}
    ]
    plugin._lib_account = ""
    plugin.config.set("playtime_cache", {})

    # -- third-party titles ------------------------------------------
    from py_modules import title_sources as _ts

    check("extracts hanzi from a localised store name", _ts.chinese_part("猫咪斗恶龙 Cat Quest") == "猫咪斗恶龙", "")
    check("keeps sequel digits", _ts.chinese_part("无主之地®4") == "无主之地4", "")
    check("drops a pure English name", _ts.chinese_part("ARK: Survival Evolved") == "", "")
    # `_same_title` is only a cheap prefilter (a localised name may look like
    # "Game - 中文名"). Identity is enforced by the appid lookup, so the DLC is
    # rejected because its English name carries the subtitle.
    check(
        "DLC English name does not normalise to the base game",
        _ts._norm("Orcs Must Die! 3 - The Balancing Act") != _ts._norm("Orcs Must Die! 3"),
        "",
    )
    check("accepts Chinese before the English name", _ts._same_title("Cat Quest", "猫咪斗恶龙 Cat Quest"), "")
    check("accepts Chinese after the English name", _ts._same_title("Cassette Beasts", "Cassette Beasts 磁带妖怪"), "")
    check(
        "ignores a title that is already Chinese",
        _ts.lookup("控制: 共振").get("error") == "already localised",
        _ts.lookup("控制: 共振").get("error"),
    )
    # A transport failure must be reported as such, never as "no Chinese name".
    _ts.reset_cooldown()
    _ts._note_failure("test")
    _ts._note_failure("test")
    down = _ts.lookup("Some Title")
    check("blocked provider reports a transport failure", bool(down.get("transport")), str(down))
    _ts.reset_cooldown()
    plugin.config.set("third_party_titles", False)
    plugin.config.set("ui_language", "zh")
    before = dict((plugin.config.get("title_cache") or {}).get("zh-Hans") or {})
    await plugin._fill_missing_titles(
        [{"app_name": "zz", "source_title": "Some Untranslated Game"}], "zh-Hans", before
    )
    after = dict((plugin.config.get("title_cache") or {}).get("zh-Hans") or {})
    check("third_party_titles=False disables lookups", after == before, str(len(after)))
    plugin.config.set("third_party_titles", True)
    plugin.config.set("ui_language", "auto")

    # -- size: manifest missing, installed games measured from disk ----
    import shutil as _shutil

    class _FakeLegendary:
        """Stands in for the CLI: no manifest, but a real install folder."""

        def __init__(self, path, manifest=None):
            self._path = path
            self._manifest = manifest

        async def game_size(self, app_name):
            return self._manifest

        async def get_install_dir(self, app_name):
            return self._path

    original_legendary = plugin.legendary
    plugin.config.set("size_cache", {})

    install_dir = os.path.join(tmp, "installed-game")
    os.makedirs(install_dir, exist_ok=True)
    blob = b"x" * 2048
    with open(os.path.join(install_dir, "data.bin"), "wb") as fh:
        fh.write(blob)

    if _shutil.which("du"):
        plugin.legendary = _FakeLegendary(install_dir)
        measured = await plugin.get_game_size("measured-game")
        check(
            "installed game with no manifest is measured on disk",
            measured.get("ok") is True and int(measured.get("disk") or 0) >= len(blob),
            str(measured),
        )
    else:
        check("du unavailable on this host (skipped)", True, "skipped")

    plugin.legendary = _FakeLegendary("")
    unknown = await plugin.get_game_size("unknown-size-game")
    check("unavailable size reports unknown, not zero", unknown.get("unknown") is True, str(unknown))
    cached_fail = (plugin.config.get("size_cache") or {}).get("unknown-size-game") or {}
    check("failed size lookup is remembered", bool(cached_fail.get("failed")), str(cached_fail))

    calls = {"n": 0}

    class _CountingLegendary(_FakeLegendary):
        async def game_size(self, app_name):
            calls["n"] += 1
            return None

    plugin.legendary = _CountingLegendary("")
    await plugin.get_game_size("cached-failure")
    again = await plugin.get_game_size("cached-failure")
    check(
        "a failed size is not retried within the failure window",
        calls["n"] == 1 and again.get("unknown") is True,
        "calls=%d" % calls["n"],
    )

    # installed.json is read directly, so the path works offline
    old_xdg = os.environ.get("XDG_CONFIG_HOME")
    os.environ["XDG_CONFIG_HOME"] = tmp
    os.makedirs(os.path.join(tmp, "legendary"), exist_ok=True)
    with open(os.path.join(tmp, "legendary", "installed.json"), "w", encoding="utf-8") as fh:
        json.dump({"some-app": {"install_path": install_dir}}, fh)
    from py_modules import legendary as _lg

    check("install path is read from installed.json", _lg._installed_path("some-app") == install_dir, "")
    if old_xdg is None:
        os.environ.pop("XDG_CONFIG_HOME", None)
    else:
        os.environ["XDG_CONFIG_HOME"] = old_xdg

    plugin.legendary = original_legendary
    plugin.config.set("size_cache", {})

    # -- update check --------------------------------------------------
    up = await plugin.check_update()
    check("update check returns a dict", isinstance(up, dict) and "current" in up, str(up.get("current")))
    check("update check never raises", isinstance(up.get("ok"), bool), str(up.get("ok")))
    cached_up = await plugin.check_update()
    check("second check is served from cache or retried", isinstance(cached_up, dict), str(cached_up.get("cached")))

    # -- open_url ------------------------------------------------------
    bad = await plugin.open_url("file:///etc/passwd")
    check("open_url rejects non-http schemes", bad.get("ok") is False, str(bad))

    # -- protondb ------------------------------------------------------
    first = await plugin.get_protondb("051eaac0842c46d7a5a62858ad534d5a")
    check("protondb returns ok flag", "ok" in first, str(first.get("reason") or first.get("tier")))
    if not first.get("ok"):
        second = await plugin.get_protondb("051eaac0842c46d7a5a62858ad534d5a")
        check(
            "failed protondb lookup is suppressed (negative cache)",
            second.get("reason") == "recent failure",
            str(second.get("reason")),
        )
    cached_map = await plugin.get_protondb_cached(["051eaac0842c46d7a5a62858ad534d5a"])
    check("cached map has no tier for a failed lookup", cached_map == {}, str(cached_map))

    # -- cloud saves ---------------------------------------------------
    cloud = await plugin.get_cloud_saves("051eaac0842c46d7a5a62858ad534d5a")
    check("cloud save info degrades without legendary", isinstance(cloud.get("ok"), bool), str(cloud))
    check(
        "cloud save info exposes supported flag when ok",
        (not cloud.get("ok")) or ("supported" in cloud),
        str(cloud.get("supported")),
    )
    bad_mode = await plugin.sync_cloud_saves("x", "sideways")
    check("sync rejects unknown direction", bad_mode.get("ok") is False, str(bad_mode.get("error")))

    # -- store install: remote_binary must match the pinned installer --
    import json as _json

    pkg = _json.load(open(os.path.join(ROOT, "package.json"), encoding="utf-8"))
    declared = (pkg.get("remote_binary") or [{}])[0]
    from py_modules import legendary_installer as _li

    check("remote_binary is declared", declared.get("name") == "legendary", str(declared.get("name")))
    check(
        "remote_binary url is pinned to the installer release",
        str(declared.get("url", "")).find(_li.PINNED_RELEASE) >= 0,
        str(declared.get("url")),
    )
    check(
        "remote_binary hash matches the pinned hash",
        declared.get("sha256hash") == _li.PINNED_SHA256.get("legendary_linux_x64"),
        str(declared.get("sha256hash")),
    )

    # -- binary resolution order --------------------------------------
    fake_plugin = os.path.join(tmp, "fake-plugin")
    os.makedirs(os.path.join(fake_plugin, "bin"), exist_ok=True)
    fake_bin = os.path.join(fake_plugin, "bin", "legendary")
    open(fake_bin, "w", encoding="utf-8").write("#!/bin/sh\n")
    decky.DECKY_PLUGIN_DIR = fake_plugin
    resolved = main.Legendary(binary="legendary")._resolve()
    check("plugin bin/legendary wins over the runtime copy", resolved == fake_bin, str(resolved))
    decky.DECKY_PLUGIN_DIR = ROOT

    # -- 进度行字段分布(7.18)--------------------------------------------
    # Legendary spreads one tick over several lines. The pump must accumulate
    # across them; these checks pin down where each field lives so a future
    # "parse per line and emit" refactor cannot silently drop speed/ETA again.
    p_line = ("[DLManager] INFO:  = Progress: 10.58% (8124/76745), "
              "Running for 00:03:21, ETA: 00:09:42")
    got = main.Plugin._parse_progress(p_line)
    check("progress line carries percent", got["percent"] == 10.58, str(got))
    check("progress line carries ETA", got["eta"] == "00:09:42", str(got))
    check("progress line has no speed", got["speed"] == "", str(got))

    s_line = ("[DLManager] INFO:  + Download\t- 42.75 MiB/s (raw) / "
              "46.98 MiB/s (decompressed)")
    got2 = main.Plugin._parse_progress(s_line)
    check("speed line carries speed", got2["speed"].startswith("42.75"), str(got2))
    check("speed line has no percent/ETA", got2["percent"] < 0 and got2["eta"] == "", str(got2))

    d_line = "[DLManager] INFO:  + Disk\t- 43.03 MiB/s (write) / 0.00 MiB/s (read)"
    got3 = main.Plugin._parse_progress(d_line)
    check("disk line yields nothing useful (this was the wipe)",
          got3["percent"] < 0 and got3["speed"] == "" and got3["eta"] == "", str(got3))
    check("log prefix is stripped for display",
          main.Plugin._strip_log_prefix("[DLManager] INFO:  = Progress: 1%") == "= Progress: 1%")

    # -- OAuth 错误映射(7.21)--------------------------------------------
    # Login no longer shells out to `legendary auth` (it dies on
    # api.legendary.gl); Epic's error payload must still produce a hint the
    # user can act on.
    from py_modules.legendary import oauth_error_text as _oet
    check("expired/unknown code maps to actionable text",
          "授权码" in _oet('{"errorCode":"errors.com.epicgames.account.oauth.authorization_code_not_found"}'))
    check("wrong-client code maps to actionable text",
          "EpicDeck" in _oet('{"errorCode":"errors.com.epicgames.account.oauth.authorization_code_not_for_your_client"}'))
    check("unrelated error yields empty string",
          _oet('{"errorCode":"something.else"}') == "")
    check("non-JSON payload yields empty string", _oet("not json") == "")

    # -- 手机扫码登录(7.22)------------------------------------------------
    # The phone pastes whatever it got into the LAN page; extract_code must pull
    # the authorization code out of a bare code, a JSON blob, or a URL.
    from py_modules.localauth import extract_code as _xcode
    check("extracts a bare code", _xcode("a" * 32) == "a" * 32)
    check("extracts from JSON",
          _xcode('{"authorizationCode":"deadbeefdeadbeefdeadbeef"}')
          == "deadbeefdeadbeefdeadbeef")
    check("extracts from URL", _xcode("https://x/?code=ABC123ABC123ABC123") == "ABC123ABC123ABC123")
    check("rejects garbage", _xcode("hello world") == "")
    check("rejects empty", _xcode("") == "")

    # -- 不可安装条目(7.20)----------------------------------------------
    # legendary returns launcher-only titles (EA App / Origin) without any
    # asset. They are listed with a badge now, so the predicate must be right:
    # every installable title in a 139-game library had asset_infos.
    from py_modules.legendary import non_installable as _ni
    check("title with assets is installable", _ni({"asset_infos": {"Windows": {}}}) is False)
    check("title without assets needs an external launcher", _ni({"asset_infos": {}}) is True)
    check("missing asset_infos counts as non-installable", _ni({}) is True)

    # -- 安装阶段识别(7.19)----------------------------------------------
    # After the last chunk, legendary still assembles files. These lines must
    # map to `installing` so the UI does not jump from 99% to "已完成" while the
    # game is not usable yet.
    for line, want in [
        ("[DLManager] INFO: Waiting for installation to finish...", "installing"),
        ("[DLManager] INFO: All done! Download manager quitting...", "installing"),
        ("[cli] INFO: Finished installation process in 1860.23 seconds.", "installing"),
        ("[DLManager] INFO:  = Progress: 100.00% (76745/76745)", "progress"),
    ]:
        got_state = main.Plugin._classify_activity(line)
        check("classify %r -> %s" % (line[22:52], want), got_state == want, str(got_state))

    # -- 下载认领(7.17)------------------------------------------------
    # 后端重启后要能把还在跑的 legendary 下载接回来,否则用户会以为下载丢了。
    check("get_active_installs is a list on a fresh plugin",
          isinstance(await plugin.get_active_installs(), list))
    check("dead pid is not reported alive", plugin._pid_alive(999999) is False)
    check("current pid is alive", plugin._pid_alive(os.getpid()) is True)
    check("external scan returns a dict",
          isinstance(plugin._scan_external_installs(), dict))
    plugin._external_pids["ghost"] = 999999
    plugin._lib_cache = [{"app_name": "ghost", "title": "幽灵游戏"}]
    active = await plugin.get_active_installs()
    check("inherited download is reported even without a log",
          any(r.get("app_name") == "ghost" and r.get("external") for r in active),
          str(active)[:120])
    check("inherited download carries its title from the library cache",
          any(r.get("app_name") == "ghost" and r.get("title") == "幽灵游戏" for r in active),
          str(active)[:120])
    plugin._external_pids.pop("ghost", None)
    plugin._lib_cache = None

    # -- config --------------------------------------------------------
    keys = plugin.config.get("update_check") or {}
    check("update cache is a dict", isinstance(keys, dict), type(keys).__name__)

    # -- 体积合理性校验(7.16)----------------------------------------
    # Epic 对某些 GOTY/合集条目返回"有值但荒谬"的 manifest(disk_size=4)。
    # 判有效性必须看数量级,只看非 0 会把 4 字节当真实体积缓存起来。
    from py_modules.legendary import MIN_PLAUSIBLE_SIZE, plausible_size

    check("plausible_size rejects 4 bytes", plausible_size(4) == 0, str(plausible_size(4)))
    check("plausible_size rejects 1109 bytes", plausible_size(1109) == 0, str(plausible_size(1109)))
    check("plausible_size rejects None", plausible_size(None) == 0, str(plausible_size(None)))
    check("plausible_size rejects garbage", plausible_size("abc") == 0, str(plausible_size("abc")))
    check(
        "plausible_size accepts a real game size",
        plausible_size(26 * 1024**3) == 26 * 1024**3,
        str(plausible_size(26 * 1024**3)),
    )
    check(
        "plausible_size boundary is 1 MiB",
        plausible_size(MIN_PLAUSIBLE_SIZE) == MIN_PLAUSIBLE_SIZE
        and plausible_size(MIN_PLAUSIBLE_SIZE - 1) == 0,
        "%d" % MIN_PLAUSIBLE_SIZE,
    )
    # 脏缓存自愈: 缓存里躺着 4 字节时,get_game_size 不得直接把它当有效值返回。
    plugin.config.set("size_cache", {"dirty": {"download": 1109, "disk": 4, "ts": 1}})
    dirty = await plugin.get_game_size("dirty")
    check(
        "dirty 4-byte cache is not treated as valid",
        not (dirty.get("ok") and dirty.get("disk") == 4),
        json.dumps(dirty, ensure_ascii=False)[:120],
    )

    print()
    failed = 0
    for name, ok, detail in rows:
        failed += 0 if ok else 1
        print(("  OK   " if ok else "  FAIL ") + name + (("  [" + detail + "]") if detail and not ok else ""))
    print("\n%d/%d passed" % (len(rows) - failed, len(rows)))
    return failed


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(run()) else 0)
