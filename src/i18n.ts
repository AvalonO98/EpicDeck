// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Minimal i18n layer.
//
// Keys are the **Chinese source strings themselves**, not invented identifiers.
// Two reasons:
//   1. a missing translation degrades to the original text instead of showing
//      `plugin.settings.title` to a user;
//   2. the conversion is mechanical and reviewable — `t("游戏库")` is obviously
//      the same string, so nobody has to keep a key registry in sync.
//
// The language comes from Steam (the only reliable signal in Game Mode, see
// HANDOFF 5.x): the backend maps `registry.vdf`'s language to a short tag, and
// the user can override it in Settings.
//
// Interpolation: `{name}` placeholders in the dictionary entry, `{0}`/`{1}` for
// `tf()`'s positional form. A placeholder without a value is left as-is rather
// than printing `undefined`.

import { useEffect, useState } from "react";

import { EN_EXTRA } from "./i18n.en";

export type Lang = "zh" | "en";

const EN_BASE: Record<string, string> = {
  // -- shell / navigation ------------------------------------------------
  "返回": "Back",
  "游戏库": "Library",
  "下载": "Downloads",
  "设置": "Settings",
  "刷新": "Refresh",
  "上一类": "Prev filter",
  "下一类": "Next filter",
  "上一页": "Previous page",
  "下一页": "Next page",
  "账号": "Account",
  "已登录": "Signed in",
  "未登录": "Signed out",
  "登出": "Sign out",

  // -- library -----------------------------------------------------------
  "全部": "All",
  "已安装": "Installed",
  "未安装": "Not installed",
  "全部游戏": "All games",
  "搜索": "Search",
  "搜索游戏": "Search games",
  "排序": "Sort",
  "最近添加": "Recently added",
  "名称": "Name",
  "游玩时长": "Playtime",
  "安装体积": "Installed size",
  "显示 X / 共 Y 个游戏": "Showing X of Y games",
  "已安装 X · 未安装 Y": "X installed · Y not installed",
  "还没有已安装的游戏": "No installed games yet",
  "所有游戏都已安装": "Every game is installed",
  "搜索不到匹配的游戏": "No games match that search",
  "这个游戏已不在游戏库里": "This game is no longer in your library",
  "共": "Total",

  // -- detail ------------------------------------------------------------
  "启动游戏": "Play",
  "正在启动": "Starting",
  "正在启动…": "Starting…",
  "安装": "Install",
  "取消": "Cancel",
  "删除": "Uninstall",
  "卸载": "Uninstall",
  "安装后": "Installs to",
  "需下载": "Download",
  "已占用": "On disk",
  "体积读取中…": "Reading size…",
  "启动参数": "Launch options",
  "已关闭": "Off",
  "已开启": "On",
  "Epic 云存档": "Epic cloud saves",
  "下载云端存档": "Download cloud saves",
  "上传本地存档": "Upload local saves",
  "双向同步": "Two-way sync",
  "下载中…": "Downloading…",
  "上传中…": "Uploading…",
  "同步中…": "Syncing…",
  "只在点按钮时同步；插件不会在启动时自动覆盖本地存档。":
    "Synced only when you press a button — the plugin never overwrites local saves on launch.",
  "小黄鸭插帧（LSFG-VK）": "Frame generation (LSFG-VK)",
  "已开启：启动时会经 ~/lsfg 包装插帧（可在启动日志里看到 [lsfg] 记录）":
    "On: launches are wrapped through ~/lsfg ([lsfg] appears in the launch log)",
  "已关闭：启动时不加插帧层": "Off: no frame-generation layer at launch",
  "插帧通过 ~/lsfg 包装实现，不会写入上方「启动参数」，所以启动参数里看不到。":
    "Frame generation is a wrapper (not a launch argument), so it never appears in the launch options above.",
  "本游戏单独设置（优先于全局默认）": "Set for this game (overrides the global default)",
  "跟随全局默认；打开后通过 ~/lsfg 包一层插帧":
    "Follows the global default; turns the ~/lsfg wrapper on",

  // -- settings ----------------------------------------------------------
  "目录与语言": "Directories & language",
  "安装目录": "Install directory",
  "界面语言": "Interface language",
  "跟随 Steam": "Follow Steam",
  "中文": "简体中文",
  "English": "English",
  "下载设置": "Download settings",
  "清理下载缓存": "Clear download cache",
  "数据位置": "Data locations",
  "诊断": "Diagnostics",
  "导出诊断日志": "Export diagnostic logs",
  "检查环境": "Check environment",
  "一键安装Legendary": "Install Legendary",
  "保存": "Save",
  "已保存": "Saved",
  "保存失败": "Save failed",
  "检查更新": "Check for updates",
  "有新版本": "Update available",
  "当前": "Current",
  "最新": "Latest",

  // -- download states ---------------------------------------------------
  "等待中": "Queued",
  "准备中": "Preparing",
  "下载中": "Downloading",
  "校验中": "Verifying",
  "修补中": "Patching",
  "安装中": "Installing",
  "已完成": "Done",
  "已暂停": "Paused",
  "已取消": "Cancelled",
  "失败": "Failed",

  // -- login -------------------------------------------------------------
  "登录Epic": "Sign in to Epic",
  "已登录为": "Signed in as",
  "取消登录": "Cancel sign-in",
  "正在等待登录": "Waiting for sign-in",
  "立即读取剪贴板": "Read clipboard now",
  "重新打开登录页": "Reopen the sign-in page",

  // -- common ------------------------------------------------------------
  "确定": "OK",
  "关闭": "Close",
  "重试": "Retry",
  "加载中": "Loading",
  "读取失败": "Could not load",
  "操作失败": "Action failed",
  "请重试": "Please try again",
  "网络错误": "Network error",
  "登录已失效": "Sign-in expired",
};

