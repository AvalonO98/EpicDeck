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
import { forwardRef, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
  exportLogs,
  fmtAgo,
  fmtPlaytime,
  fmtSize,
  getGameSize,
  getLaunchArgs,
  getLegendaryVersion,
  getProtonOptions,
  getSettings,
  installLegendary,
  isActive,
  maskPersonal,
  refreshArtwork,
  refreshSteam,
  resolveInstallDir,
  setLaunchArgs,
  setSetting,
  syncInstalledToSteam,
  completeFirstRun,
  getInstallDirOptions,
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
import { moveFocus, rememberFocus } from "./geomnav";
import { LoginPanel } from "./login";
import {
  actions,
  ensureBoot,
  markFirstRunDone,
  onSignedIn,
  recheckEnv,
  reloadDirs,
  refreshLibrary,
  signOut,
  usePluginState,
} from "./store";
import { STEAM_BOTTOM_INSET, STEAM_TOP_INSET, useViewport, type Viewport } from "./viewport";
import { LIBRARY_ROUTE, PAGE_SIZE } from "./routes";
import { setSteamMenuEntryEnabled } from "./steammenu";

export { LIBRARY_ROUTE };

type TabId = "library" | "downloads" | "settings";

// Replaced with the real number at build time (see rollup.config.js), so the
// settings footer can never drift from package.json again.
const PLUGIN_VERSION = "__EPICDECK_VERSION__";

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: "library", label: "游戏库", icon: <FaThLarge /> },
  { id: "downloads", label: "下载", icon: <FaDownload /> },
  { id: "settings", label: "设置", icon: <FaCog /> },
];

/**
 * Focus actions: "landing on this element also does something".
 *
 * React's `onFocus` is not usable here — Steam's `Focusable` consumes it for its
 * own nav bookkeeping, so a chip never hears about focus. Instead each such
 * element declares `data-ed-focus-action="tab:downloads"` and the page registers
 * the matching callback; the navigator runs it right after moving focus.
 */
const focusActions = new Map<string, () => void>();

export function setFocusAction(key: string, fn: (() => void) | null) {
  if (fn) focusActions.set(key, fn);
  else focusActions.delete(key);
}

export function runFocusAction(el: HTMLElement | null | undefined) {
  const key = el?.getAttribute?.("data-ed-focus-action");
  if (!key) return;
  const fn = focusActions.get(key);
  if (!fn) return;
  try {
    fn();
  } catch (e) {
    console.log("EpicDeck: focus action failed", key, e);
  }
}

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
}

function readFsUI(): FsUIState {
  const saved = (window as any)[FS_UI_KEY] ?? {};
  return {
    tab: TABS.some((t) => t.id === saved.tab) ? saved.tab : "library",
    filter: INSTALL_FILTER_ORDER.includes(saved.filter) ? saved.filter : "all",
    sort: SORT_OPTIONS.some((o) => o.data === saved.sort) ? saved.sort : "alpha",
    query: typeof saved.query === "string" ? saved.query : "",
    page: typeof saved.page === "number" && saved.page >= 1 ? saved.page : 1,
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
      <Focusable
        className="ed-pager"
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

const LibraryTile = forwardRef<HTMLDivElement, {
  game: Game;
  progress?: InstallProgress;
  onOpen: (game: Game) => void;
}>(function LibraryTile({ game, progress, onOpen }, ref) {
  const downloading = isActive(progress);
  return (
    <Focusable
      ref={ref}
      noFocusRing
      className="ed-tile"
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
          background:
            "linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 72%, rgba(0,0,0,0.92) 100%)",
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
            fontSize: "0.7em",
            fontWeight: 700,
          }}
        >
          {(progress!.percent >= 0 ? progress!.percent.toFixed(0) + "%" : "下载中") as string}
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
            color: "#9ecbff",
            fontSize: "0.7em",
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
            fontSize: "0.72em",
            color: game.is_installed ? "#7ee2a8" : "rgba(255,255,255,0.6)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {game.is_installed ? "已安装" : game.disk_size ? fmtSize(game.disk_size) : "未安装"}
        </div>
      </div>
    </Focusable>
  );
});

