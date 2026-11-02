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
import { useEffect, useMemo, useState } from "react";
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
}

interface InstallProgress {
  state: "starting" | "downloading" | "verifying" | "patching" | "prereq" | "done" | "error" | "cancelled";
  percent: number;
  message: string;
  speed: string;
  eta: string;
}

const authStatus = callable<[], AuthStatus>("auth_status");
const login = callable<[], { ok: boolean; error?: string }>("login");
const logout = callable<[], { ok: boolean; error?: string }>("logout");
const getLoginUrl = callable<[], { ok: boolean; url: string }>("get_login_url");
const loginWithCode = callable<[raw: string], {
  ok: boolean;
  display_name?: string;
  account_id?: string;
  error?: string;
}>("login_with_code");
const listGames = callable<
  [],
  { ok: boolean; games?: Game[]; locale?: string; size_pending?: number; error?: string }
>("list_games");
const getGameSize = callable<[app_name: string], { ok: boolean; download?: number; disk?: number; error?: string }>(
  "get_game_size"
);
const installGame = callable<[app_name: string, install_dir: string], { ok: boolean; error?: string }>("install");
const launchGame = callable<[app_name: string], { ok: boolean; error?: string }>("launch");
const uninstallGame = callable<[app_name: string], { ok: boolean; error?: string }>("uninstall");
const addToSteam = callable<[app_name: string], { ok: boolean; appid?: number; error?: string }>("add_to_steam");
const removeFromSteam = callable<[app_name: string], { ok: boolean; error?: string }>("remove_from_steam");
const isInSteam = callable<[app_name: string], { in_steam: boolean }>("is_in_steam");
const refreshSteam = callable<[], { ok: boolean; note?: string; error?: string }>("refresh_steam");
const getSettings = callable<[], Record<string, any>>("get_settings");
const setSetting = callable<[key: string, value: any], { ok: boolean }>("set_setting");
const getInstallDirOptions = callable<[], { options: InstallDirOption[]; current: string }>("get_install_dir_options");
const checkEnvironment = callable<[], { legendary_installed: boolean; legendary_path: string }>("check_environment");
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

