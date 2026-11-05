// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Epic login. The browser does the work: the backend opens Epic's page, reads
// the authorization code off the result page and redeems it, so all this screen
// has to do is start the attempt and poll for the outcome. The QR / manual code
// paths stay as a fallback for when the Steam browser misbehaves.

import { PanelSection, PanelSectionRow, ButtonItem, TextField } from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { FaSteamSymbol } from "react-icons/fa";
import {
  EPIC_LOGIN_URL,
  beginLogin,
  cancelLogin,
  getLoginUrl,
  loginPoll,
  loginWithClipboard,
  loginWithCode,
} from "./api";
import { t } from "./i18n";

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

  if (qrError) return <div style={{ padding: "12px", opacity: 0.7 }}>{t("二维码生成失败:")}{qrError}</div>;
  if (!dataUrl) return <div style={{ padding: "12px", opacity: 0.7 }}>{t('生成二维码中…')}</div>;
  return (
    <img
      src={dataUrl}
      alt={t("登录二维码")}
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

// The panel unmounts whenever Steam's browser takes over the screen, which
// would otherwise reset this screen and make it look like nothing is happening.
// Keep the live attempt on `window` so reopening re-attaches to it.
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

export function LoginPanel({
  onLoggedIn,
  variant = "qam",
}: {
  onLoggedIn: () => void;
  variant?: "qam" | "screen";
}) {
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
      setMsg(t("请先粘贴授权码"));
      return;
    }
    setBusy("code");
    setMsg(t("正在登录…"));
    try {
      const r = await loginWithCode(raw);
      if (r.ok) {
        setMsg("");
        setCode("");
        setShowCode(false);
        toaster.toast({ title: t("登录成功"), body: r.display_name || "" });
        onLoggedIn();
      } else {
        setMsg(r.error ?? t("登录失败"));
      }
    } catch (e) {
      setMsg(t("登录出错:") + String(e));
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
          toaster.toast({ title: t("登录成功"), body: r.display_name || "" });
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
        setMsg(r.error ?? t("无法开始登录"));
        return;
      }
      if (r.already_logged_in) {
        toaster.toast({ title: t("已经登录"), body: t("不需要重复登录") });
        onLoggedIn();
        return;
      }
      setLoginUrl(r.url || EPIC_LOGIN_URL);
      setSession({ state: "waiting", message: r.message ?? "", display_name: "" });
    } catch (e) {
      setMsg(t("启动登录失败:") + String(e));
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
    setMsg(t("正在读取剪贴板…"));
    try {
      const r = await loginWithClipboard();
      if (r.ok) {
        setMsg("");
        toaster.toast({ title: t("登录成功"), body: r.display_name || "" });
        onLoggedIn();
      } else {
        setMsg(r.error ?? t("登录失败"));
      }
    } catch (e) {
      setMsg(t("读取失败:") + String(e));
    } finally {
      setBusy("");
    }
  };

  let body: ReactNode;

  if (showCode) {
    body = (
      <PanelSection title={t("手机扫码登录")}>
        <PanelSectionRow>
          <div style={{ padding: "4px 0 2px", lineHeight: 1.5 }}>
            {t('1. 用手机或电脑打开下面的链接(也可扫码),登录你的 Epic 账号')}
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
            {t('2. 登录后页面会显示一段内容,复制其中')} <b>authorizationCode</b> {t('的值(只复制那 32 位字符也可以)')}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ padding: "2px 0 6px", lineHeight: 1.5 }}>
            {t('3. 粘贴到下面,点「完成登录」。')}<b>{t('授权码只能使用一次且很快过期')}</b>{t(',请尽快粘贴。')}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label={t("授权码")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={!!busy}
            bShowClearAction
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={submitCode} disabled={!!busy}>
            {busy === "code" ? t("正在登录…") : t("完成登录")}
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
            {t('返回')}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  } else if (session && session.state === "waiting") {
    // The browser is open on top of the UI and the plugin is reading the code
    // off the result page, so this screen only has to wait.
    body = (
      <PanelSection title={t("等待登录完成")}>
        <PanelSectionRow>
          <div style={{ padding: "10px 0", lineHeight: 1.6 }}>
            {t('在弹出的 Steam 窗口里登录 Epic 账号就行，')}<b>{t('不用复制，也不用回来粘贴')}</b>。
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ padding: "2px 0 4px", fontSize: "0.85em", lineHeight: 1.55, opacity: 0.75 }}>
            {t('登录成功后浏览器会停在一个显示 JSON 的页面（')}<code>authorizationCode</code>
            {t('），那就是成功了，插件会自己把码取走并完成登录。看到这个页面后按')} <b>B</b> {t('关掉浏览器即可。')}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ padding: "2px 0", fontSize: "0.9em", opacity: 0.7 }}>
            {t('正在等待登录…（约 20 秒后开始自动读取）')}
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
            {t('一直没反应的话，可以「重新打开登录页」；也可以改用手机扫码，或自己复制那段 JSON 后点「立即读取剪贴板」。')}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={startLogin} disabled={!!busy}>
            {t('重新打开登录页')}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={loginFromClipboard} disabled={!!busy}>
            {busy === "clip" ? t("正在读取…") : t("立即读取剪贴板")}
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
            {t('改用手动粘贴授权码')}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={stopLogin}>
            {t('取消登录')}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  } else {
    const failure =
      session && (session.state === "error" || session.state === "timeout") ? session.message : "";
    body = (
      <PanelSection title={t("Epic Games 登录")}>
        <PanelSectionRow>
          <div style={{ padding: "8px 0", lineHeight: 1.5 }}>
            {t('点下面的按钮，在弹出的 Steam 窗口里登录 Epic 账号即可。登录完成后插件会自己把授权码读走，')}
            <b>{t('全程不用复制或粘贴')}</b>。
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={startLogin} disabled={!!busy}>
            <div
              style={{ display: "flex", alignItems: "center", gap: "6px", justifyContent: "center" }}
            >
              <FaSteamSymbol /> {t('在 Steam 浏览器中登录（推荐）')}
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
            {t('用手机扫码 / 手动粘贴授权码')}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (variant === "qam") return <>{body}</>;

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 24px" }}>
      <div style={{ width: "100%", maxWidth: "620px" }}>{body}</div>
    </div>
  );
}
