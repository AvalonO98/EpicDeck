// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// One store shared by every surface of the plugin.
//
// The QAM panel and the full-screen page are two separate React trees (the QAM
// is mounted by Decky, the full-screen page by Steam's router), so React context
// cannot reach across them. A module-level store keeps them in sync: the library
// is fetched once, install progress is subscribed once, and navigating between
// the two never re-runs `legendary list`.

import { addEventListener, toaster } from "@decky/api";
import { useSyncExternalStore } from "react";
import {
  authStatus,
  addToSteam,
  cancelInstall,
  checkEnvironment,
  getActiveInstalls,
  getInstallDirOptions,
  getSettings,
  installGame,
  launchGame,
  listGames,
  logout,
  pauseInstall,
  refreshSteam,
  removeFromSteam,
  resumeInstall,
  uninstallGame,
  type AuthStatus,
  type EnvironmentInfo,
  type Game,
  type InstallDirOption,
  type InstallProgress,
  type LibraryFailure,
  type LibraryPayload,
} from "./api";
import { t } from "./i18n";

export interface PluginState {
  auth: AuthStatus | null;
  games: Game[];
  /** True only while there is nothing to paint yet. */
  loading: boolean;
  /** A user-triggered refresh is in flight. */
  refreshing: boolean;
  error: LibraryFailure | null;
  sizePending: number;
  locale: string;
  /** Unix seconds of the payload the list came from (0 = live fetch). */
  cachedAt: number;
  progress: Record<string, InstallProgress>;
  dirs: InstallDirOption[];
  defaultDir: string;
  env: EnvironmentInfo;
  firstRunDone: boolean | null;
  booted: boolean;
}

// ---- library snapshot cache -------------------------------------------
// Opening the QAM must not wait for `legendary list`. The backend keeps its
// own snapshot, and the frontend keeps the last rendered list too: `window`
// survives a QAM close/open (the panel is unmounted, the window is not), and
// localStorage covers a full plugin-UI reload.
const LIB_CACHE_KEY = "epicdeck:library:v2";
const LIB_MEM_KEY = "__epicdeckLibrary";

interface LibraryCache {
  account: string;
  ts: number;
  locale: string;
  size_pending?: number;
  games: Game[];
}

function readLibraryCache(account?: string): LibraryCache | null {
  const accept = (data: any): LibraryCache | null => {
    if (!data || !Array.isArray(data.games) || data.games.length === 0) return null;
    if (account && data.account && data.account !== account) return null;
    return data as LibraryCache;
  };
  const mem = accept((window as any)[LIB_MEM_KEY]);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(LIB_CACHE_KEY);
    const data = raw ? accept(JSON.parse(raw)) : null;
    // Promote to memory: localStorage is a synchronous read, and this helper
    // is called several times while a surface mounts.
    if (data) (window as any)[LIB_MEM_KEY] = data;
    return data;
  } catch {
    return null;
  }
}

function writeLibraryCache(
  account: string,
  payload: { games?: Game[]; locale?: string; size_pending?: number }
) {
  if (!payload.games || payload.games.length === 0) return;
  const data: LibraryCache = {
    account,
    ts: Math.floor(Date.now() / 1000),
    locale: payload.locale ?? "",
    size_pending: payload.size_pending ?? 0,
    games: payload.games,
  };
  (window as any)[LIB_MEM_KEY] = data;
  try {
    localStorage.setItem(LIB_CACHE_KEY, JSON.stringify(data));
  } catch (e) {
    console.log("EpicDeck: library cache write failed", e);
  }
}

export function clearLibraryCache() {
  delete (window as any)[LIB_MEM_KEY];
  try {
    localStorage.removeItem(LIB_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

// ---- store ------------------------------------------------------------

const cached = readLibraryCache();

let state: PluginState = {
  auth: null,
  games: cached?.games ?? [],
  loading: !cached,
  refreshing: false,
  error: null,
  sizePending: cached?.size_pending ?? 0,
  locale: cached?.locale ?? "",
  cachedAt: cached?.ts ?? 0,
  progress: {},
  dirs: [],
  defaultDir: "",
  env: { legendary_installed: true, legendary_path: "" },
  firstRunDone: null,
  booted: false,
};

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.log("EpicDeck: store listener failed", e);
    }
  });
}

export function getPluginState(): PluginState {
  return state;
}

