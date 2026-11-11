// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Plugin entry: register the full-screen route, hand Decky the QAM panel, and
// add the Steam-menu shortcut.
//
// Everything user-facing lives in two places:
//   src/qam.tsx         – the Quick Access panel (launcher + live status)
//   src/fullscreen.tsx  – the full-screen library/settings route
// Both read from src/store.ts, so state survives jumping between them.

import { definePlugin, routerHook } from "@decky/api";
import { ScrollPanel, ScrollPanelGroup, staticClasses } from "@decky/ui";
import { FaGamepad } from "react-icons/fa";
import { FocusStyles } from "./components";
import { FullScreenPage, openFullScreen } from "./fullscreen";
import { QamPanel } from "./qam";
import { LIBRARY_ROUTE } from "./routes";
import { moveFocus } from "./geomnav";
import { t, useLangVersion } from "./i18n";
import { bootstrapLang } from "./langboot";

// Re-renders on language change so the QAM header follows the setting, which is
// read asynchronously after the plugin loads.
function QamTitle() {
  useLangVersion();
  return <div className={staticClasses.Title}>{t("EpicDeck")}</div>;
}

export default definePlugin(() => {
  console.log("EpicDeck frontend initializing");

  // Pick the UI language once; a late answer simply re-renders the roots.
  void bootstrapLang();

  // A route (not a modal) is what makes the page take over the whole screen:
  // Steam renders it in the same router as its own pages, so the B button,
  // the top bar and gamepad focus all behave natively.
  routerHook.addRoute(LIBRARY_ROUTE, () => (
    <>
      <FocusStyles />
      <FullScreenPage />
    </>
  ));

  // 侧边栏菜单入口（steammenu.tsx）已删除：它改的是 React fiber 的 type，风险高，
  // 且 HANDOFF 7.13 记录"补丁装上但菜单项不显示"。设置项也早已从 UI 移除，整条链
  // 只剩一个没人读的布尔值（审计 2.9）。需要时再从 git 历史里取回。

  // Reachable from the Steam devtools console and from CDP: lets a developer
  // jump to the page without hunting for the QAM entry. The two Steam scroll
  // widgets are exposed for the same reason — whether they exist at all depends
  // on Steam's build, and that is worth being able to check live.
  (window as any).__epicdeck = {
    openFullScreen,
    route: LIBRARY_ROUTE,
    ScrollPanel,
    ScrollPanelGroup,
    moveFocus,
  };

  return {
    name: "EpicDeck",
    titleView: <QamTitle />,
    content: (
      <>
        <FocusStyles />
        <QamPanel />
      </>
    ),
    icon: <FaGamepad />,
    onDismount() {
      routerHook.removeRoute(LIBRARY_ROUTE);
      // uninstallMenuEntry();
    },
  };
});
