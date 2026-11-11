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
export const DIR_LEFT = 11;
export const DIR_UP = 9;
export const DIR_RIGHT = 12;
export const DIR_DOWN = 10;

const CANDIDATE_SELECTOR =
  '[tabindex]:not([tabindex="-1"]):not([aria-disabled="true"]),button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]';

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

/** First element in `root` that a cursor may legitimately land on. */
function firstLeaf(root: HTMLElement): HTMLElement | null {
  try {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR));
    for (const el of nodes) {
      if (isLeafFocusable(el) && isVisible(el, root.ownerDocument)) return el;
    }
  } catch {
    /* malformed tree: nothing to fall back to */
  }
  return null;
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

/**
 * 防「Steam 抢焦点」的锚。
 *
 * Steam 自己的导航层也会处理**同一次方向键**(它不是在 DOM 上注册的监听,
 * `preventDefault`/`stopPropagation` 拦不住),它按 DOM 顺序把焦点挪一格:
 * 下一个兄弟节点 = 右边(所以「下」看起来成了「右下」),上一个兄弟 = 左边
 * (所以「上」成了「左上」)。随后那次 `focusin` 会把我们的锚点改成隔壁元素,
 * 下一次按键就从隔壁开始算 —— 每按一次斜一格,上下对称、全界面一致。
 *
 * **不要用时间窗口判断**(旧实现是 300ms):用户按键间隔常有 400~600ms,
 * Steam 的插队一旦落在窗口外就被当成"真实焦点变化"接受了,于是偏移照旧
 * (2026-11-05 22:1x 用户复现,日志里「按『下』→ 焦点落在『已安装』」即同一行右邻)。
 *
 * 改成**元素标记 + 一次消费**:我们自己移动后记下 `ownedTarget`;接下来第一个
 * 不是它的 `focusin` 判定为 Steam 插队,拉回并消费掉标记;再往后的焦点变化是
 * 真实的(程序性聚焦、切标签),正常接受。
 */
let ownedTarget: HTMLElement | null = null;
//: 最近一次真实的指针按下（触摸/鼠标）。用来把"用户自己点控件"与"Steam 插队"区分开。
let lastPointerAt = 0;

/** Record a real pointer press; call from a document capture listener. */
export function notePointerDown() {
  lastPointerAt = Date.now();
  return lastPointerAt;
}
/** 本次移动是否已经吸收过一次 Steam 插队(每次移动只吸收一次)。 */
let ownedSettled = false;

export function rememberFocus(el: HTMLElement | null | undefined) {
  remembered = el ?? null;
  ownedTarget = null;
  ownedSettled = false;
}

/**
 * The element focus should fall back to when Steam drops it on `<body>`.
 *
 * 2026-11-09 实机：B 关详情后 Steam 把自己的 B 处理跑完，焦点落到 `body`。
 * `body` 拿到焦点**不会**触发 `focusin`，所以 `settleFocus` 的拉回逻辑根本没有机会
 * 执行；而 `onRootDirection` 只挂在插件根节点上，焦点不在里面就收不到方向键 ——
 * 表现就是「按 B 关掉详情后整个界面失联」。
 */
export function peekAnchor(): HTMLElement | null {
  return remembered;
}

/**
 * Move focus as an action of ours: anchor first, then focus, so the `focusin`
 * it triggers is recognised as ours instead of being treated as a stray move.
 */
export function focusOwned(el: HTMLElement) {
  remembered = el;
  ownedTarget = el;
  ownedSettled = false;
  try {
    el.focus();
  } catch {
    /* best effort — the caller re-checks the anchor */
  }
}

/**
 * Decide what focus should be, given a `focusin` that just happened.
 *
 * Returns the element focus should really be on. When Steam moved focus behind
 * our back right after our own move, the anchor is kept and DOM focus is put
 * back on it.
 */
