// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

/**
 * Build-time version string.
 *
 * The literal is replaced with `package.json`'s version by a rollup plugin
 * (see `rollup.config.js`), so the settings footer can never drift from the
 * package version again. Any module under `src/` may import this.
 */
export const PLUGIN_VERSION = "__EPICDECK_VERSION__";
