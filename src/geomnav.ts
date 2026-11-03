// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Geometric focus navigation for the full-screen page.
//
// Steam's own directional focus follows its nav tree, which is built from
// `Focusable` parents and their `flow-children`. That model does not survive a
// custom layout: a plain <div> contributes no nav node, so the stick falls back
// to DOM order (press down → the highlight walks *right* along the row), while a
// `Focusable` container fixes the tree but becomes focusable itself and swallows
// the stick (the "one big box" symptom). Decky's `Focusable` has no way to say
// "group my children but never take focus" — the `focusable` prop is ignored by
// Steam's implementation.
//
// So we do the navigation ourselves: on every directional press, look at the
// focused element, score every visible focusable candidate by geometry, and move
// focus to the best one in that direction. One implementation covers the header,
// the tab row, the toolbar, the 5-column grid, the detail page and the settings
// list — every "level" behaves the same way, which is also what makes per-level
// L1/R1 (page flip vs tab switch) easy to reason about.

/** Steam's GamepadButton values for the four directions. */
const DIR_LEFT = 11;
const DIR_UP = 9;
const DIR_RIGHT = 12;
const DIR_DOWN = 10;

const CANDIDATE_SELECTOR =
  '[tabindex]:not([tabindex="-1"]),button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]';

/**
 * Elements that are *containers* rather than leaves. They carry `tabindex` from
 * Steam's Focusable but should never be a navigation target — landing on one
 * gives the "selection box around the whole block" feeling.
 */
function isLeafFocusable(el: HTMLElement): boolean {
  try {
    return !el.querySelector(CANDIDATE_SELECTOR);
  } catch {
    return true;
  }
}

function isVisible(el: HTMLElement, doc: Document): boolean {
  if (!el.isConnected) return false;
  const view = doc.defaultView || window;
  if (el.offsetParent === null && view.getComputedStyle(el).position !== "fixed") return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

const GPFOCUS_RE = /(^|\s)gpfocus(\s|$)/;

/**
 * Where the user currently is, as far as *we* are concerned.
 *
 * Steam's `gpfocus` marks linger on elements it focused earlier, and its virtual
 * focus can sit somewhere else entirely, so re-deriving "current" from the DOM on
 * every press made navigation drift (press down twice and you end up in the grid).
 * Tracking the element we moved to is deterministic; the DOM is only consulted to
 * recover when that element is gone or the page just opened.
 */
let remembered: HTMLElement | null = null;

export function rememberFocus(el: HTMLElement | null | undefined) {
  remembered = el ?? null;
}

function usable(el: HTMLElement | null | undefined, root: HTMLElement): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  if (!root.contains(el)) return false;
  return isVisible(el, root.ownerDocument);
}

/**
 * The element the user currently "is on".
 *
 * `document.activeElement` alone is not enough: Steam can track focus *virtually*
 * (the nav tree keeps the selection while real DOM focus stays on a container),
 * marking the selected node with the `gpfocus` class instead. Reading only
 * `activeElement` therefore started navigation from the wrong place — pressing
 * "down" on 返回 used to jump to the pager instead of the tab row underneath it.
 */
export function currentFocused(root: HTMLElement): HTMLElement | null {
  const doc = root.ownerDocument;
  const active = doc.activeElement as HTMLElement | null;
  if (active && root.contains(active) && GPFOCUS_RE.test(String(active.className || ""))) {
    return active;
  }

  let marked: HTMLElement[] = [];
  try {
    marked = Array.from(root.querySelectorAll<HTMLElement>('[class*="gpfocus"]')).filter(
      (el) => GPFOCUS_RE.test(String(el.className || "")) && isLeafFocusable(el) && isVisible(el, doc)
    );
  } catch {
    marked = [];
  }
  if (marked.length) {
    // Prefer the innermost/smallest marked node (a container may be marked too).
    marked.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    return marked[0];
  }

  return active && root.contains(active) ? active : null;
}

/**
 * Move focus one step in `button`'s direction inside `scope`.
 * Returns true when focus actually moved (caller should swallow the event).
 */
export function moveFocus(button: number, scope?: HTMLElement | null): boolean {
  if (button !== DIR_LEFT && button !== DIR_RIGHT && button !== DIR_UP && button !== DIR_DOWN) {
    return false;
  }
  // Plugin code runs in Decky's hidden SharedJSContext window, so the global
  // `document` belongs to a 1×1 page, not to Big Picture. Everything must come
  // from the root element's own document (see HANDOFF 5.10).
  const root = scope || (document.querySelector(".ed-surface") as HTMLElement | null);
  if (!root) return false;
  const doc = root.ownerDocument;

  // `remembered` is the single source of truth: it is seeded when the page opens
  // (返回), updated after every move, and re-synced on any real DOM focus change
  // (see the focusin listener in fullscreen.tsx). Anything else is unreliable —
  // Steam's virtual focus can differ from DOM focus, and `gpfocus` marks linger
  // on elements that were focused earlier — which is how "down" used to start
  // from the wrong element and land on the far right of the toolbar.
  const active = usable(remembered, root) ? (remembered as HTMLElement) : currentFocused(root);
  if (!active) return false;

  const from = active.getBoundingClientRect();
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  const horizontal = button === DIR_LEFT || button === DIR_RIGHT;

  let all: HTMLElement[] = [];
  try {
    all = Array.from(root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR));
  } catch {
    return false;
  }

  // Two passes so "nearest in that direction" does not jump rows:
  //   1)候选只取**同一行/同一列带内**（副轴偏移小）的元素，按曼哈顿距离取最近；
  //   2)带内没有目标时，才放宽到 60° 方向锥内，仍取最近。
  let best: HTMLElement | null = null;

  const collect = (bandOnly: boolean): HTMLElement | null => {
    let pick: HTMLElement | null = null;
    let pickScore = Number.POSITIVE_INFINITY;
    for (const el of all) {
      if (el === active || active.contains(el) || el.contains(active)) continue;
      if (!isLeafFocusable(el) || !isVisible(el, doc)) continue;

      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = cx - fx;
      const dy = cy - fy;

      // Must lie in the requested direction (4px slack for rounding).
      if (button === DIR_LEFT && dx >= -4) continue;
      if (button === DIR_RIGHT && dx <= 4) continue;
      if (button === DIR_UP && dy >= -4) continue;
      if (button === DIR_DOWN && dy <= 4) continue;

      const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
      const secondary = horizontal ? Math.abs(dy) : Math.abs(dx);

      if (bandOnly) {
        // “同一行”按当前元素的高度判断，“同一列”按宽度判断。
        const band = horizontal ? Math.max(12, from.height * 0.6) : Math.max(12, from.width * 0.6);
        if (secondary > band) continue;
      } else if (secondary > primary * 1.7 + 12) {
        continue; // 超过 60°，不算这个方向上的目标
      }

      const score = primary + secondary;
      if (score < pickScore) {
        pickScore = score;
        pick = el;
      }
    }
    return pick;
  };

  best = collect(true) || collect(false);
  if (!best) return false;
  try {
    best.scrollIntoView({ block: "nearest", inline: "nearest" });
    best.focus();
  } catch {
    return false;
  }
  remembered = best;
  return true;
}

export const DIRECTION_BUTTONS = [DIR_LEFT, DIR_UP, DIR_RIGHT, DIR_DOWN];
