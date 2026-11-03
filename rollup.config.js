import { readFileSync } from "node:fs";
import deckyPlugin from "@decky/rollup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

/**
 * Replace `__EPICDECK_VERSION__` in the source with the version from package.json.
 *
 * The settings footer used to hard-code "插件 0.8.x", so every release forgot to
 * update it and the UI kept advertising an old version. Now there is exactly one
 * source of truth (package.json); CI syncs it to the tag before building, so the
 * bundle always carries the right number.
 */
const injectVersion = {
  name: "epicdeck-inject-version",
  transform(code, id) {
    // Windows gives us backslash paths, so normalise before matching.
    const file = id.replace(/\\/g, "/");
    if (!file.includes("/src/") || !code.includes("__EPICDECK_VERSION__")) return null;
    return { code: code.split("__EPICDECK_VERSION__").join(version), map: null };
  },
};

export default deckyPlugin({
  plugins: [injectVersion],
});
