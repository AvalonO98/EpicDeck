// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Small presentational pieces shared by the QAM panel and the full-screen page.
// Keeping them here means the two surfaces cannot drift apart visually.

import { Focusable, ProgressBar, ScrollPanel, ScrollPanelGroup } from "@decky/ui";
import { useState, useRef, type CSSProperties, type ReactNode } from "react";
import { FaExclamationTriangle, FaGamepad, FaRedo } from "react-icons/fa";
import { STATE_LABEL, isActive, type InstallProgress, type LibraryFailure } from "./api";

// Steam's Focusable swaps in its own class when gamepad focus lands on an
// element, so every highlight has to live in CSS — inline styles cannot react
// to focus. `gpfocus` is Steam's class, the `ed-*-focused` ones are ours (set
// through focusClassName) so the rules also apply when Steam renames its own.
export const GLOBAL_CSS = `
.ed-surface {
  color: var(--decky-text-color, #fff);
}
.ed-card,
.ed-tile,
.ed-chip,
.ed-action,
.ed-pager,
.ed-row {
  outline: none;
  transition: background 120ms ease-out, box-shadow 120ms ease-out, transform 120ms ease-out;
}
.ed-tile {
  border-radius: 10px;
  overflow: hidden;
  background: rgba(255,255,255,0.045);
  border: 1px solid rgba(255,255,255,0.06);
}
.ed-tile.gpfocus,
.ed-tile.ed-focus {
  background: rgba(74,163,255,0.22);
  border-color: rgba(74,163,255,0.9);
  box-shadow: 0 10px 24px rgba(0,0,0,0.55);
  transform: translateY(-3px) scale(1.025);
}
.ed-tile.gpfocus .ed-tile-title,
.ed-tile.ed-tile-focused .ed-tile-title {
  color: #fff;
}
.ed-tile.gpfocus .ed-tile-shade,
.ed-tile.ed-tile-focused .ed-tile-shade {
  opacity: 1;
}
.ed-chip {
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.82);
}
.ed-chip.gpfocus,
.ed-chip.ed-focus {
  background: rgba(74,163,255,0.32);
  border-color: #4aa3ff;
  color: #fff;
}
.ed-chip[data-active="true"] {
  background: rgba(74,163,255,0.26);
  border-color: rgba(74,163,255,0.75);
  color: #fff;
  font-weight: 600;
}
.ed-action {
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.08);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-weight: 600;
}
.ed-action.gpfocus,
.ed-action.ed-focus {
  background: #4aa3ff;
  border-color: #4aa3ff;
  color: #04121f;
  box-shadow: 0 8px 20px rgba(0,0,0,0.45);
}
.ed-action[data-primary="true"] {
  background: linear-gradient(135deg, #3f8ef7 0%, #6d5efc 100%);
  border-color: transparent;
}
.ed-action[data-danger="true"] {
  background: rgba(255, 92, 92, 0.16);
  border-color: rgba(255, 92, 92, 0.5);
  color: #ffb3b3;
}
.ed-action[data-disabled="true"] {
  opacity: 0.42;
}
.ed-row.gpfocus,
.ed-row.ed-focus {
  background: rgba(74,163,255,0.2);
  box-shadow: inset 0 0 0 2px rgba(74,163,255,0.7);
}
.ed-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.28) transparent;
}
.ed-scroll::-webkit-scrollbar { width: 8px; }
.ed-scroll::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.22);
  border-radius: 8px;
}
.ed-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  min-width: 0;
}
.ed-toolbar-hint {
  flex: 1 1 auto;
  text-align: right;
  font-size: 0.8em;
  opacity: 0.5;
  white-space: nowrap;
  padding-right: 4px;
}
@media (max-width: 1100px) {
  .ed-toolbar-hint { display: none; }
}
.ed-group {
  border-radius: 12px;
  background: rgba(255,255,255,0.045);
  border: 1px solid rgba(255,255,255,0.07);
}
.ed-pager.gpfocus,
.ed-pager.ed-focus {
  background: rgba(255,255,255,0.22);
  color: #fff;
}
@keyframes ed-fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.ed-fade { animation: ed-fade-in 180ms ease-out both; }
`;

// Steam's own scroll widgets. @decky/ui resolves them out of Steam's webpack at
// module-evaluation time, which can land *after* this module initialises (ESM
// live bindings settle later). So never snapshot them into a module-level
// constant — read the bindings when rendering, or we permanently fall back to a
// plain div that the gamepad cannot scroll.

/**
 * A vertically scrollable region that Steam actually knows about.
 *
 * A plain `overflow-y: auto` div does **not** scroll with the right stick in
 * Game Mode: Steam's gamepad scrolling goes through its own focus/nav tree, and
 * only `ScrollPanelGroup` + `ScrollPanel` register a node there (they also carry
 * Steam's touch-pan handling, which the shell's `touch-action: none` would
 * otherwise block). Falls back to a normal div if Steam's build lacks them.
 *
 * `style` applies to the outer group (put flex sizing there), `contentStyle` to
 * the scrolling element itself (padding, etc.).
 */