function LibraryTab({
  onOpen,
  libraryError,
  viewport,
  registerBumper,
}: {
  onOpen: (game: Game) => void;
  libraryError?: ReactNode;
  viewport: Viewport;
  registerBumper?: (fn: ((delta: number) => void) | null) => void;
}) {
  const { games, progress, sizePending, locale, refreshing } = usePluginState();
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
      if (filter === "not_installed" && g.is_installed) return false;
      if (!q) return true;
      return (g.title || "").toLowerCase().includes(q) || g.app_name.toLowerCase().includes(q);
    });
    filtered.sort((a, b) => {
      switch (sort) {
        case "alpha_desc":
          return (b.title || "").localeCompare(a.title || "", "zh-Hans-CN");
        case "playtime":
          return (b.playtime_seconds || 0) - (a.playtime_seconds || 0);
        case "recent":
          return (b.first_seen || 0) - (a.first_seen || 0);
        default:
          return (a.title || "").localeCompare(b.title || "", "zh-Hans-CN");
      }
    });
    return filtered;
  }, [games, query, sort, filter]);

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

  const chooseFilter = (next: InstallFilter) => {
    setFilter(next);
    setPage(1);
    writeFsUI({ filter: next, page: 1 });
  };

  const counts: Record<InstallFilter, number> = {
    all: games.length,
    installed: installedCount,
    not_installed: games.length - installedCount,
  };

  // Landing on a filter chip applies it immediately.
  useEffect(() => {
    const offs = INSTALL_FILTER_ORDER.map((f) => {
      setFocusAction(`filter:${f}`, () => {
        setFilter((prev) => {
          if (prev === f) return prev;
          setPage(1);
          writeFsUI({ filter: f, page: 1 });
          return f;
        });
      });
      return f;
    });
    return () => {
      for (const f of offs) setFocusAction(`filter:${f}`, null);
    };
  }, []);

  // Hand the pager up so L1/R1 can flip pages while focus is inside the grid.
  useEffect(() => {
    if (!registerBumper) return;
    registerBumper((delta) => {
      const next = Math.min(pageCount, Math.max(1, current + delta));
      if (next !== current) {
        setPage(next);
        writeFsUI({ page: next });
      }
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
        {INSTALL_FILTER_ORDER.map((f) => (
          <Focusable
            key={f}
            noFocusRing
            className="ed-chip"
            data-active={f === filter ? "true" : "false"}
            onClick={() => chooseFilter(f)}
            onActivate={() => chooseFilter(f)}
            data-ed-focus-action={`filter:${f}`}
            style={{ padding: "6px 11px", fontSize: "0.86em", whiteSpace: "nowrap", flexShrink: 0 }}
          >
            {INSTALL_FILTER_LABEL[f]}{" "}
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
          />
        </div>

        <div style={{ width: "9.5em", flexShrink: 0 }}>
          <Dropdown
            rgOptions={SORT_OPTIONS}
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
              ? `体积读取中 ${games.length - sizePending}/${games.length}`
              : locale
              ? `标题 ${LOCALE_LABELS[locale] ?? locale}`
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
              <FaSearch /> 没有匹配「{query}」的游戏
            </>
          ) : filter === "installed" ? (
            <>还没有已安装的游戏</>
          ) : filter === "not_installed" ? (
            <>所有游戏都已安装</>
          ) : (
            <>游戏库为空。请确认你的 Epic 账号下已拥有游戏（含免费领取的游戏）。</>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }} data-ed-level="grid">
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
              gridTemplateRows: `repeat(${Math.ceil(pageGames.length / viewport.cols)}, minmax(0, 1fr))`,
              gridTemplateColumns: `repeat(${viewport.cols}, minmax(0, 1fr))`,
              gap: viewport.compact ? "0.5em" : "0.7em",
              height: "100%",
              // The focus ring scales tiles up; the padding keeps it from
              // being clipped by overflow: hidden.
              padding: "0.35em",
              boxSizing: "border-box",
            }}
          >
            {pageGames.map((g) => (
              <LibraryTile key={g.app_name} game={g} progress={progress[g.app_name]} onOpen={onOpen} />
            ))}
          </div>

          {refreshing ? (
            <div style={{ textAlign: "center", fontSize: "0.8em", opacity: 0.45, padding: "8px 0" }}>
              正在刷新游戏库…
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// -- detail -------------------------------------------------------------

function DetailView({ appName, onBack }: { appName: string; onBack: () => void }) {
  const { games, progress, dirs, defaultDir } = usePluginState();
  const game = games.find((g) => g.app_name === appName);
  if (!game) {
    return (
      <div style={{ padding: "30px" }}>
        <div style={{ opacity: 0.7, marginBottom: "16px" }}>这个游戏已不在游戏库里。</div>
        <ActionButton style={{ padding: "10px 18px", width: "fit-content" }} onClick={onBack}>
          <FaArrowLeft /> 返回
        </ActionButton>
      </div>
    );
  }
  return <DetailBody game={game} progress={progress[appName]} dirs={dirs} defaultDir={defaultDir} onBack={onBack} />;
}

function DetailBody({
  game,
  progress,
  dirs,
  defaultDir,
  onBack,
}: {
  game: Game;
  progress?: InstallProgress;
  dirs: { path: string; label: string; free: number }[];
  defaultDir: string;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState<string>("");
  const [inSteam, setInSteam] = useState<boolean>(game.in_steam);
  const [installed, setInstalled] = useState<boolean>(game.is_installed);
  const [sizes, setSizes] = useState({ download: game.download_size || 0, disk: game.disk_size || 0 });
  const [target, setTarget] = useState(defaultDir || (dirs.length ? dirs[0].path : ""));
  const [args, setArgs] = useState("");
  const [argsDirty, setArgsDirty] = useState(false);
  const [argsNote, setArgsNote] = useState("");

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
        r.from_legendary ? "来自 Legendary 配置（改这里会改为插件接管）" : ""
      );
    });
    return () => {
      cancelled = true;
    };
  }, [game.app_name]);

  useEffect(() => {
    if (!argsDirty) return;
    const timer = setTimeout(async () => {
      const r = await setLaunchArgs(game.app_name, args);
      setArgsDirty(false);
      if (!r.ok) toaster.toast({ title: "启动参数保存失败", body: r.error ?? "" });
      else if (r.warning) toaster.toast({ title: "已保存，但 Steam 快捷方式未更新", body: r.warning });
      else setArgsNote("已保存，下次启动生效");
    }, 900);
    return () => clearTimeout(timer);
  }, [args, argsDirty, game.app_name]);

  // Opening a detail page for a title the background job has not reached yet
  // fetches its manifest right away instead of waiting for the crawl.
  useEffect(() => {
    setSizes({ download: game.download_size || 0, disk: game.disk_size || 0 });
    if (game.disk_size) return;
    let cancelled = false;
    getGameSize(game.app_name).then((r) => {
      if (!cancelled && r.ok) setSizes({ download: r.download || 0, disk: r.disk || 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [game.app_name, game.download_size, game.disk_size]);

  // Steam's Focusable can report one press through both onActivate and onClick;
  // for actions that toggle state (Steam shortcut, install) that would run twice.
  const guardRef = useRef(0);
  const once = (fn: () => void) => () => {
    const now = Date.now();
    if (now - guardRef.current < 300) return;
    guardRef.current = now;
    fn();
  };

  const doInstall = async () => {
    setBusy("install");
    const r = await actions.install(game.app_name, target);
    setBusy("");
    if (r.ok) toaster.toast({ title: "开始下载", body: game.title });
    else toaster.toast({ title: "安装失败", body: r.error ?? "" });
  };

  const doLaunch = async () => {
    setBusy("launch");
    const r = await actions.launch(game.app_name);
    setBusy("");
    if (!r.ok) toaster.toast({ title: "启动失败", body: r.error ?? "" });
    else if (r.note) toaster.toast({ title: "正在启动", body: r.note });
  };

  const doUninstall = async () => {
    setBusy("uninstall");
    const r = await actions.uninstall(game.app_name);
    setBusy("");
    if (r.ok) {
      setInstalled(false);
      toaster.toast({ title: "已卸载", body: game.title });
    } else {
      toaster.toast({ title: "卸载失败", body: r.error ?? "" });
    }
  };

  const doToggleSteam = async () => {
    setBusy("steam");
    const r = inSteam ? await actions.removeFromSteam(game.app_name) : await actions.addToSteam(game.app_name);
    setBusy("");
    if (r.ok) {
      setInSteam(!inSteam);
      toaster.toast({
        title: inSteam ? "已从 Steam 移除" : "已添加到 Steam",
        body: inSteam ? "" : "重启 Steam 后生效",
      });
    } else {
      toaster.toast({ title: inSteam ? "移除失败" : "添加失败", body: r.error ?? "" });
    }
  };

  const active = isActive(progress);
  const dirOptions = dirs.map((d) => ({ data: d.path, label: d.label }));

  return (
    <div className="ed-fade" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
        <Focusable
          className="ed-chip"
          onClick={onBack}
          onActivate={onBack}
          style={{ padding: "7px 14px", fontSize: "0.9em", display: "flex", alignItems: "center", gap: "6px" }}
        >
          <FaArrowLeft /> 游戏库
        </Focusable>
      </div>

      <div style={{ display: "flex", gap: "1.6em", flex: 1, minHeight: 0 }}>
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
                fontSize: "0.78em",
                color: installed ? "#7ee2a8" : "rgba(255,255,255,0.7)",
              }}
            >
              {installed ? "已安装" : "未安装"}
            </span>
            {inSteam ? (
              <span
                className="ed-chip"
                style={{ padding: "4px 10px", fontSize: "0.78em", display: "flex", gap: "5px", alignItems: "center" }}
              >
                <FaSteamSymbol /> Steam
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
                  ? "已占用 " + fmtSize(game.installed_size)
                  : sizes.disk
                  ? "安装后 " + fmtSize(sizes.disk)
                  : "体积读取中…"}
              </span>
              {!installed && sizes.download > 0 ? <span>需下载 {fmtSize(sizes.download)}</span> : null}
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
            {installed ? (
              <Focusable
                className="ed-action"
                data-primary="true"
                style={{ padding: "12px 26px", fontSize: "1em" }}
                onClick={busy ? undefined : once(doLaunch)}
                onActivate={busy ? undefined : once(doLaunch)}
              >
                <FaPlay /> {busy === "launch" ? "正在启动…" : "启动游戏"}
              </Focusable>
            ) : active ? (
              <Focusable
                className="ed-action"
                data-danger="true"
                style={{ padding: "12px 26px", fontSize: "1em" }}
                onClick={once(() => {
                  void actions.cancel(game.app_name);
                })}
                onActivate={once(() => {
                  void actions.cancel(game.app_name);
                })}
              >
                <FaTrash /> 取消下载
              </Focusable>
            ) : (
              <Focusable
                className="ed-action"
                data-primary="true"
                style={{ padding: "12px 26px", fontSize: "1em" }}
                onClick={busy ? undefined : once(doInstall)}
                onActivate={busy ? undefined : once(doInstall)}
              >
                <FaDownload /> {busy === "install" ? "正在准备…" : "下载并安装"}
              </Focusable>
            )}

            <Focusable
              className="ed-action"
              style={{ padding: "12px 20px", fontSize: "0.95em" }}
              onClick={busy ? undefined : once(doToggleSteam)}
              onActivate={busy ? undefined : once(doToggleSteam)}
              data-disabled={!installed ? "true" : "false"}
            >
              <FaSteamSymbol /> {inSteam ? "从 Steam 移除" : "添加到 Steam"}
            </Focusable>

            {installed ? (
              <Focusable
                className="ed-action"
                data-danger="true"
                style={{ padding: "12px 20px", fontSize: "0.95em" }}
                onClick={busy ? undefined : once(doUninstall)}
                onActivate={busy ? undefined : once(doUninstall)}
              >
                <FaTrash /> 卸载
              </Focusable>
            ) : null}
          </NavRow>

          {!installed && !active ? (
            <Group style={{ padding: "14px 16px" }}>
              <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>安装位置</div>
              <Dropdown
                rgOptions={dirOptions}
                selectedOption={target}
                onChange={(e) => setTarget(e.data)}
              />
            </Group>
          ) : null}

          <Group style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>
              启动参数{argsNote ? ` · ${argsNote}` : ""}
            </div>
            <TextField
              value={args}
              onChange={(e: any) => {
                setArgs(e.target.value);
                setArgsDirty(true);
              }}
              label="追加在 legendary launch 之后，如 -windowed；留空即不添加"
            />
          </Group>

          <div style={{ fontSize: "0.75em", opacity: 0.4 }}>
            {game.app_name} · 版本 {game.version || "未知"}
          </div>
        </div>
      </div>
    </div>
  );
}

// -- downloads ----------------------------------------------------------

function DownloadsTab({ onOpenGame }: { onOpenGame: (appName: string) => void }) {
  const { games, progress } = usePluginState();
  const items = useMemo(() => {
    return Object.entries(progress)
      .filter(([, p]) => isActive(p) || p.state === "error" || p.state === "cancelled")
      .sort((a, b) => (isActive(b[1]) ? 1 : 0) - (isActive(a[1]) ? 1 : 0));
  }, [progress]);

  const titleOf = (appName: string) =>
    games.find((g) => g.app_name === appName)?.title ?? appName.slice(0, 12);

  if (items.length === 0) {
    return (
      <div
        className="ed-group"
        style={{ padding: "46px 24px", textAlign: "center", opacity: 0.65, lineHeight: 1.8 }}
      >
        <div style={{ fontSize: "2em", marginBottom: "10px", opacity: 0.5 }}>
          <FaDownload />
        </div>
        <div>当前没有下载任务。</div>
        <div style={{ fontSize: "0.85em", opacity: 0.75, marginTop: "4px" }}>
          在游戏库里选一个没安装的游戏，点「下载并安装」。
        </div>
      </div>
    );
  }

  return (
    <Scroller className="ed-fade" contentStyle={{ paddingRight: "6px", paddingBottom: "1.4em" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxWidth: "980px", paddingBottom: "1.4em" }}>
        {items.map(([appName, p]) => {
          const game = games.find((g) => g.app_name === appName);
          const running = isActive(p);
          const tone = p.state === "error" ? "#ff9b9b" : p.state === "cancelled" ? "#c9c9c9" : "#9ecbff";
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
                  <div style={{ fontSize: "0.8em", color: tone }}>{STATE_LABEL[p.state] ?? p.state}</div>
                </div>
                <ProgressInline progress={p} compact />
              </div>
              <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                {running ? (
                  <Focusable
                    className="ed-action"
                    data-danger="true"
                    style={{ padding: "8px 14px", fontSize: "0.85em" }}
                    onClick={() => {
                      void actions.cancel(appName);
                    }}
                    onActivate={() => {
                      void actions.cancel(appName);
                    }}
                  >
                    取消
                  </Focusable>
                ) : (
                  <Focusable
                    className="ed-action"
                    style={{ padding: "8px 14px", fontSize: "0.85em" }}
                    onClick={() => onOpenGame(appName)}
                    onActivate={() => onOpenGame(appName)}
                  >
                    查看
                  </Focusable>
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

function SettingsTab() {
  const { auth, games, progress } = usePluginState();
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [dirs, setDirs] = useState<{ path: string; label: string; free: number }[]>([]);
  const [protons, setProtons] = useState<{ data: string; label: string }[]>([]);
  const [customPath, setCustomPath] = useState<string>("");
  const [savingPath, setSavingPath] = useState(false);
  const [busy, setBusy] = useState<string>("");
  const [env, setEnv] = useState<{ legendary?: string; proton?: string }>({});

  useEffect(() => {
    (async () => {
      const [s, d, p, lv, e] = await Promise.all([
        getSettings(),
        getInstallDirOptions(),
        getProtonOptions().catch(() => ({ options: [] as { data: string; label: string }[] })),
        getLegendaryVersion().catch(() => ({ ok: false })),
        checkEnvironment().catch(() => null),
      ]);
      setSettings(s);
      setDirs(d.options ?? []);
      setProtons(p.options ?? []);
      setCustomPath(s.install_dir || d.current || "");
      setEnv({
        legendary: (lv as any)?.version || (e as any)?.legendary_path || "",
        proton: (e as any)?.proton_path || "",
      });
    })();
  }, []);

  const update = async (key: string, value: any) => {
    setSettings((s) => ({ ...s, [key]: value }));
    await setSetting(key, value);
    // The Steam menu reads this flag on every render, so flipping it here is
    // enough — the entry appears/disappears next time the menu opens.
    if (key === "show_menu_entry") setSteamMenuEntryEnabled(value !== false);
    if (key === "title_locale" || key === "auto_fetch_size" || key === "use_proton") {
      window.dispatchEvent(new CustomEvent("epicdeck:library-changed"));
    }
  };

  const applyCustomPath = async () => {
    if (savingPath) return;
    if (!customPath.trim()) {
      toaster.toast({ title: "请填写路径", body: "留空则使用上面的默认安装目录" });
      return;
    }
    setSavingPath(true);
    try {
      const r = await resolveInstallDir(customPath);
      if (!r.ok || !r.path) {
        toaster.toast({ title: "路径无效", body: r.error ?? "" });
        return;
      }
      setCustomPath(r.path);
      await update("install_dir", r.path);
      toaster.toast({ title: "已保存安装目录", body: r.path });
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
    <Scroller className="ed-fade" contentStyle={{ paddingRight: "6px", paddingBottom: "1.6em" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "18px", maxWidth: "1040px", paddingBottom: "1.8em" }}>
        {/* account */}
        <div>
          <SectionTitle hint="Epic 账号与库概况">账号</SectionTitle>
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
                {auth?.display_name || "未登录"}
              </div>
              <div style={{ fontSize: "0.82em", opacity: 0.55, marginTop: "3px" }}>
                {auth?.account_id ? `账号 ID ${maskPersonal(auth.account_id)}` : "尚未登录 Epic 账号"}
                {stats.hours > 0 ? ` · 累计游玩 ${stats.hours.toFixed(1)} 小时` : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: "10px", flexShrink: 0 }}>
              <ActionButton
                style={{ padding: "10px 18px", fontSize: "0.9em" }}
                onClick={async () => {
                  const r = await signOut();
                  if (r.ok) done("已登出", "可以重新登录其他账号");
                  else done("登出失败", r.error ?? "");
                }}
              >
                登出
              </ActionButton>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "12px", marginTop: "12px" }}>
            <StatBlock label="游戏总数" value={stats.total} sub="Epic 库中拥有" />
            <StatBlock label="已安装" value={stats.installed} sub={`占用 ${fmtSize(stats.size)}`} accent="#7ee2a8" />
            <StatBlock label="加入 Steam" value={stats.steam} sub="非 Steam 快捷方式" />
            <StatBlock
              label="下载任务"
              value={stats.downloading}
              sub={stats.downloading > 0 ? "正在下载" : "空闲"}
              accent={stats.downloading > 0 ? "#9ecbff" : undefined}
            />
          </div>
        </div>

        {/* steam */}
        <div>
          <SectionTitle hint="决定游戏是否出现在 Steam 库里">Steam 集成</SectionTitle>
          <Group>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <ToggleField
                label="自动添加到 Steam"
                description="下载完成后自动写入 Steam 的非 Steam 快捷方式"
                checked={!!settings.auto_add_to_steam}
                onChange={(v) => update("auto_add_to_steam", v)}
              />
              <ToggleField
                label="自动下载封面图"
                description="把 Epic 的竖版封面/横幅写进 Steam 的 grid 目录"
                checked={settings.auto_cover !== false}
                onChange={(v) => update("auto_cover", v)}
              />
              <ToggleField
                label="在 Steam 菜单显示 EpicDeck"
                description="按 STEAM 键后，「库」下方多一个 EpicDeck 游戏库入口；下次打开菜单生效"
                checked={settings.show_menu_entry !== false}
                onChange={(v) => update("show_menu_entry", v)}
              />
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
                    if (!r.ok) done("添加失败", r.error ?? "");
                    else {
                      const failed = r.failed ?? [];
                      done(
                        "已写入 Steam",
                        failed.length
                          ? `已添加 ${r.added ?? 0} 个，失败 ${failed.length} 个（${failed[0].title}）`
                          : `已添加 ${r.added ?? 0} 个。${r.note ?? ""}`
                      );
                    }
                  } finally {
                    setBusy("");
                  }
                }}
              >
                <FaSteamSymbol /> 把已安装的游戏全部加入 Steam
              </ActionButton>
              <ActionButton
                disabled={busy === "art"}
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  if (busy) return;
                  setBusy("art");
                  try {
                    const r = await refreshArtwork("");
                    if (!r.ok) done("封面下载失败", r.error ?? "");
                    else
                      done(
                        r.updated ? "封面已补齐" : "封面已是最新",
                        (r.updated ? `更新 ${r.updated}/${r.total ?? 0} 个。` : "") + (r.note ?? "")
                      );
                  } finally {
                    setBusy("");
                  }
                }}
              >
                补齐封面与图标
              </ActionButton>
              <ActionButton
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  const r = await refreshSteam();
                  done(r.ok ? "正在重启 Steam" : "刷新失败", r.ok ? r.note ?? "" : r.error ?? "");
                }}
              >
                重启 Steam 刷新游戏库
              </ActionButton>
            </NavRow>
          </Group>
        </div>

        {/* compatibility */}
        <div>
          <SectionTitle hint="Windows 版 Epic 游戏靠 Steam 自带的 Proton 启动">启动与兼容</SectionTitle>
          <Group>
            <ToggleField
              label="Windows 游戏用 Proton 运行"
              description="SteamOS 没有 wine；关掉这项 Windows 游戏会起不来"
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
                <div style={{ fontSize: "0.78em", opacity: 0.5, marginTop: "6px" }}>
                  自动 = 优先 GE-Proton，其次 Steam 自带的最新正式版
                  {env.proton ? ` · 当前 ${env.proton}` : ""}
                </div>
              </div>
            ) : null}
          </Group>
        </div>

        {/* dirs & language */}
        <div>
          <SectionTitle hint="新下载默认放这里，单个游戏可以单独指定">目录与语言</SectionTitle>
          <Group>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div>
                <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>默认安装目录</div>
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
                <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>游戏名语言</div>
                <Dropdown
                  rgOptions={LOCALE_OPTIONS}
                  selectedOption={settings.title_locale || "auto"}
                  onChange={(e) => update("title_locale", e.data)}
                />
              </div>
            </div>

            <div style={{ marginTop: "14px", display: "flex", gap: "10px", alignItems: "flex-end" }}>
              <div style={{ flex: 1, maxWidth: "520px" }}>
                <div style={{ fontSize: "0.8em", opacity: 0.55, marginBottom: "8px" }}>
                  自定义路径（目录不存在会自动创建）
                </div>
                <TextField
                  value={customPath}
                  onChange={(e: any) => setCustomPath(e.target.value)}
                  label="例如 /run/media/deck/MySD/EpicGames"
                />
              </div>
              <ActionButton
                style={{ padding: "10px 18px", fontSize: "0.9em", height: "fit-content" }}
                onClick={applyCustomPath}
                disabled={savingPath}
              >
                保存路径
              </ActionButton>
            </div>

            <div style={{ marginTop: "14px" }}>
              <ToggleField
                label="后台读取安装体积"
                description="逐个读取 Epic 清单来估算体积（每个游戏几秒、几 MB 流量，结果缓存 30 天）"
                checked={settings.auto_fetch_size !== false}
                onChange={(v) => update("auto_fetch_size", v)}
              />
            </div>
          </Group>
        </div>

        {/* maintenance */}
        <div>
          <SectionTitle hint="排查问题时用">维护</SectionTitle>
          <Group>
            <NavRow level="maintenance" style={{ gap: "10px", flexWrap: "wrap" }}>
              <ActionButton
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  const r = await exportLogs();
                  if (!r.ok) {
                    done("导出失败", r.error ?? "");
                    return;
                  }
                  showModal(
                    <ConfirmModal
                      strTitle="诊断日志"
                      strDescription={
                        <div>
                          <div style={{ fontSize: "0.85em", opacity: 0.7, marginBottom: "8px" }}>
                            日志已导出到:{r.path || "（写入失败）"}
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
                      strOKButtonText="关闭"
                    />
                  );
                }}
              >
                导出诊断日志
              </ActionButton>
              <ActionButton
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  const r = await installLegendary();
                  done(r.ok ? "Legendary 已就绪" : "安装失败", r.ok ? r.version ?? "" : r.error ?? "");
                }}
              >
                重新安装 Legendary
              </ActionButton>
              <ActionButton
                style={{ padding: "10px 16px", fontSize: "0.9em" }}
                onClick={async () => {
                  const e = await checkEnvironment();
                  done(
                    e.legendary_installed ? "环境正常" : "缺少 Legendary",
                    `Legendary ${e.legendary_path || "未找到"}${e.proton_path ? ` · Proton ${e.proton_path}` : ""}`
                  );
                }}
              >
                <FaRedo /> 检查环境
              </ActionButton>
            </NavRow>
            <div style={{ marginTop: "12px", fontSize: "0.78em", opacity: 0.45 }}>
              Legendary {env.legendary || "未知版本"} · 插件 {PLUGIN_VERSION} · 数据目录
              ~/homebrew/settings/EpicDeck
            </div>
          </Group>
        </div>
      </div>
    </Scroller>
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
        setNote(r.error ?? "保存失败");
        return;
      }
      toaster.toast({ title: "下载位置已设置", body: r.install_dir ?? path });
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
        setNote(v.error ?? "路径无效");
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
          <div style={{ fontSize: "1.4em", fontWeight: 800, marginBottom: "8px" }}>先选个下载位置</div>
          <div style={{ fontSize: "0.9em", opacity: 0.65, lineHeight: 1.6, marginBottom: "18px" }}>
            Epic 游戏体积很大，先确认装在哪里。之后可以在「设置 → 目录与语言」随时改，单个游戏也能单独指定。
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
              label="自定义路径（可选，例如 /run/media/deck/MySD/EpicGames）"
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
              <FaDownload /> 使用此位置并继续
            </ActionButton>
            <ActionButton
              style={{ padding: "11px 18px", fontSize: "0.95em" }}
              onClick={() => finish("")}
            >
              用默认位置（~/Games）
            </ActionButton>
            <ActionButton
              style={{ padding: "11px 18px", fontSize: "0.95em" }}
              onClick={async () => {
                await reloadDirs();
              }}
            >
              刷新磁盘
            </ActionButton>
          </NavRow>
        </div>
      </div>
    </div>
  );
}