export function settleFocus(target: HTMLElement, root: HTMLElement): HTMLElement {
  // 0) 容器（页面根 / Panel / NavRow）永远不能成为锚点。
  //
  // 点一下封面之间的空隙、工具栏空白或标题文字时，浏览器把焦点交给最近的
  // 可聚焦祖先 —— 也就是 `.ed-surface` 自己。锚点一旦变成容器，`usable()` 会
  // 一律返回 false、`currentFocused()` 也返回 null，方向键被 preventDefault 吞掉
  // 却什么都不发生，整个界面从此对摇杆/A 键无响应（审计 1.2，实机点两下空白必现）。
  // 保持原锚点并把它按回去；没有可用锚点就落到页面第一个控件。
  if (!isLeafFocusable(target)) {
    if (remembered && remembered.isConnected && root.contains(remembered)) {
      try {
        remembered.focus();
      } catch {
        /* fall through to the first-leaf fallback */
      }
      if (root.ownerDocument.activeElement === remembered) return remembered;
    }
    const first = firstLeaf(root);
    if (first) {
      remembered = first;
      return first;
    }
    return target;
  }
  // 1) 正是我们自己移到的元素 → 确认。
  if (ownedTarget && target === ownedTarget) {
    remembered = target;
    return target;
  }
  // 2) 我们刚移过、还没吸收过插队 → 这是 Steam 对同一次按键的响应,拉回。
  //
  // 但用户用手指/鼠标点某个控件时，浏览器同样会给新元素 focusin —— 那不是插队。
  // 旧逻辑会把它当成 Steam 抢焦点、把焦点按回旧元素：点击生效了、焦点环却留在
  // 原处，接着按 A 作用在旧元素上（复审 4.8）。120ms 内有指针按下就接受。
  if (ownedTarget && !ownedSettled && root.contains(ownedTarget)) {
    ownedSettled = true;
    if (Date.now() - lastPointerAt < 120) {
      ownedTarget = null;
      remembered = target;
      return target;
    }
    try {
      ownedTarget.focus();
      remembered = ownedTarget;
      return ownedTarget;
    } catch {
      /* 拉不回去就接受,绝不把用户卡在原点 */
      ownedTarget = null;
      remembered = target;
      return target;
    }
  }
  // 3) 真实的外来焦点(程序性聚焦、切标签、点击)→ 接受并解除锚。
  ownedTarget = null;
  remembered = target;
  return target;
}

/**
 * 移动后的定时复检。
 *
 * 有些路径上 Steam 只把 DOM focus 挪走、并不触发 `focusin`(或触发得比我们的
 * 处理还早),`settleFocus` 就没有机会介入。移动后连续几帧核对一次,发现被
 * 挪走就按回来 —— 这是我们唯一能兜住那条路径的地方。
 */
export function reverifyFocus(expected: HTMLElement, root: HTMLElement, frames = 2) {
  if (!root.contains(expected)) return;
  const doc = root.ownerDocument;
  // 只在"焦点丢了"时拉回。之前是"activeElement 不是 expected 就拉回"，于是
  // 返回后 200ms 内用户推的第一下摇杆会被下一帧抢回去，感觉像"第一下没反应"（审计 1.9）。
  const active = doc.activeElement as HTMLElement | null;
  const lost = !active || active === doc.body || active === root || !root.contains(active);
  if (lost) {
    try {
      expected.focus();
      remembered = expected;
    } catch {
      /* 聚焦不了就算了,下一次按键会重新求锚 */
    }
  }
  if (frames > 0) {
    try {
      doc.defaultView?.requestAnimationFrame(() => reverifyFocus(expected, root, frames - 1));
    } catch {
      /* no rAF: the single sync check above is all we get */
    }
  }
}

/**
 * Bring an element into view inside Steam's scroll panel.
 *
 * `scrollIntoView()` does **nothing** on Steam's `ScrollPanel`: the real
 * scrolling element is an ancestor with `overflow-y: auto` (a `Panel Focusable`
 * in between reports `scrollHeight > clientHeight` but `overflow: visible`, so
 * assigning its `scrollTop` is silently ignored — the exact trap HANDOFF 7.22
 * documents). So we walk up from the target to the first *real* scroll container
 * and nudge its `scrollTop` just enough to reveal the element, the same way the
 * QAM's `scrollToTop` does. When no such container exists (the plain-div
 * fallback), `scrollIntoView` is harmless and still runs.
 */
