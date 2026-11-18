// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

/**
 * The game detail page: metadata, install/launch/uninstall actions, install
 * location, launch arguments, LSFG toggle, ProtonDB badge and cloud saves.
 *
 * Split out of `fullscreen.tsx` (3513 lines). The `shortcutGameId` helpers live
 * here because this page is the only caller.
 */
import { toaster } from "@decky/api";
import { Dropdown, TextField, ToggleField } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { FaArrowLeft, FaClock, FaDownload, FaPlay, FaSteamSymbol, FaTrash } from "react-icons/fa";
import {
  fmtPlaytime,
  fmtSize,
  getCloudSaves,
  getGameSize,
  getLaunchArgs,
  getLsfg,
  getProtonDb,
  isActive,
  setLaunchArgs,
  setLsfg,
  syncCloudSaves,
  type Game,
  type InstallProgress,
} from "../api";
import { ActionButton, Cover, NavRow, ProgressInline, Scroller } from "../components";
import { t, tf } from "../i18n";
import { actions, shallowEqual, usePluginSelector } from "../store";
import { COLOR } from "../tokens";
import { confirmAction } from "../ui/confirm";
import { Group } from "../ui/primitives";

// Steam does not start games by appid: it uses its own 64-bit GameID. For a
// non-Steam shortcut the GameID is registered in Steam's appStore once the
// shortcut is known; appid itself is a different number.
//
// Passing the appid to RunGame is what made the launch button look dead: the
// call resolves without error and nothing starts. Same-app behaviour verified
// against GameBridge's implementation.
function shortcutGameId(appid: number): string {
  const store = (globalThis as any).appStore;
  const registered = store?.m_mapApps?.get?.(appid)?.gameid;
  if (typeof registered === "string" && registered.length > 0) return registered;
  // Fallback formula used when Steam has not indexed the shortcut yet.
  return ((BigInt(appid) << 32n) | 0x02000000n).toString();
}

// A shortcut added moments ago may not be in appStore yet; poll briefly before
// falling back, otherwise Steam gets a GameID it has never heard of.
async function waitForShortcutGameId(appid: number): Promise<string> {
  const store = (globalThis as any).appStore;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const registered = store?.m_mapApps?.get?.(appid)?.gameid;
    if (typeof registered === "string" && registered.length > 0) return registered;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return shortcutGameId(appid);
}

// ProtonDB tiers, coloured the way the site colours them. Used by the detail
// page badge; an unknown tier simply hides the badge.
const PROTONDB_COLOR: Record<string, string> = {
  platinum: "#d6ecf7",
  gold: "#f0c14b",
  silver: "#c4ccd4",
  bronze: "#c98a4b",
  borked: "#ef6b6b",
  pending: "#9aa3ad",
};

/**
 * A yes/no dialog for destructive actions.
 *
 * Steam Deck's A button is easy to hit by accident, and these actions delete
 * tens of gigabytes, throw away resume state, or interrupt a running game.
 * `showModal` is fire-and-forget, so the promise is settled from the buttons.
 */
/** Detail progress changes matter at 0.1% granularity (it prints one decimal). */
function sameDetailProgress(a?: InstallProgress, b?: InstallProgress): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.state === b.state &&
    a.message === b.message &&
    a.speed === b.speed &&
    Math.abs((a.percent || 0) - (b.percent || 0)) < 0.05
  );
}

export function DetailView({ appName, onBack }: { appName: string; onBack: () => void }) {
  // The detail page only shows its own download, so subscribe to that row
  // instead of the whole state (audit 3.5).
  const { games, dirs, defaultDir } = usePluginSelector(
    (state) => ({ games: state.games, dirs: state.dirs, defaultDir: state.defaultDir }),
    shallowEqual
  );
  const progress = usePluginSelector((state) => state.progress[appName], sameDetailProgress);
  const game = games.find((g) => g.app_name === appName);
  if (!game) {
    return (
      <div style={{ padding: "30px" }}>
        <div style={{ opacity: 0.7, marginBottom: "16px" }}>{t('这个游戏已不在游戏库里。')}</div>
        <ActionButton style={{ padding: "10px 18px", width: "fit-content" }} onClick={onBack}>
          <FaArrowLeft /> {t('返回')}
        </ActionButton>
      </div>
    );
  }
  // onBack 不再往 DetailBody 传：详情页里的「← 游戏库」按钮已删（审计 V4），
  // 返回统一由顶栏「返回」/ B 处理，DetailBody 内部不需要它。
  return <DetailBody game={game} progress={progress} dirs={dirs} defaultDir={defaultDir} />;
}

