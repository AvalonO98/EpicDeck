// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

/**
 * Promise-based confirmation dialog.
 *
 * Steam's `ConfirmModal` is callback-based; every destructive action here
 * (uninstall, cancel a download, sign out, switch account) reads better as
 * `if (!(await confirmAction(...))) return;`. Kept in one place so all four
 * dialogs share the same button labels and escape behaviour.
 */
import { ConfirmModal, showModal } from "@decky/ui";
import { t } from "../i18n";

export function confirmAction(title: string, body: string, okText: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    showModal(
      <ConfirmModal
        strTitle={title}
        strDescription={<div style={{ fontSize: "0.9em", lineHeight: 1.5 }}>{body}</div>}
        strOKButtonText={okText}
        strCancelButtonText={t("取消")}
        onOK={() => finish(true)}
        onCancel={() => finish(false)}
        onEscKeypress={() => finish(false)}
      />
    );
  });
}