function scrollIntoViewport(root: HTMLElement, el: HTMLElement) {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  let container: HTMLElement | null = el.parentElement;
  while (container && container !== doc.body) {
    const style = view?.getComputedStyle(container);
    const scrollable = /(auto|scroll)/.test(style?.overflowY || "");
    if (scrollable && container.scrollHeight > container.clientHeight + 4) {
      const cTop = container.getBoundingClientRect().top;
      const cHeight = container.clientHeight;
      const r = el.getBoundingClientRect();
      const relTop = r.top - cTop;
      const relBottom = r.bottom - cTop;
      // Scroll the minimum amount to bring the element fully inside the
      // viewport; `block: nearest` semantics, but on the real container.
      if (relTop < 0) {
        container.scrollTop += relTop;
      } else if (relBottom > cHeight) {
        container.scrollTop += relBottom - cHeight;
      }
      return;
    }
    container = container.parentElement;
  }
  try {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    /* scrolling is cosmetic; never skip the move because of it */
  }
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

  if (active && root.contains(active) && isLeafFocusable(active)) return active;
  // 宁可返回页面里第一个可聚焦控件，也不要返回 null：null 会让方向键"被吞但没反应"，
  // 用户看到的是整个界面失联，而不是光标跳一下。
  return firstLeaf(root);
}

/**
 * The horizontally-flowing container an element belongs to, if any.
 *
 * Used for edge wrapping: pressing LEFT on the left-most chip should land on the
 * right-most one *of that row* — not on some element in another row. A grid is
 * deliberately excluded (`null`): wrapping columns there would fight the row
 * model and make vertical movement unpredictable.
 */
