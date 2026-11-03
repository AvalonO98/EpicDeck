// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Route ids and layout constants that more than one module needs.
//
// These live here rather than in `fullscreen.tsx` so that `steammenu.tsx` can
// add a Steam-menu item pointing at the page without importing the page itself
// (and creating a cycle when the page needs the menu's preferences).

/** Full-screen page route, registered with `routerHook.addRoute`. */
export const LIBRARY_ROUTE = "/epicdeck/library";

/** Games per page. 15 keeps a full page an exact 5×3 grid. */
export const PAGE_SIZE = 15;
