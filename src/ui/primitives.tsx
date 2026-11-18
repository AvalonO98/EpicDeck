// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

/**
 * Layout primitives shared by the full-screen pages.
 *
 * These used to live inside `fullscreen.tsx`, which meant every page module
 * that gets split out of it would have needed a circular import back into the
 * shell. Keeping them here also makes the three of them consistent: a card is
 * `16px 18px` everywhere, a section heading is `1.02em/700` everywhere.
 */
import { Focusable } from "@decky/ui";
import { FaChevronLeft, FaChevronRight } from "react-icons/fa";
import type { CSSProperties, ReactNode } from "react";

/** Prev / next arrows with the "1 / 10" counter between them. */
export function Pager({
  page,
  pageCount,
  onPrev,
  onNext,
}: {
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const btn: CSSProperties = {
    padding: "5px 10px",
    borderRadius: "8px",
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.1)",
    fontSize: "0.85em",
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  };
  const dim = (disabled: boolean): CSSProperties => (disabled ? { opacity: 0.3 } : {});
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
      {/* 到头了就不该能被聚焦：以前只是变淡，光标会停在"按了没反应"的死键上（审计 1.6）。 */}
      <Focusable
        className="ed-pager"
        noFocusRing
        tabIndex={page <= 1 ? -1 : 0}
        aria-disabled={page <= 1 ? "true" : undefined}
        style={{ ...btn, ...dim(page <= 1) }}
        onClick={page <= 1 ? undefined : onPrev}
        onActivate={page <= 1 ? undefined : onPrev}
      >
        <FaChevronLeft />
      </Focusable>
      <div
        style={{
          fontSize: "0.85em",
          opacity: 0.8,
          whiteSpace: "nowrap",
          minWidth: "56px",
          textAlign: "center",
        }}
      >
        {page} / {pageCount}
      </div>
      <Focusable
        className="ed-pager"
        noFocusRing
        tabIndex={page >= pageCount ? -1 : 0}
        aria-disabled={page >= pageCount ? "true" : undefined}
        style={{ ...btn, ...dim(page >= pageCount) }}
        onClick={page >= pageCount ? undefined : onNext}
        onActivate={page >= pageCount ? undefined : onNext}
      >
        <FaChevronRight />
      </Focusable>
    </div>
  );
}

/** Heading with an optional dimmed hint on the right. */
export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "10px", margin: "0 0 10px 2px" }}>
      <div style={{ fontSize: "1.02em", fontWeight: 700, letterSpacing: "0.01em" }}>{children}</div>
      {hint ? <div style={{ fontSize: "0.8em", opacity: 0.5 }}>{hint}</div> : null}
    </div>
  );
}

/** The rounded dark card every section sits in. */
export function Group({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="ed-group" style={{ padding: "16px 18px", ...style }}>
      {children}
    </div>
  );
}