function rowContainer(el: HTMLElement): HTMLElement | null {
  const view = el.ownerDocument?.defaultView;
  let node = el.parentElement;
  let depth = 0;
  while (node && node !== el.ownerDocument.body && depth < 8) {
    const style = view?.getComputedStyle(node);
    const display = style?.display || "";
    if (display === "grid" || display === "inline-grid") return null;
    if (display === "flex" || display === "inline-flex") {
      const dir = style?.flexDirection || "row";
      if (dir.startsWith("row")) return node;
      // A column flex is not a "row"; keep walking — its parent may still be one.
    }
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

/**
 * Wrap to the other end of the current row.
 *
 * `toLeft` means "the user pressed LEFT, so jump to the right-most sibling".
 * Elements sharing a row are picked by vertical-centre proximity, which keeps
 * this correct for `flex-wrap: wrap` rows (the detail page's action bar) where a
 * container holds several visual rows.
 */
function wrapRow(from: HTMLElement, root: HTMLElement, toLeft: boolean): HTMLElement | null {
  const row = rowContainer(from);
  if (!row || !root.contains(row)) return null;
  const doc = root.ownerDocument;
  const fr = from.getBoundingClientRect();
  const fy = fr.top + fr.height / 2;

  let items: HTMLElement[] = [];
  try {
    items = Array.from(row.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR));
  } catch {
    return null;
  }
  const sameRow = items.filter((el) => {
    if (el === from || el.contains(from) || from.contains(el)) return false;
    if (!isLeafFocusable(el) || !isVisible(el, doc)) return false;
    const r = el.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    return Math.abs(cy - fy) <= Math.max(10, Math.min(fr.height, r.height) * 0.6);
  });
  if (sameRow.length === 0) return null;
  sameRow.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  return toLeft ? sameRow[sameRow.length - 1] : sameRow[0];
}

/**
 * Move focus one step in `button`'s direction inside `scope`.
 * Returns true when focus actually moved (caller should swallow the event).
 *
 * `limitTo` restricts the *candidates* to one subtree (focus/cleanup still use
 * `scope`). Callers pass the game grid when the user is inside it: without it,
 * pressing LEFT on the first column fell through to the relaxed round and landed
 * on a toolbar chip diagonally above-left (2026-11-05 22:4x 用户反馈「网格里移动
 * 会跑到导航栏」). The grid then handles its own horizontal edges by flipping pages.
 */
export function moveFocus(
  button: number,
  scope?: HTMLElement | null,
  limitTo?: HTMLElement | null
): boolean {
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
  // Candidates come from `area` (the grid when the caller restricts it), but
  // visibility/anchoring still resolve against `root`.
  const area = limitTo && root.contains(limitTo) ? limitTo : root;
  try {
    all = Array.from(area.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR));
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
  // 横向走到行首/行尾时循环到同一行的另一端(用户 2026-11-05 要求:
  // 顶栏最左再左滑 → 落到最右的「刷新」,反之亦然)。只对「行」生效,
  // 网格被 rowContainer 主动排除,免得打乱行列关系。
  if (!best && horizontal) {
    best = wrapRow(active, root, button === DIR_LEFT);
  }
  if (!best) return false;
  scrollIntoViewport(root, best);
  focusOwned(best);
  // Steam 可能在同一拍里把焦点抢到隔壁。这里**不能**直接 return false 把按键
  // 交还给它 —— 那正是「按下去却横移一格」的放行口。先按回来,实在按不住
  // (元素正在卸载)才放行,避免把用户卡死。
  if (doc.activeElement !== best) {
    try {
      best.focus();
      remembered = best;
    } catch {
      /* fall through to the give-up branch below */
    }
  }
  if (doc.activeElement !== best) {
    remembered = null;
    ownedTarget = null;
    return false;
  }
  claimFocusRing(best, root);
  // 再盯两帧:有些路径上 Steam 不触发 focusin,只把 DOM focus 挪走。
  reverifyFocus(best, root);
  return true;
}

/**
 * Row/column navigation for flowing (non-grid) layouts — the settings, detail
 * and downloads pages, plus the header/tab bar.
 *
 * The geometric `moveFocus` above works beautifully on the library's rigid
 * 5×3 grid, but on a flowing form the user thinks in terms of *rows of
 * controls*: 上/下 moves between rows, 左/右 moves between the buttons of the
 * current row. The old "same column" test was too strict there — a ToggleField
 * and a button in neighbouring rows are never x-aligned, so 上/下 silently
 * stopped. Clustering controls into rows by their vertical centre and then
 * picking the horizontally nearest one on the target row matches the intuition
 * ("上下切换行,左右切换按钮", 2026-11-06 用户要求).
 */
type NavRow = { center: number; items: HTMLElement[] };

/** 顶栏（`data-ed-level="header"`）是吸顶的，聚类时必须和内容分开。 */
function isPinned(el: HTMLElement): boolean {
  return !!el.closest?.('[data-ed-level="header"]');
}

/** 每个可见的叶子可聚焦元素；当前元素无条件保留，行聚类需要它做参照。 */
function collectCandidates(root: HTMLElement, active: HTMLElement, doc: Document): HTMLElement[] {
  let all: HTMLElement[] = [];
  try {
    all = Array.from(root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR));
  } catch {
    return [active];
  }
  const out: HTMLElement[] = [];
  for (const el of all) {
    if (el === active) {
      out.push(el);
      continue;
    }
    if (active.contains(el) || el.contains(active)) continue;
    if (!isLeafFocusable(el) || !isVisible(el, doc)) continue;
    out.push(el);
  }
  return out;
}

const rowCenter = (el: HTMLElement): number => {
  const b = el.getBoundingClientRect();
  return b.top + b.height / 2;
};

/**
 * Cluster controls into rows by vertical-centre proximity. Buttons sharing a
 * flex row sit ~0px apart; a control in the next Group sits 40px+ lower, so a
 * band of half the shorter control's height (floor 16px) separates them cleanly.
 */
function clusterRows(list: HTMLElement[]): NavRow[] {
  const sorted = list.slice().sort((a, b) => rowCenter(a) - rowCenter(b));
  const out: NavRow[] = [];
  for (const el of sorted) {
    const cy = rowCenter(el);
    const last = out[out.length - 1];
    const band = last
      ? Math.max(16, Math.min(el.getBoundingClientRect().height, last.items[0].getBoundingClientRect().height) * 0.5)
      : 0;
    if (last && Math.abs(cy - last.center) <= band) {
      last.items.push(el);
      last.center = (last.center * (last.items.length - 1) + cy) / last.items.length;
    } else {
      out.push({ center: cy, items: [el] });
    }
  }
  return out;
}

