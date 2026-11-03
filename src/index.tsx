// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  ProgressBar,
  TextField,
  ToggleField,
  Dropdown,
  staticClasses,
  DialogButton,
  Field,
  Focusable,
  GamepadButton,
  showModal,
  ConfirmModal,
} from "@decky/ui";
import {
  addEventListener,
  removeEventListener,
  callable,
  definePlugin,
  toaster,
} from "@decky/api";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FaGamepad,
  FaDownload,
  FaPlay,
  FaTrash,
  FaSteamSymbol,
  FaChevronRight,
  FaArrowLeft,
  FaSearch,
  FaClock,
  FaExclamationTriangle,
  FaRedo,
} from "react-icons/fa";
import QRCode from "qrcode";

interface AuthStatus {
  logged_in: boolean;
  account_id: string;
  display_name: string;
}

interface Game {
  app_name: string;
  title: string;
  version: string;
  is_installed: boolean;
  install_size: number;
  installed_size: number;
  cover_url: string;
  playtime_seconds: number;
  first_seen: number;
  in_steam: boolean;
  // Filled in by the background metadata job: bytes to download and bytes on
  // disk after installation. Both stay 0 until the manifest is read.
  download_size?: number;
  disk_size?: number;
  localized_title?: boolean;
}

interface InstallDirOption {
  path: string;
  label: string;
  free: number;
  is_default?: boolean;
}

interface InstallProgress {
  state: "starting" | "downloading" | "verifying" | "patching" | "prereq" | "done" | "error" | "cancelled";
  percent: number;
  message: string;
  speed: string;
  eta: string;
}

const authStatus = callable<[], AuthStatus>("auth_status");
const logout = callable<[], { ok: boolean; error?: string }>("logout");
// A login attempt is a session, not a single call: begin_login opens Epic's page
// and starts reading the result off it, then login_poll reports the outcome
// while the user is still in the browser.
const beginLogin = callable<
  [],
  {
    ok: boolean;
    url?: string;
    opened?: boolean;
    message?: string;
    already_logged_in?: boolean;
    error?: string;
  }
>("begin_login");
const loginPoll = callable<
  [],
  { state: string; message: string; display_name: string; auto_copied: boolean; ok: boolean }
>("login_poll");
const cancelLogin = callable<[], { ok: boolean }>("cancel_login");
const loginWithClipboard = callable<
  [],
  { ok: boolean; display_name?: string; account_id?: string; error?: string }
>("login_with_clipboard");
const syncInstalledToSteam = callable<
  [app_name: string],
  { ok: boolean; added?: number; failed?: { title: string; error: string }[]; note?: string; error?: string }
>("sync_installed_to_steam");
const getLoginUrl = callable<[], { ok: boolean; url: string }>("get_login_url");
const loginWithCode = callable<[raw: string], {
  ok: boolean;
  display_name?: string;
  account_id?: string;
  error?: string;
}>("login_with_code");
const listGames = callable<
  [force?: boolean],
  {
    ok: boolean;
    games?: Game[];
    locale?: string;
    size_pending?: number;
    stale?: boolean;
    cached_at?: number;
    warning?: string;
    error?: string;
    error_kind?: "network" | "auth" | "unknown";
  }
>("list_games");
const getGameSize = callable<[app_name: string], { ok: boolean; download?: number; disk?: number; error?: string }>(
  "get_game_size"
);
const getLaunchArgs = callable<
  [app_name: string],
  { ok: boolean; args: string; own: boolean; from_legendary: boolean }
>("get_launch_args");
const setLaunchArgs = callable<
  [app_name: string, args: string],
  { ok: boolean; args?: string; error?: string; warning?: string }
>("set_launch_args");
const installGame = callable<[app_name: string, install_dir: string], { ok: boolean; error?: string }>("install");
const launchGame = callable<[app_name: string], { ok: boolean; error?: string; note?: string }>("launch");
const uninstallGame = callable<[app_name: string], { ok: boolean; error?: string }>("uninstall");
const addToSteam = callable<[app_name: string], { ok: boolean; appid?: number; error?: string }>("add_to_steam");
const removeFromSteam = callable<[app_name: string], { ok: boolean; error?: string }>("remove_from_steam");
const isInSteam = callable<[app_name: string], { in_steam: boolean }>("is_in_steam");
const refreshSteam = callable<[], { ok: boolean; note?: string; error?: string }>("refresh_steam");
const getSettings = callable<[], Record<string, any>>("get_settings");
const setSetting = callable<[key: string, value: any], { ok: boolean }>("set_setting");
const getInstallDirOptions = callable<[], { options: InstallDirOption[]; current: string }>("get_install_dir_options");
const resolveInstallDir = callable<[path: string], { ok: boolean; path?: string; free?: number; error?: string }>(
  "resolve_install_dir"
);
const completeFirstRun = callable<
  [install_dir: string],
  { ok: boolean; install_dir?: string; error?: string }
>("complete_first_run");
const checkEnvironment = callable<
  [],
  {
    legendary_installed: boolean;
    legendary_path: string;
    proton_installed?: boolean;
    proton_path?: string;
    use_proton?: boolean;
  }
>("check_environment");
const getProtonOptions = callable<
  [],
  { ok: boolean; options: { data: string; label: string }[]; current: string; found: number }
>("get_proton_options");
const refreshArtwork = callable<
  [app_name: string],
  { ok: boolean; updated?: number; icons?: number; total?: number; note?: string; error?: string }
>("refresh_artwork");
const installLegendary = callable<[], { ok: boolean; path?: string; version?: string; error?: string }>("install_legendary");
const exportLogs = callable<[], { ok: boolean; logs?: string; path?: string; error?: string }>("export_logs");

function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return gb.toFixed(1) + " GB";
  const mb = bytes / 1024 / 1024;
  return mb.toFixed(0) + " MB";
}

// "auto" follows the Steam UI language; the rest pin a specific one. Epic
// falls back to the English title when a game has no translation.
const LOCALE_OPTIONS: { data: string; label: string }[] = [
  { data: "auto", label: "自动（跟随 Steam 语言）" },
  { data: "zh-Hans", label: "简体中文" },
  { data: "zh-Hant", label: "繁體中文" },
  { data: "en-US", label: "English" },
  { data: "ja", label: "日本語" },
  { data: "ko", label: "한국어" },
  { data: "ru", label: "Русский" },
  { data: "de", label: "Deutsch" },
  { data: "fr", label: "Français" },
  { data: "es-ES", label: "Español" },
  { data: "pt-BR", label: "Português (Brasil)" },
];

// Short label for the resolved locale, shown next to the library count so it
// is obvious which language the titles came out in.
const LOCALE_LABELS: Record<string, string> = {
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  "en-US": "English",
  ja: "日本語",
  ko: "한국어",
  ru: "Русский",
  de: "Deutsch",
  fr: "Français",
  "es-ES": "Español",
  "es-419": "Español (LatAm)",
  "pt-BR": "Português",
  it: "Italiano",
  pl: "Polski",
  uk: "Українська",
  tr: "Türkçe",
};

// Epic's launcher client: the authorization code must be issued for the same
// client Legendary redeems it with, otherwise Epic rejects it with
// `authorization_code_not_for_your_client`.
const EPIC_LOGIN_URL =
  "https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code";

