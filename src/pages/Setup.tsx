// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

/**
 * First-run prompt: pick where games go before anything is downloaded.
 *
 * Shown once (gated by `first_run_done`); afterwards the same choice lives in
 * Settings → 目录与语言.
 */
import { toaster } from "@decky/api";
import { Dropdown, TextField } from "@decky/ui";
import { useEffect, useState } from "react";
import { FaDownload } from "react-icons/fa";
import { completeFirstRun, resolveInstallDir } from "../api";
import { ActionButton, NavRow } from "../components";
import { t } from "../i18n";
import { reloadDirs, usePluginState } from "../store";
import { COLOR } from "../tokens";

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const { dirs } = usePluginState();
  const [choice, setChoice] = useState<string>("");
  const [custom, setCustom] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

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
        setNote(r.error ?? t("保存失败"));
        return;
      }
      toaster.toast({ title: t("下载位置已设置"), body: r.install_dir ?? path });
      onDone();
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
    try {
      const v = await resolveInstallDir(typed);
      if (!v.ok || !v.path) {
        setNote(v.error ?? t("路径无效"));
        return;
      }
      await finish(v.path);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "20px 0" }}>
      <div style={{ width: "100%", maxWidth: "640px" }}>
        <div className="ed-group" style={{ padding: "26px 28px" }}>
          <div style={{ fontSize: "1.4em", fontWeight: 800, marginBottom: "8px" }}>{t('先选个下载位置')}</div>
          <div style={{ fontSize: "0.9em", opacity: 0.65, lineHeight: 1.6, marginBottom: "18px" }}>
            {t('Epic 游戏体积很大，先确认装在哪里。之后可以在「设置 → 目录与语言」随时改，单个游戏也能单独指定。')}
          </div>
          <Dropdown
            rgOptions={dirs.map((d) => ({ data: d.path, label: d.label }))}
            selectedOption={choice}
            onChange={(e) => setChoice(e.data)}
          />
          <div style={{ marginTop: "14px" }}>
            <TextField
              value={custom}
              onChange={(e: any) => setCustom(e.target.value)}
              label={t("自定义路径（可选，例如 /run/media/deck/MySD/EpicGames）")}
            />
          </div>
          {note ? (
            <div style={{ color: COLOR.danger, fontSize: "0.85em", marginTop: "10px" }}>{note}</div>
          ) : null}
          <NavRow level="setup-actions" style={{ gap: "10px", marginTop: "18px" }}>
            <ActionButton
              primary
              style={{ padding: "11px 22px", fontSize: "0.95em" }}
              onClick={confirm}
              disabled={busy}
            >
              <FaDownload /> {t('使用此位置并继续')}
            </ActionButton>
            <ActionButton
              style={{ padding: "11px 18px", fontSize: "0.95em" }}
              onClick={() => finish("")}
            >
              {t('用默认位置（~/Games）')}
            </ActionButton>
            <ActionButton
              style={{ padding: "11px 18px", fontSize: "0.95em" }}
              onClick={async () => {
                await reloadDirs();
              }}
            >
              {t('刷新磁盘')}
            </ActionButton>
          </NavRow>
        </div>
      </div>
    </div>
  );
}
