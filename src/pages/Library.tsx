// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

/**
 * The library grid: filter chips, search, sort, pager and the 5×N covers.
 *
 * Split out of `fullscreen.tsx` (3513 lines). Each cover subscribes to its own
 * `progress[app_name]` row (audit 3.5), so a download repaints one tile instead
 * of the whole page — that is why `LibraryTile` is `memo` and takes no
 * `progress` prop.
 */
import { Dropdown, Focusable, TextField } from "@decky/ui";
import {
  memo,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FaSearch, FaSteamSymbol } from "react-icons/fa";
import {
  INSTALL_FILTER_LABEL,
  INSTALL_FILTER_ORDER,
  LOCALE_LABELS,
  SORT_OPTIONS,
  fmtSize,
  isActive,
  type Game,
  type InstallProgress,
} from "../api";
import { NavRow } from "../components";
import { getLang, t, tf } from "../i18n";
import { readFsUI, writeFsUI } from "../shell/fsui";
import { shallowEqual, usePluginSelector } from "../store";
import { COLOR } from "../tokens";
import { Pager } from "../ui/primitives";
import type { Viewport } from "../viewport";
import { PAGE_SIZE } from "../routes";
import type { InstallFilter, SortMode } from "../api";

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

export function LibraryTab({
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
