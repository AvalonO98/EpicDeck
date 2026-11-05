// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Thin typed layer over the Python backend. Every callable the plugin exposes
// lives here so the QAM panel and the full-screen page share one definition —
// a wrong signature used to be a silent `undefined` on one surface only.

import { callable } from "@decky/api";
import { t, tf } from "./i18n";

export interface AuthStatus {
  logged_in: boolean;
  account_id: string;
  display_name: string;
}

export interface Game {
  app_name: string;
  title: string;
  version: string;
  is_installed: boolean;
  install_size: number;
  installed_size: number;
  cover_url: string;
  playtime_seconds: number;
  first_seen: number;
  in_steam: boolean;
  // Filled in by the background metadata job: bytes to download and bytes on
  // disk after installation. Both stay 0 until the manifest is read.
  download_size?: number;
  disk_size?: number;
  localized_title?: boolean;
}

export interface InstallDirOption {
  path: string;
  label: string;
  free: number;
  is_default?: boolean;
}

export interface InstallProgress {
  state:
    | "starting"
    | "downloading"
    | "verifying"
    | "patching"
    | "prereq"
    | "done"
    | "error"
    | "cancelled"
    | "paused";
  percent: number;
  message: string;
  speed: string;
  eta: string;
  // Bytes already pulled / total to pull. Present only once Legendary has
  // reported them (it prints "Downloaded: x MiB" and "Download size: y MiB"
  // on their own lines), so both may be undefined early in a download.
  downloaded_bytes?: number;
  total_bytes?: number;
}

export interface EnvironmentInfo {
  legendary_installed: boolean;
  legendary_path: string;
  proton_installed?: boolean;
  proton_path?: string;
  use_proton?: boolean;
}

export type LibraryFailure = { message: string; kind: "network" | "auth" | "unknown" };

/** Backend payload of `list_games`. */
export interface LibraryPayload {
  ok: boolean;
  games?: Game[];
  locale?: string;
  size_pending?: number;
  stale?: boolean;
  cached_at?: number;
  warning?: string;
  error?: string;
  error_kind?: "network" | "auth" | "unknown";
}

export const authStatus = callable<[], AuthStatus>("auth_status");
export const logout = callable<[], { ok: boolean; error?: string }>("logout");

// A login attempt is a session, not a single call: begin_login opens Epic's page
// and starts reading the result off it, then login_poll reports the outcome
// while the user is still in the browser.
export const beginLogin = callable<
  [],
  {
    ok: boolean;
    url?: string;
    opened?: boolean;
    message?: string;
    already_logged_in?: boolean;
    error?: string;
  }
>("begin_login");
export const loginPoll = callable<
  [],
  { state: string; message: string; display_name: string; auto_copied: boolean; ok: boolean }
>("login_poll");
export const cancelLogin = callable<[], { ok: boolean }>("cancel_login");
export const loginWithClipboard = callable<
  [],
  { ok: boolean; display_name?: string; account_id?: string; error?: string }
>("login_with_clipboard");
export const loginWithCode = callable<
  [raw: string],
  { ok: boolean; display_name?: string; account_id?: string; error?: string }
>("login_with_code");
export const getLoginUrl = callable<[], { ok: boolean; url: string }>("get_login_url");

export const listGames = callable<[force?: boolean], LibraryPayload>("list_games");
export const getGameSize = callable<
  [app_name: string],
  { ok: boolean; download?: number; disk?: number; error?: string }
>("get_game_size");

export const getLaunchArgs = callable<
  [app_name: string],
  { ok: boolean; args: string; own: boolean; from_legendary: boolean }
>("get_launch_args");
export const setLaunchArgs = callable<
  [app_name: string, args: string],
  { ok: boolean; args?: string; error?: string; warning?: string }
>("set_launch_args");

export const installGame = callable<
  [app_name: string, install_dir: string],
  { ok: boolean; error?: string }
>("install");
export const cancelInstall = callable<[app_name: string, del?: boolean], { ok: boolean }>("cancel_install");
export const pauseInstall = callable<[app_name: string], { ok: boolean }>("pause_install");
export const resumeInstall = callable<[app_name: string, install_dir?: string], { ok: boolean; error?: string }>("resume_install");
export const clearDownloadCache = callable<[], { ok: boolean; removed?: number; error?: string }>(
  "clear_download_cache"
);

export interface LsfgState {
  ok: boolean;
  available: boolean;
  default: boolean;
  enabled: boolean;
  own: boolean;
}

export const getLsfg = callable<[app_name?: string], LsfgState>("get_lsfg");
export const setLsfg = callable<
  [app_name: string, enabled: boolean],
  { ok: boolean; enabled?: boolean; warning?: string }
>("set_lsfg");
export const launchGame = callable<
  [app_name: string, direct?: boolean],
  {
    ok: boolean;
    /** Shortcut appid; the frontend hands it to Steam so gamescope switches. */
    appid?: number;
    via?: "steam" | "direct";
    error?: string;
    note?: string;
    proton?: boolean;
  }