function DetailBody({
  game,
  progress,
  dirs,
  defaultDir,
}: {
  game: Game;
  progress?: InstallProgress;
  dirs: { path: string; label: string; free: number }[];
  defaultDir: string;
}) {
  const [busy, setBusy] = useState<string>("");
  const [inSteam, setInSteam] = useState<boolean>(game.in_steam);
  const [installed, setInstalled] = useState<boolean>(game.is_installed);
  const [sizes, setSizes] = useState({ download: game.download_size || 0, disk: game.disk_size || 0 });
  // Distinguishes "still asking" from "the backend has nothing to give", so a
  // title with no manifest does not display "读取中…" forever.
  const [sizeUnknown, setSizeUnknown] = useState(false);
  const [target, setTarget] = useState(defaultDir || (dirs.length ? dirs[0].path : ""));
  const [args, setArgs] = useState("");
  const [argsDirty, setArgsDirty] = useState(false);
  const [argsNote, setArgsNote] = useState("");
  const [lsfg, setLsfgState] = useState<{ available: boolean; enabled: boolean; own: boolean }>({
    available: false,
    enabled: false,
    own: false,
  });
  // ProtonDB tier: cached server-side for 7 days, so opening a page twice costs
  // nothing. A missing report just means no badge — never an error.
  const [proton, setProton] = useState<{
    ok: boolean;
    tier?: string;
    label?: string;
    total?: number;
  } | null>(null);
  // Epic cloud saves: only offered when Legendary says the title supports them,
  // and only while installed (there is nothing to sync otherwise).
  const [cloud, setCloud] = useState<{ supported: boolean; folder?: string } | null>(null);
  const [cloudBusy, setCloudBusy] = useState<string>("");

  useEffect(() => {
    setInstalled(game.is_installed);
    setInSteam(game.in_steam);
  }, [game.is_installed, game.in_steam]);

  // Launch arguments live in the plugin config; the Steam wrapper script is
  // rewritten on save so both entry points behave identically.
  useEffect(() => {
    let cancelled = false;
    setArgsDirty(false);
    getLaunchArgs(game.app_name).then((r) => {
      if (cancelled || !r.ok) return;
      setArgs(r.args ?? "");
      setArgsNote(
        r.from_legendary ? t("来自 Legendary 配置（改这里会改为插件接管）") : ""
      );
    });
    return () => {
      cancelled = true;
    };
  }, [game.app_name]);

  // 离开详情页（按 B / 切标签 / 换游戏）时把没来得及保存的参数补一次。
  // 之前 cleanup 只 clearTimeout，900ms 内的输入直接消失，界面也没有"未保存"
  // 提示（审计 2.4）。这个 effect 只在"离开"时跑，不会每敲一个字就发请求。
  const argsDirtyRef = useRef(argsDirty);
  argsDirtyRef.current = argsDirty;
  const argsRef = useRef(args);
  argsRef.current = args;
  useEffect(
    () => () => {
      if (argsDirtyRef.current) {
        void setLaunchArgs(game.app_name, argsRef.current);
      }
    },
    [game.app_name]
  );

  useEffect(() => {
    if (!argsDirty) return;
    const timer = setTimeout(async () => {
      const r = await setLaunchArgs(game.app_name, args);
      setArgsDirty(false);
      if (!r.ok) toaster.toast({ title: t("启动参数保存失败"), body: r.error ?? "" });
      else if (r.warning) toaster.toast({ title: t("已保存，但 Steam 快捷方式未更新"), body: r.warning });
      else setArgsNote(t("已保存，下次启动生效"));
    }, 900);
    return () => clearTimeout(timer);
  }, [args, argsDirty, game.app_name]);

  // LSFG-VK frame-gen toggle. Only shown when ~/lsfg exists (the Decky LSFG-VK
  // plugin creates it); a per-game override wins over the global default.
  useEffect(() => {
    let cancelled = false;
    getLsfg(game.app_name).then((r) => {
      if (cancelled || !r?.ok) return;
      setLsfgState({ available: r.available, enabled: r.enabled, own: r.own });
    });
    return () => {
      cancelled = true;
    };
  }, [game.app_name]);

  useEffect(() => {
    let cancelled = false;
    setProton(null);
    getProtonDb(game.app_name).then((r) => {
      if (cancelled || !r?.ok || !r.tier) return;
      setProton({ ok: true, tier: r.tier, label: r.label, total: r.total });
    });
    return () => {
      cancelled = true;
    };
  }, [game.app_name]);

  useEffect(() => {
    let cancelled = false;
    setCloud(null);
    if (!installed) return;
    getCloudSaves(game.app_name).then((r) => {
      if (cancelled || !r?.ok || !r.supported) return;
      setCloud({ supported: true, folder: r.folder });
    });
    return () => {
      cancelled = true;
    };
  }, [game.app_name, installed]);

  const doCloudSync = async (mode: "sync" | "upload" | "download") => {
    // Downloading (and two-way sync) can overwrite newer local saves, so both
    // require an explicit yes. Upload is additive and needs no prompt.
    if (mode !== "upload") {
      const ok = await confirmAction(
        mode === "download" ? t("下载云端存档？") : t("双向同步存档？"),
        t("本地存档会先备份，然后被云端版本覆盖。"),
        t("继续")
      );
      if (!ok) return;
    }
    setCloudBusy(mode);
    try {
      const r = await syncCloudSaves(game.app_name, mode);
      if (r.ok) {
      toaster.toast({
        title: t("云存档已同步"),
        body:
          mode === "upload"
            ? t("本地存档已上传")
            : mode === "download"
            ? t("云端存档已下载")
            : t("双向同步完成"),
      });
      } else {
        toaster.toast({ title: t("云存档同步失败"), body: r.error ?? "" });
      }
    } catch (err) {
      toaster.toast({ title: t("云存档同步失败"), body: String(err).slice(0, 140) });
    } finally {
      setCloudBusy("");
    }
  };

  const toggleLsfg = async (v: boolean) => {
    const r = await setLsfg(game.app_name, v);
    if (!r.ok) toaster.toast({ title: t("插帧设置失败"), body: t("请重试") });
    else {
      setLsfgState((s) => ({ ...s, enabled: v, own: true }));
      if (r.warning) toaster.toast({ title: t("已保存，但 Steam 快捷方式未更新"), body: r.warning });
    }
  };

  // Opening a detail page for a title the background job has not reached yet
  // fetches its manifest right away instead of waiting for the crawl.
  useEffect(() => {
    setSizes({ download: game.download_size || 0, disk: game.disk_size || 0 });
    setSizeUnknown(false);
    if (game.disk_size) return;
    // Installed games normally know their footprint, but an old install can
    // have `installed_size: 0` — then the manifest/`du` figure is what we show.
    if (game.is_installed && game.installed_size > 0) return;
    let cancelled = false;
    getGameSize(game.app_name).then((r) => {
      if (cancelled) return;
      if (r.ok) setSizes({ download: r.download || 0, disk: r.disk || 0 });
      else setSizeUnknown(true);
    });
    return () => {
      cancelled = true;
    };
  }, [game.app_name, game.download_size, game.disk_size, game.is_installed, game.installed_size]);

  // 这页上的按钮全部走 `ActionButton`：它已经把 onActivate + onClick 合成一次
  // 并做 300ms 去重，所以这里不再需要自己的 once() 守卫（审计 3.6）。

  const doInstall = async () => {
    setBusy("install");
    try {
      const r = await actions.install(game.app_name, target);
      if (r.ok) toaster.toast({ title: t("开始下载"), body: game.title });
      else toaster.toast({ title: t("安装失败"), body: r.error ?? "" });
    } catch (err) {
      toaster.toast({ title: t("安装失败"), body: String(err).slice(0, 140) });
    } finally {
      setBusy("");
    }
  };

  const doLaunch = async () => {
    setBusy("launch");
    try {
      // Steam has to be the one that spawns the game — gamescope only switches
      // away from the Steam UI when Steam believes a game is running — and it
      // only does that for a shortcut it owns. Waiting for an entry that does
      // not exist used to end in a background launch: sound, no picture.
      if (!inSteam) {
        toaster.toast({
          title: t("正在添加到 Steam"),
          body: t("首次启动前需要先建立 Steam 条目"),
        });
        const added = await actions.addToSteam(game.app_name);
        if (!added.ok) {
          toaster.toast({ title: t("添加到 Steam 失败"), body: added.error ?? "" });
          return;
        }
        setInSteam(true);
      }

      const r = await actions.launch(game.app_name);
      if (!r.ok) {
        toaster.toast({ title: t("启动失败"), body: r.error ?? "" });
        return;
      }
      // RunGame takes Steam's own GameID (not the appid) and a 4th argument of
      // 100; see shortcutGameId() above for why the naive call does nothing.
      //
      // Keep the *object* and call the method on it. Pulling RunGame out into a
      // local (`const f = apps.RunGame; f(...)`) loses `this` — it is a native
      // method and throws, which then fell through to the direct-spawn fallback
      // and produced sound with no picture.
      const apps = (globalThis as any).SteamClient?.Apps;
      if (r.appid && apps && typeof apps.RunGame === "function") {
        try {
          const gameId = await waitForShortcutGameId(r.appid);
          await apps.RunGame(gameId, "", -1, 100);
          if (r.note) toaster.toast({ title: t("正在启动"), body: r.note });
          return;
        } catch (err) {
          console.warn("SteamClient.Apps.RunGame failed, using direct launch", err);
          toaster.toast({
            title: t("Steam 启动失败，已改用后台启动"),
            body: String(err).slice(0, 120),
          });
        }
      }
      const fallback = await actions.launch(game.app_name, true);
      if (!fallback.ok) toaster.toast({ title: t("启动失败"), body: fallback.error ?? "" });
      else if (fallback.note) toaster.toast({ title: t("正在启动"), body: fallback.note });
    } catch (err) {
      // A rejected callable used to leave `busy="launch"` forever.
      toaster.toast({ title: t("启动失败"), body: String(err).slice(0, 140) });
    } finally {
      setBusy("");
    }
  };

  const doUninstall = async () => {
    const ok = await confirmAction(
      t("卸载游戏？"),
      t("会删除游戏文件（存档保留）。想保留游戏请先取消。"),
      t("卸载")
    );
    if (!ok) return;
    setBusy("uninstall");
    try {
      const r = await actions.uninstall(game.app_name);
      if (r.ok) {
        setInstalled(false);
        toaster.toast({ title: t("已卸载"), body: game.title });
      } else {
        toaster.toast({ title: t("卸载失败"), body: r.error ?? "" });
      }
    } catch (err) {
      toaster.toast({ title: t("卸载失败"), body: String(err).slice(0, 140) });
    } finally {
      setBusy("");
    }
  };

  const doCancel = async () => {
    const ok = await confirmAction(
      t("取消下载？"),
      t("会删除已下载的进度，下次需要重新下载。只想暂时停下请用「暂停」。"),
      t("取消下载")
    );
    if (!ok) return;
    await actions.cancel(game.app_name);
  };

  const doToggleSteam = async () => {
    setBusy("steam");
    try {
      const r = inSteam
        ? await actions.removeFromSteam(game.app_name)
        : await actions.addToSteam(game.app_name);
      if (r.ok) {
        setInSteam(!inSteam);
        toaster.toast({
          title: inSteam ? t("已从 Steam 移除") : t("已添加到 Steam"),
          body: inSteam ? "" : t("重启 Steam 后生效"),
        });
      } else {
        toaster.toast({ title: inSteam ? t("移除失败") : t("添加失败"), body: r.error ?? "" });
      }
    } catch (err) {
      toaster.toast({ title: inSteam ? t("移除失败") : t("添加失败"), body: String(err).slice(0, 140) });
    } finally {
      setBusy("");
    }
  };

  const active = isActive(progress);
  const dirOptions = dirs.map((d) => ({ data: d.path, label: d.label }));

  return (
    <div className="ed-fade" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* 「← 游戏库」chip 已删（第三轮审计 V4）：顶栏「返回」在详情里就是"先关详情"，
          同一件事两个按钮还多占一行。onBack 仍由顶栏返回 / B 使用。 */}
      <Scroller contentStyle={{ paddingRight: "6px", paddingBottom: "2.5em" }}>
      <div style={{ display: "flex", gap: "1.6em", minHeight: 0 }}>
        {/* em, not px: the cover scales with the page's root font size, which
            is what keeps the detail view proportional on a docked display. */}
        <div style={{ width: "14.75em", flexShrink: 0 }}>
          <Cover
            url={game.cover_url}
            title={game.title}
            width="14.75em"
            height="22.1em"
            radius={12}
          />
          <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
            <span
              className="ed-chip"
              style={{
                padding: "4px 10px",
                fontSize: "0.84em",
                color: installed ? COLOR.success : "rgba(255,255,255,0.7)",
              }}
            >
              {installed ? t("已安装") : t("未安装")}
            </span>
            {inSteam ? (
              <span
                className="ed-chip"
                style={{ padding: "4px 10px", fontSize: "0.84em", display: "flex", gap: "5px", alignItems: "center" }}
              >
                <FaSteamSymbol /> Steam
              </span>
            ) : null}
            {proton?.tier ? (
              <span
                className="ed-chip"
                title={
                  proton.total
                    ? tf("ProtonDB:{0}({1} 份报告)", t(proton.label ?? ""), proton.total ?? 0)
                    : `ProtonDB:${t(proton.label ?? "")}`
                }
                style={{
                  padding: "4px 10px",
                  fontSize: "0.84em",
                  color: PROTONDB_COLOR[proton.tier] ?? "rgba(255,255,255,0.75)",
                }}
              >
                ProtonDB {t(proton.label ?? "")}
                {proton.total ? ` · ${proton.total}` : ""}
              </span>
            ) : null}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "14px" }}>
          <div>
            <div style={{ fontSize: "1.55em", fontWeight: 800, lineHeight: 1.2 }}>{game.title}</div>
            <div style={{ marginTop: "6px", fontSize: "0.85em", opacity: 0.6, display: "flex", gap: "14px", flexWrap: "wrap" }}>
              <span>
                {installed
                  ? game.installed_size > 0
                    ? t("已占用 ") + fmtSize(game.installed_size)
                    : sizes.disk
                    ? t("已占用 ") + fmtSize(sizes.disk)
                    : sizeUnknown
                    ? t("体积未知")
                    : t("体积读取中…")
                  : sizes.disk
                  ? t("安装后 ") + fmtSize(sizes.disk)
                  : sizeUnknown
                  ? t("体积未知")
                  : t("体积读取中…")}
              </span>
              {!installed && sizes.download > 0 ? <span>{tf("需下载 {0}", fmtSize(sizes.download))}</span> : null}
              {game.playtime_seconds > 0 ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                  <FaClock size="0.9em" /> {fmtPlaytime(game.playtime_seconds)}
                </span>
              ) : null}
            </div>
          </div>

          {active && progress ? (
            <Group style={{ padding: "14px 16px" }}>
              <ProgressInline progress={progress} />
            </Group>
          ) : null}

          <NavRow level="detail-actions" style={{ gap: "10px", flexWrap: "wrap" }}>
            {game.non_installable ? (
              /* Owned but legendary cannot install it: the entitlement has no
                 downloadable asset (EA App / Origin activation). Say so instead
                 of offering a button that is guaranteed to fail. */
              <div
                className="ed-info"
                style={{
                  padding: "10px 14px",
                  fontSize: "0.85em",
                  color: COLOR.warning,
                  lineHeight: 1.55,
                  maxWidth: "40em",
                }}
              >
                {t("这个条目需要第三方启动器（EA App / Origin 等）才能安装，EpicDeck 暂不支持直接下载。")}
              </div>
            ) : installed ? (
              <ActionButton
                primary
                disabled={!!busy}
                style={{ padding: "12px 26px", fontSize: "1em" }}
                onClick={doLaunch}
              >
                <FaPlay /> {busy === "launch" ? t("正在启动…") : t("启动游戏")}
              </ActionButton>
            ) : active ? (
              <ActionButton
                danger
                disabled={!!busy}
                style={{ padding: "12px 26px", fontSize: "1em" }}
                onClick={() => void doCancel()}
              >
                <FaTrash /> {t('取消下载')}
              </ActionButton>
            ) : (
              <ActionButton
                primary
                disabled={!!busy}
                style={{ padding: "12px 26px", fontSize: "1em" }}
                onClick={doInstall}
              >
                <FaDownload /> {busy === "install" ? t("正在准备…") : t("下载并安装")}
              </ActionButton>
            )}

            <ActionButton
              disabled={!!busy || !installed}
              style={{ padding: "12px 20px", fontSize: "0.95em" }}
              onClick={doToggleSteam}
            >
              <FaSteamSymbol /> {inSteam ? t("从 Steam 移除") : t("添加到 Steam")}
            </ActionButton>

            {installed ? (
              <ActionButton
                danger
                disabled={!!busy}
                style={{ padding: "12px 20px", fontSize: "0.95em" }}
                onClick={doUninstall}
              >
                <FaTrash /> {t('卸载')}
              </ActionButton>
            ) : null}
          </NavRow>

          {!installed && !active ? (
            <Group style={{ padding: "14px 16px" }}>
              <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>{t('安装位置')}</div>
              <Dropdown
                rgOptions={dirOptions}
                selectedOption={target}
                onChange={(e) => setTarget(e.data)}
              />
            </Group>
          ) : null}

          <Group style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>
              {t("启动参数")}{argsNote ? ` · ${argsNote}` : ""}
            </div>
            <TextField
              value={args}
              onChange={(e: any) => {
                setArgs(e.target.value);
                setArgsDirty(true);
              }}
            />
            <div style={{ fontSize: "0.78em", opacity: 0.45, marginTop: "6px" }}>
              {t("追加在 legendary launch 之后，如 -windowed；留空即不添加")}
            </div>
          </Group>

          {lsfg.available ? (
            <Group style={{ padding: "14px 16px" }}>
              <ToggleField
                label={t("小黄鸭插帧（LSFG-VK）")}
                description={
                  lsfg.own
                    ? t("本游戏单独设置（优先于全局默认）")
                    : t("跟随全局默认；打开后通过 ~/lsfg 包一层插帧")
                }
                checked={lsfg.enabled}
                onChange={(v) => void toggleLsfg(v)}
              />
              <div
                style={{
                  fontSize: "0.84em",
                  marginTop: "8px",
                  color: lsfg.enabled ? COLOR.success : "rgba(255,255,255,0.5)",
                }}
              >
                {lsfg.enabled
                  ? t("已开启：启动时会经 ~/lsfg 包装插帧（可在启动日志里看到 [lsfg] 记录）")
                  : t("已关闭：启动时不加插帧层")}
              </div>
              <div style={{ fontSize: "0.82em", marginTop: "6px", opacity: 0.5 }}>
                {t('插帧通过 ~/lsfg 包装实现，不会写入上方「启动参数」，所以启动参数里看不到。')}
              </div>
            </Group>
          ) : null}

          {cloud?.supported && installed ? (
            <Group style={{ padding: "14px 16px" }}>
              <div style={{ fontSize: "0.9em", marginBottom: "8px" }}>
                {t("Epic 云存档")}
                {cloud.folder ? (
                  <span style={{ opacity: 0.55, marginLeft: "8px", fontSize: "0.85em" }}>
                    {cloud.folder}
                  </span>
                ) : null}
              </div>
              <NavRow level="detail-actions" style={{ gap: "8px", flexWrap: "wrap" }}>
                <ActionButton
                  style={{ padding: "9px 14px", fontSize: "0.86em" }}
                  disabled={!!cloudBusy}
                  onClick={() => void doCloudSync("download")}
                >
                  {cloudBusy === "download" ? t("下载中…") : t("下载云端存档")}
                </ActionButton>
                <ActionButton
                  style={{ padding: "9px 14px", fontSize: "0.86em" }}
                  disabled={!!cloudBusy}
                  onClick={() => void doCloudSync("upload")}
                >
                  {cloudBusy === "upload" ? t("上传中…") : t("上传本地存档")}
                </ActionButton>
                <ActionButton
                  style={{ padding: "9px 14px", fontSize: "0.86em" }}
                  disabled={!!cloudBusy}
                  onClick={() => void doCloudSync("sync")}
                >
                  {cloudBusy === "sync" ? t("同步中…") : t("双向同步")}
                </ActionButton>
              </NavRow>
              <div style={{ fontSize: "0.82em", marginTop: "8px", opacity: 0.55 }}>
                {t('只在点按钮时同步；插件不会在启动时自动覆盖本地存档。')}
              </div>
            </Group>
          ) : null}

          {/* Focusable on purpose: it sits below the last interactive element
              (the LSFG toggle), and a focused element is the only thing the
              navigator scrolls to. `.ed-info` gives the cursor a landing spot
              so the left stick can reach this line — and the LSFG hint above it. */}
          <div tabIndex={0} className="ed-info" style={{ fontSize: "0.82em", opacity: 0.7 }}>
            {game.app_name}
            {tf(" · 版本 {0}", game.version || t("未知"))}
          </div>
        </div>
      </div>
      </Scroller>
    </div>
  );
}
