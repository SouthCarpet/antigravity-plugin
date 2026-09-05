/**
 * File-system helpers shared across the antigravity-plugin scripts.
 */

import fs from "node:fs";

/**
 * Read and parse a JSON file. Returns `null` if the file does not exist or
 * cannot be parsed.
 *
 * @param {string} filePath
 * @returns {any}
 */
export function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Heuristic check: is a buffer likely UTF-8 text (as opposed to binary)?
 * Returns `false` for buffers containing NULL bytes in the first 8 KB.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isProbablyText(buffer) {
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) {
      return false;
    }
  }
  return true;
}

/**
 * Safely read a text file. Returns an empty string on failure.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Render a repository-controlled path for prose that sits outside a fenced
 * data block (a heading label, a `skipped:` line, a summary file list; item
 * 12/13, F1). `-z` porcelain parsing (git.mjs) delivers a path verbatim,
 * including any byte a POSIX filesystem allows, so a raw CR/LF in a path
 * could forge a markdown heading or list line ahead of the intended content.
 * Folding both to a visible two-character escape keeps the path on one
 * output line — the label still identifies the file — and a raw backtick is
 * neutralized so it cannot help close a fence early.
 *
 * @param {string} value
 * @returns {string}
 */
export function sanitizeDisplayPath(value) {
  const text = String(value ?? "");
  return text.replace(/\r\n|\r|\n/g, "\\n").replace(/`/g, "'");
}

/**
 * Thrown by `assertPrivateDir` — distinguishable from an ordinary I/O error
 * so a caller with a best-effort catch-all (e.g. an update-cache write) can
 * still let a trust violation propagate instead of swallowing it.
 */
export class UnsafeStateDirError extends Error {}

/**
 * Refuse a state/lock/cache directory that another local user could have
 * pre-created or replaced with a symlink.
 *
 * No-op on win32: `%TEMP%` is per-user there, and Windows has no POSIX
 * uid/mode model to check. On POSIX, `lstat` (not `stat`, so a symlinked
 * root is caught instead of followed) and refuse when the entry is a
 * symlink, owned by a different uid, or group/other-writable.
 *
 * @param {string} dir
 */
export function assertPrivateDir(dir) {
  if (process.platform === "win32") return;
  const st = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (st.isSymbolicLink() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0) {
    throw new UnsafeStateDirError(
      `${dir} is not a private directory owned by this user; set CLAUDE_PLUGIN_DATA, ` +
      "CODEX_PLUGIN_DATA or AGY_PLUGIN_DATA, or fix its owner and mode",
    );
  }
}
