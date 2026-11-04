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
  // A container must never be the navigation origin: `active.contains(el)` would
  // then skip every child and the move silently fails, which hands the key back
  // to Steam — the reason "down" from the tab row landed on the pager.
  if (!isLeafFocusable(el)) return false;
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
  if (
    active &&
    root.contains(active) &&
    isLeafFocusable(active) &&
    GPFOCUS_RE.test(String(active.className || ""))
  ) {
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

  return active && root.contains(active) && isLeafFocusable(active) ? active : null;
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

  // 两轮，规则先说清楚（这是"符合常识"的部分）：
  //   1) 严格轮：左右只在**同一行**里找（垂直中心差 ≤ 较矮元素高度的一半）；
  //      上下只在**同一列**里找（水平投影重叠 ≥ 较窄元素宽度的一半）。
  //   2) 放宽轮：同区域里没有严格目标时，才允许斜向，但副轴按 2.5 倍惩罚，
  //      保证"先走主轴、再走副轴"，不会出现按右却跳到下一行最右的按钮。
  //
  // 之前用的是 60° 方向锥 + 曼哈顿距离：锥太宽，斜下方的元素也算候选，
  // 所以左右会串行、上下会串列 —— 手感就是"不听话"。
  let best: HTMLElement | null = null;

  const collect = (strict: boolean): HTMLElement | null => {
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

      if (strict) {
        if (horizontal) {
          const band = Math.max(10, Math.min(from.height, r.height) * 0.5);
          if (Math.abs(dy) > band) continue;
        } else {
          // "同一列"按矩形水平投影重叠判断，比中心差更接近人眼判断。
          const overlap = Math.min(from.right, r.right) - Math.max(from.left, r.left);
          const narrower = Math.min(from.width, r.width);
          if (narrower <= 0 || overlap < narrower * 0.5) continue;
        }
      }

      const score = strict ? primary + secondary * 0.25 : primary + secondary * 2.5;
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
  claimFocusRing(best, root);
  remembered = best;
  return true;
}

/**
 * Only the element we just moved to may look focused.
 *
 * Steam keeps `gpfocus` on elements it focused earlier, and our stylesheet
 * matches both `.gpfocus` and `.ed-focus` — so after a few moves several
 * buttons stayed highlighted at once. The focusin listener alone cannot fix
 * this: Steam can add the class after our handler has already run.
 */
export function claimFocusRing(target: HTMLElement, root: HTMLElement) {
  try {
    for (const el of Array.from(root.querySelectorAll(".ed-focus, .gpfocus"))) {
      if (el !== target) {
        el.classList.remove("ed-focus");
        el.classList.remove("gpfocus");
      }
    }
    target.classList.add("ed-focus");
  } catch {
    /* styling only — never let this break navigation */
  }
}

export const DIRECTION_BUTTONS = [DIR_LEFT, DIR_UP, DIR_RIGHT, DIR_DOWN];
