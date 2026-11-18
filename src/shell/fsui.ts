// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

/**
 * Full-screen route UI state that has to outlive the page.
 *
 * Opening the QAM unmounts this route (Steam's router), so without a memory of
 * the last tab / filter / sort / page the user re-picks "已安装" every single
 * time they come back. It lives on `window` rather than in a module variable so
 * a hot reload of the bundle does not wipe it either.
 */
import {
  INSTALL_FILTER_ORDER,
  SORT_OPTIONS,
  type InstallFilter,
  type SortMode,
} from "../api";

/**
 * Single source of truth for tab ids.
 *
 * The shell builds its `TABS` array from this (with `Record<TabId, …>` so a new
 * tab that forgets its label/icon fails the type check), and `readFsUI()` uses
 * it to reject a stale tab id saved by an older version.
 */
export const TAB_IDS = ["library", "downloads", "settings"] as const;
export type TabId = (typeof TAB_IDS)[number];

const FS_UI_KEY = "__epicdeckFullScreenUI";

export interface FsUIState {
  tab: TabId;
  filter: InstallFilter;
  sort: SortMode;
  query: string;
  page: number;
  settingsSection?: string;
}

export function readFsUI(): FsUIState {
  const saved = (window as any)[FS_UI_KEY] ?? {};
  return {
    tab: (TAB_IDS as readonly string[]).includes(saved.tab) ? (saved.tab as TabId) : "library",
    filter: INSTALL_FILTER_ORDER.includes(saved.filter) ? saved.filter : "all",
    sort: SORT_OPTIONS.some((o) => o.data === saved.sort) ? saved.sort : "alpha",
    query: typeof saved.query === "string" ? saved.query : "",
    page: typeof saved.page === "number" && saved.page >= 1 ? saved.page : 1,
    settingsSection: typeof saved.settingsSection === "string" ? saved.settingsSection : "",
  };
}

export function writeFsUI(patch: Partial<FsUIState>) {
  (window as any)[FS_UI_KEY] = { ...readFsUI(), ...patch };
}
