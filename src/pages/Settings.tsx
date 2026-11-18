// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

/**
 * Settings tab: account card, data locations, language, download knobs, the
 * Steam-integration switches and the maintenance actions.
 *
 * Split out of `fullscreen.tsx` (3513 lines). The page owns no focus logic —
 * the shell's row/column navigator walks whatever controls it renders.
 */
import { toaster } from "@decky/api";
import { ConfirmModal, Dropdown, Focusable, TextField, ToggleField, showModal } from "@decky/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { FaRedo, FaSteamSymbol } from "react-icons/fa";
import {
  LOCALE_OPTIONS,
  checkEnvironment,
  checkUpdate,
  clearDownloadCache,
  dataLocations,
  exportLogs,
  fmtSize,
  getInstallDirOptions,
  getLegendaryVersion,
  getLsfg,
  getProtonOptions,
  getSettings,
  installLegendary,
  isActive,
  maskPersonal,
  openUrl,
  refreshArtwork,
  refreshSteam,
  resolveInstallDir,
  setLsfg,
  setSetting,
  syncInstalledToSteam,
  type DataLocation,
} from "../api";
import { ActionButton, NavRow, Scroller, StatBlock } from "../components";
import { claimFocusRing, focusOwned } from "../geomnav";
import { t, tf } from "../i18n";
import { bootstrapLang } from "../langboot";
import { readFsUI, writeFsUI } from "../shell/fsui";
import { PLUGIN_VERSION } from "../shell/version";
import { signOut, switchAccount, usePluginState } from "../store";
import { COLOR } from "../tokens";
import { confirmAction } from "../ui/confirm";
import { Group, SectionTitle } from "../ui/primitives";

/**
 * Copy text from inside Steam's CEF.
 *
 * `navigator.clipboard` needs a secure context and a focused document, which
 * is why the legacy `execCommand` path is the one that usually runs here. Both
 * operate on the document passed in: `document` in plugin code can be the 1x1
 * SharedJSContext window, so callers hand in the Big Picture document taken
 * from a rendered element.
 */
