// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Full-screen UI.
//
// The QAM panel is 300px wide, which is fine for "is it downloading?" but bad
// for browsing 138 covers. This page is registered as a Steam route (the same
// trick every plugin with a real UI uses: `routerHook.addRoute` + `Navigation.
// Navigate`), so it takes over the whole screen, keeps gamepad focus, and
// leaves the QAM as a launcher.
//
// Layout: header (back / title / refresh) → tab pills → page body. The library
// body is a 5×3 cover grid with 15 games per page, so the page count stays
// small enough to flip through with L1/R1.

import {
  Dropdown,
  Focusable,
  GamepadButton,
  Navigation,
  TextField,
  ToggleField,
  showModal,
  ConfirmModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  FaArrowLeft,
  FaChevronLeft,
  FaChevronRight,
  FaClock,
  FaCog,
  FaDownload,
  FaPlay,
  FaRedo,
  FaSearch,
  FaSteamSymbol,
  FaThLarge,
  FaTrash,
} from "react-icons/fa";
import {
  INSTALL_FILTER_LABEL,
  INSTALL_FILTER_ORDER,
  LOCALE_LABELS,
  LOCALE_OPTIONS,
  SORT_OPTIONS,
  STATE_LABEL,
  checkEnvironment,
  checkUpdate,
  clearDownloadCache,
  dataLocations,
  exportLogs,
  fmtPlaytime,
  fmtSize,
  getCloudSaves,
  getGameSize,
  getLaunchArgs,
  getLegendaryVersion,
  getLsfg,
  getProtonOptions,
  getProtonDb,
  getSettings,
  installLegendary,
  isActive,
  maskPersonal,
  openUrl,
  refreshArtwork,
  refreshSteam,
  resolveInstallDir,
  setLaunchArgs,
  setLsfg,
  setSetting,
  syncCloudSaves,
  syncInstalledToSteam,
  completeFirstRun,
  getInstallDirOptions,
  type DataLocation,
  type Game,
  type InstallFilter,
  type InstallProgress,
  type SortMode,
} from "./api";
import {
  ActionButton,
  Cover,
  ErrorBlock,
  NavRow,
  ProgressInline,
  Scroller,
  StatBlock,
  WarningBanner,
} from "./components";
import {
  canFocus,
  claimFocusRing,
  describeRows,
  DIR_DOWN,
  DIR_LEFT,
  DIR_RIGHT,
  DIR_UP,
  focusOwned,
  moveFocus,
  moveFocusRowCol,
  notePointerDown,
  peekAnchor,
  rememberFocus,
  reverifyFocus,
  settleFocus,
} from "./geomnav";
import { LoginPanel } from "./login";
import {
  actions,
  ensureBoot,
  type PluginState,
  markFirstRunDone,
  onSignedIn,
  recheckEnv,
  reloadDirs,
  refreshLibrary,
  signOut,
  shallowEqual,
  switchAccount,
  usePluginState,
  usePluginSelector,
} from "./store";
import { STEAM_BOTTOM_INSET, STEAM_TOP_INSET, useViewport, type Viewport } from "./viewport";
import { LIBRARY_ROUTE, PAGE_SIZE } from "./routes";
import { COLOR } from "./tokens";
import { getLang, t, tf, useLangVersion } from "./i18n";
import { bootstrapLang } from "./langboot";

export { LIBRARY_ROUTE };

type TabId = "library" | "downloads" | "settings";

// Replaced with the real number at build time (see rollup.config.js), so the
// settings footer can never drift from package.json again.
const PLUGIN_VERSION = "__EPICDECK_VERSION__";

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

// Labels stay in the source language: this array is built at import time, long
// before the backend tells us which language to use, so `t()` here would freeze
// the tabs. Translate at render instead (`.label` is a t() key).
const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: "library", label: "游戏库", icon: <FaThLarge /> },
  { id: "downloads", label: "下载", icon: <FaDownload /> },
  { id: "settings", label: "设置", icon: <FaCog /> },
];

/**
 * Which interaction level currently has focus — read off the nearest ancestor
 * marked with `data-ed-level` (set by `NavRow` / the grid container). Used to
 * make L1/R1 act on the level the user is actually interacting with.
 */
function focusLevel(evt?: any): string {
  try {
    const target = (evt?.target || document.activeElement) as HTMLElement | null;
    const row = target?.closest?.("[data-ed-level]");
    return String(row?.getAttribute("data-ed-level") || "");
  } catch {
    return "";
  }
}

// Filter / sort / page survive a trip back to the QAM: the route page unmounts
// on NavigateBack, and re-picking "已安装" every time gets old fast.
const FS_UI_KEY = "__epicdeckFullScreenUI";

interface FsUIState {
  tab: TabId;
  filter: InstallFilter;
  sort: SortMode;
  query: string;
  page: number;
  settingsSection?: string;
}

function readFsUI(): FsUIState {
  const saved = (window as any)[FS_UI_KEY] ?? {};
  return {
    tab: TABS.some((item) => item.id === saved.tab) ? saved.tab : "library",
    filter: INSTALL_FILTER_ORDER.includes(saved.filter) ? saved.filter : "all",
    sort: SORT_OPTIONS.some((o) => o.data === saved.sort) ? saved.sort : "alpha",
    query: typeof saved.query === "string" ? saved.query : "",
    page: typeof saved.page === "number" && saved.page >= 1 ? saved.page : 1,
    settingsSection: typeof saved.settingsSection === "string" ? saved.settingsSection : "",
  };
}

function writeFsUI(patch: Partial<FsUIState>) {
  (window as any)[FS_UI_KEY] = { ...readFsUI(), ...patch };
}

// -- shared bits --------------------------------------------------------

function Pager({
  page,
  pageCount,
  onPrev,
  onNext,
}: {
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const btn: CSSProperties = {
    padding: "5px 10px",
    borderRadius: "8px",
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.1)",
    fontSize: "0.85em",
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  };
  const dim = (disabled: boolean): CSSProperties => (disabled ? { opacity: 0.3 } : {});
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
      {/* 到头了就不该能被聚焦：以前只是变淡，光标会停在"按了没反应"的死键上（审计 1.6）。 */}
      <Focusable
        className="ed-pager"
        noFocusRing
        tabIndex={page <= 1 ? -1 : 0}
        aria-disabled={page <= 1 ? "true" : undefined}
        style={{ ...btn, ...dim(page <= 1) }}
        onClick={page <= 1 ? undefined : onPrev}
        onActivate={page <= 1 ? undefined : onPrev}
      >
        <FaChevronLeft />
      </Focusable>
      <div
        style={{
          fontSize: "0.85em",
          opacity: 0.8,
          whiteSpace: "nowrap",
          minWidth: "56px",
          textAlign: "center",
        }}
      >
        {page} / {pageCount}
      </div>
      <Focusable
        className="ed-pager"
        noFocusRing
        tabIndex={page >= pageCount ? -1 : 0}
        aria-disabled={page >= pageCount ? "true" : undefined}
        style={{ ...btn, ...dim(page >= pageCount) }}
        onClick={page >= pageCount ? undefined : onNext}
        onActivate={page >= pageCount ? undefined : onNext}
      >
        <FaChevronRight />
      </Focusable>
    </div>
  );
}

function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "10px", margin: "0 0 10px 2px" }}>
      <div style={{ fontSize: "1.02em", fontWeight: 700, letterSpacing: "0.01em" }}>{children}</div>
      {hint ? <div style={{ fontSize: "0.8em", opacity: 0.5 }}>{hint}</div> : null}
    </div>
  );
}

function Group({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="ed-group" style={{ padding: "16px 18px", ...style }}>
      {children}
    </div>
  );
}

// -- library ------------------------------------------------------------

/** Compare two progress snapshots by what a cover actually renders. */
function sameTileProgress(a?: InstallProgress, b?: InstallProgress): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.state === b.state && Math.round(a.percent) === Math.round(b.percent);
}

