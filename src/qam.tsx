// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// The Quick Access Menu panel.
//
// Browsing 138 covers in a 300px column was never great, so the QAM is now a
// launcher: account, the two entry points into the full-screen page, whatever
// is downloading right now, and a one-line summary of the library. Everything
// else lives in the full-screen route.

import { ButtonItem, DialogButton, Dropdown, Field, PanelSection, PanelSectionRow, TextField } from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { FaCog, FaDownload, FaSteamSymbol, FaThLarge } from "react-icons/fa";
import {
  completeFirstRun,
  fmtAgo,
  installLegendary,
  isActive,
  resolveInstallDir,
  type InstallDirOption,
} from "./api";
import { ErrorBlock, ProgressInline, WarningBanner } from "./components";
import { LoginPanel } from "./login";
import {
  ensureBoot,
  markFirstRunDone,
  onSignedIn,
  recheckEnv,
  refreshLibrary,
  reloadDirs,
  signOut,
  switchAccount,
  usePluginState,
} from "./store";
import { openFullScreen } from "./fullscreen";
import { t, tf, useLangVersion } from "./i18n";

/** Legendary missing: SteamOS has no pip, so the plugin downloads the binary. */
function MissingDependency({ onInstalled }: { onInstalled: () => void }) {
  const [installing, setInstalling] = useState(false);

  const doInstall = async () => {
    setInstalling(true);
    const r = await installLegendary();
    setInstalling(false);
    if (r.ok) {
      toaster.toast({ title: t("安装成功"), body: tf("Legendary {0} 已安装", r.version ?? "") });
      onInstalled();
    } else {
      toaster.toast({ title: t("安装失败"), body: r.error ?? "" });
    }
  };

  return (
    <PanelSection title={t("缺少依赖")}>
      <PanelSectionRow>
        <div style={{ padding: "12px 0" }}>
          <p>{t('未检测到 Legendary(SteamOS 无 pip,无法用 pip 安装)。')}</p>
          <p style={{ opacity: 0.7, fontSize: "0.85em" }}>
            {t('点击下方按钮,将自动从 GitHub Releases 下载官方独立二进制(约 3 MB,无需 Python)。')}
          </p>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={doInstall} disabled={installing}>
          {installing ? t("正在下载…") : t("一键安装 Legendary")}
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

/** First run: pick where 60 GB downloads land before the first one starts. */
function FirstRunView({
  dirs,
  onDone,
}: {
  dirs: InstallDirOption[];
  onDone: (path: string) => void;
}) {
  const [choice, setChoice] = useState<string>("");
  const [custom, setCustom] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [note, setNote] = useState<string>("");

  // Options arrive asynchronously; preselect the backend's default (first item).
  useEffect(() => {
    if (!choice && dirs.length) setChoice(dirs[0].path);
  }, [dirs, choice]);

  const finish = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const r = await completeFirstRun(path);
      if (!r.ok) {
        setNote(r.error ?? t("保存失败"));
        return;
      }
      toaster.toast({ title: t("下载位置已设置"), body: r.install_dir ?? path });
      onDone(r.install_dir ?? path);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    const typed = custom.trim();
    if (!typed) {
      await finish(choice);
      return;
    }
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const v = await resolveInstallDir(typed);
      if (!v.ok || !v.path) {
        setNote(v.error ?? t("路径无效"));
        return;
      }
      await finish(v.path);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelSection title={t("欢迎使用 EpicDeck")}>
      <PanelSectionRow>
        <div style={{ padding: "4px 0", lineHeight: 1.5 }}>
          {t('Epic 游戏体积很大，先选一个下载安装的位置。选好之后可以在「设置 → 默认安装目录」里随时更改，单个游戏也能单独指定。')}
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <Dropdown
          rgOptions={dirs.map((d) => ({ data: d.path, label: d.label }))}
          selectedOption={choice}
          onChange={(e) => setChoice(e.data)}
        />
        <Field
          label={t("下载安装位置")}
          description={dirs.length ? dirs.find((d) => d.path === choice)?.path ?? "" : t("正在读取可用磁盘…")}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <TextField
          label={t("自定义路径（可选）")}
          value={custom}
          onChange={(e: any) => setCustom(e.target.value)}
        />
        <Field
          label={t("自定义路径")}
          description={t("填了就用它（例如 /run/media/deck/MySD/EpicGames），留空则用上面的位置；目录不存在会自动创建")}
        />
      </PanelSectionRow>
      {note && (
        <PanelSectionRow>
          <div style={{ color: "#ff8a80", fontSize: "0.9em", wordBreak: "break-all" }}>{note}</div>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={confirm} disabled={busy}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", justifyContent: "center" }}>
            <FaDownload /> {busy ? t("正在准备…") : t("使用此位置并继续")}
          </div>
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => finish("")} disabled={busy}>
          {t('用默认位置（~/Games）')}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={reloadDirs} disabled={busy}>
          {t('刷新磁盘列表（刚插 SD 卡？）')}
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

function QuickPanel({ onLogout, onSwitchAccount }: { onLogout: () => void; onSwitchAccount: () => void }) {
  const { auth, games, progress, error, refreshing, cachedAt } = usePluginState();
  const [booting, setBooting] = useState<boolean>(false);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!games.length) setBooting(true);
    ensureBoot().finally(() => setBooting(false));
  }, []);

  // Keep the panel scrolled to its top when it opens.
  //
  // Decky hands focus to the first focusable element in the panel; if that is
  // the "打开游戏库" button, Steam scrolls it into view and pushes the account
  // row (and the panel title) out of the viewport. The account row is focusable
  // now, but Steam may still scroll after that, so we pin it a few times over
  // the first second and then leave it alone (the user may scroll meanwhile).
  useEffect(() => {
    const el = topRef.current;
    if (!el) return;
    const doc = el.ownerDocument;
    const scrollToTop = () => {
      const view = doc.defaultView;
      let parent: HTMLElement | null = el.parentElement;
      while (parent && parent !== doc.body) {
        // Only real scroll containers. An ancestor with overflow:visible can
        // still report scrollHeight > clientHeight (Steam's "Panel Focusable"
        // does) and setting scrollTop on it silently does nothing — that was
        // why the account row stayed clipped by ~34px.
        const style = view?.getComputedStyle(parent);
        const scrollable = /(auto|scroll)/.test(style?.overflowY || "");
        if (scrollable && parent.scrollHeight > parent.clientHeight + 4) {
          parent.scrollTop = 0;
          return;
        }
        parent = parent.parentElement;
      }
    };
    const timers = [50, 200, 500, 900].map((delay) =>
      doc.defaultView?.setTimeout(scrollToTop, delay)
    );
    return () => {
      for (const timer of timers) {
        if (timer !== undefined) doc.defaultView?.clearTimeout(timer);
      }
    };
  }, []);

  const installed = games.filter((g) => g.is_installed).length;
  const downloads = Object.entries(progress).filter(([, p]) => isActive(p));

  if (booting && !games.length) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ padding: "16px 0", opacity: 0.7 }}>{t('正在读取游戏库…')}</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <div
            ref={topRef}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "2px 0 6px",
            }}
          >
            {/* tabIndex only: making this a Focusable changed its layout (flex)
                and squeezed the name into a 1-character column. A plain
                focusable div keeps the visual and still gives Steam a landing
                spot at the top of the panel. */}
            <div
              tabIndex={0}
              className="ed-qam-account"
              style={{ minWidth: 0, flex: "1 1 auto" }}
            >
              <div style={{ fontWeight: 700, fontSize: "0.98em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {auth?.display_name || t("Epic 账号")}
              </div>
              <div style={{ fontSize: "0.76em", opacity: 0.55, marginTop: "1px" }}>
                {tf("共 {0} 个 · 已安装 {1}", games.length, installed)}
                {cachedAt ? tf(" · {0}更新", fmtAgo(cachedAt)) : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
              <DialogButton onClick={onSwitchAccount} style={{ padding: "4px 10px", fontSize: "0.8em", minWidth: 0 }}>
                {t('切换')}
              </DialogButton>
              <DialogButton onClick={onLogout} style={{ padding: "4px 10px", fontSize: "0.8em", minWidth: 0 }}>
                {t('登出')}
              </DialogButton>
            </div>
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            label={t("打开游戏库")}
            description={t("全屏浏览、下载、启动、加进 Steam")}
            onClick={() => openFullScreen("library")}
          >
            <FaThLarge />
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            label={t("设置与账号")}
            description={t("Proton、目录、封面、诊断日志")}
            onClick={() => openFullScreen("settings")}
          >
            <FaCog />
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      {error ? (
        <PanelSection title={t("连接状态")}>
          <PanelSectionRow>
            {games.length ? (
              <WarningBanner text={error.message} onRetry={() => void refreshLibrary(true)} />
            ) : (
              <ErrorBlock error={error} onRetry={() => void refreshLibrary(true)} retrying={refreshing} />
            )}
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {downloads.length > 0 ? (
        <PanelSection title={tf("正在下载（{0}）", downloads.length)}>
          {downloads.slice(0, 3).map(([appName, p]) => {
            const game = games.find((g) => g.app_name === appName);
            return (
              <PanelSectionRow key={appName}>
                <div style={{ padding: "2px 0 4px" }}>
                  <div
                    style={{
                      fontSize: "0.9em",
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {game?.title ?? appName.slice(0, 12)}
                  </div>
                  <ProgressInline progress={p} compact />
                </div>
              </PanelSectionRow>
            );
          })}
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => openFullScreen("downloads")}>
              {t('查看全部下载任务')}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      <PanelSection>
        <PanelSectionRow>
          <div style={{ fontSize: "0.74em", opacity: 0.45, lineHeight: 1.5, display: "flex", alignItems: "center", gap: "6px" }}>
            <FaSteamSymbol /> {t('添加进 Steam 的游戏会带封面，重启 Steam 后出现在「非 Steam 游戏」里')}
          </div>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

export function QamPanel() {
  useLangVersion();
  const { auth, env, firstRunDone, booted, games, dirs } = usePluginState();
  const [booting, setBooting] = useState(!booted);

  useEffect(() => {
    let alive = true;
    ensureBoot().finally(() => {
      if (alive) setBooting(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const logout = async () => {
    const r = await signOut();
    if (!r.ok) toaster.toast({ title: t("登出失败"), body: r.error ?? "" });
  };

  const switchAccountAction = async () => {
    const r = await switchAccount();
    if (!r.ok) toaster.toast({ title: t("切换失败"), body: r.error ?? "" });
  };

  if (booting && !booted && games.length === 0) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ padding: "16px 0", opacity: 0.7 }}>{t('加载中…')}</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (!env.legendary_installed) {
    return (
      <MissingDependency
        onInstalled={() => {
          void recheckEnv().then(() => refreshLibrary(true));
        }}
      />
    );
  }

  // Before the login screen: a first-run user picks where games go. Asking now
  // avoids the "disk full halfway through a 60 GB download" surprise.
  if (firstRunDone === false) {
    return <FirstRunView dirs={dirs} onDone={(path) => markFirstRunDone(path)} />;
  }

  if (!auth?.logged_in) {
    return <LoginPanel onLoggedIn={() => void onSignedIn()} />;
  }

  return <QuickPanel onLogout={logout} onSwitchAccount={switchAccountAction} />;
}