export function Scroller({
  children,
  className,
  style,
  contentStyle,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  contentStyle?: CSSProperties;
}) {
  const outer: CSSProperties = {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    ...style,
  };
  const inner: CSSProperties = { flex: 1, minHeight: 0, ...contentStyle };

  // Late-bound on purpose: see the comment above.
  const Group = ScrollPanelGroup as any;
  const Panel = ScrollPanel as any;

  if (Panel && Group) {
    return (
      // `focusable={false}` is the key: the group is a Steam `Panel` that
      // otherwise registers itself as a focus node and swallows gamepad focus,
      // so the stick stops on the big box instead of reaching the buttons
      // inside it. Disabling it lets focus pass through to the children.
      <Group className={className} style={outer} focusable={false}>
        <Panel scrollDirection="y" style={inner}>
          {children}
        </Panel>
      </Group>
    );
  }

  return (
    <div
      data-ed-diag={`${Panel ? "P" : "p"}${Group ? "G" : "g"}-${typeof (window as any).__epicdeck}`}
      className={`ed-scroll${className ? ` ${className}` : ""}`}
      style={{ ...outer, overflowY: "auto", touchAction: "pan-y", ...contentStyle }}
    >
      {children}
    </div>
  );
}

/**
 * A row/column of focusable children, tagged with an interaction level.
 *
 * Deliberately a plain <div>: Steam's `Focusable` would register a nav node and
 * become a focus target itself, which produces the "selection box around the
 * whole block, can't get inside" behaviour. Decky's `Focusable` has no way to
 * say "group children but never take focus" (Steam ignores the `focusable` prop
 * here). Directional movement is therefore implemented by `moveFocus` in
 * `geomnav.ts`, and `data-ed-level` is what tells L1/R1 which level it is acting
 * on (grid → flip pages, tabs → switch tabs).
 */
export function NavRow({
  children,
  className,
  style,
  flow = "horizontal",
  level,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  flow?: "horizontal" | "vertical";
  /** Marks the interaction level, used by per-level L1/R1 handling. */
  level?: string;
}) {
  return (
    <div
      className={className}
      data-ed-level={level}
      style={{ display: "flex", flexDirection: flow === "vertical" ? "column" : "row", ...style }}
    >
      {children}
    </div>
  );
}

export function FocusStyles() {
  return <style>{GLOBAL_CSS}</style>;
}

