// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Small presentational pieces shared by the QAM panel and the full-screen page.
// Keeping them here means the two surfaces cannot drift apart visually.

import { Focusable, ProgressBar, ScrollPanel, ScrollPanelGroup } from "@decky/ui";
import { useState, useRef, type CSSProperties, type ReactNode } from "react";
import { FaExclamationTriangle, FaGamepad, FaRedo } from "react-icons/fa";
import { STATE_LABEL, fmtEta, fmtSize, type InstallProgress, type LibraryFailure } from "./api";
import { t } from "./i18n";
import { COLOR } from "./tokens";

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
.ed-loc {
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
/* 这两个选择器以前写的是 .ed-tile-focused，而代码里从来没有这个类（加的是
   .ed-focus），所以"聚焦时标题变纯白、遮罩不透明"两条规则一直没生效（审计 1.13）。 */
.ed-tile.gpfocus .ed-tile-title,
.ed-tile.ed-focus .ed-tile-title {
  color: #fff;
}
.ed-tile.gpfocus .ed-tile-shade,
.ed-tile.ed-focus .ed-tile-shade {
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
  background: rgba(74,163,255,0.38);
  border-color: ${COLOR.accent};
  color: #fff;
  box-shadow: 0 0 0 2px rgba(74,163,255,0.55);
}
/* The tab that owns the current page is a *state*, not the cursor. Using the
   same blue fill for both made it look like several buttons were still
   focused at once. State = faint fill + a short underline; cursor = strong
   blue fill + ring. */
.ed-chip[data-active="true"] {
  background: rgba(255,255,255,0.10);
  border-color: rgba(255,255,255,0.22);
  color: #fff;
  font-weight: 700;
  position: relative;
}
.ed-chip[data-active="true"]::after {
  content: "";
  position: absolute;
  left: 26%;
  right: 26%;
  bottom: 2px;
  height: 3px;
  border-radius: 2px;
  background: ${COLOR.accent};
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
  background: ${COLOR.accent};
  border-color: ${COLOR.accent};
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
  color: ${COLOR.danger};
}
.ed-action[data-disabled="true"] {
  opacity: 0.42;
}
/* Read-only information that still needs to be reachable by the stick (the
   version line at the bottom of settings sits below the last button, and
   without a focusable box the cursor never scrolls it into view). The border
   is what tells the user "you can stop here". */
.ed-info {
  display: block;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(255,255,255,0.04);
  padding: 8px 12px;
  transition: background 120ms ease-out, border-color 120ms ease-out,
    box-shadow 120ms ease-out;
}
.ed-info.gpfocus,
.ed-info.ed-focus {
  border-color: ${COLOR.accent};
  background: rgba(74,163,255,0.16);
  box-shadow: 0 0 0 2px rgba(74,163,255,0.45);
}
.ed-loc {
  display: block;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(255,255,255,0.04);
  padding: 8px 12px;
  transition: background 120ms ease-out, border-color 120ms ease-out,
    box-shadow 120ms ease-out;
}
.ed-loc.gpfocus,
.ed-loc.ed-focus {
  border-color: ${COLOR.accent};
  background: rgba(74,163,255,0.16);
  box-shadow: 0 0 0 2px rgba(74,163,255,0.45);
}
/* Steam 原生控件（下拉的 DialogButton、路径输入框、开关）用的是 Steam 自己的哈希类名，
   上面那些 .ed-* 规则一条都不匹配。claimFocusRing 照样会给它们加 ed-focus，但没有
   样式 → "光标落到原生控件上等于看不见"（2026-11-10 用户反馈）。这里补一圈和自有控件
   同色的环。用 outline 而不是 background：不参与布局、不改 Steam 自己的配色，开关那种
   38x22 的小控件也照样画得出来。
   ":not()" 链把自有控件排除，免得和上面各自的方案叠成双环。 */
/* 输入框/多行框除外：它们的外壳是 overflow:hidden，外扩的环会被裁掉，见下面那条规则。 */
.ed-focus:not(.ed-chip):not(.ed-tile):not(.ed-action):not(.ed-info):not(.ed-loc):not(.ed-pager):not(input):not(textarea) {
  outline: 2px solid ${COLOR.accent};
  outline-offset: 2px;
}
/* 光靠 ed-focus 不够：Steam 的焦点管理会重写它自己节点上的 className，实测出现过
   "hasEdFocus=false 但元素仍是 document.activeElement" —— 环跟着类一起消失，用户看到
   的就是"光标没了"。「:focus」由浏览器维护，抹不掉，所以同样的环再挂一份在这里。 */
.ed-surface :focus:not(.ed-chip):not(.ed-tile):not(.ed-action):not(.ed-info):not(.ed-loc):not(.ed-pager):not(input):not(textarea) {
  outline: 2px solid ${COLOR.accent};
  outline-offset: 2px;
}
/* 路径输入框的外壳是 overflow:hidden（padding 0 4px 0 40px），外扩 2px 的环会被裁掉，
   等于没有。这类改成内嵌环：画在输入框自己的边框内侧，裁不到，颜色一致。 */
input.ed-focus,
textarea.ed-focus,
.ed-surface input:focus,
.ed-surface textarea:focus {
  outline: none;
  box-shadow: inset 0 0 0 2px ${COLOR.accent};
}
.ed-loc-path {
  font-family: monospace;
  font-size: 0.82em;
  margin-top: 3px;
  word-break: break-all;
  user-select: text;
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
          {t(STATE_LABEL[progress.state] ?? "") || t("处理中")}
          {progress.message ? " · " + progress.message : ""}
        </span>
        <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
          {progress.downloaded_bytes != null && progress.total_bytes ? (
            <>
              {fmtSize(progress.downloaded_bytes)} / {fmtSize(progress.total_bytes)}
              {progress.percent >= 0 ? ` · ${progress.percent.toFixed(1)}%` : ""}
            </>
          ) : progress.percent >= 0 ? (
            `${progress.percent.toFixed(1)}%`
          ) : null}
        </span>
      </div>
      <ProgressBar
        nProgress={progress.percent >= 0 ? progress.percent : 0}
        indeterminate={progress.percent < 0}
      />
      {/* Speed and remaining time only make sense while bytes are flowing: at
          100% the download is over and the pump is assembling files, so showing
          "剩余 6:59" there would be a lie. */}
      {progress.state === "downloading" && (progress.speed || progress.eta) && (
        <div style={{ fontSize: compact ? "0.72em" : "0.8em", opacity: 0.6, marginTop: "4px" }}>
          {progress.speed}
          {progress.speed && progress.eta ? " · " : ""}
          {progress.eta ? t("剩余 ") + fmtEta(progress.eta) : ""}
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
          {t('重试')}
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
      ? t("连不上 Epic 服务器")
      : error.kind === "auth"
      ? t("登录状态已失效")
      : t("读取游戏库失败");
  const hint =
    error.kind === "network"
      ? t("请确认掌机已联网、代理（如有）可用；Epic 服务器偶发不稳定，稍后重试通常就好。")
      : error.kind === "auth"
      ? t("凭证可能已过期或被吊销，请到「设置 → 账号」重新登录。")
      : t("可以重试一次；若反复失败，请到「设置 → 维护」导出诊断日志。");
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
          color: COLOR.warningStrong,
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
      <ActionButton
        disabled={!!retrying}
        style={{ marginTop: "14px", padding: "10px 18px", width: "fit-content", fontSize: "0.95em" }}
        onClick={onRetry}
      >
        <FaRedo /> {retrying ? t("正在重试…") : t("重试")}
      </ActionButton>
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
      <div style={{ fontSize: "0.84em", letterSpacing: "0.06em", opacity: 0.55, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: "1.45em", fontWeight: 700, color: accent ?? "#fff", lineHeight: 1.15 }}>
        {value}
      </div>
      {sub ? (
        <div style={{ fontSize: "0.84em", opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis" }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
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
      // 禁用态必须离开焦点序列，否则光标会停在"按 A 没反应"的按钮上（审计 1.6）。
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled ? "true" : undefined}
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