async function copyToClipboard(doc: Document, text: string): Promise<boolean> {
  const view = doc.defaultView;
  try {
    const clipboard = view?.navigator?.clipboard;
    if (clipboard && typeof clipboard.writeText === "function") {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    /* no secure context, or the permission was denied: fall through */
  }
  const previous = doc.activeElement as HTMLElement | null;
  let area: HTMLTextAreaElement | null = null;
  try {
    area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
    doc.body.appendChild(area);
    area.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    // Leaving the textarea behind leaks a node per press and steals the
    // gamepad focus; hand both back.
    if (area) area.remove();
    if (previous && doc.contains(previous)) {
      try {
        previous.focus();
      } catch {
        /* focus is best effort */
      }
    }
  }
}

/**
 * Where the games, saves, config and logs actually live.
 *
 * Decky's uninstall only removes `plugins/<Name>`, so this doubles as the
 * answer to "if I remove the plugin, what do I lose?" — each row says it in
 * its note. Focusable on purpose: a plain div cannot be reached with the
 * stick, and the copy action needs A.
 */
function DataLocations() {
  const [items, setItems] = useState<DataLocation[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  // Steam can deliver both onClick and onActivate for one A press; without a
  // guard that shows the toast twice.
  const lastCopy = useRef(0);

  useEffect(() => {
    let alive = true;
    void dataLocations()
      .then((r) => {
        if (!alive || !r?.ok) return;
        setItems(
          (r.items ?? []).filter((i) => i && typeof i.path === "string" && i.path.length > 0)
        );
      })
      .catch(() => {
        /* older backend without the callable: the section stays hidden */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!items.length) return null;

  const copy = async (path: string) => {
    const now = Date.now();
    if (now - lastCopy.current < 400) return;
    lastCopy.current = now;
    // Take the document from our own rendered node: the module-level
    // `document` may be the hidden 1x1 plugin window, which cannot touch the
    // Big Picture clipboard.
    const doc = boxRef.current?.ownerDocument ?? document;
    const ok = await copyToClipboard(doc, path);
    toaster.toast({
      title: ok ? t("已复制路径") : t("复制失败"),
      body: ok ? path : t("剪贴板不可用，请手动记录这一行"),
    });
  };

  return (
    <div ref={boxRef}>
      <SectionTitle hint={t("卸载插件只删插件代码，下面这些都会保留")}>{t('数据位置')}</SectionTitle>
      <Group>
        <NavRow flow="vertical" level="storage" style={{ gap: "8px" }}>
          {items.map((it) => (
            <Focusable
              key={it.key}
              noFocusRing
              className="ed-loc"
              // Decky's Focusable defaults to a flex column (that is what
              // squeezed the QAM account row into one character per line);
              // block keeps the three lines stacked as written.
              style={{ display: "block" }}
              onClick={() => void copy(it.path)}
              onActivate={() => void copy(it.path)}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: "10px",
                }}
              >
                <span style={{ fontWeight: 600, fontSize: "0.9em" }}>{it.label}</span>
                <span style={{ fontSize: "0.8em", opacity: 0.45, flexShrink: 0 }}>{t('按 A 复制')}</span>
              </div>
              <div className="ed-loc-path">{it.path}</div>
              <div style={{ fontSize: "0.82em", opacity: 0.5, marginTop: "3px" }}>{it.note}</div>
            </Focusable>
          ))}
        </NavRow>
      </Group>
    </div>
  );
}

export function SettingsTab({ onGoLogin }: { onGoLogin: () => void }) {
  const { auth, games, progress } = usePluginState();
  // The plugin JS runs in Decky's 1×1 SharedJSContext, so the module-level
  // `document` belongs to that hidden window and never contains `.ed-surface`.
  // Everything below must read the real Big Picture document off a rendered
  // node's `ownerDocument` (HANDOFF 5.10 / 886).
  const rootRef = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [dirs, setDirs] = useState<{ path: string; label: string; free: number }[]>([]);
  const [protons, setProtons] = useState<{ data: string; label: string }[]>([]);
  const [customPath, setCustomPath] = useState<string>("");
  const [savingPath, setSavingPath] = useState(false);
  const [busy, setBusy] = useState<string>("");
  const [env, setEnv] = useState<{ legendary?: string; proton?: string }>({});
  const [lsfgAvailable, setLsfgAvailable] = useState(false);
  // null = still checking / check failed (row shows the plain version line);
  // an object with has_update flips the row into "new version" mode.
  const [updateInfo, setUpdateInfo] = useState<{ latest?: string; has_update?: boolean; url?: string } | null>(null);

  // If the user jumped here from the downloads tab's "下载设置" button, land on
  // the 下载 section instead of the top of the page. The intent is carried in
  // FsUI and consumed (cleared) here so a later manual visit starts at the top.
  useEffect(() => {
    const target = readFsUI().settingsSection;
    if (target) {
      writeFsUI({ settingsSection: "" });
      const timer = window.setTimeout(() => {
        const root = rootRef.current;
        if (!root || !root.isConnected) return;
        const el = root.ownerDocument.querySelector(`[data-ed-section="${target}"]`) as HTMLElement | null;
        if (!el) return;
        // scrollIntoView does nothing on Steam's ScrollPanel; walk up to the real
        // overflow-y container and nudge its scrollTop to reveal the section.
        const doc = root.ownerDocument;
        const view = doc.defaultView;
        let container: HTMLElement | null = el.parentElement;
        while (container && container !== doc.body) {
          const style = view?.getComputedStyle(container);
          if (/(auto|scroll)/.test(style?.overflowY || "") && container.scrollHeight > container.clientHeight + 4) {
            const cTop = container.getBoundingClientRect().top;
            container.scrollTop += el.getBoundingClientRect().top - cTop;
            break;
          }
          container = container.parentElement;
        }
        // 只滚不落焦的话，光标还停在顶栏 chip 上，下一次按"下"又按 chip 的
        // 几何位置选目标，页面被拉回顶部（审计 1.14）。
        const landing = el.querySelector<HTMLElement>(".ed-action,[tabindex]");
        if (landing) {
          focusOwned(landing);
          claimFocusRing(landing, root.ownerDocument.querySelector(".ed-surface") as HTMLElement || root);
        }
      }, 120);
      return () => window.clearTimeout(timer);
    }
    // Normal open: force the scroll back to the top AND focus the first account
    // action. Steam's ScrollPanel keeps its scrollTop across tab switches, so
    // re-opening Settings can land mid-page — the account row (切换账号/登出)
    // sits at negative y, Steam focuses the first *visible* control
    // ("补齐封面与图标") and keeps it in view, which defeats any scrollTop=0
    // reset done alone (focus re-scrolls back to it). So scroll to top *and*
    // focus the top control together, so "keep focused visible" agrees with
    // "at the top". scrollIntoView does nothing on Steam's panel; scrollTop=0
    // is the one that works — and it must be set on the *real* scroll container
    // (an ancestor with overflow-y:auto), found by walking up from the account
    // row exactly like qam.tsx does. Searching the .ed-fade subtree for the
    // first "overflow:auto" node is unreliable: the true scroller sits *outside*
    // the ScrollPanelGroup, and a Panel Focusable in between reports
    // scrollHeight>clientHeight with overflow:visible whose scrollTop is ignored.
    const settle = () => {
      const root = rootRef.current;
      if (!root || !root.isConnected) return;
      const doc = root.ownerDocument;
      const surface = (root.closest(".ed-surface") as HTMLElement | null) || root;
      const first = surface.querySelector<HTMLElement>(".ed-group .ed-action, .ed-action");
      if (!first) return;
      // The later timers used to yank the cursor back even after the user had
      // started navigating. Once focus is on something *inside* the page that
      // is not our landing target, the user owns it.
      const current = doc.activeElement as HTMLElement | null;
      // 只有"用户自己已经把光标挪到页面里"才让位。从顶栏 chip 进来时
      // activeElement 就是那个 chip（在 surface 内、也不是 first），旧判断会直接
      // return：不滚顶、不落焦，于是上次停在"维护"这次还停在"维护"（审计 1.7）。
      const onHeaderChip = !!current?.closest?.('[data-ed-level="header"]');
      if (current && current !== first && surface.contains(current) && !onHeaderChip) return;
      const view = doc.defaultView;
      // Find the real vertical scroller by walking up from the account row.
      let container: HTMLElement | null = first.parentElement;
      while (container && container !== doc.body) {
        const style = view?.getComputedStyle(container);
        const scrollable = /(auto|scroll)/.test(style?.overflowY || "");
        if (scrollable && container.scrollHeight > container.clientHeight + 4) {
          container.scrollTop = 0;
          break;
        }
        container = container.parentElement;
      }
      focusOwned(first);
      claimFocusRing(first, surface);
    };
    const timers: number[] = [];
    // 40/220 only: the 420/900 ms repeats were what kept stealing focus.
    [40, 220].forEach((ms) => timers.push(window.setTimeout(settle, ms)));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  // Version check rides along with the settings load: cached for a day on the
  // backend, silent on failure, so it never adds a spinner or an error to the
  // page (HANDOFF 7.13.5).
  useEffect(() => {
    let cancelled = false;
    checkUpdate()
      .then((r) => {
        if (cancelled || !r) return;
        // A failed refresh still carries the last known release from the cache,
        // so keep showing it instead of hiding the button on a flaky network.
        if (!r.ok && !r.has_update) return;
        setUpdateInfo({ latest: r.latest, has_update: r.has_update, url: r.url });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    (async () => {
      const [s, d, p, lv, e, lsfg] = await Promise.all([
        getSettings(),
        getInstallDirOptions(),
        getProtonOptions().catch(() => ({ options: [] as { data: string; label: string }[] })),
        getLegendaryVersion().catch(() => ({ ok: false })),
        checkEnvironment().catch(() => null),
        getLsfg("").catch(() => ({ ok: false, available: false, default: false })),
      ]);
      setSettings(s);
      setDirs(d.options ?? []);
      setProtons(p.options ?? []);
      setCustomPath(s.install_dir || d.current || "");
      setEnv({
        legendary: (lv as any)?.version || (e as any)?.legendary_path || "",
        proton: (e as any)?.proton_path || "",
      });
      setLsfgAvailable((lsfg as any)?.available ?? false);
    })();
  }, []);

  const update = async (key: string, value: any) => {
    setSettings((s) => ({ ...s, [key]: value }));
    await setSetting(key, value);
    if (
      key === "title_locale" ||
      key === "third_party_titles" ||
      key === "ui_language" ||
      key === "auto_fetch_size"
    ) {
      // Re-render from the backend snapshot; no entitlement refetch.
      window.dispatchEvent(new CustomEvent("epicdeck:library-changed"));
    }
    // use_proton needs no library reload at all: the backend rewrites the
    // launcher wrappers when the setting is saved.
  };

  const applyCustomPath = async () => {
    if (savingPath) return;
    if (!customPath.trim()) {
      toaster.toast({ title: t("请填写路径"), body: t("留空则使用上面的默认安装目录") });
      return;
    }
    setSavingPath(true);
    try {
      const r = await resolveInstallDir(customPath);
      if (!r.ok || !r.path) {
        toaster.toast({ title: t("路径无效"), body: r.error ?? "" });
        return;
      }
      setCustomPath(r.path);
      await update("install_dir", r.path);
      toaster.toast({ title: t("已保存安装目录"), body: r.path });
    } finally {
      setSavingPath(false);
    }
  };

  const done = (title: string, body: string) => toaster.toast({ title, body });

  const stats = useMemo(() => {
    const installed = games.filter((g) => g.is_installed);
    const totalSeconds = games.reduce((sum, g) => sum + (g.playtime_seconds || 0), 0);
    const size = installed.reduce((sum, g) => sum + (g.installed_size || 0), 0);
    return {
      total: games.length,
      installed: installed.length,
      steam: games.filter((g) => g.in_steam).length,
      hours: totalSeconds / 3600,
      size,
      downloading: Object.values(progress).filter((p) => isActive(p)).length,
    };
  }, [games, progress]);

  return (
    <div ref={rootRef} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
    <Scroller className="ed-fade" contentStyle={{ paddingRight: "6px", paddingBottom: "1.6em" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "18px", maxWidth: "1040px", paddingBottom: "1.8em" }}>
        {/* account */}
        <div>
          <SectionTitle hint={t("Epic 账号与库概况")}>{t('账号')}</SectionTitle>
          <div className="ed-group" style={{ padding: "18px 20px", display: "flex", gap: "18px", alignItems: "center" }}>
            <div
              style={{
                width: "58px",
                height: "58px",
                borderRadius: "50%",
                background: "linear-gradient(135deg, #3f8ef7 0%, #6d5efc 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.4em",
                fontWeight: 800,
                flexShrink: 0,
              }}
            >
              {(auth?.display_name || "?").slice(0, 1).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "1.15em", fontWeight: 700 }}>
                {auth?.display_name || t("未登录")}
              </div>
              <div style={{ fontSize: "0.82em", opacity: 0.55, marginTop: "3px" }}>
                {auth?.account_id ? tf("账号 ID {0}", maskPersonal(auth.account_id)) : t("尚未登录 Epic 账号")}
                {stats.hours > 0 ? tf(" · 累计游玩 {0} 小时", stats.hours.toFixed(1)) : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: "10px", flexShrink: 0 }}>
              {auth?.logged_in ? (
                <>
                  <ActionButton
                    style={{ padding: "10px 18px", fontSize: "0.9em" }}
                    onClick={async () => {
                      const ok = await confirmAction(
                        t("切换 Epic 账号？"),
                        t("会退出当前账号、清空本账号缓存，并清除 Steam 内置浏览器的网站数据（用于重新选择 Epic 账号）。"),
                        t("切换账号")
                      );
                      if (!ok) return;
                      const r = await switchAccount();
                      if (r.ok) done(t("已切换账号"), t("下次登录会要求输入新账号"));
                      else done(t("切换失败"), r.error ?? "");
                    }}
                  >
                    {t('切换账号')}
                  </ActionButton>
                  <ActionButton
                    style={{ padding: "10px 18px", fontSize: "0.9em" }}
                    onClick={async () => {
                      // Signing out deletes the credentials on disk, so the user
                      // has to go through Epic's browser flow again. That is
                      // destructive enough to deserve the same prompt as
                      // "switch account" — 2026-11-09 a stray click did it.
                      const ok = await confirmAction(
                        t("登出 Epic 账号？"),
                        t("会删除本机保存的登录凭据，下次需要重新登录。游戏文件与存档不受影响。"),
                        t("登出")
                      );
                      if (!ok) return;
                      const r = await signOut();
                      if (r.ok) done(t("已登出"), t("下次登录会沿用当前账号"));
                      else done(t("登出失败"), r.error ?? "");
                    }}
                  >
                    {t('登出')}
                  </ActionButton>
                </>
              ) : (
                <ActionButton
                  primary
                  style={{ padding: "10px 18px", fontSize: "0.9em" }}
                  onClick={onGoLogin}
                >
                  {t('去登录')}
                </ActionButton>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "12px", marginTop: "12px" }}>
            <StatBlock label={t("游戏总数")} value={stats.total} sub={t("Epic 库中拥有")} />
            <StatBlock label={t("已安装")} value={stats.installed} sub={tf("占用 {0}", fmtSize(stats.size))} accent={COLOR.success} />
            <StatBlock label={t("加入 Steam")} value={stats.steam} sub={t("非 Steam 快捷方式")} />
            <StatBlock
              label={t("下载任务")}
              value={stats.downloading}
              sub={stats.downloading > 0 ? t("正在下载") : t("空闲")}
              accent={stats.downloading > 0 ? COLOR.accentSoft : undefined}
            />
          </div>
        </div>

        {/* steam */}
        <div>
          <SectionTitle hint={t("决定游戏是否出现在 Steam 库里")}>{t('Steam 集成')}</SectionTitle>
          <Group>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <ToggleField
                label={t("自动添加到 Steam")}
                description={t("下载完成后自动写入 Steam 的非 Steam 快捷方式")}
                checked={!!settings.auto_add_to_steam}
                onChange={(v) => update("auto_add_to_steam", v)}
              />
              <ToggleField
                label={t("自动下载封面图")}
                description={t("把 Epic 的竖版封面/横幅写进 Steam 的 grid 目录")}
                checked={settings.auto_cover !== false}
                onChange={(v) => update("auto_cover", v)}
              />
              {/* 功能尚未做完（HANDOFF 7.13 侧边栏菜单入口），先隐藏。
              <ToggleField
                label={t("在 Steam 菜单显示 EpicDeck")}
                description={t("按 STEAM 键后，「库」下方多一个 EpicDeck 游戏库入口；下次打开菜单生效")}
                checked={settings.show_menu_entry !== false}
                onChange={(v) => update("show_menu_entry", v)}
              />
              */}
            </div>
            <NavRow level="steam-actions" style={{ gap: "10px", marginTop: "12px", flexWrap: "wrap" }}>
              <ActionButton
                disabled={busy === "sync"}
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  if (busy) return;
                  setBusy("sync");
                  try {
                    const r = await syncInstalledToSteam("");
                    if (!r.ok) done(t("添加失败"), r.error ?? "");
                    else {
                      const failed = r.failed ?? [];
                      done(
                        t("已写入 Steam"),
                        failed.length
                          ? tf("已添加 {0} 个，失败 {1} 个（{2}）", r.added ?? 0, failed.length, failed[0].title)
                          : tf("已添加 {0} 个。{1}", r.added ?? 0, r.note ?? "")
                      );
                    }
                  } finally {
                    setBusy("");
                  }
                }}
              >
                <FaSteamSymbol /> {t('把已安装的游戏全部加入 Steam')}
              </ActionButton>
              <ActionButton
                disabled={busy === "art"}
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  if (busy) return;
                  setBusy("art");
                  try {
                    const r = await refreshArtwork("");
                    if (!r.ok) done(t("封面下载失败"), r.error ?? "");
                    else
                      done(
                        r.updated ? t("封面已补齐") : t("封面已是最新"),
                        (r.updated ? tf("更新 {0}/{1} 个。", r.updated ?? 0, r.total ?? 0) : "") + (r.note ?? "")
                      );
                  } finally {
                    setBusy("");
                  }
                }}
              >
                {t('补齐封面与图标')}
              </ActionButton>
              <ActionButton
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  const ok = await confirmAction(
                    t("重启 Steam？"),
                    t("正在运行的游戏会被中断，未保存的进度可能丢失。"),
                    t("重启")
                  );
                  if (!ok) return;
                  const r = await refreshSteam();
                  done(r.ok ? t("正在重启 Steam") : t("刷新失败"), r.ok ? r.note ?? "" : r.error ?? "");
                }}
              >
                {t('重启 Steam 刷新游戏库')}
              </ActionButton>
            </NavRow>
          </Group>
        </div>

        {/* compatibility */}
        <div>
          <SectionTitle hint={t("Windows 版 Epic 游戏靠 Steam 自带的 Proton 启动")}>{t('启动与兼容')}</SectionTitle>
          <Group>
            <ToggleField
              label={t("Windows 游戏用 Proton 运行")}
              description={t("SteamOS 没有 wine；关掉这项 Windows 游戏会起不来")}
              checked={settings.use_proton !== false}
              onChange={(v) => update("use_proton", v)}
            />
            {settings.use_proton !== false ? (
              <div style={{ marginTop: "10px", maxWidth: "420px" }}>
                <Dropdown
                  rgOptions={protons}
                  selectedOption={settings.proton_path || ""}
                  onChange={(e) => update("proton_path", e.data)}
                />
                <div style={{ fontSize: "0.84em", opacity: 0.5, marginTop: "6px" }}>
                  {t("自动 = 优先 GE-Proton，其次 Steam 自带的最新正式版")}
                  {env.proton ? tf(" · 当前 {0}", env.proton ?? "") : ""}
                </div>
              </div>
            ) : null}

            {lsfgAvailable ? (
              <div style={{ marginTop: "10px" }}>
                <ToggleField
                  label={t("默认开启小黄鸭插帧（LSFG-VK）")}
                  description={t("新装的游戏默认用 ~/lsfg 包一层插帧；单个游戏可在详情页单独开关")}
                  checked={settings.lsfg_default === true}
                  onChange={async (v) => {
                    await setLsfg("", v);
                    await update("lsfg_default", v);
                  }}
                />
                <div style={{ fontSize: "0.82em", opacity: 0.5, marginTop: "6px" }}>
                  {t('插帧通过 ~/lsfg 包装实现，不是启动参数，所以游戏启动参数里看不到相关内容。')}
                </div>
              </div>
            ) : null}
          </Group>
        </div>

        {/* download */}
        <div data-ed-section="download">
          <SectionTitle hint={t("Legendary 没有精确限速，用并发数分档控速")}>{t('下载')}</SectionTitle>
          <Group>
            <div style={{ maxWidth: "460px" }}>
              <div style={{ fontSize: "0.82em", opacity: 0.7, marginBottom: "8px" }}>
                {t('下载并发（越少越慢，也越省带宽）')}
              </div>
              <Dropdown
                rgOptions={[
                  { data: 0, label: t("自动（最快，约 25~30 MB/s）") },
                  { data: 8, label: t("8 并发（约 15~20 MB/s）") },
                  { data: 4, label: t("4 并发（约 8~12 MB/s）") },
                  { data: 2, label: t("2 并发（约 4~8 MB/s）") },
                  { data: 1, label: t("1 并发（约 2~4 MB/s）") },
                ]}
                selectedOption={Number(settings.max_workers || 0)}
                onChange={(e) => update("max_workers", Number(e.data))}
              />
              <div style={{ fontSize: "0.84em", opacity: 0.5, marginTop: "6px" }}>
                {t('只能按档降速，做不到精确到 KB/s；数值是实测参考，实际受 CDN 和网络影响')}
              </div>
            </div>

            <div style={{ marginTop: "14px", maxWidth: "460px" }}>
              <div style={{ fontSize: "0.82em", opacity: 0.7, marginBottom: "8px" }}>
                {t('首选 CDN 节点（留空 = 自动）')}
              </div>
              <TextField
                value={settings.preferred_cdn || ""}
                onChange={(e: any) => update("preferred_cdn", e.target.value)}
              />
              <div style={{ fontSize: "0.78em", opacity: 0.45, marginTop: "6px" }}>
                {t("例如 epicgames-download1-1251447533.file.myqcloud.com")}
              </div>
              <div style={{ fontSize: "0.84em", opacity: 0.5, marginTop: "6px" }}>
                {t('只填主机名（不含 http://）。国内机器 Epic 通常已自动分配腾讯云节点，一般无需改')}
              </div>
            </div>

            <div style={{ marginTop: "14px" }}>
              <ToggleField
                label={t("用明文 HTTP 下载")}
                description={t("国内 CDN 本身走 http；对 https 节点强制明文可绕过部分 TLS 卡顿，但传输不加密（chunk 仍由 Legendary 校验哈希）")}
                checked={settings.no_https === true}
                onChange={(v) => update("no_https", v)}
              />
            </div>

            <div style={{ marginTop: "14px", display: "flex", alignItems: "center", gap: "12px" }}>
              <ActionButton
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  const ok = await confirmAction(
                    t("清理下载缓存？"),
                    t("只删除 Legendary 的临时文件与断点记录；正在下载时请先暂停。"),
                    t("清理")
                  );
                  if (!ok) return;
                  const r = await clearDownloadCache();
                  done(
                    r.ok ? t("缓存已清理") : t("清理失败"),
                    r.ok ? tf("删除了 {0} 个残留文件", r.removed ?? 0) : r.error ?? ""
                  );
                }}
              >
                {t('清理下载缓存')}
              </ActionButton>
              <span style={{ fontSize: "0.84em", opacity: 0.5 }}>
                {t('删除残留的断点续传状态与临时文件（不影响已装游戏）')}
              </span>
            </div>
          </Group>
        </div>

        {/* dirs & language */}
        <div>
          <SectionTitle hint={t("新下载默认放这里，单个游戏可以单独指定")}>{t('目录与语言')}</SectionTitle>
          <Group>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div>
                <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>{t('默认安装目录')}</div>
                <Dropdown
                  rgOptions={dirs.map((d) => ({ data: d.path, label: d.label }))}
                  selectedOption={settings.install_dir || (dirs.length ? dirs[0].path : "")}
                  onChange={(e) => {
                    setCustomPath(e.data);
                    update("install_dir", e.data);
                  }}
                />
              </div>
              <div>
                <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>{t('游戏名语言')}</div>
                <Dropdown
                  rgOptions={LOCALE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
                  selectedOption={settings.title_locale || "auto"}
                  onChange={(e) => update("title_locale", e.data)}
                />
              </div>
              <div>
                <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>{t("界面语言")}</div>
                <Dropdown
                  rgOptions={[
                    { data: "auto", label: t("跟随 Steam") },
                    { data: "zh", label: "简体中文" },
                    { data: "en", label: "English" },
                  ]}
                  selectedOption={settings.ui_language || "auto"}
                  onChange={(e) => {
                    // Persist first: the bootstrap re-reads the setting from the
                    // backend, so applying before the save would keep the old one.
                    void update("ui_language", e.data).then(() => bootstrapLang());
                  }}
                />
              </div>
              <div>
                <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>{t("中文名来源")}</div>
                <ToggleField
                  label={t("用 Steam 商店补全")}
                  description={t("Epic 没有中文名时，尝试取 Steam 商店的官方中文名")}
                  checked={settings.third_party_titles !== false}
                  onChange={(v) => update("third_party_titles", v)}
                />
              </div>
            </div>

            <div style={{ marginTop: "14px", maxWidth: "640px" }}>
              <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>
                {t('自定义路径（目录不存在会自动创建）')}
              </div>
              {/* 按钮要和输入框居中对齐：以前整行 `alignItems: flex-end`，而 TextField 会在
                  输入框下方再画一行提示文字，结果按钮底部对齐的是提示文字、看起来比输入框低了
                  一截。现在把提示文字移出行外，行内只有「输入框 + 按钮」，直接居中。 */}
              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <div style={{ flex: 1, maxWidth: "440px" }}>
                  <TextField
                    value={customPath}
                    onChange={(e: any) => setCustomPath(e.target.value)}
                  />
                  {/* 示例不放 TextField 的 label：Steam 会把 label 转大写，
                      Linux 路径大小写敏感，示例会被显示成 /RUN/MEDIA/...（审计 V6）。 */}
                  <div style={{ fontSize: "0.78em", opacity: 0.45, marginTop: "6px" }}>
                    {t("例如 /run/media/deck/MySD/EpicGames")}
                  </div>
                </div>
                <ActionButton
                  style={{ padding: "10px 18px", fontSize: "0.9em" }}
                  onClick={applyCustomPath}
                  disabled={savingPath}
                >
                  {t('保存路径')}
                </ActionButton>
              </div>
            </div>

            <div style={{ marginTop: "14px" }}>
              <ToggleField
                label={t("后台读取安装体积")}
                description={t("逐个读取 Epic 清单来估算体积（每个游戏几秒、几 MB 流量，结果缓存 30 天）")}
                checked={settings.auto_fetch_size !== false}
                onChange={(v) => update("auto_fetch_size", v)}
              />
            </div>
          </Group>
        </div>

        <DataLocations />

        {/* maintenance */}
        <div>
          <SectionTitle hint={t("排查问题时用")}>{t('维护')}</SectionTitle>
          <Group>
            <NavRow level="maintenance" style={{ gap: "10px", flexWrap: "wrap" }}>
              <ActionButton
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  const r = await exportLogs();
                  if (!r.ok) {
                    done(t("导出失败"), r.error ?? "");
                    return;
                  }
                  showModal(
                    <ConfirmModal
                      strTitle={t("诊断日志")}
                      strDescription={
                        <div>
                          <div style={{ fontSize: "0.85em", opacity: 0.7, marginBottom: "8px" }}>
                            {t("日志已导出到:")}{r.path || t("（写入失败）")}
                          </div>
                          <div
                            style={{
                              fontFamily: "monospace",
                              fontSize: "0.8em",
                              maxHeight: "46vh",
                              overflowY: "auto",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-all",
                              background: "rgba(0,0,0,0.3)",
                              padding: "8px",
                              borderRadius: "4px",
                            }}
                          >
                            {r.logs ?? ""}
                          </div>
                        </div>
                      }
                      strOKButtonText={t("关闭")}
                    />
                  );
                }}
              >
                {t('导出诊断日志')}
              </ActionButton>
              <ActionButton
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  const r = await installLegendary();
                  done(r.ok ? t("Legendary 已就绪") : t("安装失败"), r.ok ? r.version ?? "" : r.error ?? "");
                }}
              >
                {t('重新安装 Legendary')}
              </ActionButton>
              <ActionButton
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  const e = await checkEnvironment();
                  done(
                    e.legendary_installed ? t("环境正常") : t("缺少 Legendary"),
                    tf("Legendary {0}{1}", e.legendary_path || t("未找到"), e.proton_path ? " · Proton " + e.proton_path : "")
                  );
                }}
              >
                <FaRedo /> {t('检查环境')}
              </ActionButton>
            </NavRow>
            {updateInfo?.has_update && updateInfo.latest ? (
              <NavRow
                level="settings-actions"
                style={{ gap: "10px", marginTop: "12px", flexWrap: "wrap", alignItems: "center" }}
              >
                <ActionButton
                  style={{ padding: "9px 16px", fontSize: "0.88em" }}
                  onClick={() =>
                    void openUrl(
                      updateInfo.url || "https://github.com/AvalonO98/EpicDeck/releases/latest"
                    )
                  }
                >
                  <FaRedo /> {t("有新版本")} {updateInfo.latest}
                </ActionButton>
                <span style={{ fontSize: "0.85em", opacity: 0.7 }}>
                  {tf("当前 {0}，点左侧在 Steam 里打开下载页", PLUGIN_VERSION)}
                </span>
              </NavRow>
            ) : null}
            {/* Focusable on purpose: it sits below the last button, and a
                focused element is the only thing the navigator scrolls to.
                `.ed-info` gives it a visible border so the cursor has somewhere
                to land instead of stopping in mid-air above the version line. */}
            <div
              tabIndex={0}
              className="ed-info"
              style={{ marginTop: "12px", fontSize: "0.8em", opacity: 0.85 }}
            >
              {tf("Legendary {0} · 插件 {1} · 数据目录 ~/homebrew/settings/EpicDeck",
                env.legendary || t("未知版本"), PLUGIN_VERSION)}
            </div>
          </Group>
        </div>
      </div>
    </Scroller>
    </div>
  );
}

// -- setup / dependency screens ----------------------------------------