export function Cover({
  url,
  title,
  width = 40,
  height = 56,
  radius = 6,
}: {
  url: string;
  title: string;
  width?: number | string;
  height?: number | string;
  radius?: number;
}) {
  const [failed, setFailed] = useState(false);
  const box: React.CSSProperties = {
    width,
    height,
    minWidth: width,
    borderRadius: radius,
    background: "rgba(255,255,255,0.06)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flexShrink: 0,
  };
  if (!url || failed) {
    return (
      <div style={{ ...box, opacity: 0.65, fontSize: "1.1em" }}>
        <FaGamepad />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={title}
      onError={() => setFailed(true)}
      style={{
        ...box,
        objectFit: "cover",
        objectPosition: "center top",
        display: "block",
      }}
    />
  );
}

export function ProgressInline({
  progress,
  compact,
}: {
  progress: InstallProgress;
  compact?: boolean;
}) {
  return (
    <div style={{ margin: compact ? "4px 0 0 2px" : "6px 0 0 0" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: compact ? "0.78em" : "0.85em",
          opacity: 0.85,
          marginBottom: "4px",
          gap: "10px",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {STATE_LABEL[progress.state] ?? "处理中"}
          {progress.message ? " · " + progress.message : ""}
        </span>
        {progress.percent >= 0 && <span>{progress.percent.toFixed(1)}%</span>}
      </div>
      <ProgressBar
        nProgress={progress.percent >= 0 ? progress.percent : 0}
        indeterminate={progress.percent < 0}
      />
      {(progress.speed || progress.eta) && (
        <div style={{ fontSize: compact ? "0.72em" : "0.8em", opacity: 0.6, marginTop: "4px" }}>
          {progress.speed}
          {progress.speed && progress.eta ? " · " : ""}
          {progress.eta ? "剩余 " + progress.eta : ""}
        </div>
      )}
    </div>
  );
}

export function WarningBanner({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 12px",
        borderRadius: "8px",
        background: "rgba(255, 184, 77, 0.12)",
        border: "1px solid rgba(255, 184, 77, 0.35)",
        color: "#ffcf80",
        fontSize: "0.85em",
        lineHeight: 1.4,
      }}
    >
      <FaExclamationTriangle />
      <span style={{ flex: 1 }}>{text}</span>
      {onRetry && (
        <Focusable
          onClick={onRetry}
          onActivate={onRetry}
          className="ed-chip"
          style={{ padding: "4px 10px", fontSize: "0.95em", whiteSpace: "nowrap" }}
        >
          重试
        </Focusable>
      )}
    </div>
  );
}

/**
 * "Can't reach Epic" is an actionable state, not a red line of text: the user
 * needs to know whether to check Wi-Fi or log in again.
 */
export function errorCopy(error: LibraryFailure) {
  const title =
    error.kind === "network"
      ? "连不上 Epic 服务器"
      : error.kind === "auth"
      ? "登录状态已失效"
      : "读取游戏库失败";
  const hint =
    error.kind === "network"
      ? "请确认掌机已联网、代理（如有）可用；Epic 服务器偶发不稳定，稍后重试通常就好。"
      : error.kind === "auth"
      ? "凭证可能已过期或被吊销，请到「设置 → 账号」重新登录。"
      : "可以重试一次；若反复失败，请到「设置 → 维护」导出诊断日志。";
  return { title, hint };
}

export function ErrorBlock({
  error,
  onRetry,
  retrying,
  big,
}: {
  error: LibraryFailure;
  onRetry: () => void;
  retrying?: boolean;
  big?: boolean;
}) {
  const { title, hint } = errorCopy(error);
  return (
    <div
      className="ed-group ed-fade"
      style={{
        padding: big ? "28px 30px" : "12px 14px",
        borderColor: "rgba(255,184,77,0.35)",
        background: "rgba(255,184,77,0.08)",
        maxWidth: big ? "720px" : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          color: "#ffb84d",
          fontWeight: 700,
          fontSize: big ? "1.35em" : "1em",
        }}
      >
        <FaExclamationTriangle /> {title}
      </div>
      <div
        style={{
          marginTop: "8px",
          color: "rgba(255,255,255,0.82)",
          fontSize: big ? "1em" : "0.9em",
          wordBreak: "break-word",
          lineHeight: 1.5,
        }}
      >
        {error.message}
      </div>
      <div
        style={{
          marginTop: "6px",
          color: "rgba(255,255,255,0.6)",
          fontSize: big ? "0.95em" : "0.82em",
          lineHeight: 1.5,
        }}
      >
        {hint}
      </div>
      <Focusable
        className="ed-action"
        onClick={onRetry}
        onActivate={onRetry}
        data-disabled={retrying ? "true" : "false"}
        style={{ marginTop: "14px", padding: "10px 18px", width: "fit-content", fontSize: "0.95em" }}
      >
        <FaRedo /> {retrying ? "正在重试…" : "重试"}
      </Focusable>
    </div>
  );
}

/** A labelled value block used on the settings / account pages. */
export function StatBlock({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: string;
}) {
  return (
    <div
      className="ed-group"
      style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}
    >
      <div style={{ fontSize: "0.78em", letterSpacing: "0.06em", opacity: 0.55, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: "1.45em", fontWeight: 700, color: accent ?? "#fff", lineHeight: 1.15 }}>
        {value}
      </div>
      {sub ? (
        <div style={{ fontSize: "0.78em", opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis" }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

export function activeLabel(progress?: InstallProgress): { text: string; color: string } | null {
  if (!progress || !isActive(progress)) return null;
  return {
    text:
      (STATE_LABEL[progress.state] ?? "下载中") +
      (progress.percent >= 0 ? " " + progress.percent.toFixed(0) + "%" : ""),
    color: "#4aa3ff",
  };
}

/**
 * A button that behaves the same for gamepad and mouse/touch.
 *
 * Steam's `Focusable` reports one press through *both* `onActivate` (gamepad A)
 * and `onClick` (mouse/touch), and many of our buttons only wired one of them —
 * so a gamepad press did nothing, or a click double-fired. This wraps both into
 * a single handler with a 300 ms debounce, so one physical press = one action,
 * on every input path.
 */
export function ActionButton({
  children,
  onClick,
  className = "ed-action",
  style,
  disabled,
  primary,
  danger,
  noFocusRing = true,
}: {
  children: ReactNode;
  onClick?: (e: any) => void;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  noFocusRing?: boolean;
}) {
  const lastRef = useRef(0);
  const fire = (e: any) => {
    if (disabled) return;
    const now = Date.now();
    if (now - lastRef.current < 300) return;
    lastRef.current = now;
    onClick?.(e);
  };
  return (
    <Focusable
      className={className}
      noFocusRing={noFocusRing}
      data-primary={primary ? "true" : "false"}
      data-danger={danger ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
      style={style}
      onClick={fire}
      onActivate={fire}
    >
      {children}
    </Focusable>
  );
}
