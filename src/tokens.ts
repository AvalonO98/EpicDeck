// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

/**
 * Colour tokens.
 *
 * The same accent blue used to be written out ten times, plus six more shades
 * inlined wherever they happened to be needed, so "make the blue a bit softer"
 * meant a grep across three files and hoping nothing was missed (audit B7).
 * Everything semantic now lives here.
 *
 * Font sizes and white opacities are deliberately *not* tokenised: they are
 * per-component `em` values tuned against screenshots, and collapsing 21 sizes
 * into 5 without re-checking every screen would be a visual regression dressed
 * up as a cleanup.
 */
export const COLOR = {
  /** Focus ring, primary action, download badge — the one brand accent. */
  accent: "#4aa3ff",
  /** Secondary info: link-ish text, "downloading" tone, hint text on dark. */
  accentSoft: "#9ecbff",
  /** Installed / success. */
  success: "#7ee2a8",
  /** Warning: needs an external launcher, paused download. */
  warning: "#ffd27e",
  /** Warning headline (stronger than `warning`, used for banners). */
  warningStrong: "#ffb84d",
  /** Danger text on a dark translucent surface. */
  danger: "#ffb3b3",
  /** Danger text used inline next to a title. */
  dangerSoft: "#ff9b9b",
} as const;
