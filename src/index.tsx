// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  ProgressBar,
  ToggleField,
  Dropdown,
  staticClasses,
  DialogButton,
  Field,
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
import { useEffect, useState } from "react";
import { FaGamepad, FaDownload, FaPlay, FaTrash, FaSteamSymbol } from "react-icons/fa";
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
const deviceCodeStart = callable<[], {
  ok: boolean;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  error?: string;
}>("device_code_start");
const deviceCodeCancel = callable<[], { ok: boolean }>("device_code_cancel");
const listGames = callable<[], { ok: boolean; games?: Game[]; error?: string }>("list_games");
const installGame = callable<[app_name: string], { ok: boolean; error?: string }>("install");
const launchGame = callable<[app_name: string], { ok: boolean; error?: string }>("launch");
const uninstallGame = callable<[app_name: string], { ok: boolean; error?: string }>("uninstall");
const addToSteam = callable<[app_name: string], { ok: boolean; appid?: number; error?: string }>("add_to_steam");
const removeFromSteam = callable<[app_name: string], { ok: boolean; error?: string }>("remove_from_steam");
const isInSteam = callable<[app_name: string], { in_steam: boolean }>("is_in_steam");
const refreshSteam = callable<[], { ok: boolean; note?: string; error?: string }>("refresh_steam");
const getSettings = callable<[], Record<string, any>>("get_settings");
const setSetting = callable<[key: string, value: any], { ok: boolean }>("set_setting");
const getInstallDirOptions = callable<[], { options: string[] }>("get_install_dir_options");
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

interface DeviceCodeInfo {
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
}