function LoginView({ onLogin, onLoggedIn }: { onLogin: () => void; onLoggedIn: () => void }) {
  const [showCode, setShowCode] = useState<boolean>(false);
  const [loginUrl, setLoginUrl] = useState<string>(EPIC_LOGIN_URL);
  const [code, setCode] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [browserBusy, setBrowserBusy] = useState<boolean>(false);

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
    setBusy(true);
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
      setBusy(false);
    }
  };

  const doBrowserLogin = async () => {
    setBrowserBusy(true);
    try {
      onLogin();
    } finally {
      setBrowserBusy(false);
    }
  };

  if (showCode) {
    return (
      <PanelSection title="授权码登录">
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
            disabled={busy}
            bShowClearAction
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={submitCode} disabled={busy}>
            {busy ? "正在登录…" : "完成登录"}
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
            disabled={busy}
          >
            返回
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <PanelSection title="Epic Games 登录">
      <PanelSectionRow>
        <div style={{ padding: "12px 0" }}>
          登录后即可浏览你的 Epic 游戏库并下载游戏。
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setShowCode(true)}>
          手机/电脑授权码登录(推荐)
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={doBrowserLogin} disabled={browserBusy}>
          浏览器登录(需桌面模式)
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
  const [target, setTarget] = useState(
    defaultDir || (dirs.length ? dirs[0].path : "")
  );

  useEffect(() => {
    isInSteam(game.app_name).then((r) => setInSteam(r.in_steam));
  }, [game.app_name]);

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

function LibraryView({
  games,
  error,
  progress,
  sizePending,
  locale,
  onOpen,
}: {
  games: Game[];
  error?: string;
  progress: Record<string, InstallProgress>;
  sizePending: number;
  locale: string;
  onOpen: (game: Game) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("alpha");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? games.filter(
          (g) =>
            (g.title || "").toLowerCase().includes(q) ||
            g.app_name.toLowerCase().includes(q)
        )
      : games.slice();

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
  }, [games, query, sort]);

  if (error) {
    return (
      <PanelSection title="游戏库">
        <PanelSectionRow>
          <div style={{ padding: "12px 0", color: "var(--decky-error-color, #ff6b6b)" }}>
            读取游戏库失败：{error}
          </div>
        </PanelSectionRow>
      </PanelSection>
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
    <>
      <FocusStyles />
      <PanelSection>
        <PanelSectionRow>
          <TextField
            label="搜索游戏"
            value={query}
            onChange={(e: any) => setQuery(e.target.value)}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <Dropdown
            rgOptions={SORT_OPTIONS}
            selectedOption={sort}
            onChange={(e) => setSort(e.data as SortMode)}
          />
          <Field
            label="排序方式"
            description={
              (query.trim()
                ? "找到 " + visible.length + " / " + games.length + " 个游戏"
                : "共 " + games.length + " 个游戏") +
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
              <FaSearch /> 没有匹配「{query}」的游戏
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
    </>
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

function SettingsView() {
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [dirs, setDirs] = useState<InstallDirOption[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      setSettings(await getSettings());
      setDirs((await getInstallDirOptions()).options);
      setLoaded(true);
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
        <Dropdown
          rgOptions={dirs.map((d) => ({ data: d.path, label: d.label }))}
          selectedOption={settings.install_dir || (dirs.length ? dirs[0].path : "")}
          onChange={(e) => update("install_dir", e.data)}
        />
        <Field label="默认安装目录" description="新建下载默认使用此位置（单个游戏可在详情页覆盖）" />
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
  const [games, setGames] = useState<Game[]>([]);
  const [gameError, setGameError] = useState<string>("");
  const [env, setEnv] = useState<{ legendary_installed: boolean }>({ legendary_installed: true });
  const [loading, setLoading] = useState(true);
  // Detail page state: opening a game replaces the library view.
  const [selected, setSelected] = useState<Game | null>(null);
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({});
  const [dirs, setDirs] = useState<InstallDirOption[]>([]);
  const [defaultDir, setDefaultDir] = useState<string>("");
  // Titles and sizes arrive after the list is already on screen.
  const [sizePending, setSizePending] = useState(0);
  const [locale, setLocale] = useState("");

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
  // network round-trips.
  useEffect(() => {
    type Patch = { title?: string; download?: number; disk?: number };
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
                download_size: p.download ?? g.download_size,
                disk_size: p.disk ?? g.disk_size,
                install_size: p.download ?? g.install_size,
              };
            })
          );
        }
        setSizePending(typeof remaining === "number" ? remaining : 0);
      }
    );
    return () => removeEventListener("library_patch", listener);
  }, []);

  const reloadGames = async () => {
    const r = await listGames();
    if (r.ok) {
      setGames(r.games ?? []);
      setSizePending(r.size_pending ?? 0);
      setLocale(r.locale ?? "");
    }
  };

  const refresh = async () => {
    setLoading(true);
    const a = await authStatus();
    setAuth(a);
    setGameError("");
    if (a.logged_in) {
      const r = await listGames();
      if (r.ok) {
        setGames(r.games ?? []);
        setSizePending(r.size_pending ?? 0);
        setLocale(r.locale ?? "");
      } else {
        setGames([]);
        setGameError(r.error ?? "未知错误");
      }
    } else {
      setGames([]);
    }
    setLoading(false);
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

      const [envResult, authResult] = await Promise.all([
        withTimeout(checkEnvironment(), 8000, { legendary_installed: true, legendary_path: "" }),
        withTimeout(authStatus(), 15000, { logged_in: false, account_id: "", display_name: "" }),
      ]);

      if (cancelled) return;
      setEnv(envResult);
      setAuth(authResult);
      setGameError("");

      if (authResult.logged_in) {
        const r = await withTimeout(listGames(), 20000, {
          ok: false,
          games: [],
          size_pending: 0,
          locale: "",
          error: "读取游戏库超时",
        });
        if (cancelled) return;
        if (r.ok) {
          setGames(r.games ?? []);
          setSizePending(r.size_pending ?? 0);
          setLocale(r.locale ?? "");
        } else {
          setGames([]);
          setGameError(r.error ?? "未知错误");
        }
      } else {
        setGames([]);
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

  useEffect(() => {
    (async () => {
      try {
        const [d, s] = await Promise.all([getInstallDirOptions(), getSettings()]);
        setDirs(d.options ?? []);
        setDefaultDir(s.install_dir || d.current || "");
      } catch (e) {
        console.log("EpicDeck: install dir options unavailable", e);
      }
    })();
  }, []);

  const doLogin = async () => {
    const r = await login();
    if (r.ok) {
      toaster.toast({ title: "登录中", body: "请在浏览器中完成 Epic 授权" });
      // Poll for auth completion
      const timer = setInterval(async () => {
        const a = await authStatus();
        if (a.logged_in) {
          clearInterval(timer);
          await refresh();
          toaster.toast({ title: "登录成功", body: a.display_name });
        }
      }, 3000);
      // stop polling after 5 minutes
      setTimeout(() => clearInterval(timer), 300000);
    } else {
      toaster.toast({ title: "登录失败", body: r.error ?? "" });
    }
  };

  const doLogout = async () => {
    const r = await logout();
    if (r.ok) {
      setAuth(null);
      setGames([]);
      setGameError("");
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

  if (!auth?.logged_in) {
    return <LoginView onLogin={doLogin} onLoggedIn={() => refresh()} />;
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
