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
 *
 * `expandShortPath` and `canonicalComparePath` take an optional seam
 * `{ platform, fs }` (defaults: `process.platform`, `node:fs`; only
 * `lstatSync` and `readdirSync` are used). Tests supply a fixture volume so
 * 8.3 expansion is asserted on hosts whose filesystem never mints an alias.
 * Production callers pass nothing and get the real implementation.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * `path.win32` or `path.posix` for a platform id. For the host's own
 * platform this is the same object as `node:path`.
 *
 * @param {string} [platform]
 * @returns {path.PlatformPath}
 */
export function pathModuleFor(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

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
 * @param {{ platform?: string, fs?: Pick<typeof fs, "lstatSync" | "readdirSync"> }} [seam]
 * @returns {string}
 */
export function expandShortPath(input, { platform = process.platform, fs: fsImpl = fs } = {}) {
  const p = pathModuleFor(platform);
  const resolved = p.resolve(stripExtendedPath(input));
  if (platform !== "win32") return p.normalize(resolved);

  const parsed = p.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(/[\\/]/).filter(Boolean);
  let parent = parsed.root;
  const expanded = [];

  for (const part of parts) {
    expanded.push(longNameOf(parent, part, fsImpl, p));
    parent = p.join(parent, expanded[expanded.length - 1]);
  }

  return expanded.length === 0 ? parsed.root : p.join(parsed.root, ...expanded);
}

/**
 * Canonical form for equality: expanded 8.3, no `\\?\` prefix, normalized,
 * case-folded on Windows. Does not follow reparse points.
 *
 * @param {string} input
 * @param {{ platform?: string, fs?: Pick<typeof fs, "lstatSync" | "readdirSync"> }} [seam]
 * @returns {string}
 */
export function canonicalComparePath(input, seam = {}) {
  const platform = seam.platform ?? process.platform;
  const expanded = pathModuleFor(platform).normalize(expandShortPath(input, seam));
  return platform === "win32" ? expanded.toLowerCase() : expanded;
}

function longNameOf(parent, part, fsImpl, p) {
  // Truncated 8.3 aliases always contain `~` (RUNNER~1, APPDAT~1). Names that
  // already fit in 8.3 compare equal after case-folding, so skip the readdir.
  if (!part.includes("~")) return part;

  const candidate = p.join(parent, part);
  let st;
  try {
    st = fsImpl.lstatSync(candidate);
  } catch {
    return part;
  }

  try {
    const names = fsImpl.readdirSync(parent);
    const partKey = part.toLowerCase();
    for (const name of names) {
      if (name.toLowerCase() === partKey) return name;
    }

    const usableIno = st.ino !== 0 && st.ino !== 0n;
    if (!usableIno) return part;
    for (const name of names) {
      try {
        const other = fsImpl.lstatSync(p.join(parent, name));
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