// Base map (shell/library/settings) merged with the later batch of strings.
const EN: Record<string, string> = { ...EN_BASE, ...EN_EXTRA };

const DICTS: Record<Exclude<Lang, "zh">, Record<string, string>> = { en: EN };

let current: Lang = "zh";
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: string | null | undefined) {
  const next: Lang = lang === "en" ? "en" : "zh";
  if (next === current) return;
  current = next;
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* a broken subscriber must not block the others */
    }
  });
}

/** Subscribe to language changes (used by the page-level re-render hook). */
export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function fill(template: string, vars?: Record<string, string | number> | Array<string | number>) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    const value = Array.isArray(vars) ? vars[Number(key)] : vars[key];
    return value === undefined || value === null ? whole : String(value);
  });
}

/**
 * Translate a Chinese source string.
 *
 * Unknown strings (and everything while the UI is Chinese) come back unchanged,
 * which is what makes partial coverage safe during development.
 */
export function t(zh: string, vars?: Record<string, string | number>): string {
  if (current === "zh") return fill(zh, vars);
  const hit = DICTS[current][zh];
  return fill(hit ?? zh, vars);
}

/** Positional form for template literals: tf("已安装 {0} / {1}", a, b). */
export function tf(zh: string, ...vars: Array<string | number>): string {
  if (current === "zh") return fill(zh, vars);
  const hit = DICTS[current][zh];
  return fill(hit ?? zh, vars);
}

/** Map Steam's language tag onto a supported UI language. */
export function langFromSteam(tag: string | null | undefined): Lang {
  const value = String(tag || "").toLowerCase();
  // Anything non-Chinese falls back to English: the store and the Deck's
  // default UI are English, so that is the least surprising second language.
  if (value.startsWith("schinese") || value.startsWith("tchinese") || value.startsWith("zh")) {
    return "zh";
  }
  return value ? "en" : "zh";
}

/**
 * Re-render the calling component when the language changes.
 *
 * The whole page tree is rendered from one component, so subscribing at the
 * roots (QAM panel + full-screen page) is enough — no context provider needed.
 */
export function useLangVersion(): void {
  const [, bump] = useState(0);
  useEffect(() => onLangChange(() => bump((n) => n + 1)), []);
}