export function setPluginState(patch: Partial<PluginState>) {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe a component to the whole state object (stable between writes). */
export function usePluginState(): PluginState {
  return useSyncExternalStore(subscribe, getPluginState, getPluginState);
}

const accountId = () => state.auth?.account_id || "";

function applyPayload(r: LibraryPayload) {
  setPluginState({
    games: r.games ?? [],
    sizePending: r.size_pending ?? 0,
    locale: r.locale ?? "",
    cachedAt: r.stale ? r.cached_at ?? state.cachedAt : Math.floor(Date.now() / 1000),
    error: r.error_kind
      ? { message: r.warning || r.error || t("读取游戏库失败"), kind: r.error_kind }
      : r.warning
      ? { message: r.warning, kind: "unknown" }
      : null,
    loading: false,
  });
  writeLibraryCache(accountId(), r);
}

// ---- events -----------------------------------------------------------

let eventsBound = false;

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;

  addEventListener<[string, string, number, string, string, string, number?, number?]>(
    "install_progress",
    (appName, st, percent, message, speed, eta, downloadedBytes, totalBytes) => {
      const progress = {
        ...state.progress,
        [appName]: {
          // Keep what the snapshot put here (notably `title`): an event carries
          // no title, and a bare overwrite made the download list fall back to
          // the raw app_name.
          ...state.progress[appName],
          state: st,
          percent,
          message,
          speed,
          eta,
          downloaded_bytes: downloadedBytes,
          total_bytes: totalBytes,
        } as InstallProgress,
      } as Record<string, InstallProgress>;
      setPluginState({ progress });
      // A finished install flips is_installed / sizes; one refetch covers both.
      if (st === "done") {
        // Mirrors the "开始下载" toast so the pair reads as the two ends of one
        // action. `state.games` may still be empty (a download inherited right
        // after a reload), hence the fallback.
        const finished = state.games.find((g) => g.app_name === appName);
        toaster.toast({
          title: t("安装完成"),
          body: finished?.title || appName.slice(0, 12),
        });
        setTimeout(() => {
          void reloadGames();
        }, 800);
      }
    }
  );

  // The backend patches titles/sizes in as it discovers them (localised title
  // first, then one manifest per game), so the list never blocks on 138
  // network round-trips. Playtime arrives through the same channel.
  addEventListener<[Record<string, any>, number]>("library_patch", (patch, remaining) => {
    if (patch && Object.keys(patch).length > 0) {
      const games = state.games.map((g) => {
        const p = patch[g.app_name];
        if (!p) return g;
        return {
          ...g,
          title: p.title ?? g.title,
          localized_title: p.title ? true : g.localized_title,
          playtime_seconds: p.playtime_seconds ?? g.playtime_seconds,
          download_size: p.download ?? g.download_size,
          disk_size: p.disk ?? g.disk_size,
          install_size: p.download ?? g.install_size,
        };
      });
      setPluginState({ games });
      writeLibraryCache(accountId(), { games, locale: state.locale });
    }
    // A negative count means "this patch is not about sizes" (playtime).
    if (typeof remaining === "number" && remaining >= 0) {
      setPluginState({ sizePending: remaining });
    }
  });

  // The backend refreshes a stale snapshot in the background and pushes the
  // whole list when it lands, which is what lets the panel open instantly and
  // fill itself in silently.
  addEventListener<[any]>("library_full", (payload) => {
    if (!payload || !payload.ok) return;
    applyPayload(payload as LibraryPayload);
  });

  addEventListener<[string, string]>("library_error", (message, kind) => {
    setPluginState({
      error: {
        message: message || t("读取游戏库失败"),
        kind: (kind as LibraryFailure["kind"]) || "unknown",
      },
      loading: false,
    });
  });

  window.addEventListener("epicdeck:library-changed", () => {
    void reloadGames();
  });
}

// ---- actions ----------------------------------------------------------

let bootPromise: Promise<void> | null = null;