function QrImage({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = useState<string>("");
  const [qrError, setQrError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, {
      width: 190,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((d) => {
        if (!cancelled) {
          setDataUrl(d);
          setQrError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setQrError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (qrError) {
    return <div style={{ padding: "12px", opacity: 0.7 }}>二维码生成失败:{qrError}</div>;
  }
  if (!dataUrl) {
    return <div style={{ padding: "12px", opacity: 0.7 }}>生成二维码中…</div>;
  }
  return (
    <img
      src={dataUrl}
      alt="登录二维码"
      style={{
        width: "190px",
        height: "190px",
        background: "#ffffff",
        borderRadius: "8px",
        display: "block",
        margin: "0 auto",
      }}
    />
  );
}

// The QAM unmounts whenever Steam's browser takes over the screen, which would
// otherwise reset this screen and make it look like nothing is happening. Keep
// the live attempt on `window` so reopening the panel re-attaches to it.
const LOGIN_UI_KEY = "__epicdeckLoginUI";

type LoginSession = { state: string; message: string; display_name: string };

function readStoredLoginSession(): LoginSession | null {
  const stored = (window as any)[LOGIN_UI_KEY] as LoginSession | undefined;
  return stored && stored.state === "waiting" ? stored : null;
}

function storeLoginSession(session: LoginSession | null) {
  if (session && session.state === "waiting") {
    (window as any)[LOGIN_UI_KEY] = session;
  } else {
    delete (window as any)[LOGIN_UI_KEY];
  }
}

function LoginView({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [showCode, setShowCode] = useState<boolean>(false);
  const [loginUrl, setLoginUrl] = useState<string>(EPIC_LOGIN_URL);
  const [code, setCode] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState<string>("");
  // null = no attempt running; "waiting" = browser open, plugin is listening.
  const [session, setSession] = useState<LoginSession | null>(readStoredLoginSession);

  useEffect(() => {
    storeLoginSession(session);
  }, [session]);

  useEffect(() => {
    if (!showCode) return;
    let cancelled = false;
    getLoginUrl()
      .then((r) => {
        if (!cancelled && r?.url) setLoginUrl(r.url);
      })
      .catch(() => {
        /* keep the built-in URL */
      });
    return () => {
      cancelled = true;
    };
  }, [showCode]);

  const submitCode = async () => {
    const raw = code.trim();
    if (!raw) {
      setMsg("请先粘贴授权码");
      return;
    }
    setBusy("code");
    setMsg("正在登录…");
    try {
      const r = await loginWithCode(raw);
      if (r.ok) {
        setMsg("");
        setCode("");
        setShowCode(false);
        toaster.toast({ title: "登录成功", body: r.display_name || "" });
        onLoggedIn();
      } else {
        setMsg(r.error ?? "登录失败");
      }
    } catch (e) {
      setMsg("登录出错:" + String(e));
    } finally {
      setBusy("");
    }
  };

  // Hands-off login: the backend captures the code from the page itself, so all
  // this screen has to do is poll for the outcome. Restored sessions (panel
  // reopened after the browser closed it) resume polling here.
  useEffect(() => {
    if (!session || session.state !== "waiting") return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await loginPoll();
        if (stopped) return;
        if (r.ok) {
          stopped = true;
          setSession({ state: "ok", message: "", display_name: r.display_name });
          toaster.toast({ title: "登录成功", body: r.display_name || "" });
          onLoggedIn();
        } else if (r.state === "error" || r.state === "timeout") {
          stopped = true;
          setSession({ state: r.state, message: r.message, display_name: "" });
        }
      } catch (e) {
        console.log("EpicDeck: login poll failed", e);
      }
    };
    void tick();
    const timer = setInterval(tick, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session?.state]);

  const startLogin = async () => {
    setBusy("open");
    setMsg("");
    setSession(null);
    try {
      const r = await beginLogin();
      if (!r.ok) {
        setMsg(r.error ?? "无法开始登录");
        return;
      }
      if (r.already_logged_in) {
        toaster.toast({ title: "已经登录", body: "不需要重复登录" });
        onLoggedIn();
        return;
      }
      setLoginUrl(r.url || EPIC_LOGIN_URL);
      setSession({ state: "waiting", message: r.message ?? "", display_name: "" });
    } catch (e) {
      setMsg("启动登录失败:" + String(e));
    } finally {
      setBusy("");
    }
  };

  const stopLogin = async () => {
    setSession(null);
    try {
      await cancelLogin();
    } catch (e) {
      console.log("EpicDeck: cancel login failed", e);
    }
  };

  // The code is sitting in the clipboard after step 3; the backend reads X11
  // CLIPBOARD itself, so the user never has to paste it anywhere.
  const loginFromClipboard = async () => {
    setBusy("clip");
    setMsg("正在读取剪贴板…");
    try {
      const r = await loginWithClipboard();
      if (r.ok) {
        setMsg("");
        toaster.toast({ title: "登录成功", body: r.display_name || "" });
        onLoggedIn();
      } else {
        setMsg(r.error ?? "登录失败");
      }
    } catch (e) {
      setMsg("读取失败:" + String(e));
    } finally {
      setBusy("");
    }
  };

  if (showCode) {
    return (
      <PanelSection title="手机扫码登录">
        <PanelSectionRow>
          <div style={{ padding: "4px 0 2px", lineHeight: 1.5 }}>
            1. 用手机或电脑打开下面的链接(也可扫码),登录你的 Epic 账号
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <QrImage url={loginUrl} />
        </PanelSectionRow>
        <PanelSectionRow>
          <div
            style={{
              fontSize: "0.78em",
              opacity: 0.75,
              wordBreak: "break-all",
              textAlign: "center",
            }}
          >
            {loginUrl}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ padding: "6px 0 2px", lineHeight: 1.5 }}>
            2. 登录后页面会显示一段内容,复制其中 <b>authorizationCode</b> 的值
            (只复制那 32 位字符也可以)
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ padding: "2px 0 6px", lineHeight: 1.5 }}>
            3. 粘贴到下面,点「完成登录」。<b>授权码只能使用一次且很快过期</b>,请尽快粘贴。
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="授权码"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={!!busy}
            bShowClearAction
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={submitCode} disabled={!!busy}>
            {busy === "code" ? "正在登录…" : "完成登录"}
          </ButtonItem>
        </PanelSectionRow>
        {msg ? (
          <PanelSectionRow>
            <div style={{ padding: "6px 0", fontSize: "0.85em", opacity: 0.9 }}>{msg}</div>
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() => {
              setShowCode(false);
              setMsg("");
              setCode("");
            }}
            disabled={!!busy}
          >
            返回
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  // The browser is open on top of the QAM and the plugin is reading the code
  // off the result page, so this screen only has to wait.
  if (session && session.state === "waiting") {
    return (
      <PanelSection title="等待登录完成">
        <PanelSectionRow>
          <div style={{ padding: "10px 0", lineHeight: 1.6 }}>
            在弹出的 Steam 窗口里登录 Epic 账号就行，<b>不用复制，也不用回来粘贴</b>。
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ padding: "2px 0 4px", fontSize: "0.85em", lineHeight: 1.55, opacity: 0.75 }}>
            登录成功后浏览器会停在一个显示 JSON 的页面（<code>authorizationCode</code>
            ），那就是成功了，插件会自己把码取走并完成登录。看到这个页面后按 <b>B</b> 关掉浏览器即可。
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ padding: "2px 0", fontSize: "0.9em", opacity: 0.7 }}>
            正在等待登录…（约 20 秒后开始自动读取）
          </div>
        </PanelSectionRow>
        {session.message ? (
          <PanelSectionRow>
            <div style={{ padding: "4px 0", fontSize: "0.85em", lineHeight: 1.5, opacity: 0.85 }}>
              {session.message}
            </div>
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <div style={{ padding: "2px 0 6px", fontSize: "0.78em", lineHeight: 1.55, opacity: 0.55 }}>
            一直没反应的话，可以「重新打开登录页」；也可以改用手机扫码，或自己复制那段 JSON 后点「立即读取剪贴板」。
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={startLogin} disabled={!!busy}>
            重新打开登录页
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={loginFromClipboard} disabled={!!busy}>
            {busy === "clip" ? "正在读取…" : "立即读取剪贴板"}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={async () => {
              await stopLogin();
              setShowCode(true);
            }}
            disabled={!!busy}
          >
            改用手动粘贴授权码
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={stopLogin}>
            取消登录
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const failure =
    session && (session.state === "error" || session.state === "timeout") ? session.message : "";

  return (
    <PanelSection title="Epic Games 登录">
      <PanelSectionRow>
        <div style={{ padding: "8px 0", lineHeight: 1.5 }}>
          点下面的按钮，在弹出的 Steam 窗口里登录 Epic 账号即可。登录完成后插件会自己把授权码读走，
          <b>全程不用复制或粘贴</b>。
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={startLogin} disabled={!!busy}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", justifyContent: "center" }}>
            <FaSteamSymbol /> 在 Steam 浏览器中登录（推荐）
          </div>
        </ButtonItem>
      </PanelSectionRow>
      {failure ? (
        <PanelSectionRow>
          <div style={{ padding: "6px 0", fontSize: "0.85em", lineHeight: 1.5 }}>{failure}</div>
        </PanelSectionRow>
      ) : null}
      {msg ? (
        <PanelSectionRow>
          <div style={{ padding: "6px 0", fontSize: "0.85em", lineHeight: 1.5, wordBreak: "break-all" }}>
            {msg}
          </div>
        </PanelSectionRow>
      ) : null}
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setShowCode(true)} disabled={!!busy}>
          用手机扫码 / 手动粘贴授权码
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

function CoverImage({ url, title }: { url: string; title: string }) {
  const [error, setError] = useState(false);

  if (!url || error) {
    return (
      <div
        style={{
          width: "40px",
          height: "56px",
          minWidth: "40px",
          background: "var(--decky-button-background-color, #3a3a3a)",
          borderRadius: "4px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "0.8em",
          opacity: 0.7,
        }}
      >
        <FaGamepad />
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={title}
      onError={() => setError(true)}
      style={{
        width: "40px",
        height: "56px",
        minWidth: "40px",
        objectFit: "cover",
        borderRadius: "4px",
        background: "#222",
      }}
    />
  );
}

function fmtPlaytime(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const hours = seconds / 3600;
  if (hours >= 10) return Math.round(hours) + " 小时";
  if (hours >= 1) return hours.toFixed(1) + " 小时";
  return Math.max(1, Math.round(seconds / 60)) + " 分钟";
}

function isActive(progress?: InstallProgress): boolean {
  if (!progress) return false;
  return (
    progress.state === "starting" ||
    progress.state === "downloading" ||
    progress.state === "verifying" ||
    progress.state === "patching" ||
    progress.state === "prereq"
  );
}

const STATE_LABEL: Record<string, string> = {
  starting: "准备中",
  downloading: "下载中",
  verifying: "校验中",
  patching: "更新中",
  prereq: "安装组件中",
  done: "已完成",
  cancelled: "已取消",
  error: "出错",
};

function ProgressInline({ progress }: { progress: InstallProgress }) {
  return (
    <div style={{ margin: "4px 0 0 2px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.8em",
          opacity: 0.8,
          marginBottom: "3px",
        }}
      >
        <span>
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
        <div style={{ fontSize: "0.75em", opacity: 0.6, marginTop: "3px" }}>
          {progress.speed}
          {progress.speed && progress.eta ? " · " : ""}
          {progress.eta ? "剩余 " + progress.eta : ""}
        </div>
      )}
    </div>
  );
}

// A whole row is a single focusable target: pressing A opens the detail page.
// Deliberately no buttons here — per-row buttons used to steal gamepad focus,
// and the scroll view then cropped the cover and title out of sight.
function GameCard({
  game,
  progress,
  onOpen,
}: {
  game: Game;
  progress?: InstallProgress;
  onOpen: (game: Game) => void;
}) {
  const active = isActive(progress);

  let statusText: string;
  let statusColor = "rgba(255,255,255,0.65)";
  if (active) {
    statusText =
      (STATE_LABEL[progress!.state] ?? "下载中") +
      (progress!.percent >= 0 ? " " + progress!.percent.toFixed(0) + "%" : "");
    statusColor = "#4aa3ff";
  } else if (game.is_installed) {
    statusText = "已安装 · " + fmtSize(game.installed_size);
    statusColor = "#5ad17a";
  } else if (game.disk_size) {
    statusText = "未安装 · 安装后 " + fmtSize(game.disk_size);
  } else {
    statusText = "未安装 · 体积读取中…";
  }

  const playtime = fmtPlaytime(game.playtime_seconds);

  return (
    <div style={{ marginBottom: "6px" }}>
      <Focusable
        className="epicdeck-card"
        focusClassName="epicdeck-card-focused"
        onActivate={() => onOpen(game)}
        onClick={() => onOpen(game)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "8px 10px",
          width: "100%",
          boxSizing: "border-box",
          borderRadius: "6px",
          transition:
            "background 120ms ease-out, box-shadow 120ms ease-out, transform 120ms ease-out",
          background:
            "var(--decky-button-background-color, rgba(255,255,255,0.07))",
        }}
      >
        <CoverImage url={game.cover_url} title={game.title} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="epicdeck-card-title"
            style={{
              fontWeight: 600,
              fontSize: "0.95em",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {game.title}
          </div>
          <div
            style={{
              fontSize: "0.78em",
              marginTop: "2px",
              display: "flex",
              gap: "8px",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: statusColor }}>{statusText}</span>
            {playtime && (
              <span style={{ opacity: 0.6, display: "inline-flex", alignItems: "center", gap: "3px" }}>
                <FaClock size="0.85em" /> {playtime}
              </span>
            )}
            {game.in_steam && (
              <span style={{ opacity: 0.6, display: "inline-flex", alignItems: "center", gap: "3px" }}>
                <FaSteamSymbol size="0.85em" /> Steam
              </span>
            )}
          </div>
        </div>
        <FaChevronRight
          className="epicdeck-card-arrow"
          style={{ opacity: 0.4, flexShrink: 0 }}
        />
      </Focusable>
      {progress && (isActive(progress) || progress.state === "error") && (
        <ProgressInline progress={progress} />
      )}
    </div>
  );
}

function GameDetail({
  game,
  progress,
  dirs,
  defaultDir,
  onBack,
  onChanged,
}: {
  game: Game;
  progress?: InstallProgress;
  dirs: InstallDirOption[];
  defaultDir: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [installed, setInstalled] = useState(game.is_installed);
  const [inSteam, setInSteam] = useState(game.in_steam);
  const [busy, setBusy] = useState("");
  const [sizes, setSizes] = useState({
    download: game.download_size || 0,
    disk: game.disk_size || 0,
  });
  const [launchArgs, setLaunchArgsValue] = useState("");
  const [argsDirty, setArgsDirty] = useState(false);
  const [argsNote, setArgsNote] = useState("");
  const [target, setTarget] = useState(
    defaultDir || (dirs.length ? dirs[0].path : "")
  );

  useEffect(() => {
    isInSteam(game.app_name).then((r) => setInSteam(r.in_steam));
  }, [game.app_name]);

  // Launch arguments live in the plugin config; the Steam wrapper script is
  // rewritten on save so both entry points behave identically.
  useEffect(() => {
    let cancelled = false;
    setArgsDirty(false);
    getLaunchArgs(game.app_name).then((r) => {
      if (cancelled || !r.ok) return;
      setLaunchArgsValue(r.args ?? "");
      setArgsNote(
        r.from_legendary
          ? "来自 Legendary 配置（Legendary 启动时会自动应用，改这里会改为插件接管）"
          : ""
      );
    });
    return () => {
      cancelled = true;
    };
  }, [game.app_name]);

  useEffect(() => {
    if (!argsDirty) return;
    const timer = setTimeout(async () => {
      const r = await setLaunchArgs(game.app_name, launchArgs);
      setArgsDirty(false);
      if (!r.ok) {
        toaster.toast({ title: "启动参数保存失败", body: r.error ?? "" });
      } else if (r.warning) {
        toaster.toast({ title: "已保存，但 Steam 快捷方式未更新", body: r.warning });
      } else {
        setArgsNote("已保存，下次启动生效");
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [launchArgs, argsDirty, game.app_name]);

  // Opening a detail page for a title the background job has not reached yet
  // fetches its manifest right away instead of waiting for the crawl.
  useEffect(() => {
    setSizes({ download: game.download_size || 0, disk: game.disk_size || 0 });
    if (game.disk_size) return;
    let cancelled = false;
    getGameSize(game.app_name).then((r) => {
      if (!cancelled && r.ok) {
        setSizes({ download: r.download || 0, disk: r.disk || 0 });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [game.app_name, game.download_size, game.disk_size]);

  const dirOptions = dirs.map((d) => ({ data: d.path, label: d.label }));
  const currentDirLabel =
    dirs.find((d) => d.path === target)?.label || target || "未选择";

  const doInstall = async () => {
    setBusy("install");
    const r = await installGame(game.app_name, target);
    setBusy("");
    if (r.ok) {
      toaster.toast({ title: "开始下载", body: game.title });
    } else {
      toaster.toast({ title: "安装失败", body: r.error ?? "" });
    }
  };

  const doLaunch = async () => {
    setBusy("launch");
    const r = await launchGame(game.app_name);
    setBusy("");
    if (!r.ok) toaster.toast({ title: "启动失败", body: r.error ?? "" });
    else if (r.note) toaster.toast({ title: "正在启动", body: r.note });
  };

  const doUninstall = async () => {
    setBusy("uninstall");
    const r = await uninstallGame(game.app_name);
    setBusy("");
    if (r.ok) {
      setInstalled(false);
      onChanged();
      toaster.toast({ title: "已卸载", body: game.title });
    } else {
      toaster.toast({ title: "卸载失败", body: r.error ?? "" });
    }
  };

  const doAddSteam = async () => {
    setBusy("steam");
    const r = await addToSteam(game.app_name);
    setBusy("");
    if (r.ok) {
      setInSteam(true);
      onChanged();
      toaster.toast({ title: "已添加到 Steam", body: "重启 Steam 后生效" });
    } else {
      toaster.toast({ title: "添加失败", body: r.error ?? "" });
    }
  };

  const doRemoveSteam = async () => {
    setBusy("steam");
    const r = await removeFromSteam(game.app_name);
    setBusy("");
    if (r.ok) {
      setInSteam(false);
      onChanged();
    } else {
      toaster.toast({ title: "移除失败", body: r.error ?? "" });
    }
  };

  const active = isActive(progress);

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={onBack}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", justifyContent: "center" }}>
              <FaArrowLeft /> 返回游戏库
            </div>
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={game.title}>
        <PanelSectionRow>
          <div style={{ display: "flex", gap: "12px", padding: "4px 0" }}>
            <img
              src={game.cover_url}
              alt={game.title}
              style={{
                width: "92px",
                height: "128px",
                objectFit: "cover",
                borderRadius: "6px",
                background: "#222",
                flexShrink: 0,
              }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <div style={{ fontSize: "0.85em", lineHeight: "1.5em" }}>
              <div style={{ color: installed ? "#5ad17a" : "rgba(255,255,255,0.65)" }}>
                {installed ? "已安装" : "未安装"}
              </div>
              <div style={{ opacity: 0.75 }}>
                {installed
                  ? "已占用 " + fmtSize(game.installed_size)
                  : sizes.disk
                  ? "安装后 " + fmtSize(sizes.disk)
                  : "体积读取中…"}
              </div>
              {!installed && sizes.download > 0 && (
                <div style={{ opacity: 0.6 }}>需下载 {fmtSize(sizes.download)}</div>
              )}
              {installed && sizes.disk > 0 && (
                <div style={{ opacity: 0.6 }}>原始体积 {fmtSize(sizes.disk)}</div>
              )}
              {game.playtime_seconds > 0 && (
                <div style={{ opacity: 0.75 }}>游玩 {fmtPlaytime(game.playtime_seconds)}</div>
              )}
              <div style={{ opacity: 0.55, fontSize: "0.9em", wordBreak: "break-all" }}>
                {game.app_name.slice(0, 16)}…
              </div>
            </div>
          </div>
        </PanelSectionRow>

        {active && progress && (
          <PanelSectionRow>
            <ProgressInline progress={progress} />
          </PanelSectionRow>
        )}

        {!installed && !active && (
          <>
            <PanelSectionRow>
              <Dropdown
                rgOptions={dirOptions}
                selectedOption={target}
                onChange={(e) => setTarget(e.data)}
              />
              <Field label="安装位置" description={currentDirLabel} />
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={doInstall} disabled={busy === "install"}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", justifyContent: "center" }}>
                  <FaDownload /> 下载并安装
                </div>
              </ButtonItem>
            </PanelSectionRow>
          </>
        )}

        {installed && (
          <>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={doLaunch} disabled={busy === "launch"}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", justifyContent: "center" }}>
                  <FaPlay /> 启动游戏
                </div>
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={doUninstall} disabled={busy === "uninstall"}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", justifyContent: "center" }}>
                  <FaTrash /> 卸载
                </div>
              </ButtonItem>
            </PanelSectionRow>
          </>
        )}

        <PanelSectionRow>
          <TextField
            label="启动参数（可选）"
            value={launchArgs}
            onChange={(e: any) => {
              setLaunchArgsValue(e.target.value);
              setArgsDirty(true);
            }}
          />
          <Field
            label="启动参数"
            description={
              argsNote ||
              "追加在 legendary launch 之后，如 -windowed；留空即不添加。Steam 属性里手填的启动项也会被转发"
            }
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={inSteam ? doRemoveSteam : doAddSteam}
            disabled={!installed || busy === "steam"}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px", justifyContent: "center" }}>
              <FaSteamSymbol /> {inSteam ? "已添加到 Steam（点击移除）" : "添加到 Steam"}
            </div>
          </ButtonItem>
        </PanelSectionRow>
        {!installed && (
          <PanelSectionRow>
            <div style={{ fontSize: "0.78em", opacity: 0.55, padding: "0 4px" }}>
              需要先安装才能添加到 Steam。
            </div>
          </PanelSectionRow>
        )}
      </PanelSection>
    </>
  );
}

// Focus styling for the game list. Steam's Focusable swaps the element's class
// when gamepad focus lands on it, so the highlight has to live in CSS — inline
// styles cannot react to focus.
const CARD_CSS = `
.epicdeck-card.epicdeck-card-focused,
.epicdeck-card.gpfocus {
  background: linear-gradient(90deg, rgba(74,163,255,0.34) 0%, rgba(74,163,255,0.12) 100%) !important;
  box-shadow: 0 0 0 2px #4aa3ff, 0 4px 16px rgba(0,0,0,0.5), 0 0 18px rgba(74,163,255,0.28) !important;
  transform: translateX(3px);
}
.epicdeck-card.epicdeck-card-focused .epicdeck-card-title,
.epicdeck-card.gpfocus .epicdeck-card-title {
  color: #ffffff !important;
  text-shadow: 0 0 12px rgba(74,163,255,0.6);
}
.epicdeck-card.epicdeck-card-focused .epicdeck-card-arrow,
.epicdeck-card.gpfocus .epicdeck-card-arrow {
  opacity: 1 !important;
  color: #4aa3ff;
  transform: translateX(2px);
  transition: opacity 120ms ease-out, transform 120ms ease-out;
}
`;

function FocusStyles() {
  return <style dangerouslySetInnerHTML={{ __html: CARD_CSS }} />;
}

type SortMode = "alpha" | "alpha_desc" | "playtime" | "recent";

const SORT_OPTIONS: { data: SortMode; label: string }[] = [
  { data: "alpha", label: "字母 A → Z" },
  { data: "alpha_desc", label: "字母 Z → A" },
  { data: "playtime", label: "游玩时间（长 → 短）" },
  { data: "recent", label: "最近添加" },
];

type InstallFilter = "all" | "installed" | "not_installed";

// Order doubles as the L1/R1 cycle order: 全部 → 已安装 → 未安装 → 全部.
const INSTALL_FILTER_ORDER: InstallFilter[] = ["all", "installed", "not_installed"];

const INSTALL_FILTER_LABEL: Record<InstallFilter, string> = {
  all: "全部",
  installed: "已安装",
  not_installed: "未安装",
};

interface LibraryUIState {
  filter: InstallFilter;
  sort: SortMode;
  query: string;
}

// The QAM unmounts the plugin panel when it closes, so component state is lost
// every time the user re-opens it — which is why picking "已安装" looked like it
// snapped back to the full list. `window` survives both remounts and a plugin
// UI reload, so the choice stays put without a backend round-trip.
const UI_STATE_KEY = "__epicdeckLibraryUI";

function readUIState(): LibraryUIState {
  const saved = (window as any)[UI_STATE_KEY] ?? {};
  return {
    filter: INSTALL_FILTER_ORDER.includes(saved.filter) ? saved.filter : "all",
    sort: SORT_OPTIONS.some((o) => o.data === saved.sort) ? saved.sort : "alpha",
    query: typeof saved.query === "string" ? saved.query : "",
  };
}

function writeUIState(patch: Partial<LibraryUIState>) {
  (window as any)[UI_STATE_KEY] = { ...readUIState(), ...patch };
}

// ---- library snapshot cache -------------------------------------------
// Opening the QAM must not wait for `legendary list`. The backend keeps its
// own snapshot, and the frontend keeps the last rendered list too: `window`
// survives a QAM close/open (the panel is unmounted, the window is not), and
// localStorage covers a full plugin-UI reload.
const LIB_CACHE_KEY = "epicdeck:library:v1";
const LIB_MEM_KEY = "__epicdeckLibrary";

interface LibraryCache {
  account: string;
  ts: number;
  locale: string;
  size_pending?: number;
  games: Game[];
}

function readLibraryCache(account?: string): LibraryCache | null {
  const accept = (data: any): LibraryCache | null => {
    if (!data || !Array.isArray(data.games) || data.games.length === 0) return null;
    if (account && data.account && data.account !== account) return null;
    return data as LibraryCache;
  };
  const mem = accept((window as any)[LIB_MEM_KEY]);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(LIB_CACHE_KEY);
    const data = raw ? accept(JSON.parse(raw)) : null;
    // Promote to memory: localStorage is a synchronous read, and this helper
    // is called several times while the panel mounts.
    if (data) (window as any)[LIB_MEM_KEY] = data;
    return data;
  } catch {
    return null;
  }
}

function writeLibraryCache(
  account: string,
  payload: { games?: Game[]; locale?: string; size_pending?: number }
) {
  if (!payload.games || payload.games.length === 0) return;
  const data: LibraryCache = {
    account,
    ts: Date.now(),
    locale: payload.locale ?? "",
    size_pending: payload.size_pending ?? 0,
    games: payload.games,
  };
  (window as any)[LIB_MEM_KEY] = data;
  try {
    localStorage.setItem(LIB_CACHE_KEY, JSON.stringify(data));
  } catch (e) {
    console.log("EpicDeck: library cache write failed", e);
  }
}

function clearLibraryCache() {
  delete (window as any)[LIB_MEM_KEY];
  try {
    localStorage.removeItem(LIB_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

type LibraryFailure = { message: string; kind: "network" | "auth" | "unknown" };

// A dedicated card instead of one red line: "can't reach Epic" is an actionable
// state, and the user needs to know whether to check Wi-Fi or log in again.
function LibraryErrorCard({
  error,
  onRetry,
  retrying,
}: {
  error: LibraryFailure;
  onRetry: () => void;
  retrying?: boolean;
}) {
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
      ? "凭证可能已过期或被吊销，请在下方「设置」里重新登录。"
      : "可以重试一次；若反复失败，请到设置里导出诊断日志。";
  return (
    <PanelSection title="游戏库">
      <PanelSectionRow>
        <div style={{ padding: "8px 0", lineHeight: 1.5 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              color: "#ffb84d",
              fontWeight: 600,
            }}
          >
            <FaExclamationTriangle /> {title}
          </div>
          <div
            style={{
              marginTop: "6px",
              color: "var(--decky-secondary-text, #b8b8b8)",
              fontSize: "0.9em",
              wordBreak: "break-word",
            }}
          >
            {error.message}
          </div>
          <div
            style={{
              marginTop: "6px",
              color: "var(--decky-secondary-text, #9a9a9a)",
              fontSize: "0.82em",
            }}
          >
            {hint}
          </div>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={onRetry} disabled={retrying}>
          <div style={{ display: "flex", gap: "6px", justifyContent: "center", alignItems: "center" }}>
            <FaRedo /> {retrying ? "正在重试…" : "重试"}
          </div>
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

// Non-blocking banner shown above a cached list when a refresh failed.
function LibraryWarning({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        margin: "0 0 8px 0",
        padding: "8px 10px",
        borderRadius: "6px",
        background: "rgba(255, 184, 77, 0.12)",
        border: "1px solid rgba(255, 184, 77, 0.35)",
        color: "#ffcf80",
        fontSize: "0.82em",
        lineHeight: 1.4,
      }}
    >
      <FaExclamationTriangle />
      <span style={{ flex: 1 }}>{text}</span>
      {onRetry && (
        <span
          onClick={onRetry}
          style={{ textDecoration: "underline", cursor: "pointer", whiteSpace: "nowrap" }}
        >
          重试
        </span>
      )}
    </div>
  );
}

function LibraryView({
  games,
  error,
  warning,
  progress,
  sizePending,
  locale,
  onOpen,
  onRetry,
  retrying,
}: {
  games: Game[];
  error?: LibraryFailure | null;
  warning?: string;
  progress: Record<string, InstallProgress>;
  sizePending: number;
  locale: string;
  onOpen: (game: Game) => void;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const initial = useMemo(readUIState, []);
  const [query, setQuery] = useState(initial.query);
  const [sort, setSort] = useState<SortMode>(initial.sort);
  const [installFilter, setInstallFilter] = useState<InstallFilter>(initial.filter);

  const chooseFilter = (next: InstallFilter) => {
    setInstallFilter(next);
    writeUIState({ filter: next });
  };

  // L1 / R1 step through the three lists and wrap around, so the whole library
  // can be paged without touching the tab row.
  const cycleFilter = (delta: number) => {
    const i = INSTALL_FILTER_ORDER.indexOf(installFilter);
    const next = INSTALL_FILTER_ORDER[
      (i + delta + INSTALL_FILTER_ORDER.length) % INSTALL_FILTER_ORDER.length
    ];
    chooseFilter(next);
  };

  const filterCount = (f: InstallFilter) =>
    f === "installed" ? installedCount : f === "not_installed" ? games.length - installedCount : games.length;

  const onGamepadButton = (evt: any) => {
    const button = evt?.detail?.button;
    if (button === GamepadButton.BUMPER_LEFT) cycleFilter(-1);
    else if (button === GamepadButton.BUMPER_RIGHT) cycleFilter(1);
  };

  const installedCount = useMemo(
    () => games.filter((g) => g.is_installed).length,
    [games]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = games.filter((g) => {
      if (installFilter === "installed" && !g.is_installed) return false;
      if (installFilter === "not_installed" && g.is_installed) return false;
      if (!q) return true;
      return (
        (g.title || "").toLowerCase().includes(q) || g.app_name.toLowerCase().includes(q)
      );
    });

    filtered.sort((a, b) => {
      switch (sort) {
        case "alpha_desc":
          return (b.title || "").localeCompare(a.title || "", "zh-Hans-CN");
        case "playtime":
          return (b.playtime_seconds || 0) - (a.playtime_seconds || 0);
        case "recent":
          return (b.first_seen || 0) - (a.first_seen || 0);
        default:
          return (a.title || "").localeCompare(b.title || "", "zh-Hans-CN");
      }
    });
    return filtered;
  }, [games, query, sort, installFilter]);

  if (error && games.length === 0) {
    return (
      <LibraryErrorCard
        error={error}
        onRetry={onRetry ?? (() => {})}
        retrying={retrying}
      />
    );
  }

  if (games.length === 0) {
    return (
      <PanelSection title="游戏库">
        <PanelSectionRow>
          <div style={{ padding: "12px 0" }}>
            游戏库为空。请确认你的 Epic 账号下已拥有游戏（含免费领取的游戏）。
          </div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <Focusable
      onButtonDown={onGamepadButton}
      actionDescriptionMap={{
        [GamepadButton.BUMPER_LEFT]: "上一类",
        [GamepadButton.BUMPER_RIGHT]: "下一类",
      }}
    >
      <FocusStyles />
      <PanelSection>
        {(error || warning) && (
          <PanelSectionRow>
            <LibraryWarning
              text={
                error
                  ? `${error.message} 当前显示的是上次加载的游戏库。`
                  : warning!
              }
              onRetry={onRetry}
            />
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <Focusable style={{ display: "flex", gap: "6px", width: "100%" }}>
            {INSTALL_FILTER_ORDER.map((f) => {
              const active = f === installFilter;
              return (
                <DialogButton
                  key={f}
                  onClick={() => chooseFilter(f)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: "8px 4px",
                    fontSize: "0.82em",
                    textAlign: "center",
                    background: active
                      ? "var(--decky-selected-background-color, rgba(255,255,255,0.22))"
                      : "var(--decky-button-background-color, rgba(255,255,255,0.07))",
                    color: active ? "#fff" : "inherit",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {INSTALL_FILTER_LABEL[f]} {filterCount(f)}
                </DialogButton>
              );
            })}
          </Focusable>
          <Field label="列表分类" description="按 L1 / R1 左右切换" />
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="搜索游戏"
            value={query}
            onChange={(e: any) => {
              setQuery(e.target.value);
              writeUIState({ query: e.target.value });
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <Dropdown
            rgOptions={SORT_OPTIONS}
            selectedOption={sort}
            onChange={(e) => {
              setSort(e.data as SortMode);
              writeUIState({ sort: e.data as SortMode });
            }}
          />
          <Field
            label="排序方式"
            description={
              (visible.length === games.length
                ? "共 " + games.length + " 个游戏"
                : "显示 " + visible.length + " / 共 " + games.length + " 个游戏") +
              (sizePending > 0
                ? " · 体积读取中 " + (games.length - sizePending) + "/" + games.length
                : locale
                ? " · 标题 " + (LOCALE_LABELS[locale] ?? locale)
                : "")
            }
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection>
        {visible.length === 0 ? (
          <PanelSectionRow>
            <div style={{ padding: "12px 0", opacity: 0.7 }}>
              {query.trim() ? (
                <>
                  <FaSearch /> 没有匹配「{query}」的游戏
                </>
              ) : installFilter === "installed" ? (
                <>还没有已安装的游戏</>
              ) : installFilter === "not_installed" ? (
                <>所有游戏都已安装</>
              ) : (
                <>没有可显示的游戏</>
              )}
            </div>
          </PanelSectionRow>
        ) : (
          visible.map((g) => (
            <PanelSectionRow key={g.app_name}>
              <GameCard game={g} progress={progress[g.app_name]} onOpen={onOpen} />
            </PanelSectionRow>
          ))
        )}
      </PanelSection>
    </Focusable>
  );
}

function MissingDependency({ onInstalled }: { onInstalled: () => void }) {
  const [installing, setInstalling] = useState(false);

  const doInstall = async () => {
    setInstalling(true);
    const r = await installLegendary();
    setInstalling(false);
    if (r.ok) {
      toaster.toast({
        title: "安装成功",
        body: `Legendary ${r.version ?? ""} 已安装`,
      });
      onInstalled();
    } else {
      toaster.toast({ title: "安装失败", body: r.error ?? "" });
    }
  };

  return (
    <PanelSection title="缺少依赖">
      <PanelSectionRow>
        <div style={{ padding: "12px 0" }}>
          <p>未检测到 Legendary(SteamOS 无 pip,无法用 pip 安装)。</p>
          <p style={{ opacity: 0.7, fontSize: "0.85em" }}>
            点击下方按钮,将自动从 GitHub Releases 下载官方独立二进制(约 3 MB,无需 Python)。
          </p>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={doInstall} disabled={installing}>
          {installing ? "正在下载…" : "一键安装 Legendary"}
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

function FirstRunView({
  dirs,
  onReloadDirs,
  onDone,
}: {
  dirs: InstallDirOption[];
  onReloadDirs: () => void;
  onDone: (path: string) => void;
}) {
  const [choice, setChoice] = useState<string>("");
  const [custom, setCustom] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [note, setNote] = useState<string>("");

  // Options arrive asynchronously; preselect the backend's default (first item).
  useEffect(() => {
    if (!choice && dirs.length) setChoice(dirs[0].path);
  }, [dirs, choice]);

  const finish = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const r = await completeFirstRun(path);
      if (!r.ok) {
        setNote(r.error ?? "保存失败");
        return;
      }
      toaster.toast({ title: "下载位置已设置", body: r.install_dir ?? path });
      onDone(r.install_dir ?? path);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    const typed = custom.trim();
    if (!typed) {
      await finish(choice);
      return;
    }
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const v = await resolveInstallDir(typed);
      if (!v.ok || !v.path) {
        setNote(v.error ?? "路径无效");
        return;
      }
      await finish(v.path);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PanelSection title="欢迎使用 EpicDeck">
        <PanelSectionRow>
          <div style={{ padding: "4px 0", lineHeight: 1.5 }}>
            Epic 游戏体积很大，先选一个下载安装的位置。选好之后可以在
            「设置 → 默认安装目录」里随时更改，单个游戏也能单独指定。
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <Dropdown
            rgOptions={dirs.map((d) => ({ data: d.path, label: d.label }))}
            selectedOption={choice}
            onChange={(e) => setChoice(e.data)}
          />
          <Field
            label="下载安装位置"
            description={
              dirs.length
                ? dirs.find((d) => d.path === choice)?.path ?? ""
                : "正在读取可用磁盘…"
            }
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="自定义路径（可选）"
            value={custom}
            onChange={(e: any) => setCustom(e.target.value)}
          />
          <Field
            label="自定义路径"
            description="填了就用它（例如 /run/media/deck/MySD/EpicGames），留空则用上面的位置；目录不存在会自动创建"
          />
        </PanelSectionRow>
        {note && (
          <PanelSectionRow>
            <div style={{ color: "#ff8a80", fontSize: "0.9em", wordBreak: "break-all" }}>{note}</div>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={confirm} disabled={busy}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", justifyContent: "center" }}>
              <FaDownload /> {busy ? "正在准备…" : "使用此位置并继续"}
            </div>
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => finish("")} disabled={busy}>
            用默认位置（~/Games）
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={onReloadDirs} disabled={busy}>
            刷新磁盘列表（刚插 SD 卡？）
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

function SettingsView() {
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [dirs, setDirs] = useState<InstallDirOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [customPath, setCustomPath] = useState<string>("");
  const [savingPath, setSavingPath] = useState<boolean>(false);
  const [syncingSteam, setSyncingSteam] = useState<boolean>(false);
  const [protons, setProtons] = useState<{ data: string; label: string }[]>([]);
  const [fixingArt, setFixingArt] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      const s = await getSettings();
      const d = await getInstallDirOptions();
      setSettings(s);
      setDirs(d.options);
      setCustomPath(s.install_dir || d.current || "");
      setLoaded(true);
      try {
        const p = await getProtonOptions();
        setProtons(p.options);
      } catch {
        setProtons([]);
      }
    })();
  }, []);

  const update = async (key: string, value: any) => {
    setSettings((s) => ({ ...s, [key]: value }));
    await setSetting(key, value);
    // The library list lives in a sibling component; a DOM event is the
    // cheapest way to tell it to re-read titles/sizes after a settings change.
    if (key === "title_locale" || key === "auto_fetch_size") {
      window.dispatchEvent(new CustomEvent("epicdeck:library-changed"));
    }
  };

  // A hand-typed path is validated (and created) before it is stored, so a
  // typo surfaces here instead of as a failed download later.
  const applyCustomPath = async () => {
    if (savingPath) return;
    if (!customPath.trim()) {
      toaster.toast({ title: "请填写路径", body: "留空则使用上面的默认安装目录" });
      return;
    }
    setSavingPath(true);
    try {
      const r = await resolveInstallDir(customPath);
      if (!r.ok || !r.path) {
        toaster.toast({ title: "路径无效", body: r.error ?? "" });
        return;
      }
      setCustomPath(r.path);
      await update("install_dir", r.path);
      toaster.toast({ title: "已保存安装目录", body: r.path });
    } finally {
      setSavingPath(false);
    }
  };

  // Writes every installed Epic title into Steam's shortcuts.vdf in one go.
  // Steam only re-reads that file at startup, so the note says so explicitly.
  const syncAllToSteam = async () => {
    if (syncingSteam) return;
    setSyncingSteam(true);
    try {
      const r = await syncInstalledToSteam("");
      if (!r.ok) {
        toaster.toast({ title: "添加失败", body: r.error ?? "" });
        return;
      }
      const failed = r.failed ?? [];
      const body = failed.length
        ? `已添加 ${r.added ?? 0} 个，失败 ${failed.length} 个（${failed[0].title}）`
        : `已添加 ${r.added ?? 0} 个。${r.note ?? ""}`;
      toaster.toast({ title: "已写入 Steam", body });
    } catch (e) {
      toaster.toast({ title: "添加失败", body: String(e) });
    } finally {
      setSyncingSteam(false);
    }
  };

  if (!loaded) return <PanelSection title="设置"><PanelSectionRow><div>加载中…</div></PanelSectionRow></PanelSection>;

  return (
    <PanelSection title="设置">
      <PanelSectionRow>
        <ToggleField
          label="自动添加到 Steam"
          description="下载完成后自动加入 Steam 游戏库"
          checked={!!settings.auto_add_to_steam}
          onChange={(v) => update("auto_add_to_steam", v)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Windows 游戏用 Proton 运行"
          description="SteamOS 没有 wine；Windows 版 Epic 游戏要靠 Steam 自带的 Proton 启动"
          checked={settings.use_proton !== false}
          onChange={(v) => {
            update("use_proton", v);
            // The launcher scripts carry the --wine flag, so they have to be
            // rewritten for the change to take effect.
            window.dispatchEvent(new CustomEvent("epicdeck:library-changed"));
          }}
        />
      </PanelSectionRow>
      {settings.use_proton !== false && protons.length > 0 && (
        <PanelSectionRow>
          <Dropdown
            rgOptions={protons}
            selectedOption={settings.proton_path || ""}
            onChange={(e) => update("proton_path", e.data)}
          />
          <Field
            label="Proton 版本"
            description="自动 = 优先 GE-Proton，其次 Steam 自带的最新正式版"
          />
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <Dropdown
          rgOptions={dirs.map((d) => ({ data: d.path, label: d.label }))}
          selectedOption={settings.install_dir || (dirs.length ? dirs[0].path : "")}
          onChange={(e) => {
            setCustomPath(e.data);
            update("install_dir", e.data);
          }}
        />
        <Field label="默认安装目录" description="新建下载默认使用此位置（单个游戏可在详情页覆盖）" />
      </PanelSectionRow>
      <PanelSectionRow>
        <TextField
          label="自定义路径（可选）"
          value={customPath}
          onChange={(e: any) => setCustomPath(e.target.value)}
        />
        <Field
          label="自定义路径"
          description="目录不存在会自动创建；改完点下面的按钮保存"
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={applyCustomPath} disabled={savingPath}>
          保存自定义路径
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <Dropdown
          rgOptions={LOCALE_OPTIONS}
          selectedOption={settings.title_locale || "auto"}
          onChange={(e) => update("title_locale", e.data)}
        />
        <Field
          label="游戏名语言"
          description="自动 = 跟随 Steam 界面语言；没有对应译名的游戏仍显示英文原名"
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="后台读取安装体积"
          description="逐个读取 Epic 清单来估算体积（每个游戏约几秒、几 MB 流量，结果缓存 30 天）"
          checked={settings.auto_fetch_size !== false}
          onChange={(v) => update("auto_fetch_size", v)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="自动下载封面图"
          description="把 Epic 的竖版封面/横幅写进 Steam 的 grid 目录，非 Steam 条目才不会只有灰底"
          checked={settings.auto_cover !== false}
          onChange={(v) => update("auto_cover", v)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={fixingArt}
          onClick={async () => {
            if (fixingArt) return;
            setFixingArt(true);
            try {
              const r = await refreshArtwork("");
              if (!r.ok) {
                toaster.toast({ title: "封面下载失败", body: r.error ?? "" });
                return;
              }
              toaster.toast({
                title: r.updated ? "封面已补齐" : "封面已是最新",
                body:
                  (r.updated ? `更新 ${r.updated}/${r.total ?? 0} 个。` : "") +
                  (r.note ?? ""),
              });
            } catch (e) {
              toaster.toast({ title: "封面下载失败", body: String(e) });
            } finally {
              setFixingArt(false);
            }
          }}
        >
          {fixingArt ? "正在下载封面…" : "补齐封面与图标"}
        </ButtonItem>
        <Field
          label="封面图"
          description="只补缺失的图，已存在的不重复下载；下载后重启 Steam 才会显示"
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={syncAllToSteam} disabled={syncingSteam}>
          {syncingSteam ? "正在写入…" : "把已安装的游戏全部加入 Steam"}
        </ButtonItem>
        <Field
          label="加入 Steam"
          description="写入 Steam 的非 Steam 快捷方式；重启 Steam 后出现在「库 → 非 Steam 游戏」"
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={async () => {
            const r = await refreshSteam();
            if (r.ok) toaster.toast({ title: "刷新", body: r.note ?? "" });
            else toaster.toast({ title: "刷新失败", body: r.error ?? "" });
          }}
        >
          重启 Steam 刷新游戏库
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={async () => {
            const r = await exportLogs();
            if (!r.ok) {
              toaster.toast({ title: "导出失败", body: r.error ?? "" });
              return;
            }
            const logs = r.logs ?? "";
            const path = r.path ?? "";
            showModal(
              <ConfirmModal
                strTitle="诊断日志"
                strDescription={
                  <div>
                    <div style={{ fontSize: "0.85em", opacity: 0.7, marginBottom: "8px" }}>
                      日志已导出到:{path || "（写入失败）"}
                    </div>
                    <div
                      style={{
                        fontFamily: "monospace",
                        fontSize: "0.8em",
                        maxHeight: "50vh",
                        overflowY: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                        background: "var(--decky-secondary-color, rgba(0,0,0,0.3))",
                        padding: "8px",
                        borderRadius: "4px",
                      }}
                    >
                      {logs}
                    </div>
                  </div>
                }
                strOKButtonText="关闭"
              />
            );
          }}
        >
          导出诊断日志
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

function Content() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  // Paint the last known library before the first IPC round-trip finishes.
  // `useState(readLibraryCache())` runs once per mount; the QAM remounts the
  // panel on every open, so this is what makes opening feel instant.
  const [games, setGames] = useState<Game[]>(() => readLibraryCache()?.games ?? []);
  const [gameError, setGameError] = useState<LibraryFailure | null>(null);
  const [env, setEnv] = useState<{ legendary_installed: boolean }>({ legendary_installed: true });
  const [loading, setLoading] = useState<boolean>(() => !readLibraryCache());
  const [refreshing, setRefreshing] = useState<boolean>(false);
  // Detail page state: opening a game replaces the library view.
  const [selected, setSelected] = useState<Game | null>(null);
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({});
  const [dirs, setDirs] = useState<InstallDirOption[]>([]);
  const [defaultDir, setDefaultDir] = useState<string>("");
  // null while the first-run prompt is still being decided, so neither the
  // login screen nor the library flashes before the prompt appears.
  const [firstRunDone, setFirstRunDone] = useState<boolean | null>(null);
  // Titles and sizes arrive after the list is already on screen.
  const [sizePending, setSizePending] = useState<number>(
    () => readLibraryCache()?.size_pending ?? 0
  );
  const [locale, setLocale] = useState<string>(() => readLibraryCache()?.locale ?? "");
  // Cache is keyed by account so switching users never shows the old library.
  const accountRef = useRef<string>("");
  useEffect(() => {
    accountRef.current = auth?.account_id || "";
  }, [auth?.account_id]);

  // Install progress is owned here so both the list and the detail page see it.
  useEffect(() => {
    const listener = addEventListener<[string, string, number, string, string, string]>(
      "install_progress",
      (appName, state, percent, message, speed, eta) => {
        setProgress((prev) => ({
          ...prev,
          [appName]: { state, percent, message, speed, eta } as InstallProgress,
        }));
      }
    );
    return () => removeEventListener("install_progress", listener);
  }, []);

  // The backend patches titles/sizes in as it discovers them (localised title
  // first, then one manifest per game), so the list never blocks on 138
  // network round-trips. Playtime arrives through the same channel.
  useEffect(() => {
    type Patch = {
      title?: string;
      playtime_seconds?: number;
      download?: number;
      disk?: number;
    };
    const listener = addEventListener<[Record<string, Patch>, number]>(
      "library_patch",
      (patch, remaining) => {
        if (patch && Object.keys(patch).length > 0) {
          setGames((prev) =>
            prev.map((g) => {
              const p = patch[g.app_name];
              if (!p) return g;
              return {
                ...g,
                title: p.title ?? g.title,
                localized_title: p.title ? true : g.localized_title,
                playtime_seconds: p.playtime_seconds ?? g.playtime_seconds,
                download_size: p.download ?? g.download_size,
                disk_size: p.disk ?? g.disk_size,
                install_size: p.download ?? g.install_size,
              };
            })
          );
        }
        // A negative count means "this patch is not about sizes" (playtime).
        if (typeof remaining === "number" && remaining >= 0) setSizePending(remaining);
      }
    );
    return () => removeEventListener("library_patch", listener);
  }, []);

  // The backend refreshes a stale snapshot in the background and pushes the
  // whole list when it lands, which is what lets the panel open instantly and
  // fill itself in silently.
  useEffect(() => {
    const onFull = addEventListener<[any]>("library_full", (payload) => {
      if (!payload || !payload.ok) return;
      setGames(payload.games ?? []);
      setSizePending(payload.size_pending ?? 0);
      setLocale(payload.locale ?? "");
      setGameError(null);
      setLoading(false);
      writeLibraryCache(accountRef.current, payload);
    });
    const onError = addEventListener<[string, string]>("library_error", (message, kind) => {
      setGameError({
        message: message || "读取游戏库失败",
        kind: (kind as LibraryFailure["kind"]) || "unknown",
      });
    });
    return () => {
      removeEventListener("library_full", onFull);
      removeEventListener("library_error", onError);
    };
  }, []);

  // Single place that turns a backend payload into component state, so the
  // cached, refreshed and event-driven paths can never drift apart.
  const applyLibrary = (r: {
    games?: Game[];
    locale?: string;
    size_pending?: number;
    stale?: boolean;
    warning?: string;
    error?: string;
    error_kind?: string;
  }) => {
    setGames(r.games ?? []);
    setSizePending(r.size_pending ?? 0);
    setLocale(r.locale ?? "");
    setGameError(
      r.error_kind
        ? {
            message: r.warning || r.error || "读取游戏库失败",
            kind: (r.error_kind as LibraryFailure["kind"]) || "unknown",
          }
        : null
    );
    writeLibraryCache(accountRef.current, r);
  };

  const reloadGames = async () => {
    const r = await listGames();
    if (r.ok) applyLibrary(r);
  };

  // `force` skips the backend snapshot — used by the retry button, where the
  // user explicitly wants a fresh network call.
  const refresh = async (force = false) => {
    // Only block the UI when there is nothing cached to show.
    if (readLibraryCache() === null) setLoading(true);
    setRefreshing(true);
    const a = await authStatus();
    setAuth(a);
    // Ref writes are synchronous: the cache key must be correct before
    // applyLibrary() writes to it, not one render later.
    accountRef.current = a.account_id || "";
    setGameError(null);
    if (a.logged_in) {
      const r = await listGames(force);
      if (r.ok) {
        applyLibrary(r);
      } else {
        const cached = readLibraryCache(a.account_id);
        if (cached) {
          // Keep the cached list visible with a banner instead of wiping it.
          setGames(cached.games);
          setGameError({
            message: r.error ?? "读取游戏库失败",
            kind: (r.error_kind as LibraryFailure["kind"]) || "unknown",
          });
        } else {
          setGames([]);
          setGameError({
            message: r.error ?? "未知错误",
            kind: (r.error_kind as LibraryFailure["kind"]) || "unknown",
          });
        }
      }
    } else {
      setGames([]);
      clearLibraryCache();
    }
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Run environment check and auth status in parallel, each with its own
      // timeout, so a slow/blocked backend callable can never leave the UI
      // stuck on "loading" forever.
      const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
        Promise.race([
          p,
          new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
        ]);

      const [envResult, authResult, boot] = await Promise.all([
        withTimeout(checkEnvironment(), 8000, { legendary_installed: true, legendary_path: "" }),
        withTimeout(authStatus(), 15000, { logged_in: false, account_id: "", display_name: "" }),
        // The first-run prompt needs the install-location options up front, so
        // they load together with the rest instead of after the UI is shown.
        withTimeout(
          (async () => {
            const [d, s] = await Promise.all([getInstallDirOptions(), getSettings()]);
            return { dirs: d.options ?? [], current: d.current ?? "", settings: s };
          })(),
          8000,
          { dirs: [] as InstallDirOption[], current: "", settings: {} as Record<string, any> }
        ),
      ]);

      if (cancelled) return;
      setEnv(envResult);
      setAuth(authResult);
      setDirs(boot.dirs);
      setDefaultDir(boot.settings.install_dir || boot.current || "");
      // A backend that timed out reports {} — do not trap the user in the
      // prompt just because the settings call was slow.
      setFirstRunDone(boot.settings.first_run_done !== false);
      accountRef.current = authResult.account_id || "";
      setGameError(null);

      if (authResult.logged_in) {
        // Drop a snapshot that belongs to a different Epic account.
        const cached = readLibraryCache(authResult.account_id);
        if (!cached && readLibraryCache()) {
          clearLibraryCache();
          setGames([]);
          setSizePending(0);
          setLocale("");
          setLoading(true);
        }

        // The snapshot path returns in milliseconds; the first run (no cache)
        // still gets a generous ceiling so a dead network cannot hang the UI.
        const r = await withTimeout(listGames(), 20000, {
          ok: false,
          games: [],
          size_pending: 0,
          locale: "",
          error: "读取游戏库超时：Epic 服务器没有响应",
          error_kind: "network",
        });
        if (cancelled) return;
        if (r.ok) {
          applyLibrary(r);
        } else if (cached) {
          // Keep the cached rows; the banner explains the failed refresh.
          setGames(cached.games);
          setGameError({
            message: r.error ?? "读取游戏库失败",
            kind: (r.error_kind as LibraryFailure["kind"]) || "unknown",
          });
        } else {
          setGames([]);
          setGameError({
            message: r.error ?? "未知错误",
            kind: (r.error_kind as LibraryFailure["kind"]) || "unknown",
          });
        }
      } else {
        setGames([]);
        clearLibraryCache();
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      reloadGames();
    };
    window.addEventListener("epicdeck:library-changed", handler);
    return () => window.removeEventListener("epicdeck:library-changed", handler);
  }, []);

  // Re-read the disk list — the first-run prompt offers this because an SD
  // card inserted after the plugin opened would otherwise be invisible.
  const reloadDirs = async () => {
    try {
      const d = await getInstallDirOptions();
      setDirs(d.options ?? []);
      if (d.current) setDefaultDir(d.current);
    } catch (e) {
      console.log("EpicDeck: install dir options unavailable", e);
    }
  };

  const doLogout = async () => {
    const r = await logout();
    if (r.ok) {
      setAuth(null);
      setGames([]);
      setGameError(null);
      clearLibraryCache();
    } else {
      toaster.toast({ title: "登出失败", body: r.error ?? "" });
    }
  };

  if (loading) {
    return <PanelSection><PanelSectionRow><div style={{ padding: "16px 0" }}>加载中…</div></PanelSectionRow></PanelSection>;
  }

  if (!env.legendary_installed) {
    return <MissingDependency onInstalled={refresh} />;
  }

  // Before the login screen: a first-run user picks where games go. Asking now
  // avoids the "disk full halfway through a 60 GB download" surprise.
  if (firstRunDone === false) {
    return (
      <FirstRunView
        dirs={dirs}
        onReloadDirs={reloadDirs}
        onDone={(path) => {
          if (path) setDefaultDir(path);
          setFirstRunDone(true);
        }}
      />
    );
  }

  if (!auth?.logged_in) {
    return <LoginView onLoggedIn={() => refresh()} />;
  }

  if (selected) {
    const fresh = games.find((g) => g.app_name === selected.app_name) ?? selected;
    return (
      <GameDetail
        game={fresh}
        progress={progress[selected.app_name]}
        dirs={dirs}
        defaultDir={defaultDir}
        onBack={() => {
          setSelected(null);
          reloadGames();
        }}
        onChanged={reloadGames}
      />
    );
  }

  return (
    <>
      <PanelSection title="账号">
        <PanelSectionRow>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0" }}>
            <span>{auth.display_name || auth.account_id}</span>
            <DialogButton onClick={doLogout}>登出</DialogButton>
          </div>
        </PanelSectionRow>
      </PanelSection>
      <LibraryView
        games={games}
        error={gameError}
        progress={progress}
        sizePending={sizePending}
        locale={locale}
        onOpen={(g) => setSelected(g)}
        onRetry={() => refresh(true)}
        retrying={refreshing}
      />
      <SettingsView />
    </>
  );
}

export default definePlugin(() => {
  console.log("EpicDeck frontend initializing");

  return {
    name: "EpicDeck",
    titleView: <div className={staticClasses.Title}>EpicDeck · Epic 游戏下载</div>,
    content: <Content />,
    icon: <FaGamepad />,
    onDismount() {},
  };
});
