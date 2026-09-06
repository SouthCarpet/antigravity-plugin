"use strict";

/**
 * Shipped CommonJS module the generated `node -e` wrapper snippet
 * require()s (see `scripts/lib/plugin-root.mjs#hostBootstrapSource`).
 *
 * Two hosts (agy, which has no bang executor, and Claude Code) need a
 * snippet that finds the install root without knowing it in advance. Before
 * 076-T7 that snippet's whole body — root resolution, manifest check,
 * refusal message, spawn of the verb, exit-code passthrough — was generated
 * as one long interpolated string and passed to `node -e`. This module is
 * that body as real, reviewable, testable source: the generated snippet
 * now only resolves the root the same way and calls `run(root, verb)` here.
 * Nothing here is built from interpolated text, and the root itself is read
 * from `process.env.CLAUDE_PLUGIN_ROOT` at run time, never baked into
 * generated source.
 *
 * CommonJS is intentional: the `node -e` shim require()s this file
 * synchronously, and a `.cjs` extension makes that unambiguous regardless of
 * this package's own `"type": "module"`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_MANIFEST_FILE = "plugin.json";
const PLUGIN_MANIFEST_NAME = "antigravity";

/**
 * True when `root` holds this plugin's manifest. Mirrors
 * `scripts/lib/plugin-root.mjs#isPluginRoot`; duplicated here (not
 * imported) because this module must stay loadable with a synchronous
 * `require()` from a one-line `node -e` snippet, and `plugin-root.mjs` is an
 * ES module.
 *
 * @param {string} root
 * @returns {boolean}
 */
function isPluginRoot(root) {
  try {
    const raw = fs.readFileSync(path.join(root, PLUGIN_MANIFEST_FILE), "utf8");
    return JSON.parse(raw)?.name === PLUGIN_MANIFEST_NAME;
  } catch {
    return false;
  }
}

/**
 * The one line printed when `root` is not this plugin's tree. Wording must
 * match `scripts/lib/plugin-root.mjs#invalidPluginRootMessage`;
 * `tests/host-bootstrap.test.mjs` pins the two together.
 *
 * @param {string} root
 * @param {string} verb
 * @returns {string}
 */
function invalidPluginRootMessage(root, verb) {
  return (
    `antigravity-plugin: ${root} is not an antigravity plugin tree ` +
    "(plugin.json missing or name mismatch). " +
    `Run: npx @southcarpet/antigravity-plugin ${verb}`
  );
}

/**
 * The one line printed when the verb's runtime script is missing. Wording
 * must match `scripts/lib/plugin-root.mjs#missingRuntimeMessage`.
 *
 * @param {string} scriptPath
 * @param {string} verb
 * @returns {string}
 */
function missingRuntimeMessage(scriptPath, verb) {
  return (
    `antigravity-plugin: runtime not found at ${scriptPath}. ` +
    `Run: npx @southcarpet/antigravity-plugin ${verb}`
  );
}

/**
 * Locate, validate, and run one verb's runtime script, passing its exit
 * code through. Refuses before it spawns anything when `root` is not this
 * plugin's tree, or when the verb's script is missing.
 *
 * The generated `node -e` snippet (`scripts/lib/plugin-root.mjs#hostBootstrapSource`,
 * 076-T7 fix round 1, F1/F2) already checks the manifest before it
 * `require()`s this file at all, so `root` normally arrives here
 * pre-validated. This function repeats the same check anyway — defence in
 * depth, in case this module is ever reached by a caller other than that
 * snippet — rather than trust the caller silently.
 *
 * @param {string} root plugin root (from `process.env.CLAUDE_PLUGIN_ROOT`
 *   or the agy install fallback — resolved by the calling snippet)
 * @param {string} verb
 * @param {string[]} [argv] the command's own arguments; defaults to
 *   `process.argv.slice(1)`, matching the caller snippet's own convention
 *   (the `node -e ... -- $ARGUMENTS` split leaves the user's arguments
 *   starting at index 1, not 2, because `-e` consumes no argv slot of its
 *   own)
 * @returns {number} the exit code the caller should pass to `process.exit`
 */
function run(root, verb, argv = process.argv.slice(1)) {
  if (!isPluginRoot(root)) {
    console.error(invalidPluginRootMessage(root, verb));
    return 1;
  }
  const script = path.join(root, "scripts", "commands", `${verb}.mjs`);
  if (!fs.existsSync(script)) {
    console.error(missingRuntimeMessage(script, verb));
    return 1;
  }
  const result = spawnSync(process.execPath, [script, ...argv], { stdio: "inherit" });
  if (result.error) {
    console.error(
      `antigravity-plugin: failed to start ${script}: ${result.error.message}. ` +
        `Run: npx @southcarpet/antigravity-plugin ${verb}`,
    );
    return 1;
  }
  return result.status == null ? 1 : result.status;
}

module.exports = { run, isPluginRoot, invalidPluginRootMessage, missingRuntimeMessage };