async function boot() {
  bindEvents();
  const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

  const [envResult, authResult, bootData] = await Promise.all([
    withTimeout(checkEnvironment(), 8000, {
      legendary_installed: true,
      legendary_path: "",
    } as EnvironmentInfo),
    withTimeout(authStatus(), 15000, { logged_in: false, account_id: "", display_name: "" }),
    withTimeout(
      (async () => {
        const [d, s] = await Promise.all([getInstallDirOptions(), getSettings()]);
        return { dirs: d.options ?? [], current: d.current ?? "", settings: s };
      })(),
      8000,
      { dirs: [] as InstallDirOption[], current: "", settings: {} as Record<string, any> }
    ),
  ]);

  setPluginState({
    env: envResult,
    auth: authResult,
    dirs: bootData.dirs,
    defaultDir: bootData.settings.install_dir || bootData.current || "",
    // A backend that timed out reports {} — do not trap the user in the
    // prompt just because the settings call was slow.
    firstRunDone: bootData.settings.first_run_done !== false,
    booted: true,
  });

  // Downloads that survived a plugin reload live only in the backend (HANDOFF
  // 7.17). Their `install_progress` events fired before this UI existed, so ask
  // for a snapshot — otherwise the download looks like it vanished.
  void getActiveInstalls()
    .then((items) => {
      if (!Array.isArray(items) || items.length === 0) return;
      const progress: Record<string, InstallProgress> = { ...state.progress };
      for (const item of items) {
        if (!item || !item.app_name) continue;
        progress[item.app_name] = {
          state: item.state || "downloading",
          percent: item.percent ?? -1,
          message: item.message || "",
          speed: item.speed || "",
          eta: item.eta || "",
          downloaded_bytes: item.downloaded_bytes ?? undefined,
          total_bytes: item.total_bytes ?? undefined,
          title: item.title || undefined,
        } as InstallProgress;
      }
      setPluginState({ progress });
    })
    .catch(() => {
      /* a snapshot miss must never break boot */
    });

  if (!authResult.logged_in) {
    setPluginState({ games: [], loading: false, sizePending: 0, locale: "", cachedAt: 0 });
    clearLibraryCache();
    return;
  }

  // Drop a snapshot that belongs to a different Epic account.
  const mine = readLibraryCache(authResult.account_id);
  if (!mine && readLibraryCache()) {
    clearLibraryCache();
    setPluginState({ games: [], sizePending: 0, locale: "", loading: true });
  }

  // The snapshot path returns in milliseconds; the first run (no cache) still
  // gets a generous ceiling so a dead network cannot hang the UI.
  // A rejected callable (bad cache row, plugin-side exception) used to abort
  // boot() right here: no games, no error banner, the page said "游戏库为空".
  let r: Awaited<ReturnType<typeof listGames>>;
  try {
    r = await withTimeout(listGames(), 20000, {
      ok: false,
      games: [],
      size_pending: 0,
      locale: "",
      error: t("读取游戏库超时：Epic 服务器没有响应"),
      error_kind: "network",
    });
  } catch (e) {
    console.log("EpicDeck: list_games failed", e);
    r = {
      ok: false,
      games: [],
      size_pending: 0,
      locale: "",
      error: t("读取游戏库失败：") + String(e),
      error_kind: "unknown",
    };
  }
  if (r.ok) {
    applyPayload(r);
  } else if (mine) {
    setPluginState({
      games: mine.games,
      sizePending: mine.size_pending ?? 0,
      locale: mine.locale ?? "",
      cachedAt: mine.ts,
      loading: false,
      error: {
        message: r.error ?? t("读取游戏库失败"),
        kind: (r.error_kind as LibraryFailure["kind"]) || "unknown",
      },
    });
  } else {
    setPluginState({
      games: [],
      loading: false,
      error: {
        message: r.error ?? t("未知错误"),
        kind: (r.error_kind as LibraryFailure["kind"]) || "unknown",
      },
    });
  }
}

/** First-run prompt answered: no reboot needed, just record the choice. */
export function markFirstRunDone(path: string) {
  setPluginState({ firstRunDone: true, defaultDir: path || state.defaultDir });
}

/** Re-read the environment (after installing Legendary, for instance). */
export async function recheckEnv() {
  try {
    const env = await checkEnvironment();
    setPluginState({ env });
    return env;
  } catch (e) {
    console.log("EpicDeck: check_environment failed", e);
    return state.env;
  }
}

/** Idempotent: every surface calls this on mount, the work happens once. */
export function ensureBoot(): Promise<void> {
  if (!bootPromise) bootPromise = boot().catch((e) => console.log("EpicDeck: boot failed", e));
  return bootPromise;
}

export async function reloadGames() {
  // After an install the cached snapshot still says "not installed" (and with
  // stale:false, so the UI cannot even warn). Ask for a fresh list.
  const r = await listGames(true);
  if (r.ok) applyPayload(r);
}