>("launch");
export const uninstallGame = callable<[app_name: string], { ok: boolean; error?: string }>("uninstall");

export const addToSteam = callable<
  [app_name: string],
  { ok: boolean; appid?: number; error?: string }
>("add_to_steam");
export const removeFromSteam = callable<[app_name: string], { ok: boolean; error?: string }>(
  "remove_from_steam"
);
export const syncInstalledToSteam = callable<
  [app_name: string],
  { ok: boolean; added?: number; failed?: { title: string; error: string }[]; note?: string; error?: string }
>("sync_installed_to_steam");
export const refreshSteam = callable<[], { ok: boolean; note?: string; error?: string }>("refresh_steam");

export const getSettings = callable<[], Record<string, any>>("get_settings");
// Which language the UI should use: Steam's own setting unless overridden.
export const getUILanguage = callable<
  [],
  { ok: boolean; lang: "zh" | "en"; steam?: string; source?: string }
>("get_ui_language");export const setSetting = callable<[key: string, value: any], { ok: boolean }>("set_setting");
export const getInstallDirOptions = callable<
  [],
  { options: InstallDirOption[]; current: string }
>("get_install_dir_options");
export const resolveInstallDir = callable<
  [path: string],
  { ok: boolean; path?: string; free?: number; error?: string }
>("resolve_install_dir");
export const completeFirstRun = callable<
  [install_dir: string],
  { ok: boolean; install_dir?: string; error?: string }
>("complete_first_run");

export const checkEnvironment = callable<[], EnvironmentInfo>("check_environment");
export const getProtonOptions = callable<
  [],
  { ok: boolean; options: { data: string; label: string }[]; current: string; found: number }
>("get_proton_options");
export const refreshArtwork = callable<
  [app_name: string],
  { ok: boolean; updated?: number; icons?: number; total?: number; note?: string; error?: string }
>("refresh_artwork");
export const installLegendary = callable<
  [],
  { ok: boolean; path?: string; version?: string; error?: string }
>("install_legendary");
export const getLegendaryVersion = callable<
  [],
  { ok: boolean; version?: string; path?: string; error?: string }
>("get_legendary_version");
export const exportLogs = callable<[], { ok: boolean; logs?: string; path?: string; error?: string }>(
  "export_logs"
);

// -- update check + ProtonDB (HANDOFF 7.13.5 / 7.13.2) -------------------

export interface UpdateState {
  ok: boolean;
  current: string;
  latest?: string;
  has_update?: boolean;
  url?: string;
  zip_url?: string;
  cached?: boolean;
  checked_at?: number;
  reason?: string;
}

// Silent by design: `ok: false` means "could not check", which the settings row
// renders as nothing rather than an error.
export const checkUpdate = callable<[force?: boolean], UpdateState>("check_update");

export interface ProtonDbTier {
  ok: boolean;
  tier?: string;
  label?: string;
  total?: number;
  appid?: number;
  matched?: string;
  confidence?: number;
  report_confidence?: string;
  cached?: boolean;
  title?: string;
  reason?: string;
}

export const getProtonDb = callable<[app_name: string, force?: boolean], ProtonDbTier>(
  "get_protondb"
);
export const getProtonDbCached = callable<
  [app_names?: string[]],
  Record<string, { tier: string; label: string; total: number; appid: number }>
>("get_protondb_cached");

// Game Mode has no browser window we can call; the backend hands the URL to
// Steam's built-in one.
export const openUrl = callable<[url: string], { ok: boolean; error?: string }>("open_url");

export interface CloudSaveInfo {
  ok: boolean;
  supported?: boolean;
  folder?: string;
  save_path?: string;
  error?: string;
}

// Manual only: auto-syncing on launch can overwrite newer local saves.
export const getCloudSaves = callable<[app_name: string], CloudSaveInfo>("get_cloud_saves");
export const syncCloudSaves = callable<
  [app_name: string, mode?: "sync" | "upload" | "download"],
  { ok: boolean; output?: string; error?: string }
>("sync_cloud_saves");

export interface DataLocation {
  key: string;
  label: string;
  path: string;
  note: string;
}

// Every directory the plugin owns or reads. Shown in Settings so a user can
// find their games/backups, and so "what survives an uninstall" is answerable
// without reading the docs (only plugins/<Name> is removed).
export const dataLocations = callable<[], { ok: boolean; items?: DataLocation[] }>(
  "data_locations"
);

// -- formatting helpers --------------------------------------------------

export function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return gb.toFixed(1) + " GB";
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return mb.toFixed(0) + " MB";
  const kb = bytes / 1024;
  return kb.toFixed(0) + " KB";
}

export function fmtPlaytime(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const hours = seconds / 3600;
  if (hours >= 10) return tf("{0} 小时", Math.round(hours));
  if (hours >= 1) return tf("{0} 小时", hours.toFixed(1));
  return tf("{0} 分钟", Math.max(1, Math.round(seconds / 60)));
}

