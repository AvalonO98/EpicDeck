// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// Pulls the UI language from the backend and applies it.
//
// Kept out of i18n.ts on purpose: `api.ts` imports `tf()` from i18n for its
// duration strings, so i18n importing api would create a cycle.

import { getUILanguage } from "./api";
import { setLang } from "./i18n";

/**
 * Ask the backend which language to use (Steam's setting, or the override).
 * Failures keep the default rather than leaving the UI half-translated.
 */
export async function bootstrapLang(): Promise<void> {
  try {
    const result = await getUILanguage();
    setLang(result?.lang);
  } catch {
    /* keep the current language */
  }
}
