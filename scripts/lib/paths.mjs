/**
 * Path identity helpers for Windows 8.3 short names and junction defence.
 *
 * `fs.realpathSync.native()` expands `RUNNER~1` to `runneradmin` and follows
 * junctions. Lexical `path.resolve` does neither. Comparing the two therefore
 * treats a legitimate short-name path as a symlink escape.
 *
 * `expandShortPath` walks components and replaces 8.3 names with the on-disk
 * long name via directory listing + inode match. It does not follow
 * symlinks or junctions, so a path that actually resolves elsewhere still
 * compares unequal to `realpathSync.native()`.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Strip a Windows extended-length prefix (`\\?\C:\…`, `\\?\UNC\…`).
 *
 * @param {string} input
 * @returns {string}
 */
export function stripExtendedPath(input) {
  const value = String(input);
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  if (value.startsWith("//?/UNC/")) return `//${value.slice(8)}`;
  if (value.startsWith("//?/")) return value.slice(4);
  return value;
}

/**
 * Expand 8.3 short-name components without following symlinks or junctions.
 *
 * @param {string} input
 * @returns {string}
 */
export function expandShortPath(input) {
  const resolved = path.resolve(stripExtendedPath(input));
  if (process.platform !== "win32") return path.normalize(resolved);

  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(/[\\/]/).filter(Boolean);
  let parent = parsed.root;
  const expanded = [];

  for (const part of parts) {
    expanded.push(longNameOf(parent, part));
    parent = path.join(parent, expanded[expanded.length - 1]);
  }

  return expanded.length === 0 ? parsed.root : path.join(parsed.root, ...expanded);
}

/**
 * Canonical form for equality: expanded 8.3, no `\\?\` prefix, normalized,
 * case-folded on Windows. Does not follow reparse points.
 *
 * @param {string} input
 * @returns {string}
 */
export function canonicalComparePath(input) {
  const expanded = path.normalize(expandShortPath(input));
  return process.platform === "win32" ? expanded.toLowerCase() : expanded;
}

function longNameOf(parent, part) {
  // Truncated 8.3 aliases always contain `~` (RUNNER~1, APPDAT~1). Names that
  // already fit in 8.3 compare equal after case-folding, so skip the readdir.
  if (!part.includes("~")) return part;

  const candidate = path.join(parent, part);
  let st;
  try {
    st = fs.lstatSync(candidate);
  } catch {
    return part;
  }

  try {
    const names = fs.readdirSync(parent);
    const partKey = part.toLowerCase();
    for (const name of names) {
      if (name.toLowerCase() === partKey) return name;
    }

    const usableIno = st.ino !== 0 && st.ino !== 0n;
    if (!usableIno) return part;
    for (const name of names) {
      try {
        const other = fs.lstatSync(path.join(parent, name));
        if (other.ino === st.ino && other.dev === st.dev) return name;
      } catch {
        // Skip entries we cannot stat.
      }
    }
  } catch {
    // Parent unreadable — keep the component as given.
  }

  return part;
}