export function fmtMinutes(totalMinutes: number): string {
  if (!totalMinutes || totalMinutes <= 0) return "—";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes % 60);
  if (hours <= 0) return tf("{0} 分钟", minutes);
  return minutes > 0 ? tf("{0} 小时 {1} 分", hours, minutes) : tf("{0} 小时", hours);
}

/** "刚刚" / "12 分钟前" / "3 天前" — used for cache age. */
export function fmtAgo(ts: number): string {
  if (!ts) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diff < 60) return t("刚刚");
  if (diff < 3600) return tf("{0} 分钟前", Math.floor(diff / 60));
  if (diff < 86400) return tf("{0} 小时前", Math.floor(diff / 3600));
  return tf("{0} 天前", Math.floor(diff / 86400));
}

/**
 * Mask the middle of a personal identifier (account ID, phone, email) for
 * on-screen display. How many chars survive on each side scales with length so
 * short values stay recognisable and long ones stay private:
 *   1-2   → keep as-is (too short to mask meaningfully)
 *   3-4   → keep 1 + mask 1 + keep 1   (a*b)
 *   5-8   → keep 2 + mask rest + keep 2 (ab**yz)
 *   >=9   → keep 3 + mask + keep 3     (abc***xyz)
 * An email keeps its full domain so the provider stays visible (ab***@mail.com).
 */
export function maskPersonal(value: string): string {
  if (!value) return "";
  const s = String(value).trim();

  // Email: mask the local part, keep the domain.
  const at = s.indexOf("@");
  if (at > 0) {
    const local = s.slice(0, at);
    const domain = s.slice(at);
    return maskPersonal(local) + domain;
  }

  const len = s.length;
  if (len <= 2) return s;
  if (len <= 4) {
    return s[0] + "*".repeat(Math.max(1, len - 2)) + s[len - 1];
  }
  const keep = len >= 9 ? 3 : 2;
  const head = s.slice(0, keep);
  const tail = s.slice(len - keep);
  return head + "*".repeat(Math.max(1, len - keep * 2)) + tail;
}

export const STATE_LABEL: Record<string, string> = {
  starting: "准备中",
  downloading: "下载中",
  verifying: "校验中",
  patching: "更新中",
  prereq: "安装组件中",
  done: "已完成",
  cancelled: "已取消",
  paused: "已暂停",
  error: "出错",
};

export function isActive(progress?: InstallProgress): boolean {
  if (!progress) return false;
  return (
    progress.state === "starting" ||
    progress.state === "downloading" ||
    progress.state === "verifying" ||
    progress.state === "patching" ||
    progress.state === "prereq"
  );
}

// "auto" follows the Steam UI language; the rest pin a specific one. Epic
// falls back to the English title when a game has no translation.
export const LOCALE_OPTIONS: { data: string; label: string }[] = [
  { data: "auto", label: "自动（跟随 Steam 语言）" },
  { data: "zh-Hans", label: "简体中文" },
  { data: "zh-Hant", label: "繁體中文" },
  { data: "en-US", label: "English" },
  { data: "ja", label: "日本語" },
  { data: "ko", label: "한국어" },
  { data: "ru", label: "Русский" },
  { data: "de", label: "Deutsch" },
  { data: "fr", label: "Français" },
  { data: "es-ES", label: "Español" },
  { data: "pt-BR", label: "Português (Brasil)" },
];

// Short label for the resolved locale, shown next to the library count so it
// is obvious which language the titles came out in.
export const LOCALE_LABELS: Record<string, string> = {
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  "en-US": "English",
  ja: "日本語",
  ko: "한국어",
  ru: "Русский",
  de: "Deutsch",
  fr: "Français",
  "es-ES": "Español",
  "es-419": "Español (LatAm)",
  "pt-BR": "Português",
  it: "Italiano",
  pl: "Polski",
  uk: "Українська",
  tr: "Türkçe",
};

// Epic's launcher client: the authorization code must be issued for the same
// client Legendary redeems it with, otherwise Epic rejects it with
// `authorization_code_not_for_your_client`.
export const EPIC_LOGIN_URL =
  "https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code";

export type SortMode = "alpha" | "alpha_desc" | "playtime" | "recent";

export const SORT_OPTIONS: { data: SortMode; label: string }[] = [
  { data: "alpha", label: "字母 A → Z" },
  { data: "alpha_desc", label: "字母 Z → A" },
  { data: "playtime", label: "游玩时间" },
  { data: "recent", label: "最近添加" },
];

export type InstallFilter = "all" | "installed" | "not_installed";

// Order doubles as the L1/R1 cycle order: 全部 → 已安装 → 未安装 → 全部.
export const INSTALL_FILTER_ORDER: InstallFilter[] = ["all", "installed", "not_installed"];

export const INSTALL_FILTER_LABEL: Record<InstallFilter, string> = {
  all: "全部",
  installed: "已安装",
  not_installed: "未安装",
};
