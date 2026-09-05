/**
 * File-system helpers shared across the antigravity-plugin scripts.
 */

import fs from "node:fs";

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
 * @returns {void}
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