// -- page shell ---------------------------------------------------------

export function FullScreenPage() {
  const state = usePluginState();
  // Measured from the element, not the window: plugin code runs in Decky's
  // hidden 1×1 SharedJSContext, so `window.innerWidth` lies.
  const surfaceRef = useRef<HTMLDivElement>(null);
  const viewport = useViewport(surfaceRef);
  const [tab, setTab] = useState<TabId>(() => readFsUI().tab);
  const [detail, setDetail] = useState<string | null>(null);
  const [booting, setBooting] = useState(!state.booted);
  // The library owns its paging state; it registers its pager here so L1/R1 can
  // flip pages while focus is inside the grid.
  const gridBumperRef = useRef<((delta: number) => void) | null>(null);

  useEffect(() => {
    let alive = true;
    ensureBoot().finally(() => {
      if (alive) setBooting(false);
    });
    return () => {
      alive = false;
    };
  }, []);

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
    }, 260);
    return () => window.clearTimeout(timer);
  }, []);

  // Landing on a tab is the same intent as picking it: switch the page.
  useEffect(() => {
    for (const t of TABS) {
      setFocusAction(`tab:${t.id}`, () => {
        setTab((prev) => {
          if (prev === t.id) return prev;
          setDetail(null);
          writeFsUI({ tab: t.id });
          return t.id;
        });
      });
    }
    return () => {
      for (const t of TABS) setFocusAction(`tab:${t.id}`, null);
    };
  }, []);

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
      if (!t || !root.contains(t)) return;
      clear();
      t.classList.add("ed-focus");
      // Keep the navigator anchored to whatever really has focus (Steam may move
      // it on its own after a click / tab switch).
      rememberFocus(t);
    };
    doc.addEventListener("focusin", onFocusIn, true);
    return () => {
      doc.removeEventListener("focusin", onFocusIn, true);
      clear();
    };
  }, []);

  useEffect(() => {
    const view = surfaceRef.current?.ownerDocument?.defaultView as any;
    if (!view) return;
    view.__epicdeckMoveFocus = moveFocus;
    // Same path the stick takes: move, then run the landing element's action.
    view.__epicdeckNav = (button: number) => {
      const root = surfaceRef.current;
      if (!root) return false;
      if (!moveFocus(button, root)) return false;
      runFocusAction(root.ownerDocument.activeElement as HTMLElement | null);
      return true;
    };
    return () => {
      delete view.__epicdeckMoveFocus;
      delete view.__epicdeckNav;
    };
  }, []);

  // The navigator lives in the plugin window but must act on Big Picture's DOM.
  // Exposing it on the *page* window makes that explicit and gives us a way to
  // drive focus from devtools / CDP when debugging.
  useEffect(() => {
    const view = surfaceRef.current?.ownerDocument?.defaultView as any;
    if (!view) return;
    view.__epicdeckMoveFocus = moveFocus;
    // Same path the stick takes: move, then run the landing element's action.
    view.__epicdeckNav = (button: number) => {
      const root = surfaceRef.current;
      if (!root) return false;
      if (!moveFocus(button, root)) return false;
      runFocusAction(root.ownerDocument.activeElement as HTMLElement | null);
      return true;
    };
    return () => {
      delete view.__epicdeckMoveFocus;
      delete view.__epicdeckNav;
    };
  }, []);

  const showTab = (next: TabId) => {
    setTab(next);
    setDetail(null);
    writeFsUI({ tab: next });
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
    const i = TABS.findIndex((t) => t.id === tab);
    const next = (i + delta + TABS.length) % TABS.length;
    showTab(TABS[next].id);
  };
  // Directional input goes through our own geometric navigator: Steam's nav tree
  // cannot express "rows of rows" in a custom layout, so the stick used to walk
  // DOM order (down = right). See geomnav.ts.
  //
  // Handled in `onGamepadDirection` only — that is the direction-specific event
  // Steam offers and the one whose default navigation can be suppressed. Doing
  // it in `onButtonDown` as well would move focus twice per press.
  const dirGuardRef = useRef({ button: 0, at: 0 });
  const okGuardRef = useRef({ at: 0 });
  const onRootDirection = (evt: any) => {
    const button = Number(evt?.detail?.button || 0);
    const now = Date.now();
    // One press can arrive twice (stick + d-pad synthesis); ignore the echo.
    if (dirGuardRef.current.button === button && now - dirGuardRef.current.at < 60) {
      evt?.preventDefault?.();
      evt?.stopPropagation?.();
      return;
    }
    if (moveFocus(button, surfaceRef.current)) {
      dirGuardRef.current = { button, at: now };
      runFocusAction(surfaceRef.current?.ownerDocument?.activeElement as HTMLElement | null);
      evt?.preventDefault?.();
      evt?.stopPropagation?.();
    }
  };

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
      const now = Date.now();
      if (okGuardRef.current.at && now - okGuardRef.current.at < 250) {
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

    // L1/R1 acts on the level the focus is currently in: inside the game grid
    // they flip pages, everywhere else they switch tabs. Falling back to "switch
    // tab" keeps them useful on rows that have no pages of their own.
    const level = focusLevel(evt);
    if (level === "grid" && gridBumperRef.current) {
      gridBumperRef.current(delta);
      evt?.preventDefault?.();
      evt?.stopPropagation?.();
      return;
    }
    tabOffset(delta);
  };

  // One B press must pop exactly one route entry. Two separate things used to
  // make it two: Steam runs its own cancel navigation unless the handler claims
  // the event, and the fallback timer could fire *after* we had already left —
  // the detached page kept reporting its old pathname, so it looked "still here"
  // and popped once more.
  const leaveRef = useRef({ busy: false, at: 0 });
  const leaveTimers = useRef<number[]>([]);

  useEffect(() => {
    const timers = leaveTimers;
    return () => {
      for (const id of timers.current) window.clearTimeout(id);
      timers.current = [];
    };
  }, []);

  const goBack = () => {
    const root = surfaceRef.current;
    const now = Date.now();
    // Coalesce repeated events (ours + Steam's default, or a held button).
    if (leaveRef.current.busy || now - leaveRef.current.at < 800) return;
    leaveRef.current = { busy: true, at: now };

    // `NavigateBack()` does **not** throw when Steam's route stack is empty — it
    // just quietly does nothing (or only restores the focused item, which looks
    // like "back went to the last button").
    const pageWindow = root?.ownerDocument?.defaultView as any;
    const before = String(pageWindow?.location?.pathname || "");
    try {
      Navigation.NavigateBack();
    } catch (e) {
      console.log("EpicDeck: NavigateBack failed", e);
    }

    // Fall back only if this page is *still mounted on the same route*: a
    // successful pop detaches it almost immediately, and navigating from a
    // detached page is exactly what caused the extra back.
    const timer = window.setTimeout(() => {
      const mount = surfaceRef.current;
      if (!mount?.isConnected) return;
      const current = String(mount.ownerDocument?.defaultView?.location?.pathname || "");
      if (current !== before) return;
      try {
        if (Navigation.NavigateToLibraryTab) Navigation.NavigateToLibraryTab();
        else Navigation.Navigate("/library/home");
      } catch (e) {
        console.log("EpicDeck: leave fallback failed", e);
      }
      // Still here (or the fallback failed): let the next press try again.
      leaveRef.current.busy = false;
    }, 300);
    leaveTimers.current.push(timer);
  };

  // B (CANCEL) walks back up the in-page stack first: detail view → library
  // list → leave the plugin. Mirrors how Steam pages behave.
  const onCancel = (evt?: any) => {
    // Claim the event. Without preventDefault Steam treats B as unhandled and
    // performs its own route pop on top of ours.
    evt?.preventDefault?.();
    evt?.stopPropagation?.();
    if (detail) {
      setDetail(null);
    } else {
      goBack();
    }
    return true;
  };

  const header = (
    <NavRow
      level="header"
      style={{
        alignItems: "center",
        gap: "0.75em",
        padding: viewport.compact ? "0.3em 1em 0.25em" : "0.5em 1.5em 0.4em",
      }}
    >
      <Focusable
        noFocusRing
        className="ed-chip"
        onClick={goBack}
        onActivate={goBack}
        style={{
          padding: "0.42em 0.8em",
          fontSize: "0.86em",
          display: "flex",
          alignItems: "center",
          gap: "0.4em",
          flexShrink: 0,
        }}
      >
        <FaArrowLeft /> 返回
      </Focusable>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.6em", minWidth: 0 }}>
        <div style={{ fontSize: "1.15em", fontWeight: 800, letterSpacing: "0.01em" }}>EpicDeck</div>
        {viewport.compact ? null : (
          <div style={{ fontSize: "0.82em", opacity: 0.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {state.auth?.display_name || "未登录"}
            {state.games.length ? ` · ${state.games.length} 个游戏` : ""}
            {state.cachedAt ? ` · 更新于 ${fmtAgo(state.cachedAt)}` : ""}
          </div>
        )}
      </div>
      <div style={{ flex: 1 }} />
      <Focusable
        noFocusRing
        className="ed-chip"
        onClick={() => {
          void refreshLibrary(true);
        }}
        onActivate={() => {
          void refreshLibrary(true);
        }}
        style={{
          padding: "0.42em 0.8em",
          fontSize: "0.86em",
          display: "flex",
          alignItems: "center",
          gap: "0.4em",
          opacity: state.refreshing ? 0.5 : 1,
        }}
      >
        <FaRedo /> {state.refreshing ? "刷新中…" : "刷新"}
      </Focusable>
    </NavRow>
  );

  const tabBar = (
    <NavRow
      level="tabs"
      style={{ gap: "0.5em", padding: viewport.compact ? "0 1em 0.4em" : "0 1.5em 0.6em" }}
    >
      {TABS.map((t) => {
        const active = t.id === tab;
        const badge =
          t.id === "downloads" ? Object.values(state.progress).filter((p) => isActive(p)).length : 0;
        return (
          <Focusable
            key={t.id}
            noFocusRing
            className="ed-chip"
            data-active={active ? "true" : "false"}
            onClick={() => showTab(t.id)}
            onActivate={() => showTab(t.id)}
            // Moving the highlight onto a tab is the same intent as picking it.
            data-ed-focus-action={`tab:${t.id}`}
            style={{
              padding: "0.55em 1.05em",
              fontSize: "0.95em",
              display: "flex",
              alignItems: "center",
              gap: "0.5em",
              fontWeight: active ? 700 : 500,
            }}
          >
            {t.icon}
            {t.label}
            {badge > 0 ? (
              <span
                style={{
                  background: "#4aa3ff",
                  color: "#04121f",
                  borderRadius: "999px",
                  fontSize: "0.72em",
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
        [GamepadButton.CANCEL]: "返回",
        [GamepadButton.BUMPER_LEFT]: "上一页 / 上一个标签",
        [GamepadButton.BUMPER_RIGHT]: "下一页 / 下一个标签",
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
      {tabBar}

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
          <div style={{ padding: "60px 0", textAlign: "center", opacity: 0.6 }}>正在读取账号与游戏库…</div>
        ) : !state.env.legendary_installed ? (
          <div style={{ display: "flex", justifyContent: "center", paddingTop: "20px" }}>
            <div className="ed-group" style={{ padding: "26px 28px", maxWidth: "640px" }}>
              <div style={{ fontSize: "1.3em", fontWeight: 700, marginBottom: "8px" }}>缺少 Legendary</div>
              <div style={{ fontSize: "0.9em", opacity: 0.7, lineHeight: 1.6 }}>
                SteamOS 没有 pip，插件会直接从 GitHub Releases 下载官方独立二进制（约 3 MB）。
              </div>
              <ActionButton
                primary
                style={{ padding: "11px 22px", fontSize: "0.95em", marginTop: "16px", width: "fit-content" }}
                onClick={async () => {
                  const r = await installLegendary();
                  if (r.ok) {
                    toaster.toast({ title: "安装成功", body: `Legendary ${r.version ?? ""} 已安装` });
                    await recheckEnv();
                    await refreshLibrary(true);
                  } else {
                    toaster.toast({ title: "安装失败", body: r.error ?? "" });
                  }
                }}
              >
                一键安装 Legendary
              </ActionButton>
            </div>
          </div>
        ) : state.firstRunDone === false ? (
          <SetupScreen onDone={() => markFirstRunDone("")} />
        ) : !state.auth?.logged_in ? (
          <Scroller>
            <LoginPanel variant="screen" onLoggedIn={() => void onSignedIn()} />
          </Scroller>
        ) : tab === "library" ? (
          detail ? (
            <DetailView appName={detail} onBack={() => setDetail(null)} />
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
                        text={`${state.error.message} 当前显示的是上次加载的游戏库。`}
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
          />
        ) : (
          <SettingsTab />
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
    toaster.toast({ title: "打不开大屏页面", body: String(e) });
  }
}
