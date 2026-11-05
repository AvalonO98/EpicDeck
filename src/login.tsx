// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Epic login. The browser does the work: the backend opens Epic's page, reads
// the authorization code off the result page and redeems it, so all this screen
// has to do is start the attempt and poll for the outcome. The QR / manual code
// paths stay as a fallback for when the Steam browser misbehaves.

import { PanelSection, PanelSectionRow, ButtonItem, TextField, ConfirmModal, showModal } from "@decky/ui";
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
  startPhoneLogin,
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
  const [showManual, setShowManual] = useState<boolean>(false);
  const [loginUrl, setLoginUrl] = useState<string>(EPIC_LOGIN_URL);
  const [phoneUrl, setPhoneUrl] = useState<string>("");
  const [phoneMode, setPhoneMode] = useState<boolean>(false);
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

  // Entering the QR screen kicks off the LAN server and shows a QR of its URL.
  useEffect(() => {
    if (!showCode) return;
    void startPhone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          // Phone login wants an explicit "signed in" toast (there is no
          // browser to close and the user is looking at the Deck the whole
          // time). Browser login does NOT toast here: this poll only resumes
          // *after* the browser is already closed (the panel unmounts while
          // it is open), so a "press B to close the browser" toast would fire
          // late and be nonsense — the confirm dialog already told them to
          // press B up front. Just flip to the library.
          if (phoneMode) {
            toaster.toast({ title: t("登录成功"), body: r.display_name || "" });
          }
          onLoggedIn();
        } else if (r.state === "finishing") {
          // The code was captured and the token exchange is running; surface it
          // so the panel does not look stuck for those few seconds.
          setSession((prev) =>
            prev
              ? { ...prev, message: r.message || t("已读取授权码，正在登录…") }
              : prev,
          );
        } else if (r.state === "error" || r.state === "timeout") {
          stopped = true;
          setSession({ state: r.state, message: r.message, display_name: "" });
          toaster.toast({
            title: r.state === "timeout" ? t("登录超时") : t("登录失败"),
            body: r.message || "",
          });
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

  // Show a heads-up *before* the browser opens. Once Steam's browser is up it
  // covers everything — including any toast — so the only reliable time to tell
  // the user what to expect is right now. This doubles as a "second confirm".
  const confirmBrowserLogin = () => {
    showModal(
      <ConfirmModal
        strTitle={t("在 Steam 浏览器中登录")}
        strDescription={
          <div style={{ lineHeight: 1.6, fontSize: "0.9em" }}>
            <div style={{ marginBottom: "10px" }}>
              {t('会弹出 Steam 浏览器打开 Epic 登录页，登录你的账号。')}
            </div>
            <div style={{ marginBottom: "10px" }}>
              {t('登录成功后页面会显示一段 JSON，形如：')}
            </div>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: "0.78em",
                background: "rgba(0,0,0,0.35)",
                padding: "10px",
                borderRadius: "6px",
                wordBreak: "break-all",
                marginBottom: "10px",
                opacity: 0.85,
              }}
            >
              {'{"authorizationCode": "a1b2c3d4..."}'}
            </div>
            <div>
              {t('看到这段 JSON 就说明登录成功了，插件会自己把授权码取走。')}
            </div>
            <div style={{ marginTop: "8px" }}>
              {t('请稍等约 15 秒，确保授权码被完整读取。')}
            </div>
            <div style={{ marginTop: "8px" }}>
              {t('第一次登录可能因网络较慢，若长时间没出现代码，可关闭浏览器重新登录。')}
            </div>
            <div style={{ marginTop: "8px", fontWeight: 600, color: "#9ecbff" }}>
              {t('然后再按 B 键关掉浏览器，回到插件即可。')}
            </div>
          </div>
        }
        strOKButtonText={t("开始登录")}
        strCancelButtonText={t("取消")}
        onOK={() => {
          void startLogin();
        }}
      />,
    );
  };

  const startLogin = async () => {
    setBusy("open");
    setMsg("");
    setSession(null);
    // Persist "waiting" *before* the browser opens. `beginLogin()` hands the URL
    // to Steam's browser on the backend, which takes over the screen and
    // unmounts this panel — if we only set the state after `await beginLogin()`
    // returns, the panel is already gone and the session never lands in
    // `window.__epicdeckLoginUI`, so closing the browser re-mounts a panel that
    // thinks nothing is running (the user has to press "sign in" again).
    const waiting = { state: "waiting", message: "", display_name: "" };
    setSession(waiting);
    storeLoginSession(waiting);
    try {
      const r = await beginLogin();
      if (!r.ok) {
        setSession(null);
        storeLoginSession(null);
        setMsg(r.error ?? t("无法开始登录"));
        return;
      }
      if (r.already_logged_in) {
        setSession(null);
        storeLoginSession(null);
        toaster.toast({ title: t("已经登录"), body: t("不需要重复登录") });
        onLoggedIn();
        return;
      }
      setLoginUrl(r.url || EPIC_LOGIN_URL);
      setSession({ state: "waiting", message: r.message ?? "", display_name: "" });
      // Steam's browser covers this panel, so a toast is the only thing the
      // user can still see while signing in. Tell them the plugin is working
      // instead of leaving them staring at a browser window.
      toaster.toast({
        title: t("脚本登录中"),
        body: t("在打开的窗口里登录 Epic，完成后会自动继续"),
      });
    } catch (e) {
      setSession(null);
      storeLoginSession(null);
      setMsg(t("启动登录失败:") + String(e));
    } finally {
      setBusy("");
    }
  };

  // Phone-assisted login: the Deck serves a page on its LAN IP, the phone opens
  // it via QR, signs in to Epic and pastes the code there — no cross-device copy.
  const startPhone = async () => {
    setBusy("phone");
    setMsg("");
    setSession(null);
    try {
      const r = await startPhoneLogin();
      if (!r.ok) {
        setMsg(r.error ?? t("无法开始手机登录"));
        return;
      }
      if (r.already_logged_in) {
        toaster.toast({ title: t("已经登录"), body: t("不需要重复登录") });
        onLoggedIn();
        return;
      }
      setPhoneUrl(r.url || "");
      setPhoneMode(true);
      setSession({ state: "waiting", message: "", display_name: "" });
    } catch (e) {
      setMsg(t("启动手机登录失败:") + String(e));
    } finally {
      setBusy("");
    }
  };

  const stopLogin = async () => {
    setSession(null);
    setPhoneMode(false);
    setPhoneUrl("");
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
            {t('用手机扫下面的码，登录 Epic 并在那个页面里粘贴授权码，全程不用在 Deck 上输入。')}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ padding: "0 0 6px", fontSize: "0.82em", lineHeight: 1.5, opacity: 0.65 }}>
            {t('手机和 Steam Deck 需要连同一个 WiFi（局域网），否则扫码会连不上。')}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          {phoneUrl ? (
            <QrImage url={phoneUrl} />
          ) : (
            <div style={{ padding: "16px 0", textAlign: "center", opacity: 0.7 }}>
              {msg || t('正在准备二维码…')}
            </div>
          )}
        </PanelSectionRow>
        {phoneUrl ? (
          <PanelSectionRow>
            <div
              style={{
                fontSize: "0.78em",
                opacity: 0.75,
                wordBreak: "break-all",
                textAlign: "center",
              }}
            >
              {phoneUrl}
            </div>
          </PanelSectionRow>
        ) : null}
        {phoneMode && session && session.state === "waiting" ? (
          <PanelSectionRow>
            <div style={{ padding: "6px 0", fontSize: "0.88em", lineHeight: 1.5, color: "#9ecbff" }}>
              {session.message || t("等待手机完成登录…（这个页面别关）")}
            </div>
          </PanelSectionRow>
        ) : null}
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
              setShowManual(true);
              setMsg("");
            }}
            disabled={!!busy}
          >
            {t('二维码用不了？改用手动粘贴授权码')}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() => {
              setShowCode(false);
              setMsg("");
            }}
            disabled={!!busy}
          >
            {t('返回')}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  } else if (showManual) {
    body = (
      <PanelSection title={t("手动粘贴授权码")}>
        <PanelSectionRow>
          <div style={{ padding: "4px 0 2px", lineHeight: 1.5 }}>
            {t('1. 用手机或电脑打开下面的链接,登录你的 Epic 账号')}
          </div>
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
              setShowManual(false);
              setShowCode(true);
              setMsg("");
              setCode("");
            }}
            disabled={!!busy}
          >
            {t('返回扫码')}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  } else if (session && session.state === "waiting") {
    // The browser is open on top of the UI and the plugin is reading the code
    // off the result page, so this screen only has to wait.
    body = (
      <PanelSection title={t("脚本登录中")}>
        <PanelSectionRow>
          <div style={{ padding: "8px 0 4px", fontSize: "1.05em", fontWeight: 600, lineHeight: 1.5 }}>
            {t('在打开的窗口里登录 Epic，插件会自己取授权码')}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ padding: "0 0 4px", fontSize: "0.82em", lineHeight: 1.5, opacity: 0.7 }}>
            {t('登录成功后浏览器会停在 JSON 页面，按')} <b>B</b> {t('关掉即可。')}
          </div>
        </PanelSectionRow>
        {session.message ? (
          <PanelSectionRow>
            <div style={{ padding: "4px 0", fontSize: "0.88em", lineHeight: 1.5, color: "#9ecbff" }}>
              {session.message}
            </div>
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <div style={{ padding: "2px 0 6px", fontSize: "0.78em", lineHeight: 1.55, opacity: 0.55 }}>
            {t('没反应？可重新打开登录页，或改用手机扫码 / 手动粘贴授权码。')}
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
              setShowManual(true);
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
          <ButtonItem layout="below" onClick={confirmBrowserLogin} disabled={!!busy}>
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
            {t('用手机扫码登录')}
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
