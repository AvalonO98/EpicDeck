// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// The full-screen page has to look right on three very different screens:
// the Deck's 854×534 handheld viewport, a docked 1280×800 window, and a
// 1080p/4K TV. Rather than hard-coding one of them, the page measures itself
// and derives a single scale factor; every size on the page is em-based, so one
// `fontSize` on the root scales the whole surface.
//
// Measure the element, not the window. Decky runs plugin code in the hidden
// SharedJSContext window (1×1 px) while the UI is rendered into the Steam
// window, so `window.innerWidth` is meaningless here — it reports 1. A
// ResizeObserver on the page's own root element gives the real box and, because
// that box is 100vw/100vh, it also tracks docking and window resizes.
//
// Steam's chrome (40px top bar, 42px button-hint footer) does not scale with the
// viewport, so its inset stays in pixels.

import { useEffect, useState, type RefObject } from "react";

/** The Deck's Game Mode viewport; scale 1 means "exactly the handheld". */
const BASE_W = 854;
const BASE_H = 534;

export interface Viewport {
  width: number;
  height: number;
  /** 0.82 – 1.5; multiply by 16 for the root font size. */
  scale: number;
  /** Tiles per row. Five keeps a 15-game page an exact 5×3 grid. */
  cols: number;
  /** Short or narrow window: drop hints and tighten paddings. */
  compact: boolean;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function compute(width: number, height: number): Viewport {
  const w = width > 4 ? width : BASE_W;
  const h = height > 4 ? height : BASE_H;

  // Scale by the *shorter* axis so a 4K TV does not end up with 8px captions
  // and a narrow window does not overflow horizontally.
  const scale = clamp(Math.min(w / BASE_W, h / BASE_H), 0.82, 1.5);

  return {
    width: Math.round(w),
    height: Math.round(h),
    scale,
    cols: w < 700 ? 4 : 5,
    compact: w < 900 || h < 500,
  };
}

function same(a: Viewport, b: Viewport) {
  return a.width === b.width && a.height === b.height && a.cols === b.cols && a.compact === b.compact;
}

/**
 * Live metrics for the page. `ref` must point at the element that fills the
 * Steam window (the `.ed-surface` root).
 */
export function useViewport(ref: RefObject<HTMLElement | null>): Viewport {
  // Start from the handheld size so the first frame is already sane; the
  // observer corrects within a frame.
  const [viewport, setViewport] = useState<Viewport>(() => compute(BASE_W, BASE_H));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const apply = () => {
      const rect = el.getBoundingClientRect();
      const next = compute(rect.width, rect.height);
      setViewport((prev) => (same(prev, next) ? prev : next));
    };

    apply();

    // ResizeObserver from the element's own window — the element lives in
    // Steam's window, not in the one this module runs in.
    const view = el.ownerDocument?.defaultView as any;
    const Observer: typeof ResizeObserver | undefined = view?.ResizeObserver ?? (globalThis as any).ResizeObserver;
    if (!Observer) {
      const onResize = () => apply();
      view?.addEventListener?.("resize", onResize);
      return () => view?.removeEventListener?.("resize", onResize);
    }

    const observer = new Observer(() => apply());
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return viewport;
}

/** Steam's own overlay chrome, in CSS pixels (identical on every resolution). */
export const STEAM_TOP_INSET = 40;
export const STEAM_BOTTOM_INSET = 42;
