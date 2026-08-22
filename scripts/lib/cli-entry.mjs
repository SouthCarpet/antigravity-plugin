/**
 * Direct-execution guard for command modules.
 *
 * Every scripts/commands/<verb>.mjs exports `run(argv, ctx)` and is loaded
 * two different ways:
 *   1. bin/antigravity.mjs dynamically `import()`s it and calls `run()`
 *      itself — that path already worked.
 *   2. commands/<verb>.md (Claude Code and agy TUI wrappers) locate this
 *      plugin with a `node -e` snippet, then spawn
 *      `node ".../scripts/commands/<verb>.mjs"` with the user's arguments.
 *      Claude Code still supplies CLAUDE_PLUGIN_ROOT; agy does not, so the
 *      snippet falls back to the agy install copy.
 * Before this guard, path 2 only ever imported the module — `run` was
 * exported but never called — so `node vision.mjs foo.png` exited 0 with
 * zero output. A success-shaped silent failure. `runIfMain` makes a module
 * call its own `run()` when Node loaded it as the process entrypoint, while
 * staying a no-op when another module (bin/antigravity.mjs, a test) merely
 * imports it.
 */

import { fileURLToPath } from "node:url";

import { canonicalComparePath } from "./paths.mjs";

/**
 * True when `importMetaUrl` is the URL of the module Node was invoked with
 * (`node <file>`), i.e. `process.argv[1]`.
 *
 * Both sides go through fileURLToPath + canonicalComparePath so that
 * slashes, drive-letter case, and 8.3 short names don't cause a false
 * negative. Junctions are not followed: an entrypoint reached through a
 * reparse point is a different lexical path, matching the previous
 * path.resolve behaviour.
 *
 * @param {string} importMetaUrl
 * @returns {boolean}
 */
function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;

  try {
    return canonicalComparePath(fileURLToPath(importMetaUrl)) === canonicalComparePath(entry);
  } catch {
    return false;
  }
}

/**
 * Call `run(process.argv.slice(2), { host, cwd: process.cwd() })` when this
 * module is the process entrypoint, then exit with its return code. No-op
 * (resolves to `false`) when the module was merely imported.
 *
 * @param {string} importMetaUrl - the caller's `import.meta.url`
 * @param {(argv: string[], ctx: object) => Promise<number|void>|number|void} run
 * @param {{ host?: string }} [opts]
 * @returns {Promise<boolean>} whether this call invoked `run` (and is about
 *   to exit — only reachable past that point when `process.exit` is stubbed,
 *   as in tests)
 */
export async function runIfMain(importMetaUrl, run, { host = "claude-code" } = {}) {
  if (!isMainModule(importMetaUrl)) return false;

  try {
    const code = await run(process.argv.slice(2), { host, cwd: process.cwd() });
    process.exit(typeof code === "number" ? code : 0);
  } catch (err) {
    process.stderr.write(`antigravity-plugin: ${err?.message ?? err}\n`);
    process.exit(1);
  }
  return true;
}
