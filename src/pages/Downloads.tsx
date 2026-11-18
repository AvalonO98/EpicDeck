// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

/**
 * The Downloads tab: active / paused / failed installs with pause, resume,
 * cancel and "open detail" actions.
 *
 * Split out of `fullscreen.tsx` (3513 lines, five pages + the shell) so that a
 * change here cannot accidentally touch the library grid or the focus code.
 */
import { FaDownload } from "react-icons/fa";
import { useMemo } from "react";
import { STATE_LABEL, isActive } from "../api";
import { ActionButton, Cover, ProgressInline, Scroller } from "../components";
import { t } from "../i18n";
import { actions, usePluginState } from "../store";
import { COLOR } from "../tokens";

export function DownloadsTab({ onOpenGame, onOpenSettings }: { onOpenGame: (appName: string) => void; onOpenSettings: () => void }) {
  const { games, progress } = usePluginState();
  const items = useMemo(() => {
    return Object.entries(progress)
      .filter(([, p]) => isActive(p) || p.state === "error" || p.state === "cancelled" || p.state === "paused")
      .sort((a, b) => {
        const aActive = isActive(a[1]) ? 1 : 0;
        const bActive = isActive(b[1]) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return (b[1].state === "paused" ? 1 : 0) - (a[1].state === "paused" ? 1 : 0);
      });
  }, [progress]);

  // `title` comes from the backend (it holds the library cache), so the list
  // still names the game when our own payload has not landed yet — e.g. when a
  // download is inherited right after a plugin reload.
  const titleOf = (appName: string) =>
    progress[appName]?.title ||
    games.find((g) => g.app_name === appName)?.title ||
    appName.slice(0, 12);

  if (items.length === 0) {
    return (
      // 空态卡片以前贴在上半屏，下面 ~230px 全是空的；这里让它占满内容区并居中（审计 V13）。
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 0 2em",
        }}
      >
      <div
        className="ed-group"
        style={{ padding: "46px 24px", textAlign: "center", opacity: 0.65, lineHeight: 1.8, maxWidth: "640px" }}
      >
        <div style={{ fontSize: "2em", marginBottom: "10px", opacity: 0.5 }}>
          <FaDownload />
        </div>
        <div>{t('当前没有下载任务。')}</div>
        <div style={{ fontSize: "0.85em", opacity: 0.75, marginTop: "4px" }}>
          {t('在游戏库里选一个没安装的游戏，点「下载并安装」。')}
        </div>
        <ActionButton
          style={{
            padding: "8px 16px",
            fontSize: "0.85em",
            marginTop: "14px",
            width: "fit-content",
            // 父级是 text-align:center 的普通 div，alignSelf 不生效，得靠 auto margin 居中。
            marginLeft: "auto",
            marginRight: "auto",
          }}
          onClick={onOpenSettings}
        >
          {t('下载设置（并发 / CDN / 清理缓存）')}
        </ActionButton>
      </div>
      </div>
    );
  }

  return (
    <Scroller className="ed-fade" contentStyle={{ paddingRight: "6px", paddingBottom: "1.4em" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxWidth: "980px", paddingBottom: "1.4em" }}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <ActionButton
            style={{ padding: "6px 14px", fontSize: "0.82em", opacity: 0.85 }}
            onClick={onOpenSettings}
          >
            {t('下载设置')}
          </ActionButton>
        </div>
        {items.map(([appName, p]) => {
          const game = games.find((g) => g.app_name === appName);
          const running = isActive(p);
          const paused = p.state === "paused";
          const tone =
            p.state === "error"
              ? COLOR.dangerSoft
              : p.state === "cancelled"
                ? "#c9c9c9"
                : p.state === "paused"
                  ? COLOR.warning
                  : COLOR.accentSoft;
          return (
            <div
              key={appName}
              className="ed-group"
              style={{ padding: "14px 16px", display: "flex", gap: "14px", alignItems: "center" }}
            >
              <Cover url={game?.cover_url ?? ""} title={titleOf(appName)} width={44} height={62} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: "10px" }}>
                  <div style={{ fontWeight: 600, fontSize: "0.98em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {titleOf(appName)}
                  </div>
                  <div style={{ fontSize: "0.8em", color: tone }}>{t(STATE_LABEL[p.state] ?? "") || p.state}</div>
                </div>
                <ProgressInline progress={p} compact />
              </div>
              <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                {running ? (
                  <>
                    <ActionButton
                      style={{ padding: "8px 14px", fontSize: "0.85em" }}
                      onClick={() => void actions.pause(appName)}
                    >
                      {t('暂停')}
                    </ActionButton>
                    <ActionButton
                      danger
                      style={{ padding: "8px 14px", fontSize: "0.85em" }}
                      onClick={() => void actions.cancel(appName)}
                    >
                      {t('取消')}
                    </ActionButton>
                  </>
                ) : paused ? (
                  <>
                    <ActionButton
                      style={{ padding: "8px 14px", fontSize: "0.85em" }}
                      onClick={() => void actions.resume(appName)}
                    >
                      {t('继续')}
                    </ActionButton>
                    <ActionButton
                      danger
                      style={{ padding: "8px 14px", fontSize: "0.85em" }}
                      onClick={() => void actions.cancel(appName)}
                    >
                      {t('取消')}
                    </ActionButton>
                  </>
                ) : (
                  <ActionButton
                    style={{ padding: "8px 14px", fontSize: "0.85em" }}
                    onClick={() => onOpenGame(appName)}
                  >
                    {t('查看')}
                  </ActionButton>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Scroller>
  );
}