/**
 * 顶栏单独成组并且永远排在内容行之前，"跨过顶栏"的那一步单独算。
 *
 * 为什么必须分开：吸顶元素的屏幕 Y 恒定，滚到同一高度的内容行会被并进同一
 * "行"。2026-11-10 实机走查直接复现——设置页里「插件设置」那一行和顶栏芯片
 * 聚成了同一行（cy 62 vs 64），"相邻行"索引因此错位，按"下"整块跳过。
 */
function splitRows(candidates: HTMLElement[]): { rows: NavRow[]; contentStart: number } {
  const pinned = clusterRows(candidates.filter(isPinned));
  const content = clusterRows(candidates.filter((el) => !isPinned(el)));
  return { rows: pinned.concat(content), contentStart: pinned.length };
}

/** 离 `y` 最近的行（只在 [from,to) 里找）。 */
function nearestRowIndex(rows: NavRow[], from: number, to: number, y: number): number {
  let best = -1;
  let gap = Number.POSITIVE_INFINITY;
  for (let i = from; i < to; i += 1) {
    const g = Math.abs(y - rows[i].center);
    if (g < gap) {
      gap = g;
      best = i;
    }
  }
  return best;
}

/**
 * Compact snapshot of the row model + where the cursor sits in it.
 *
 * 实机排查用：`onRootDirection` 把失败的那一次按键连同这个快照写进
 * `__epicdeckNavLog`，于是"点了没反应"能区分成三种完全不同的原因——
 * 行模型里根本没有顶栏（pinned=0）、当前行已经是第 0 行（atTop）、
 * 或者算出了目标但 DOM 焦点被抢走（domFocus 对不上）。
 */
export function describeRows(scope?: HTMLElement | null) {
  const root = scope || (document.querySelector(".ed-surface") as HTMLElement | null);
  if (!root) return null;
  const doc = root.ownerDocument;
  const active = usable(remembered, root) ? (remembered as HTMLElement) : currentFocused(root);
  const label = (el: HTMLElement | null | undefined) =>
    (el?.innerText || el?.className || "").trim().replace(/\s+/g, " ").slice(0, 14);
  if (!active) return { active: null, rows: [], pinned: 0 };
  const candidates = collectCandidates(root, active, doc);
  const { rows, contentStart } = splitRows(candidates);
  const fy = rowCenter(active);
  const myRow = isPinned(active)
    ? nearestRowIndex(rows, 0, contentStart, fy)
    : nearestRowIndex(rows, contentStart, rows.length, fy);
  return {
    active: label(active),
    domFocus: label(doc.activeElement as HTMLElement | null),
    anchored: usable(remembered, root),
    pinned: contentStart,
    rows: rows.length,
    atRow: myRow,
    content: rows.slice(contentStart, contentStart + 3).map((row) => ({
      cy: Math.round(row.center),
      items: row.items.map(label),
    })),
  };
}

