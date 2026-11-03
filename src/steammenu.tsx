// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Adds an "EpicDeck 游戏库" entry to Steam's main menu (主页 / 库 / 商店 栏).
//
// Steam ships no API for this. On current builds the menu items are React
// sibling fibers under a numeric-key array host (`memoizedProps = {0,1,2,…}`),
// NOT a `props.children` array — which is why freedeck's "splice the children
// array" trick silently no-ops today. Instead of betting on one internal shape,
// we patch the menu container component and then, on each render, walk its
// returned element tree for *any* array of menu-item elements and splice ours
// in. Menu items are identified structurally (label + route + icon), which has
// stayed stable across Steam versions.
//
// Safety: we only replace a single fiber's `type`; a failed walk just returns
// the original tree. `unpatch()` restores it.

import { findInReactTree, getReactRoot } from "@decky/ui";
import { FaGamepad } from "react-icons/fa";
import { LIBRARY_ROUTE } from "./routes";

const PATCH_MARK = "__EPICDECK_STEAM_MENU_PATCHED";
const PATCH_ORIG = "__EPICDECK_STEAM_MENU_ORIG";
const ENTRY_LABEL = "EpicDeck 游戏库";

type AnyFn = (...args: any[]) => any;

let entryEnabled = true;

export function setSteamMenuEntryEnabled(next: boolean) {
  entryEnabled = next;
}

export function isSteamMenuEntryEnabled() {
  return entryEnabled;
}

function getTreeRoot(): any {
  try {
    const el = document.getElementById("root");
    if (!el) return null;
    return getReactRoot(el) ?? null;
  } catch {
    return null;
  }
}

function findMenuFiber(root: any): any | null {
  const node = findInReactTree(root, (n: any) => {
    return String(n?.memoizedProps?.navID ?? "") === "MainNavMenuContainer";
  });
  const fiber = node as any;
  if (!fiber || typeof fiber !== "object") return null;
  if (!fiber.return || typeof fiber.return.type !== "function") return null;
  return fiber;
}

function restoreFiber(fiber: any, orig: AnyFn) {
  try {
    fiber.return.type = orig;
    if (fiber.return.alternate) fiber.return.alternate.type = orig;
  } catch {
    /* ignore */
  }
}

/** A menu item is an element with `label`, `route` and an `icon` prop. */
function isMenuItemElement(el: any): boolean {
  const p = el?.props;
  return Boolean(p?.label && p?.route && p?.icon);
}

/** Walk an element/fiber tree for the array of menu items. */
function findMenuItemsArray(node: any, depth = 0): any[] | null {
  if (!node || typeof node !== "object" || depth > 40) return null;
  if (Array.isArray(node)) {
    const menuCount = node.filter(isMenuItemElement).length;
    if (menuCount >= 2) return node; // the menu list has 主页/库/商店/…
    for (const child of node) {
      const found = findMenuItemsArray(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  // element or fiber: walk common child-bearing keys
  const keys = ["props", "children", "child", "sibling", "memoizedProps", "stateNode"];
  for (const k of keys) {
    const v = node[k];
    if (v == null || v === node) continue;
    const found = findMenuItemsArray(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function MenuEntry({ MenuItemComponent, label, ...props }: any) {
  const labelElement = (
    <div style={{ display: "flex", width: "150px", justifyContent: "space-between" }}>
      <div style={{ whiteSpace: "nowrap" }}>{label}</div>
    </div>
  );
  const iconNode = <FaGamepad style={{ opacity: 0.92 }} />;
  return <MenuItemComponent {...props} label={labelElement} icon={iconNode} />;
}

function createMenuPatch(): (() => void) | null {
  const root = getTreeRoot();
  if (!root) return null;

  const fiber = findMenuFiber(root);
  if (!fiber) return null;

  const current = fiber.return.type as AnyFn;
  if ((current as any)[PATCH_MARK]) {
    const prev = (current as any)[PATCH_ORIG] as AnyFn | undefined;
    return typeof prev === "function" ? () => restoreFiber(fiber, prev) : () => {};
  }

  const orig = current;

  const wrapper: AnyFn = (props: any) => {
    const ret = orig(props);

    try {
      const items = findMenuItemsArray(ret);
      if (!(window as any).__edMenuLogged) {
        (window as any).__edMenuLogged = true;
        // one-shot diagnostic: what does the returned element tree look like?
        console.log("EpicDeck menu: ret keys", ret ? Object.keys(ret) : null);
        console.log("EpicDeck menu: ret.props keys", ret?.props ? Object.keys(ret.props).slice(0, 20) : null);
        console.log("EpicDeck menu: items found", items ? items.length : "NONE");
      }
      if (items && entryEnabled) {
        // drop any stale copy (hot reload / toggle)
        for (let i = items.length - 1; i >= 0; i -= 1) {
          const route = String(items[i]?.props?.route ?? "");
          if (route === LIBRARY_ROUTE || route.startsWith(`${LIBRARY_ROUTE}?`)) items.splice(i, 1);
        }
        if (entryEnabled) {
          const libraryIndex = items.findIndex((c) => String(c?.props?.route ?? "").startsWith("/library"));
          const sample = items.find(isMenuItemElement);
          if (sample) {
            const at = libraryIndex >= 0 ? libraryIndex + 1 : items.length;
            items.splice(Math.min(Math.max(0, at), items.length), 0, (
              <MenuEntry
                key="epicdeck-library"
                route={LIBRARY_ROUTE}
                label={ENTRY_LABEL}
                onGamepadFocus={sample.props.onGamepadFocus}
                onFocus={sample.props.onFocus}
                MenuItemComponent={sample.type}
              />
            ));
          }
        }
      }
    } catch (e) {
      console.log("EpicDeck: steam menu insert failed", e);
    }

    return ret;
  };

  (wrapper as any)[PATCH_MARK] = true;
  (wrapper as any)[PATCH_ORIG] = orig;

  fiber.return.type = wrapper;
  if (fiber.return.alternate) fiber.return.alternate.type = wrapper;

  return () => restoreFiber(fiber, orig);
}

export function installSteamMenuEntry(): () => void {
  let disposed = false;
  let timer: number | null = null;
  let unpatch: (() => void) | null = null;
  let delay = 800;
  let installed = false;

  const schedule = (ms: number) => {
    if (disposed) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(tick, Math.max(400, Math.round(ms)));
  };

  const tick = () => {
    if (disposed) return;
    timer = null;
    let ok = false;
    try {
      const root = getTreeRoot();
      const fiber = root ? findMenuFiber(root) : null;
      const type = fiber?.return?.type;
      if (type && (type as any)[PATCH_MARK]) {
        ok = true;
      } else if (fiber) {
        const patch = createMenuPatch();
        if (patch) {
          unpatch = patch;
          ok = true;
        }
      }
    } catch (e) {
      console.log("EpicDeck: steam menu patch failed", e);
    }
    if (ok && !installed) {
      installed = true;
      console.log("EpicDeck: steam menu entry installed");
    }
    delay = ok ? 1200 : Math.min(6000, Math.round(delay * 1.5));
    schedule(ok ? 1200 : delay);
  };

  schedule(800);

  return () => {
    disposed = true;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    try {
      unpatch?.();
    } catch {
      /* ignore */
    }
    unpatch = null;
  };
}
