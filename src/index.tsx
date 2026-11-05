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
import { getSettings } from "./api";
import { FocusStyles } from "./components";
import { FullScreenPage, openFullScreen } from "./fullscreen";
import { QamPanel } from "./qam";
import { LIBRARY_ROUTE } from "./routes";
import { moveFocus } from "./geomnav";
import { installSteamMenuEntry, setSteamMenuEntryEnabled } from "./steammenu";
import { t, useLangVersion } from "./i18n";
import { bootstrapLang } from "./langboot";

// Re-renders on language change so the QAM header follows the setting, which is
// read asynchronously after the plugin loads.
function QamTitle() {
  useLangVersion();
  return <div className={staticClasses.Title}>{t("EpicDeck · Epic 游戏库")}</div>;
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

  // "EpicDeck 游戏库" in the STEAM button menu. Patched lazily: the menu only
  // mounts when it is opened, so the installer keeps re-applying itself.
  const uninstallMenuEntry = installSteamMenuEntry();

  // Honour the user's choice without blocking startup — the menu reads the flag
  // on every render, so a late answer simply applies to the next menu open.
  void getSettings()
    .then((settings) => setSteamMenuEntryEnabled(settings?.show_menu_entry !== false))
    .catch(() => {});

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
      uninstallMenuEntry();
    },
  };
});