export function moveFocusRowCol(
  button: number,
  scope?: HTMLElement | null
): boolean {
  if (button !== DIR_LEFT && button !== DIR_RIGHT && button !== DIR_UP && button !== DIR_DOWN) {
    return false;
  }
  const root = scope || (document.querySelector(".ed-surface") as HTMLElement | null);
  if (!root) return false;
  const doc = root.ownerDocument;

  const active = usable(remembered, root) ? (remembered as HTMLElement) : currentFocused(root);
  if (!active) return false;

  // 当前元素无条件保留，行聚类需要它做参照；其余只留可见的叶子控件。
  const candidates = collectCandidates(root, active, doc);
  if (candidates.length === 0) return false;

  const r = active.getBoundingClientRect();
  const fx = r.left + r.width / 2;
  const fy = r.top + r.height / 2;

  const { rows, contentStart } = splitRows(candidates);

  // Locate the row the active element sits in. 顶栏只在顶栏里找，内容只在内容里
  // 找——否则吸顶那一行会把它旁边经过的内容行抢走。
  const myRowIndex = isPinned(active)
    ? nearestRowIndex(rows, 0, contentStart, fy)
    : nearestRowIndex(rows, contentStart, rows.length, fy);
  if (myRowIndex < 0) return false;

  const horizontal = button === DIR_LEFT || button === DIR_RIGHT;

  if (horizontal) {
    // Within the current row, ordered left→right. Wrap around so the header's
    // "left-most → left = right-most" behaviour survives (2026-11-05 用户要求).
    const myRow = rows[myRowIndex].items
      .slice()
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const idx = myRow.indexOf(active);
    let target: HTMLElement | null = null;
    if (idx < 0) {
      // active is not a leaf (edge case): pick the nearest sibling in the
      // requested direction, or wrap.
      for (const el of myRow) {
        const dx = el.getBoundingClientRect().left - r.left;
        if (button === DIR_LEFT && dx < 0) target = el;
        else if (button === DIR_RIGHT && dx > 0) {
          target = el;
          break;
        }
      }
      if (!target && myRow.length) target = button === DIR_LEFT ? myRow[myRow.length - 1] : myRow[0];
    } else if (button === DIR_LEFT) {
      target = idx > 0 ? myRow[idx - 1] : myRow[myRow.length - 1];
    } else {
      target = idx < myRow.length - 1 ? myRow[idx + 1] : myRow[0];
    }
    if (!target || target === active) return false;
    scrollIntoViewport(root, target);
    focusOwned(target);
    claimFocusRing(target, root);
    reverifyFocus(target, root);
    return true;
  }

  // Vertical: jump to the adjacent row and pick the x-nearest control there.
  const pickInRow = (rowIndex: number): HTMLElement | null => {
    let best: HTMLElement | null = null;
    let bestDx = Number.POSITIVE_INFINITY;
    for (const el of rows[rowIndex].items) {
      if (el === active) continue;
      const b = el.getBoundingClientRect();
      const dx = Math.abs(b.left + b.width / 2 - fx);
      if (dx < bestDx) {
        bestDx = dx;
        best = el;
      }
    }
    return best;
  };

  let nextI: number;
  if (button === DIR_UP) {
    if (myRowIndex <= 0) return false;
    nextI = myRowIndex - 1;
  } else if (myRowIndex < contentStart) {
    // 顶栏按"下"：去**顶栏底边以下**的第一行。不能直接取 rows[contentStart]，
    // 内容行可能正滚到顶栏背后（cy 比顶栏底边还小），跳过去会突然向上翻滚。
    const headerBottom = Math.max(
      ...rows
        .slice(0, contentStart)
        .flatMap((row) => row.items.map((el) => el.getBoundingClientRect().bottom))
    );
    nextI = -1;
    for (let i = contentStart; i < rows.length; i += 1) {
      if (rows[i].center >= headerBottom - 2) {
        nextI = i;
        break;
      }
    }
    if (nextI < 0) return false;
  } else {
    if (myRowIndex + 1 >= rows.length) return false;
    nextI = myRowIndex + 1;
  }

  const target = pickInRow(nextI);
  if (!target) return false;
  scrollIntoViewport(root, target);
  focusOwned(target);
  if (doc.activeElement !== target) {
    try {
      target.focus();
      remembered = target;
    } catch {
      /* fall through */
    }
  }
  if (doc.activeElement !== target) {
    remembered = null;
    ownedTarget = null;
    return false;
  }
  claimFocusRing(target, root);
  reverifyFocus(target, root);
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
    // 我们也清掉 Steam 的 `gpfocus`：审计 1.13 建议"交回 Steam"，但实测如果不清，
    // 上一张封面会保持 gpfocus，CSS 里 `.ed-tile.gpfocus` 同样命中，屏幕上会同时
    // 有两张高亮。这里保留清理，只画一个环（`noFocusRing` 已关掉 Steam 的方框）。
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

/** True when `el` may legitimately receive the cursor right now (复审 4.4). */
export function canFocus(el: HTMLElement | null | undefined, root: HTMLElement): boolean {
  return usable(el, root);
}