/**
 * `force` skips the backend snapshot — used by the retry button, where the
 * user explicitly wants a fresh network call.
 */
export async function refreshLibrary(force = false) {
  // Only block the UI when there is nothing cached to show.
  if (readLibraryCache() === null) setPluginState({ loading: true });
  setPluginState({ refreshing: true });
  const a = await authStatus();
  setPluginState({ auth: a });
  if (!a.logged_in) {
    setPluginState({ games: [], error: null, loading: false, refreshing: false });
    clearLibraryCache();
    return;
  }
  const r = await listGames(force);
  if (r.ok) {
    applyPayload(r);
  } else {
    const mine = readLibraryCache(a.account_id);
    setPluginState({
      // Keep the cached list visible with a banner instead of wiping it.
      games: mine?.games ?? [],
      error: {
        message: r.error ?? t("读取游戏库失败"),
        kind: (r.error_kind as LibraryFailure["kind"]) || "unknown",
      },
      loading: false,
    });
  }
  setPluginState({ refreshing: false });
}

export async function reloadDirs() {
  try {
    const d = await getInstallDirOptions();
    setPluginState({ dirs: d.options ?? [], defaultDir: d.current || state.defaultDir });
  } catch (e) {
    console.log("EpicDeck: install dir options unavailable", e);
  }
}

export async function signOut() {
  const r = await logout();
  if (!r.ok) return r;
  setPluginState({
    auth: null,
    games: [],
    error: null,
    progress: {},
    sizePending: 0,
    locale: "",
    cachedAt: 0,
  });
  clearLibraryCache();
  return r;
}

/** After a login the whole store has to be rebuilt (account changed). */
export async function onSignedIn() {
  bootPromise = null;
  setPluginState({ loading: true, error: null });
  await ensureBoot();
}

export function setProgress(appName: string, progress: InstallProgress) {
  setPluginState({ progress: { ...state.progress, [appName]: progress } });
}

// Game actions: each one is a thin wrapper that keeps the shared state honest,
// so the QAM panel and the full-screen page show the same aftermath.
export const actions = {
  async install(appName: string, dir: string) {
    const r = await installGame(appName, dir);
    if (r.ok) {
      setProgress(appName, {
        state: "starting",
        percent: -1,
        message: t("正在准备…"),
        speed: "",
        eta: "",
      });
    }
    return r;
  },
  async cancel(appName: string) {
    // delete=true: clear the partial download so a retry starts over.
    const r = await cancelInstall(appName, true);
    if (r.ok) {
      setProgress(appName, {
        state: "cancelled",
        percent: 0,
        message: t("已取消"),
        speed: "",
        eta: "",
      });
    }
    return r;
  },
  async pause(appName: string) {
    const r = await pauseInstall(appName);
    if (r.ok) {
      setProgress(appName, {
        state: "paused",
        percent: 0,
        message: t("已暂停"),
        speed: "",
        eta: "",
      });
    }
    return r;
  },
  async resume(appName: string, dir = "") {
    const r = await resumeInstall(appName, dir);
    if (r.ok) {
      setProgress(appName, {
        state: "starting",
        percent: -1,
        message: t("正在继续…"),
        speed: "",
        eta: "",
      });
    }
    return r;
  },
  async launch(appName: string, direct = false) {
    return launchGame(appName, direct);
  },
  async uninstall(appName: string) {
    const r = await uninstallGame(appName);
    if (r.ok) await reloadGames();
    return r;
  },
  async addToSteam(appName: string) {
    const r = await addToSteam(appName);
    if (r.ok) {
      setPluginState({
        games: state.games.map((g) => (g.app_name === appName ? { ...g, in_steam: true } : g)),
      });
    }
    return r;
  },
  async removeFromSteam(appName: string) {
    const r = await removeFromSteam(appName);
    if (r.ok) {
      setPluginState({
        games: state.games.map((g) => (g.app_name === appName ? { ...g, in_steam: false } : g)),
      });
    }
    return r;
  },
  refreshSteam,
};

/** Games currently downloading / verifying, newest first by name. */
export function activeDownloads(progress: Record<string, InstallProgress>): string[] {
  return Object.keys(progress).filter((k) => {
    const p = progress[k];
    return (
      p.state === "starting" ||
      p.state === "downloading" ||
      p.state === "verifying" ||
      p.state === "patching" ||
      p.state === "prereq"
    );
  });
}