const LibraryTile = memo(forwardRef<HTMLDivElement, {
  game: Game;
  onOpen: (game: Game) => void;
}>(function LibraryTile({ game, onOpen }, ref) {
  // Each cover subscribes to its own progress row instead of receiving it as a
  // prop. A download writes `progress` 1–2 times a second; with the prop every
  // cover in the grid re-rendered on every tick (audit 3.5).
  const progress = usePluginSelector((state) => state.progress[game.app_name], sameTileProgress);
  const downloading = isActive(progress);
  return (
    // `data-ed-app` is the handle used to return the cursor to this cover when
    // the detail page closes; without it the first d-pad press after B is
    // swallowed while the navigator hunts for a removed node.
    <Focusable
      ref={ref}
      noFocusRing
      className="ed-tile"
      data-ed-app={game.app_name}
      onActivate={() => onOpen(game)}
      onClick={() => onOpen(game)}
      style={{
        position: "relative",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        cursor: "pointer",
      }}
    >
      <img
        src={game.cover_url}
        alt={game.title}
        draggable={false}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "center 22%",
          display: "block",
          background: "rgba(255,255,255,0.04)",
        }}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
        }}
      />
      <div
        className="ed-tile-shade"
        style={{
          position: "absolute",
          inset: 0,
          // 45% 起步时，浅色封面（龙腾世纪那种）上「未安装 / 体积」几乎看不清；
          // 提前到 32% 并加深中段（审计 V9）。
          background:
            "linear-gradient(180deg, rgba(0,0,0,0) 32%, rgba(0,0,0,0.62) 68%, rgba(0,0,0,0.94) 100%)",
          opacity: 0.92,
          pointerEvents: "none",
        }}
      />
      {downloading && (
        <div
          style={{
            position: "absolute",
            top: "6px",
            left: "6px",
            padding: "2px 7px",
            borderRadius: "999px",
            background: "rgba(74,163,255,0.92)",
            color: "#04121f",
            fontSize: "0.8em",
            fontWeight: 700,
          }}
        >
          {(progress!.percent >= 0 ? progress!.percent.toFixed(0) + "%" : t("下载中")) as string}
        </div>
      )}
      {!downloading && game.in_steam && (
        <div
          style={{
            position: "absolute",
            top: "6px",
            right: "6px",
            padding: "3px 6px",
            borderRadius: "999px",
            background: "rgba(0,0,0,0.55)",
            color: COLOR.accentSoft,
            fontSize: "0.8em",
            display: "flex",
            alignItems: "center",
          }}
        >
          <FaSteamSymbol />
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "8px 9px 7px",
          display: "flex",
          flexDirection: "column",
          gap: "2px",
        }}
      >
        <div
          className="ed-tile-title"
          style={{
            fontSize: "0.86em",
            fontWeight: 600,
            lineHeight: 1.2,
            color: "rgba(255,255,255,0.96)",
            // 亮封面 + 白色标题时靠阴影保住对比度（审计 V9）。
            textShadow: "0 1px 3px rgba(0,0,0,0.85)",
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {game.title}
        </div>
        <div
          style={{
            fontSize: "0.8em",
            color: game.is_installed
              ? COLOR.success
              : game.non_installable
                ? COLOR.warning
                : "rgba(255,255,255,0.6)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            textShadow: "0 1px 3px rgba(0,0,0,0.85)",
          }}
        >
          {game.is_installed
            ? t("已安装")
            : game.non_installable
              ? t("需外部启动器")
              : game.disk_size
                ? fmtSize(game.disk_size)
                : t("未安装")}
        </div>
      </div>
    </Focusable>
  );
}));