function QrLogin({ deviceInfo, deviceState, deviceMsg }: {
  deviceInfo: DeviceCodeInfo;
  deviceState: string;
  deviceMsg: string;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [qrError, setQrError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const url = deviceInfo.verification_uri_complete || deviceInfo.verification_uri;
    QRCode.toDataURL(url, {
      width: 200,
      margin: 1,
      errorCorrectionLevel: "M",
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
          setQrError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setQrError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [deviceInfo.verification_uri_complete, deviceInfo.verification_uri]);

  return (
    <div style={{ padding: "12px 0", textAlign: "center" }}>
      <div style={{ fontSize: "0.95em", marginBottom: "10px" }}>
        用手机扫描下方二维码,或手动打开网址输入验证码
      </div>

      {qrError ? (
        <div style={{ padding: "16px", opacity: 0.7 }}>
          二维码生成失败:{qrError}
        </div>
      ) : qrDataUrl ? (
        <img
          src={qrDataUrl}
          alt="登录二维码"
          style={{
            width: "200px",
            height: "200px",
            background: "#ffffff",
            borderRadius: "8px",
            margin: "0 auto",
            display: "block",
          }}
        />
      ) : (
        <div style={{ padding: "16px", opacity: 0.7 }}>生成二维码中…</div>
      )}

      <div style={{ margin: "14px 0 4px", fontSize: "0.85em", opacity: 0.75 }}>
        验证码:
      </div>
      <div style={{ fontSize: "2em", fontWeight: 700, letterSpacing: "6px" }}>
        {deviceInfo.user_code}
      </div>
      <div style={{ fontSize: "0.8em", opacity: 0.6, marginTop: "4px" }}>
        {deviceInfo.verification_uri}
      </div>

      <div style={{ fontSize: "0.85em", opacity: 0.8, marginTop: "12px" }}>
        {deviceState === "pending"
          ? "等待授权中…(手机端完成登录后自动跳转)"
          : deviceState === "error"
            ? "错误: " + deviceMsg
            : deviceMsg}
      </div>
    </div>
  );
}

function LoginView({ onLogin, onLoggedIn }: { onLogin: () => void; onLoggedIn: () => void }) {
  const [deviceInfo, setDeviceInfo] = useState<DeviceCodeInfo | null>(null);
  const [deviceState, setDeviceState] = useState<string>("");
  const [deviceMsg, setDeviceMsg] = useState<string>("");
  const [starting, setStarting] = useState<boolean>(false);

  useEffect(() => {
    const listener = addEventListener<[string, string]>(
      "device_code_status",
      (state, message) => {
        setDeviceState(state);
        setDeviceMsg(message);
        if (state === "success") {
          setDeviceInfo(null);
          onLoggedIn();
        }
      }
    );
    return () => removeEventListener("device_code_status", listener);
  }, [onLoggedIn]);

  const startDeviceCode = async () => {
    setStarting(true);
    setDeviceMsg("正在连接 Epic 服务器…");
    try {
      const r = await deviceCodeStart();
      if (!r.ok) {
        toaster.toast({ title: "登录失败", body: r.error ?? "" });
        setDeviceMsg("");
        return;
      }
      setDeviceInfo({
        user_code: r.user_code ?? "",
        verification_uri: r.verification_uri ?? "",
        verification_uri_complete: r.verification_uri_complete ?? "",
        expires_in: r.expires_in ?? 600,
      });
      setDeviceState("pending");
      setDeviceMsg("");
    } finally {
      setStarting(false);
    }
  };

  const cancelDeviceCode = async () => {
    await deviceCodeCancel();
    setDeviceInfo(null);
    setDeviceState("");
    setDeviceMsg("");
  };

  return (
    <>
      <PanelSection title="Epic Games 登录">
        <PanelSectionRow>
          <div style={{ padding: "12px 0", color: "var(--decky-text-color)" }}>
            登录后即可浏览你的 Epic 游戏库并下载游戏。
          </div>
        </PanelSectionRow>

        {!deviceInfo ? (
          <>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={startDeviceCode} disabled={starting}>
                {starting ? "正在连接 Epic…" : "扫码/验证码登录(推荐,无需浏览器)"}
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={onLogin} disabled={starting}>
                浏览器登录(需桌面模式)
              </ButtonItem>
            </PanelSectionRow>
          </>
        ) : (
          <>
            <PanelSectionRow>
              <QrLogin
                deviceInfo={deviceInfo}
                deviceState={deviceState}
                deviceMsg={deviceMsg}
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={cancelDeviceCode}>
                取消
              </ButtonItem>
            </PanelSectionRow>
          </>
        )}
      </PanelSection>
    </>
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

function GameRow({ game, progress }: { game: Game; progress?: InstallProgress }) {
  const [inSteam, setInSteam] = useState<boolean>(false);
  const [busy, setBusy] = useState<string>("");

  useEffect(() => {
    isInSteam(game.app_name).then((r) => setInSteam(r.in_steam));
  }, [game.app_name]);

  const downloading = progress && (
    progress.state === "starting" || progress.state === "downloading" ||
    progress.state === "verifying" || progress.state === "patching" ||
    progress.state === "prereq"
  );

  const stateLabel: Record<string, string> = {
    starting: "准备中",
    downloading: "下载中",
    verifying: "校验中",
    patching: "更新中",
    prereq: "安装组件中",
  };

  const doInstall = async () => {
    setBusy("install");
    const r = await installGame(game.app_name);
    setBusy("");
    if (!r.ok) toaster.toast({ title: "安装失败", body: r.error ?? "" });
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
    if (!r.ok) toaster.toast({ title: "卸载失败", body: r.error ?? "" });
  };

  const doAddSteam = async () => {
    setBusy("steam");
    const r = await addToSteam(game.app_name);
    setBusy("");
    if (r.ok) {
      setInSteam(true);
      toaster.toast({ title: "已添加到 Steam", body: "重启 Steam 后即可在库中看到" });
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
    } else {
      toaster.toast({ title: "移除失败", body: r.error ?? "" });
    }
  };

  return (
    <div style={{ padding: "8px 0", borderBottom: "1px solid var(--decky-separator-color, #333)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <CoverImage url={game.cover_url} title={game.title} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{game.title}</div>
          <div style={{ fontSize: "0.85em", opacity: 0.7 }}>
            {game.is_installed
              ? "已安装 · " + fmtSize(game.installed_size)
              : "未安装 · " + fmtSize(game.install_size)}
          </div>
        </div>
        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          {game.is_installed ? (
            <>
              <DialogButton
                onClick={doLaunch}
                disabled={busy === "launch"}
                style={{ display: "flex", alignItems: "center", gap: "4px" }}
              >
                <FaPlay /> 启动
              </DialogButton>
              <DialogButton
                onClick={doUninstall}
                disabled={busy === "uninstall"}
                style={{ display: "flex", alignItems: "center", gap: "4px" }}
              >
                <FaTrash />
              </DialogButton>
            </>
          ) : (
            <DialogButton
              onClick={doInstall}
              disabled={downloading || busy === "install"}
              style={{ display: "flex", alignItems: "center", gap: "4px" }}
            >
              <FaDownload /> {downloading ? "下载中" : "下载"}
            </DialogButton>
          )}
          {inSteam ? (
            <DialogButton
              onClick={doRemoveSteam}
              disabled={busy === "steam"}
              style={{ display: "flex", alignItems: "center", gap: "4px" }}
            >
              <FaSteamSymbol /> 已加
            </DialogButton>
          ) : (
            <DialogButton
              onClick={doAddSteam}
              disabled={!game.is_installed || busy === "steam"}
              style={{ display: "flex", alignItems: "center", gap: "4px" }}
            >
              <FaSteamSymbol /> 加Steam
            </DialogButton>
          )}
        </div>
      </div>
      {downloading && (
        <div style={{ marginTop: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
            <span style={{ fontSize: "0.85em", opacity: 0.8 }}>
              {stateLabel[progress.state] ?? "处理中"}
            </span>
            {progress.percent >= 0 && (
              <span style={{ fontSize: "0.85em", opacity: 0.8 }}>
                {progress.percent.toFixed(1)}%
              </span>
            )}
          </div>
          <ProgressBar
            focusable
            nProgress={progress.percent >= 0 ? progress.percent : 0}
            indeterminate={progress.percent < 0}
          />
          {(progress.speed || progress.eta) && (
            <div style={{ fontSize: "0.8em", opacity: 0.65, marginTop: "4px" }}>
              {progress.speed && <span>{progress.speed}</span>}
              {progress.speed && progress.eta && <span> · </span>}
              {progress.eta && <span>剩余 {progress.eta}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LibraryView({ games, error }: { games: Game[]; error?: string }) {
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({});

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

  if (error) {
    return (
      <PanelSection title="游戏库">
        <PanelSectionRow>
          <div style={{ padding: "12px 0", color: "var(--decky-error-color, #ff6b6b)" }}>
            读取游戏库失败:{error}
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
            游戏库为空。请确认你的 Epic 账号下已拥有游戏(含免费领取的游戏)。
          </div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <PanelSection title={`游戏库 (${games.length})`}>
      {games.map((g) => (
        <PanelSectionRow key={g.app_name}>
          <GameRow game={g} progress={progress[g.app_name]} />
        </PanelSectionRow>
      ))}
    </PanelSection>
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
  const [dirs, setDirs] = useState<string[]>([]);
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
          rgOptions={dirs.map((d) => ({ data: d, label: d }))}
          selectedOption={settings.install_dir || dirs[0] || ""}
          onChange={(e) => update("install_dir", e.data)}
        />
        <Field label="安装目录" description="游戏安装位置（建议选择 SD 卡）" />
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

  const refresh = async () => {
    setLoading(true);
    const a = await authStatus();
    setAuth(a);
    setGameError("");
    if (a.logged_in) {
      const r = await listGames();
      if (r.ok) {
        setGames(r.games ?? []);
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
          error: "读取游戏库超时",
        });
        if (cancelled) return;
        if (r.ok) {
          setGames(r.games ?? []);
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
      <LibraryView games={games} error={gameError} />
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
