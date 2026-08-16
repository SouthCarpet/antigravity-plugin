/**
 * Direct-execution guard for command modules.
 *
 * Every scripts/commands/<verb>.mjs exports `run(argv, ctx)` and is loaded
 * two different ways:
 *   1. bin/antigravity.mjs dynamically `import()`s it and calls `run()`
 *      itself — that path already worked.
 *   2. commands/<verb>.md (the Claude Code command surfaces) invoke it
 *      DIRECTLY: `node ".../scripts/commands/<verb>.mjs" $ARGUMENTS`.
 * Before this guard, path 2 only ever imported the module — `run` was
 * exported but never called — so `node vision.mjs foo.png` exited 0 with
 * zero output. A success-shaped silent failure. `runIfMain` makes a module
 * call its own `run()` when Node loaded it as the process entrypoint, while
 * staying a no-op when another module (bin/antigravity.mjs, a test) merely
 * imports it.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/**
 * True when `importMetaUrl` is the URL of the module Node was invoked with
 * (`node <file>`), i.e. `process.argv[1]`.
 *
 * Both sides are normalized through fileURLToPath + path.resolve so that
 * forward vs backslashes and drive-letter case don't cause a false negative.
 * On win32 the comparison is case-insensitive (NTFS paths are, for this
 * purpose). Not covered: 8.3 short names and symlinked entrypoints —
 * path.resolve does not dereference those; realpath would, at the cost of a
 * filesystem call on every import.
 *
 * @param {string} importMetaUrl
 * @returns {boolean}
 */
function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;

  let modulePath;
  let entryPath;
  try {
    modulePath = resolve(fileURLToPath(importMetaUrl));
    entryPath = resolve(entry);
  } catch {
    return false;
  }

  if (process.platform === "win32") {
    return modulePath.toLowerCase() === entryPath.toLowerCase();
  }
  return modulePath === entryPath;
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