function LibraryTab({
  onOpen,
  libraryError,
  viewport,
  registerBumper,
}: {
  onOpen: (game: Game) => void;
  libraryError?: ReactNode;
  viewport: Viewport;
  registerBumper?: (fn: ((delta: number) => boolean) | null) => void;
}) {
  // No `progress` here any more: each cover subscribes to its own row, so a
  // download no longer re-renders the toolbar and the whole grid (audit 3.5).
  const { games, sizePending, locale, refreshing } = usePluginSelector(
    (state) => ({
      games: state.games,
      sizePending: state.sizePending,
      locale: state.locale,
      refreshing: state.refreshing,
    }),
    shallowEqual
  );
  const initial = useRef(readFsUI()).current;

  const [filter, setFilter] = useState<InstallFilter>(initial.filter);
  const [sort, setSort] = useState<SortMode>(initial.sort);
  const [query, setQuery] = useState(initial.query);
  const [page, setPage] = useState(initial.page);

  const installedCount = useMemo(() => games.filter((g) => g.is_installed).length, [games]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = games.filter((g) => {
      if (filter === "installed" && !g.is_installed) return false;
      // "Not installed" means "installable but not installed" — a title that
      // needs an external launcher is neither, so it stays out of that filter
      // instead of padding it with entries that cannot be downloaded.
      if (filter === "not_installed" && (g.is_installed || g.non_installable)) return false;
      if (!q) return true;
      return (g.title || "").toLowerCase().includes(q) || g.app_name.toLowerCase().includes(q);
    });
    // 排序按当前界面语言比较：英文界面下用中文 collator 会把 A/a、重音字母
    // 和标点的顺序排得很怪（审计 2.8）。
    const collator = new Intl.Collator(getLang() === "en" ? "en" : "zh-Hans-CN", {
      sensitivity: "base",
    });
    filtered.sort((a, b) => {
      switch (sort) {
        case "alpha_desc":
          return collator.compare(b.title || "", a.title || "");
        case "playtime":
          return (b.playtime_seconds || 0) - (a.playtime_seconds || 0);
        case "recent":
          return (b.first_seen || 0) - (a.first_seen || 0);
        default:
          return collator.compare(a.title || "", b.title || "");
      }
    });
    return filtered;
  }, [games, query, sort, filter, getLang()]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
      writeFsUI({ page: pageCount });
    }
  }, [page, pageCount]);

  const goPage = (delta: number) => {
    const next = Math.min(pageCount, Math.max(1, current + delta));
    setPage(next);
    writeFsUI({ page: next });
  };

  const pageGames = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  // `onOpen` arrives as an inline arrow from the shell, so its identity changes
  // on every render of the shell. Keep a stable wrapper or `memo` never bails.
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const openGame = useCallback((game: Game) => onOpenRef.current(game), []);

  const chooseFilter = (next: InstallFilter) => {
    setFilter(next);
    setPage(1);
    writeFsUI({ filter: next, page: 1 });
  };

  const counts: Record<InstallFilter, number> = {
    all: games.length,
    installed: installedCount,
    // 与过滤保持一致：`non_installable`（EA/Origin 类）不算"未安装"，
    // 否则徽章数字比点开看到的条数多（审计 2.2）。
    not_installed: games.filter((g) => !g.is_installed && !g.non_installable).length,
  };

  // Filters are applied with A (`chooseFilter`), not on focus.

  // Hand the pager up so L1/R1 can flip pages while focus is inside the grid.
  useEffect(() => {
    if (!registerBumper) return;
    registerBumper((delta) => {
      const next = Math.min(pageCount, Math.max(1, current + delta));
      // 报告"到底有没有换页"，调用方据此决定要不要落焦（审计 1.4）。
      if (next === current) return false;
      setPage(next);
      writeFsUI({ page: next });
      return true;
    });
    return () => registerBumper(null);
  }, [registerBumper, current, pageCount]);

  return (
    <div
      onFocus={undefined}
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      <NavRow level="toolbar" className="ed-toolbar">
        {/* Chips are direct children of the row so Steam's horizontal flow can
            actually link them (a nested wrapper would break the nav flow even
            though it looks identical). */}
        {/* Chips apply on A, not on focus: sliding towards the search box used
            to apply "全部 / 已安装 / 未安装" one after another. */}
        {INSTALL_FILTER_ORDER.map((f) => (
          <Focusable
            key={f}
            noFocusRing
            className="ed-chip"
            data-active={f === filter ? "true" : "false"}
            onClick={() => chooseFilter(f)}
            onActivate={() => chooseFilter(f)}
            style={{ padding: "6px 11px", fontSize: "0.86em", whiteSpace: "nowrap", flexShrink: 0 }}
          >
            {t(INSTALL_FILTER_LABEL[f])}{" "}
            <span style={{ opacity: 0.6, fontSize: "0.92em" }}>{counts[f]}</span>
          </Focusable>
        ))}

        {/* No label: Steam's TextField draws the label above the box, which
            makes the whole toolbar two lines tall. Kept bare and directly in
            the horizontal focus flow so left/right reaches it from the chips. */}
        <div style={{ flex: "1 1 9em", minWidth: "7.5em", maxWidth: "18em", minHeight: 0 }}>
          <TextField
            value={query}
            onChange={(e: any) => {
              setQuery(e.target.value);
              setPage(1);
              writeFsUI({ query: e.target.value, page: 1 });
            }}
            bShowClearAction
            placeholder={t("搜索")}
          />
        </div>

        <div style={{ width: "9.5em", flexShrink: 0 }}>
          <Dropdown
            rgOptions={SORT_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
            selectedOption={sort}
            onChange={(e) => {
              setSort(e.data as SortMode);
              setPage(1);
              writeFsUI({ sort: e.data as SortMode, page: 1 });
            }}
          />
        </div>

        {viewport.compact ? null : (
          <div className="ed-toolbar-hint">
            {sizePending > 0
              ? tf("体积读取中 {0}/{1}", games.length - sizePending, games.length)
              : locale
              ? `${t("标题")} ${t(LOCALE_LABELS[locale] ?? "") || locale}`
              : ""}
          </div>
        )}

        <Pager
          page={current}
          pageCount={pageCount}
          onPrev={() => goPage(-1)}
          onNext={() => goPage(1)}
        />
      </NavRow>

      {libraryError}

      {visible.length === 0 ? (
        <div
          className="ed-group"
          style={{
            padding: "40px 24px",
            textAlign: "center",
            opacity: 0.65,
            fontSize: "0.95em",
            lineHeight: 1.7,
          }}
        >
          {query.trim() ? (
            <>
              <FaSearch /> {tf("没有匹配「{0}」的游戏", query)}
            </>
          ) : filter === "installed" ? (
            <>{t('还没有已安装的游戏')}</>
          ) : filter === "not_installed" ? (
            <>{t('所有游戏都已安装')}</>
          ) : (
            <>{t('游戏库为空。请确认你的 Epic 账号下已拥有游戏（含免费领取的游戏）。')}</>
          )}
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            // 网格的 padding 是 0.35em（给放大后的焦点环留空间），于是封面从 x=21.6
            // 起、工具栏 chip 从 x=16 起，左边线差 5.6px（审计 V8）。外层用等量负
            // margin 抵掉，封面回到 16，环还剩 5.6px 余量不会被裁。
            marginLeft: "-0.35em",
            marginRight: "-0.35em",
          }}
          data-ed-level="grid"
        >
          <div
            key={`${current}-${filter}-${sort}-${query}`}
            className="ed-fade"
            style={{
              display: "grid",
              // Rows are fractions of the available height, so a page of 15
              // always fits on screen instead of scrolling under the footer.
              // Only the column count changes with the window; the row count
              // follows from it, so a narrow window reflows to 4×4 instead of
              // squeezing five covers into thumbnails.
              // A full page's worth of rows, not the current page's: with
              // 3 games on the last page the old formula produced one row that
              // filled the viewport and stretched every cover.
              gridTemplateRows: `repeat(${Math.max(1, Math.ceil(PAGE_SIZE / viewport.cols))}, minmax(0, 1fr))`,
              gridTemplateColumns: `repeat(${viewport.cols}, minmax(0, 1fr))`,
              alignContent: "start",
              gap: viewport.compact ? "0.5em" : "0.7em",
              height: "100%",
              // The focus ring scales tiles up; the padding keeps it from
              // being clipped by overflow: hidden.
              padding: "0.35em",
              boxSizing: "border-box",
            }}
          >
            {pageGames.map((g) => (
              <LibraryTile key={g.app_name} game={g} onOpen={openGame} />
            ))}
          </div>

          {refreshing ? (
            <div style={{ textAlign: "center", fontSize: "0.8em", opacity: 0.45, padding: "8px 0" }}>
              {t('正在刷新游戏库…')}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// -- detail -------------------------------------------------------------

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
function confirmAction(title: string, body: string, okText: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    showModal(
      <ConfirmModal
        strTitle={title}
        strDescription={<div style={{ fontSize: "0.9em", lineHeight: 1.5 }}>{body}</div>}
        strOKButtonText={okText}
        strCancelButtonText={t("取消")}
        onOK={() => finish(true)}
        onCancel={() => finish(false)}
        onEscKeypress={() => finish(false)}
      />
    );
  });
}

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

function DetailView({ appName, onBack }: { appName: string; onBack: () => void }) {
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

// -- downloads ----------------------------------------------------------

function DownloadsTab({ onOpenGame, onOpenSettings }: { onOpenGame: (appName: string) => void; onOpenSettings: () => void }) {
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

// -- settings & account -------------------------------------------------

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

function SettingsTab({ onGoLogin }: { onGoLogin: () => void }) {
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

function SetupScreen({ onDone }: { onDone: () => void }) {
  const { dirs } = usePluginState();
  const [choice, setChoice] = useState<string>("");
  const [custom, setCustom] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

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
      onDone();
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
    try {
      const v = await resolveInstallDir(typed);
      if (!v.ok || !v.path) {
        setNote(v.error ?? t("路径无效"));
        return;
      }
      await finish(v.path);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "20px 0" }}>
      <div style={{ width: "100%", maxWidth: "640px" }}>
        <div className="ed-group" style={{ padding: "26px 28px" }}>
          <div style={{ fontSize: "1.4em", fontWeight: 800, marginBottom: "8px" }}>{t('先选个下载位置')}</div>
          <div style={{ fontSize: "0.9em", opacity: 0.65, lineHeight: 1.6, marginBottom: "18px" }}>
            {t('Epic 游戏体积很大，先确认装在哪里。之后可以在「设置 → 目录与语言」随时改，单个游戏也能单独指定。')}
          </div>
          <Dropdown
            rgOptions={dirs.map((d) => ({ data: d.path, label: d.label }))}
            selectedOption={choice}
            onChange={(e) => setChoice(e.data)}
          />
          <div style={{ marginTop: "14px" }}>
            <TextField
              value={custom}
              onChange={(e: any) => setCustom(e.target.value)}
              label={t("自定义路径（可选，例如 /run/media/deck/MySD/EpicGames）")}
            />
          </div>
          {note ? (
            <div style={{ color: "#ff8a80", fontSize: "0.85em", marginTop: "10px" }}>{note}</div>
          ) : null}
          <NavRow level="setup-actions" style={{ gap: "10px", marginTop: "18px" }}>
            <ActionButton
              primary
              style={{ padding: "11px 22px", fontSize: "0.95em" }}
              onClick={confirm}
              disabled={busy}
            >
              <FaDownload /> {t('使用此位置并继续')}
            </ActionButton>
            <ActionButton
              style={{ padding: "11px 18px", fontSize: "0.95em" }}
              onClick={() => finish("")}
            >
              {t('用默认位置（~/Games）')}
            </ActionButton>
            <ActionButton
              style={{ padding: "11px 18px", fontSize: "0.95em" }}
              onClick={async () => {
                await reloadDirs();
              }}
            >
              {t('刷新磁盘')}
            </ActionButton>
          </NavRow>
        </div>
      </div>
    </div>
  );
}

// -- page shell ---------------------------------------------------------

/** Everything the shell renders — deliberately *not* the per-app progress map. */
function shellSlice(state: PluginState) {
  let activeDownloads = 0;
  for (const key in state.progress) {
    if (isActive(state.progress[key])) activeDownloads += 1;
  }
  return {
    auth: state.auth,
    authUnknown: state.authUnknown,
    games: state.games,
    error: state.error,
    refreshing: state.refreshing,
    firstRunDone: state.firstRunDone,
    env: state.env,
    booted: state.booted,
    activeDownloads,
  };
}

export function FullScreenPage() {
  useLangVersion();
  // Select everything except `progress`: installing a game writes that map 1–2
  // times a second, and re-rendering the header, the tabs and the whole tab body
  // on every tick is what made the Deck drop frames during downloads (audit 3.5).
  const state = usePluginSelector(shellSlice, shallowEqual);
  // Measured from the element, not the window: plugin code runs in Decky's
  // hidden 1×1 SharedJSContext, so `window.innerWidth` lies.
  const surfaceRef = useRef<HTMLDivElement>(null);
  const viewport = useViewport(surfaceRef);
  const [tab, setTab] = useState<TabId>(() => readFsUI().tab);
  const [detail, setDetail] = useState<string | null>(null);
  /** App whose cover should get the cursor back once the grid is mounted again. */
  const pendingFocusRef = useRef<string | null>(null);

  /** Close the detail page and put the cursor back on its cover. */
  const closeDetail = () => {
    const closing = detail;
    // The grid is not in the DOM while a detail page is open: it mounts again
    // after the state change commits. A fixed timeout therefore raced the
    // render (2026-11-09: at +80 ms `[data-ed-app]` was still empty, focus
    // stayed on <body> and the page stopped receiving d-pad input). Record the
    // app and let the effect below focus it once the grid actually exists.
    pendingFocusRef.current = closing || null;
    setDetail(null);
  };

  // Put the cursor back on the cover that was opened, after the grid is back.
  // Retries briefly because the grid can mount a frame or two later.
  useEffect(() => {
    if (detail) return;
    const app = pendingFocusRef.current;
    if (!app) return;
    const root = surfaceRef.current;
    if (!root) {
      pendingFocusRef.current = null;
      return;
    }
    let tries = 0;
    let timer = 0;
    const tick = () => {
      const tiles = root.querySelectorAll<HTMLElement>("[data-ed-app]");
      for (const tile of Array.from(tiles)) {
        if (tile.getAttribute("data-ed-app") === app) {
          pendingFocusRef.current = null;
          focusOwned(tile);
          // Steam's own B handling runs right after ours and parks focus on
          // <body>. A single focus() loses that race, so re-check a few frames.
          reverifyFocus(tile, root, 12);
          return;
        }
      }
      if (++tries < 12) {
        timer = window.setTimeout(tick, 100);
      } else {
        pendingFocusRef.current = null;
      }
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [detail]);
  const [booting, setBooting] = useState(!state.booted);
  // The library owns its paging state; it registers its pager here so L1/R1 can
  // flip pages while focus is inside the grid.
  const gridBumperRef = useRef<((delta: number) => boolean) | null>(null);
  // 从工具栏进入网格时记下那个控件；网格里按"上"优先回到它。
  // 几何模型下"下→上"不互逆（从"全部"下去，上来可能落在"已安装"，第 5 列上方
  // 更是翻页键），用户的心智是"原路返回"（审计 1.8，只做这个最小改动）。
  const gridEntryRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    ensureBoot().finally(() => {
      if (alive) setBooting(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Safety net for lost focus.
  //
  // Steam's controller model can move focus to <body> after it handles a button
  // we also handled (B closing a panel is the reproducible one). Body focus
  // emits no focusin, so settleFocus cannot pull it back — and because the
  // direction handlers live on the page root, a focus-less page simply stops
  // responding. Put the last anchor back whenever focus drops to nothing,
  // unless a Steam modal owns the input or we are being unmounted.
  useEffect(() => {
    const surface = surfaceRef.current;
    const doc = surface?.ownerDocument;
    if (!doc) return;
    let last = 0;
    let attempts = 0;
    const restore = () => {
      const root = surfaceRef.current;
      if (!root || !root.isConnected) return;
      // Only when focus is genuinely gone. A handled interaction that left focus
      // on a real control must not be overridden.
      if (doc.activeElement && doc.activeElement !== doc.body) return;
      // Decky's confirm dialog renders outside the page and takes focus; do not
      // fight it, or the dialog becomes unusable.
      if (doc.querySelector('[class*="ModalOverlayContent"].active')) return;
      const now = Date.now();
      if (now - last > 600) attempts = 0;
      else attempts += 1;
      if (attempts > 4) return; // something keeps stealing: stop fighting it
      last = now;
      const anchor = peekAnchor();
      // The anchor can be a button from a panel that just unmounted (a detail
      // page); focusing a detached node does nothing, so fall back to whatever
      // the current page offers first.
      const target =
        anchor && root.contains(anchor) && anchor.isConnected
          ? anchor
          : (root.querySelector<HTMLElement>("[data-ed-app]") ||
             root.querySelector<HTMLElement>(".ed-chip") ||
             root.querySelector<HTMLElement>("[tabindex]"));
      if (!target) return;
      window.setTimeout(() => {
        if (doc.activeElement === doc.body && root.isConnected) {
          try {
            target.focus();
          } catch {
            /* element went away between the check and the focus */
          }
        }
      }, 30);
    };
    const onFocusOut = (evt: FocusEvent) => {
      const to = evt.relatedTarget as Node | null;
      if (to && to !== doc.body) return; // a real move somewhere else
      restore();
    };
    // `focusout` is not enough: when the focused element is removed (page flip,
    // uninstall, tab switch) Chromium sometimes drops focus to <body> without
    // firing it, and the page then ignores every direction key while looking
    // perfectly alive. A pointer/mouse interaction is the moment to re-check.
    const onPointerUp = () => window.setTimeout(restore, 30);
    doc.addEventListener("focusout", onFocusOut, true);
    doc.addEventListener("pointerup", onPointerUp, true);
    return () => {
      doc.removeEventListener("focusout", onFocusOut, true);
      doc.removeEventListener("pointerup", onPointerUp, true);
    };
  }, []);

  /** 翻页并在新页落焦。返回 false 表示"没换页"（已经到头了）。
   *
   * 三处调用共用：L1/R1、网格里按到左右边界。以前 L1/R1 只翻页不落焦，
   * 新页的瓦片是整个重建的，被聚焦的那张随旧页卸载 → 焦点掉到 body，界面失联；
   * 而边界那条又会在"根本没换页"时把光标丢到本页另一端（审计 1.3 / 1.4）。
   */
  const flipPageAndFocus = (delta: number, edge?: "first" | "last"): boolean => {
    const root = surfaceRef.current;
    const doc = root?.ownerDocument;
    const from = doc?.activeElement as HTMLElement | null;
    const grid = from?.closest?.('[data-ed-level="grid"]') as HTMLElement | null;
    let col = 0;
    if (grid && from) {
      const tiles = Array.from(grid.querySelectorAll<HTMLElement>(".ed-tile"));
      const index = tiles.indexOf(from);
      if (index >= 0) col = index % Math.max(1, viewport.cols);
    }
    // 光标在工具栏（chip / 排序 / 翻页键）时翻页，焦点应当留在原控件上。
    // 以前 col 会退回 0 并把光标拽进第 1 张封面（复审 4.3）。
    const inGrid = !!grid && !!from && grid.contains(from);
    const flipped = gridBumperRef.current ? gridBumperRef.current(delta) : false;
    if (!flipped) return false;
    if (!inGrid) return true;
    // 两帧之后再落焦：第一帧 React 提交，第二帧布局稳定，几何位置才准。
    window.setTimeout(() => window.setTimeout(() => {
      const r = surfaceRef.current;
      if (!r || !r.isConnected) return;
      const tiles = Array.from(r.querySelectorAll<HTMLElement>(".ed-tile"));
      if (tiles.length === 0) return;
      const target = edge === "last"
        ? tiles[tiles.length - 1]
        : edge === "first"
        ? tiles[0]
        : tiles[Math.min(col, tiles.length - 1)];
      focusOwned(target);
      claimFocusRing(target, r);
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, 0), 0);
    return true;
  };

  // Give the page a known starting point: the 返回 chip. Without this Steam may
  // keep its own idea of "focused" from the previous screen, and the first stick
  // press moves from somewhere the user cannot see.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const root = surfaceRef.current;
      if (!root) return;
      const doc = root.ownerDocument;
      const active = doc.activeElement as HTMLElement | null;
      if (active && active !== doc.body && root.contains(active)) return;
      const back = root.querySelector(".ed-chip") as HTMLElement | null;
      back?.focus();
      rememberFocus(back);
    }, 260);
    return () => window.clearTimeout(timer);
  }, []);

  // Opening a game page means "I want to play it": focus the primary action
  // (启动游戏 / 安装 / 取消) instead of making the user slide down from the
  // header. Re-runs whenever a different game's page is opened.
  useEffect(() => {
    if (!detail) return;
    const timer = window.setTimeout(() => {
      const root = surfaceRef.current;
      if (!root) return;
      const primary = (root.querySelector('.ed-action[data-primary="true"]') ||
        root.querySelector(".ed-action")) as HTMLElement | null;
      if (!primary) return;
      primary.focus();
      rememberFocus(primary);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [detail]);

  // Tabs are activated with A (`showTab`), never by focus. Registry entries
  // for `tab:*` are intentionally gone: they made merely passing over a tab
  // mount its page, and Settings issues several backend calls on mount.

  // The navigator lives in the plugin window but must act on Big Picture's DOM.
  // Exposing it on the *page* window makes that explicit and gives us a way to
  // drive focus from devtools / CDP when debugging.
  // Steam's `noFocusRing` also drops the `gpfocus` class we style against, so we
  // track focus ourselves: one class on whatever is focused, driven by real
  // focusin events (which fire even though React's onFocus is consumed).
  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    const doc = root.ownerDocument;
    const clear = () => {
      root.querySelectorAll(".ed-focus").forEach((el) => el.classList.remove("ed-focus"));
    };
    const onFocusIn = (ev: Event) => {
      const t = ev.target as HTMLElement | null;
      if (!t) return;
      // 排查用：谁把焦点放到哪、有没有被拉回、有没有跑到页面外面去。
      // 实机报「上没反应」时，只有这份记录能区分"我们的处理器没被调用"
      // 和"调用了但焦点又被抢走"——前者在日志里会是一条 outside:true。
      try {
        const view = doc.defaultView as any;
        if (view) {
          const log = view.__epicdeckFocusLog || (view.__epicdeckFocusLog = []);
          const label = (n: any) =>
            (n?.innerText || n?.className || n?.tagName || "").trim().replace(/\s+/g, " ").slice(0, 14);
          log.push({ t: Date.now(), to: label(t), outside: !root.contains(t) });
          if (log.length > 40) log.shift();
        }
      } catch {
        /* diagnostics only */
      }
      if (!root.contains(t)) return;
      // `settleFocus` decides who really owns focus: normally `t`, but when
      // Steam moved focus on its own right after one of our moves it returns
      // our anchor and puts focus back — that is what stops the cursor from
      // drifting one tile sideways on every vertical step (HANDOFF 7.12.2-b).
      const settled = settleFocus(t, root);
      clear();
      settled.classList.add("ed-focus");
    };
    doc.addEventListener("focusin", onFocusIn, true);
    return () => {
      doc.removeEventListener("focusin", onFocusIn, true);
      clear();
    };
  }, []);

  // The navigator lives in the plugin window but must act on Big Picture's DOM.
  // Exposing it on the *page* window makes that explicit and gives us a way to
  // drive focus from devtools / CDP when debugging.
  // 调试/验收钩子：注册一次，函数体从 ref 取最新闭包。
  // 以前这个 effect 没有依赖数组，每次渲染都先 delete 再重挂，CDP 恰好在这条缝里
  // 调用会拿到 undefined（复审 4.6）。
  // 显式标注类型：不写的话 TS 会把 `() => false` 推断成字面量 `false`，
  // 后面赋一个返回 boolean 的实现就会报 TS2322（第三轮审计 3.1，CI 因此必红）。
  type DebugHooks = {
    nav: (button: number) => boolean;
    navRC: (button: number) => boolean;
    bump: (delta: number) => boolean;
    tab: (delta: number) => void;
  };
  const hooksRef = useRef<DebugHooks>({
    nav: () => false,
    navRC: () => false,
    bump: () => false,
    tab: () => {},
  });
  hooksRef.current = {
    nav: (b: number) => {
      const root = surfaceRef.current;
      return root ? moveFocus(b, root) : false;
    },
    navRC: (b: number) => {
      const root = surfaceRef.current;
      return root ? moveFocusRowCol(b, root) : false;
    },
    bump: (d: number) => flipPageAndFocus(d),
    tab: (d: number) => tabOffset(d),
  };
  useEffect(() => {
    const root = surfaceRef.current;
    const view = root?.ownerDocument?.defaultView as any;
    if (!view || !root) return;
    view.__epicdeckMoveFocus = moveFocus;
    view.__epicdeckNav = (button: number) => hooksRef.current.nav(button);
    // 设置/详情/顶栏这类**流式**布局走的是 moveFocusRowCol（行/列模型）。
    view.__epicdeckNavRC = (button: number) => hooksRef.current.navRC(button);
    // L1/R1 不能从 CDP 注入（键盘没有对应手柄键），所以把真实路径也挂出来。
    view.__epicdeckBump = (delta: number) => hooksRef.current.bump(delta);
    view.__epicdeckTab = (delta: number) => hooksRef.current.tab(delta);
    view.__epicdeckDiag = () => ({
      dirs: view.__epicdeckDirLog || [],
      nav: view.__epicdeckNavLog || [],
      focus: view.__epicdeckFocusLog || [],
    });
    // 记录真实的触摸/鼠标按下：settleFocus 用它区分"用户点的"和"Steam 插队"（4.8）。
    const onPointer = () => notePointerDown();
    root.ownerDocument.addEventListener("pointerdown", onPointer, true);
    return () => {
      root.ownerDocument.removeEventListener("pointerdown", onPointer, true);
      delete view.__epicdeckMoveFocus;
      delete view.__epicdeckNav;
      delete view.__epicdeckNavRC;
      delete view.__epicdeckBump;
      delete view.__epicdeckTab;
      delete view.__epicdeckDiag;
    };
  }, []);

  const showTab = (next: TabId, section?: string) => {
    setTab(next);
    setDetail(null);
    writeFsUI({ tab: next, settingsSection: section ?? "" });
    // Focus actions switch tabs while the highlight stays on the chip; keep our
    // notion of "current" in sync with the DOM so the next press moves from there.
    const doc = surfaceRef.current?.ownerDocument;
    rememberFocus(doc?.activeElement as HTMLElement | null);
  };

  // Tabs are a *horizontal* row, so the natural gamepad gestures are left/right
  // (stick/d-pad) and L1/R1 — not up/down. Steam's default nav tree treats the
  // three chips as a vertical stack, which is why the stick was only moving
  // focus up/down between them.
  const tabOffset = (delta: number) => {
    const i = TABS.findIndex((item) => item.id === tab);
    const next = (i + delta + TABS.length) % TABS.length;
    const nextId = TABS[next].id;
    showTab(nextId);
    // L1/R1 changes the page, so the cursor must move with it. Without this the
    // highlight stayed on the old tab (or on a row of the previous page) while
    // the content had already switched.
    const root = surfaceRef.current;
    if (!root) return;
    // `data-ed-focus-action` 已经没有任何写入方（"聚焦即切页"在 0.9.3 删掉了），
    // 以前这里永远查不到 chip 就直接 return，切完标签光标留在原地（审计 1.5）。
    const chip = root.querySelector(`[data-ed-tab="${nextId}"]`) as HTMLElement | null;
    if (!chip) return;
    // `focusOwned` anchors + stamps the move as ours, so the focusin it fires is
    // not mistaken for a stray Steam navigation.
    focusOwned(chip);
    claimFocusRing(chip, root);
  };
  // Directional input goes through our own geometric navigator: Steam's nav tree
  // cannot express "rows of rows" in a custom layout, so the stick used to walk
  // DOM order (down = right). See geomnav.ts.
  //
  // 两条入口，同一个实现：
  //   1) `onGamepadDirection`（React prop）——Steam 正常派发时会走到这里；
  //   2) window 捕获阶段的 `vgp_ondirection` DOM 事件——**真机的主力路径**。
  //
  // 为什么必须补第 2 条（2026-11-10 实机定案）：页面里的 Steam 原生控件
  // （ToggleField / Dropdown / ButtonItem）会自己消化这个事件，`onGamepadDirection`
  // 就永远不被调用。用 DOM 事件日志抓到的现场是——焦点在「自动下载封面图」开关上，
  // 按「上」派发了 `vgp_ondirection {button:9}`（target 就在开关内部），我们一条
  // 记录都没有；同一位置按「左」却收到了 `{button:11}`。于是"设置页里按上没反应"
  // 的真相是：事件根本没到我们手上，只有那些不拦方向的控件才碰巧能用。
  // 捕获阶段先于控件执行，所以能拿到同一次按键并掐掉，Steam 的 DOM 顺序导航
  // 也就插不进来了。
  const dirGuardRef = useRef({ button: 0, at: 0 });
  const okGuardRef = useRef({ at: 0 });
  // 每次渲染把最新的处理器写进 ref：effect 只挂一次，但它要调用最新的闭包。
  const dirHandlerRef = useRef<(evt: any) => void>(() => {});
  const onRootDirection = (evt: any) => {
    const button = Number(evt?.detail?.button || 0);
    const now = Date.now();
    const doc0 = surfaceRef.current?.ownerDocument;
    const focused0 = doc0?.activeElement as HTMLElement | null;
    // 到了就等于"处理器被调用"。实机报"某个方向没反应"时，这条记录决定
    // 排查方向：没有它 → 事件根本没送到我们的 Focusable（Steam 自己吃了或
    // 焦点不在本页面）；有它但没有对应的 moved 记录 → 是我们的行模型算空。
    try {
      const view = doc0?.defaultView as any;
      if (view) {
        const log = view.__epicdeckDirLog || (view.__epicdeckDirLog = []);
        log.push({
          t: now,
          b: button,
          focus: (focused0?.innerText || focused0?.className || focused0?.tagName || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 14),
          inside: !!surfaceRef.current?.contains(focused0),
        });
        if (log.length > 20) log.shift();
      }
    } catch {
      /* diagnostics only */
    }
    // 左右键留给输入框移动光标；**上下必须由我们接管**——放行给 Steam 会按它
    // 自己的 DOM 顺序跳（搜索框里按"下"曾落到最右边的翻页键，审计 1.10）。
    // moveFocus 从输入框本身出发，几何位置照样能算出正下方的控件。
    if (focused0 && /^(INPUT|TEXTAREA|SELECT)$/.test(focused0.tagName)) {
      if (button === DIR_LEFT || button === DIR_RIGHT) return;
    }

    // One press can arrive twice (stick + d-pad synthesis); ignore the echo.
    if (dirGuardRef.current.button === button && now - dirGuardRef.current.at < 60) {
      evt?.preventDefault?.();
      evt?.stopPropagation?.();
      return;
    }
    const before = (focused0?.innerText || focused0?.className || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 14);

    // Inside the game grid, LEFT/RIGHT must stay inside the grid. Without this,
    // a press on the first column fell through to the relaxed (diagonal) round
    // and landed on a toolbar chip above-left — the cursor "jumped into the nav
    // bar". Horizontal edges mean *flip the page* instead.
    const grid = focused0?.closest?.('[data-ed-level="grid"]') as HTMLElement | null;
    const horizontal = button === DIR_LEFT || button === DIR_RIGHT;
    let moved = false;
    if (grid && horizontal) {
      // Grid horizontal movement keeps the rigid geometric model + page flips
      // on the edges.
      moved = moveFocus(button, surfaceRef.current, grid);
      if (!moved) {
        // 到头了：只有**真的换页**才落焦。以前不管换没换页都把 moved 置 true
        // 并把光标丢到本页另一端，第一页按左像"原地传送到最右"（审计 1.4）。
        moved = flipPageAndFocus(
          button === DIR_LEFT ? -1 : 1,
          button === DIR_LEFT ? "last" : "first"
        );
      }
    } else if (grid) {
      // 网格纵向：向上时先试着回"来源控件"，其余情况仍走几何模型（可跨层到工具栏）。
      const entry = gridEntryRef.current;
      if (
        button === DIR_UP &&
        entry &&
        entry.isConnected &&
        !!surfaceRef.current &&
        canFocus(entry, surfaceRef.current) &&
        !grid.contains(entry)
      ) {
        const root = surfaceRef.current!;
        focusOwned(entry);
        claimFocusRing(entry, root);
        entry.scrollIntoView({ block: "nearest", inline: "nearest" });
        moved = true;
      } else {
        moved = moveFocus(button, surfaceRef.current);
      }
    } else {
      // Flowing layouts (settings / detail / downloads / header / tabs) use the
      // row/column model: 上/下 switches rows, 左/右 moves between the buttons
      // of the current row (2026-11-06 用户要求).
      moved = moveFocusRowCol(button, surfaceRef.current);
    }
    // Diagnostics: a press that never reaches this handler, and a press whose
    // moveFocus fails, look identical from the outside (Steam moves the cursor
    // instead). Recording both makes them distinguishable from the console.
    // `before`/`after` together are what proved the sideways drift: 2026-11-05
    // 22:1x, pressing "down" on 全部 ended on 已安装 — its DOM sibling.
    try {
      const view = surfaceRef.current?.ownerDocument?.defaultView as any;
      if (view) {
        const log = view.__epicdeckNavLog || (view.__epicdeckNavLog = []);
        const doc = surfaceRef.current?.ownerDocument;
        const el = doc?.activeElement as HTMLElement | null;
        const label = (n: HTMLElement | null) =>
          (n?.innerText || n?.className || "").trim().replace(/\s+/g, " ").slice(0, 14);
        log.push({
          b: button,
          moved: moved,
          before: before,
          after: label(el),
          at: now,
          // 没移动时才拍快照（快照要跑一次行聚类，不能每次都算）。它回答的是
          // "为什么没动"：顶栏有没有进候选（pinned）、当前是不是已经在第 0 行
          // （atRow）、DOM 焦点和锚点是不是同一条（anchored / domFocus）。
          diag: moved ? undefined : describeRows(surfaceRef.current),
        });
        // 决定性的第二笔:移动瞬间 vs 下一帧。若两者不同,就是 Steam 在我们
        // 之后又挪了焦点(它的插队),而不是几何算法选错。
        doc?.defaultView?.requestAnimationFrame(() => {
          try {
            log.push({ b: button, phase: "raf", after: label(doc.activeElement as HTMLElement | null) });
            if (log.length > 60) log.shift();
          } catch {
            /* diagnostics only */
          }
        });
        if (log.length > 60) log.shift();
      }
    } catch (e) {
      /* diagnostics must never break navigation */
    }
    // 记住"从工具栏进入网格"的那一下，供 1.8 的"原路返回"用。
    try {
      const doc = surfaceRef.current?.ownerDocument;
      const now2 = doc?.activeElement as HTMLElement | null;
      const fromLevel = focused0?.closest?.("[data-ed-level]")?.getAttribute("data-ed-level") || "";
      const toLevel = now2?.closest?.("[data-ed-level]")?.getAttribute("data-ed-level") || "";
      if (moved && fromLevel === "toolbar" && toLevel === "grid" && focused0) {
        gridEntryRef.current = focused0;
      }
    } catch {
      /* 只影响手感，绝不能影响导航 */
    }
    dirGuardRef.current = { button, at: now };
    // 左右键在"这一行没有第二个控件"时无处可去（开关、滑条、下拉框都是整行一个）。
    // 这类 Steam 原生控件用左右改值：开关翻转、滑条加减。放行给它们比吞掉有用，
    // 否则站在开关上按左右永远没反应——而这恰好是 Steam 用户的本能操作。
    if (!moved && (button === DIR_LEFT || button === DIR_RIGHT)) {
      const el = surfaceRef.current?.ownerDocument?.activeElement as HTMLElement | null;
      if (
        el &&
        (el.matches?.('input[type="range"], select, [role="checkbox"], [role="switch"], [role="slider"]') ||
          el.closest?.('input[type="range"], select, [role="checkbox"], [role="switch"], [role="slider"]'))
      ) {
        return;
      }
    }
    // **Always** swallow a directional press on our surface, even when we hit a
    // boundary and did not move. We are the only navigator here; letting Steam
    // handle it makes it walk DOM order instead — pressing "down" jumped to the
    // right-most pager button (HANDOFF 7.10) and drifts one tile sideways on
    // every step (7.12.2-b). We accept the echo guard above as the price.
    evt?.preventDefault?.();
    evt?.stopPropagation?.();
  };
  dirHandlerRef.current = onRootDirection;

  // 真机方向键的主力入口：window 捕获阶段的 `vgp_ondirection`。
  //
  // 只接管"焦点在我们页面里"的按键——QAM、Steam 自己的界面、以及我们弹的
  // ConfirmModal（Steam 的 Dialog 渲染在页面之外）都不受影响，否则整个大屏的
  // 方向键都会被我们吃掉。
  useEffect(() => {
    const view = surfaceRef.current?.ownerDocument?.defaultView as any;
    if (!view) return;
    const onDomDirection = (ev: any) => {
      const surface = surfaceRef.current;
      const active = surface?.ownerDocument?.activeElement as HTMLElement | null;
      if (!surface || !active || !surface.contains(active)) return;
      const button = Number(ev?.detail?.button || 0);
      if (
        button !== DIR_LEFT &&
        button !== DIR_RIGHT &&
        button !== DIR_UP &&
        button !== DIR_DOWN
      ) {
        return;
      }
      dirHandlerRef.current(ev);
    };
    view.addEventListener("vgp_ondirection", onDomDirection, true);
    return () => {
      try {
        view.removeEventListener("vgp_ondirection", onDomDirection, true);
      } catch {
        /* window gone: nothing to detach */
      }
    };
  }, []);

  const onRootButton = (evt: any) => {
    const button = evt?.detail?.button;

    // A / OK: activate whatever *we* navigated to.
    //
    // Our navigator moves DOM focus directly, which Steam's nav tree does not
    // necessarily follow right away — so the first A used to be swallowed by the
    // stale node (you had to press it twice on tabs / filters). Clicking the
    // focused element ourselves makes one press = one activation, every time.
    // Text inputs are left to Steam so it can raise the on-screen keyboard.
    if (button === GamepadButton.OK) {
      const doc = surfaceRef.current?.ownerDocument;
      const el = doc?.activeElement as HTMLElement | null;
      if (!el) return;
      // Only our own page: modals, dropdowns and the OSK live in portals outside
      // the surface, and Steam has to drive those itself.
      if (!surfaceRef.current?.contains(el)) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (el.closest(".DialogInput_Wrapper")) return;
      // 只接管我们自己画的控件。Steam 的 Dropdown / ToggleField / ButtonItem 的
      // 激活入口是它自己的 onActivate 路径，替它 click() 属于"靠巧合"（审计 1.11）。
      // `data-ed-own` 目前**没有任何元素使用**，是给以后自绘的非 .ed-* 控件预留的
      // 白名单钩子（审计 3.7 指出过）。保留但不参与当前逻辑。
      if (!el.matches(".ed-chip,.ed-tile,.ed-action,.ed-pager,.ed-loc,[data-ed-own]")) return;
      const now = Date.now();
      // 250ms 会把"连按两下 A"的第二下吞掉；掌机上连按很常见（审计 1.11）。
      if (okGuardRef.current.at && now - okGuardRef.current.at < 120) {
        evt?.preventDefault?.();
        evt?.stopPropagation?.();
        return;
      }
      okGuardRef.current = { at: now };
      evt?.preventDefault?.();
      evt?.stopPropagation?.();
      try {
        el.click();
      } catch (e) {
        console.log("EpicDeck: activate failed", e);
      }
      return;
    }

    if (button !== GamepadButton.BUMPER_LEFT && button !== GamepadButton.BUMPER_RIGHT) return;
    const delta = button === GamepadButton.BUMPER_LEFT ? -1 : 1;

    // L1/R1 acts on the level the focus is currently in: on the library page
    // they flip pages, everywhere else they switch tabs.
    //
    // The filter/sort row counts as "inside the library" too: it is a NavRow
    // with `level="toolbar"`, so gating on `grid` alone made L1/R1 jump to the
    // top nav while the user was thinking about the games. `tab === "library"`
    // also keeps a stale `gridBumperRef` (set on mount, never cleared) from
    // paging a grid that is no longer on screen.
    const level = focusLevel(evt);
    const bumper = tab === "library" ? gridBumperRef.current : null;
    if (bumper && (level === "grid" || level === "toolbar")) {
      // 翻页后必须自己落焦：新页的瓦片以页码为 key 重新挂载，被聚焦的那张已经
      // 卸载，焦点会掉到 body（界面失联）或回退到顶栏（审计 1.3）。
      flipPageAndFocus(delta);
      evt?.preventDefault?.();
      evt?.stopPropagation?.();
      return;
    }
    tabOffset(delta);
  };

  // One B press pops exactly one Steam route entry.
  //
  // Do NOT gate this on `location.pathname`: the Big Picture window is an SPA —
  // its `location.pathname` is always `/index.html` and never changes with the
  // route. A "did we actually leave?" check based on pathname is therefore
  // always true, and any fallback timer it guards will fire even after a
  // successful pop — which is exactly the "back returns to the pre-plugin page,
  // then ~1s later Steam's own library opens" bug. `NavigateBack()` is the
  // correct, complete action: it pops the route `Navigate()` pushed on entry.
  const leaveRef = useRef({ busy: false, at: 0 });

  const goBack = () => {
    const now = Date.now();
    // Coalesce repeated events (a held button, or Steam re-delivering the same
    // cancel after our handler claimed it).
    if (leaveRef.current.busy || now - leaveRef.current.at < 400) return;
    leaveRef.current = { busy: true, at: now };
    try {
      Navigation.NavigateBack();
    } catch (e) {
      console.log("EpicDeck: NavigateBack failed", e);
    }
    // Allow a later press even if this one silently no-ops.
    window.setTimeout(() => {
      leaveRef.current.busy = false;
    }, 400);
  };

  // B (CANCEL) walks back up the in-page stack first: detail view → library
  // list → leave the plugin. Mirrors how Steam pages behave.
  const onCancel = (evt?: any) => {
    // Claim the event. Without preventDefault Steam treats B as unhandled and
    // performs its own route pop on top of ours.
    evt?.preventDefault?.();
    evt?.stopPropagation?.();
    if (detail) {
      closeDetail();
    } else {
      goBack();
    }
    return true;
  };

  /** 顶栏"返回"和 B 用同一套语义：有详情就先关详情，而不是直接退出插件。 */
  const backOrClose = () => {
    if (detail) {
      closeDetail();
      return;
    }
    goBack();
  };

  // 顶栏就是唯一的导航层：返回 / 游戏库 / 下载 / 设置 / 刷新 排在同一行，
  // 下面的内容区跟着聚焦的按钮走。返回和刷新没有"对应页面"，聚焦它们时
  // 内容保持不变 —— 这样光标在顶栏里左右移动时，页面不会莫名其妙地跳。
  const header = (
    <NavRow
      level="header"
      style={{
        alignItems: "center",
        gap: "0.5em",
        padding: viewport.compact ? "0.3em 1em 0.25em" : "0.5em 1.5em 0.4em",
        flexWrap: "nowrap",
      }}
    >
      <Focusable
        noFocusRing
        className="ed-chip"
        onClick={backOrClose}
        onActivate={backOrClose}
        style={{
          padding: "0.45em 0.85em",
          fontSize: "0.9em",
          display: "flex",
          alignItems: "center",
          gap: "0.4em",
          flexShrink: 0,
        }}
      >
        <FaArrowLeft /> {t('返回')}
      </Focusable>
      {/* Tabs switch on A, not on focus: focus-to-switch mounted/unmounted
          pages (Settings alone fired six backend calls) while the cursor was
          only passing over them. */}
      {TABS.map((item) => {
        const active = item.id === tab;
        const badge =
          item.id === "downloads" ? state.activeDownloads : 0;
        return (
          <Focusable
            key={item.id}
            data-ed-tab={item.id}
            noFocusRing
            className="ed-chip"
            data-active={active ? "true" : "false"}
            onClick={() => showTab(item.id)}
            onActivate={() => showTab(item.id)}
            style={{
              padding: "0.45em 0.95em",
              fontSize: "0.9em",
              display: "flex",
              alignItems: "center",
              gap: "0.45em",
              fontWeight: active ? 700 : 500,
              flexShrink: 0,
            }}
          >
            {item.icon}
            {t(item.label)}
            {badge > 0 ? (
              <span
                style={{
                  background: COLOR.accent,
                  color: "#04121f",
                  borderRadius: "999px",
                  fontSize: "0.8em",
                  padding: "0.08em 0.4em",
                  fontWeight: 800,
                }}
              >
                {badge}
              </span>
            ) : null}
          </Focusable>
        );
      })}
      <div style={{ flex: 1, minWidth: "0.5em" }} />
      {viewport.compact ? null : (
        <div
          style={{
            fontSize: "0.84em",
            opacity: 0.45,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "22em",
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {state.auth?.display_name || t("未登录")}
          {state.games.length ? tf(" · {0} 个游戏", state.games.length) : ""}
        </div>
      )}
      <Focusable
        noFocusRing
        className="ed-chip"
        // 连点会发多个全量请求（每个 ~20s）；refreshing 期间直接忽略（审计 2.6）。
        onClick={() => {
          if (!state.refreshing) void refreshLibrary(true);
        }}
        onActivate={() => {
          if (!state.refreshing) void refreshLibrary(true);
        }}
        style={{
          padding: "0.45em 0.85em",
          fontSize: "0.9em",
          display: "flex",
          alignItems: "center",
          gap: "0.4em",
          opacity: state.refreshing ? 0.5 : 1,
          flexShrink: 0,
        }}
      >
        <FaRedo /> {state.refreshing ? t("刷新中…") : t("刷新")}
      </Focusable>
    </NavRow>
  );

  return (
    <Focusable
      ref={surfaceRef}
      className="ed-surface"
      noFocusRing
      onCancel={onCancel}
      onButtonDown={onRootButton}
      onGamepadDirection={onRootDirection}
      actionDescriptionMap={{
        [GamepadButton.CANCEL]: t("返回"),
        // 详情页没有分页，L1/R1 只切标签；提示条要是还写「上一页」会误导（审计 V11）。
        [GamepadButton.BUMPER_LEFT]: detail ? t("上一个标签") : t("上一页 / 上一个标签"),
        [GamepadButton.BUMPER_RIGHT]: detail ? t("下一个标签") : t("下一页 / 下一个标签"),
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        // Steam's Big Picture chrome floats above the route: a 40px header and
        // a 42px footer with the button hints. Inset by hand or the first row
        // and the last row disappear underneath them. These stay in px — the
        // chrome does not scale with the viewport, only the page does.
        height: "100vh",
        width: "100%",
        paddingTop: `${STEAM_TOP_INSET}px`,
        paddingBottom: `${STEAM_BOTTOM_INSET}px`,
        boxSizing: "border-box",
        // One font size drives the whole page: every size below is em-based, so
        // this is the single knob that makes the UI fit 854×534, a docked
        // window, or a 4K TV.
        fontSize: `${(16 * viewport.scale).toFixed(2)}px`,
        background:
          "radial-gradient(1100px 620px at 18% -10%, rgba(63,142,247,0.16) 0%, rgba(0,0,0,0) 62%), linear-gradient(180deg, #171a21 0%, #101216 100%)",
        overflow: "hidden",
      }}
    >
      {header}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          padding: viewport.compact ? "0 1em 0.6em" : "0 1.5em 0.85em",
        }}
      >
        {booting ? (
          <div style={{ padding: "60px 0", textAlign: "center", opacity: 0.6 }}>{t('正在读取账号与游戏库…')}</div>
        ) : !state.env.legendary_installed ? (
          <div style={{ display: "flex", justifyContent: "center", paddingTop: "20px" }}>
            <div className="ed-group" style={{ padding: "26px 28px", maxWidth: "640px" }}>
              <div style={{ fontSize: "1.3em", fontWeight: 700, marginBottom: "8px" }}>{t('缺少 Legendary')}</div>
              <div style={{ fontSize: "0.9em", opacity: 0.7, lineHeight: 1.6 }}>
                {t('SteamOS 没有 pip，插件会直接从 GitHub Releases 下载官方独立二进制（约 14 MB）。')}
              </div>
              <ActionButton
                primary
                style={{ padding: "11px 22px", fontSize: "0.95em", marginTop: "16px", width: "fit-content" }}
                onClick={async () => {
                  const r = await installLegendary();
                  if (r.ok) {
                    toaster.toast({ title: t("安装成功"), body: tf("Legendary {0} 已安装", r.version ?? "") });
                    await recheckEnv();
                    await refreshLibrary(true);
                  } else {
                    toaster.toast({ title: t("安装失败"), body: r.error ?? "" });
                  }
                }}
              >
                {t('一键安装 Legendary')}
              </ActionButton>
            </div>
          </div>
        ) : state.firstRunDone === false ? (
          <SetupScreen onDone={() => markFirstRunDone("")} />
        ) : state.authUnknown && !state.auth?.logged_in ? (
          // 后端没回答（超时）≠ 未登录。显示可重试的提示，别让用户以为掉登录了
          // 又去输一次密码（复审 2.1 收尾）。
          <Scroller>
            <div style={{ padding: "28px 24px", maxWidth: "640px" }}>
              <div style={{ fontSize: "1.12em", fontWeight: 700 }}>
                {t("无法确认登录状态")}
              </div>
              <div style={{ marginTop: "8px", opacity: 0.7, lineHeight: 1.6 }}>
                {t("账号状态读取超时，请稍后点「刷新」重试")}
              </div>
              <ActionButton
                style={{ marginTop: "16px", padding: "10px 16px" }}
                onClick={() => void refreshLibrary(true)}
              >
                {t("重试")}
              </ActionButton>
            </div>
          </Scroller>
        ) : !state.auth?.logged_in && tab !== "settings" ? (
          // Settings stays reachable while signed out: signing in is exactly
          // when the network, proxy, language or Legendary install is broken,
          // and those live here. Everything else needs an account.
          <Scroller>
            <LoginPanel variant="screen" onLoggedIn={() => void onSignedIn()} />
          </Scroller>
        ) : tab === "library" ? (
          !state.auth?.logged_in ? (
            <Scroller>
              <LoginPanel variant="screen" onLoggedIn={() => void onSignedIn()} />
            </Scroller>
          ) :
          detail ? (
            <DetailView appName={detail} onBack={closeDetail} />
          ) : (
            <LibraryTab
              viewport={viewport}
              registerBumper={(fn) => {
                gridBumperRef.current = fn;
              }}
              onOpen={(g) => setDetail(g.app_name)}
              libraryError={
                state.error ? (
                  <div style={{ marginBottom: "12px", maxWidth: "860px" }}>
                    {state.games.length > 0 ? (
                      <WarningBanner
                        text={state.error.message + t("当前显示的是上次加载的游戏库。")}
                        onRetry={() => void refreshLibrary(true)}
                      />
                    ) : (
                      <ErrorBlock
                        error={state.error}
                        onRetry={() => void refreshLibrary(true)}
                        retrying={state.refreshing}
                        big
                      />
                    )}
                  </div>
                ) : null
              }
            />
          )
        ) : tab === "downloads" ? (
          <DownloadsTab
            onOpenGame={(appName) => {
              setTab("library");
              writeFsUI({ tab: "library" });
              setDetail(appName);
            }}
            onOpenSettings={() => showTab("settings", "download")}
          />
        ) : (
          <SettingsTab onGoLogin={() => showTab("library")} />
        )}
      </div>
    </Focusable>
  );
}

/** Used by the QAM panel's "open library" button. */
export function openFullScreen(tab: TabId = "library") {
  writeFsUI({ tab });
  try {
    // Steam keeps the QAM open across navigations in some builds; closing it
    // first means the page is visible immediately instead of behind the panel.
    Navigation.CloseSideMenus?.();
    Navigation.Navigate(LIBRARY_ROUTE);
  } catch (e) {
    console.log("EpicDeck: Navigation.Navigate failed", e);
    toaster.toast({ title: t("打不开大屏页面"), body: String(e) });
  }
}
