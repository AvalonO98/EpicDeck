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
  Focusable,
  GamepadButton,
  Navigation,
} from "@decky/ui";
import { toaster } from "@decky/api";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  FaArrowLeft,
  FaCog,
  FaDownload,
  FaRedo,
  FaThLarge,
} from "react-icons/fa";
import {
  installLegendary,
  isActive,
} from "./api";
import {
  ActionButton,
  ErrorBlock,
  NavRow,
  Scroller,
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
  ensureBoot,
  type PluginState,
  markFirstRunDone,
  onSignedIn,
  recheckEnv,
  refreshLibrary,
  shallowEqual,
  usePluginSelector,
} from "./store";
import { STEAM_BOTTOM_INSET, STEAM_TOP_INSET, useViewport } from "./viewport";
import { LIBRARY_ROUTE } from "./routes";
import { readFsUI, TAB_IDS, writeFsUI, type TabId } from "./shell/fsui";
import { COLOR } from "./tokens";
import { DownloadsTab } from "./pages/Downloads";
import { DetailView } from "./pages/Detail";
import { LibraryTab } from "./pages/Library";
import { SettingsTab } from "./pages/Settings";
import { SetupScreen } from "./pages/Setup";
import { t, tf, useLangVersion } from "./i18n";

export { LIBRARY_ROUTE };

// Labels stay in the source language: this array is built at import time, long
// before the backend tells us which language to use, so `t()` here would freeze
// the tabs. Translate at render instead (`.label` is a t() key).
const TAB_META: Record<TabId, { label: string; icon: ReactNode }> = {
  library: { label: "游戏库", icon: <FaThLarge /> },
  downloads: { label: "下载", icon: <FaDownload /> },
  settings: { label: "设置", icon: <FaCog /> },
};
// `Record<TabId, …>` 保证漏写一个标签就是类型错误；顺序由 TAB_IDS 决定。
const TABS = TAB_IDS.map((id) => ({ id, ...TAB_META[id] }));

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
