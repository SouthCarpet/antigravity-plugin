/**
 * Portable temp-root for tests.
 *
 * Do not hardcode `/tmp`. On Windows that is a drive-relative path
 * (`<cwd-drive>:\tmp`) whose parent must already exist, so
 * `fs.mkdtempSync` throws ENOENT on any machine that does not happen
 * to have a `\tmp` directory at the drive root.
 *
 * `os.tmpdir()` is the right default, but a sandbox TMPDIR/TEMP may
 * point inside a git work tree. Tests that need an absolutely-not-a-
 * git-repo location (git.mjs, workspace.mjs) would then silently
 * exercise the enclosing checkout. This helper walks candidates,
 * skips any that sit inside a `.git`, and falls back to a sibling of
 * the enclosing work tree if every candidate is contaminated.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Walk from `start` up to the filesystem root. Returns the first
 * ancestor that contains a `.git` entry, or null if none.
 *
 * @param {string} start
 * @returns {string | null}
 */
export function findEnclosingGitRoot(start) {
  let current = path.resolve(start);
  while (true) {
    try {
      if (fs.existsSync(path.join(current, ".git"))) return current;
    } catch {
      // Permission / race on this ancestor — keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateRoots() {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p) return;
    const resolved = path.resolve(p);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };

  add(os.tmpdir());
  if (process.platform === "win32") {
    add(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Temp"));
    const windir = process.env.WINDIR || process.env.SystemRoot;
    add(windir && path.join(windir, "Temp"));
  } else {
    add("/tmp");
    add("/var/tmp");
  }
  return out;
}

let cachedRoot = null;

/**
 * A writable directory that exists and is not inside a git work tree.
 *
 * @returns {string}
 */
export function portableTmpRoot() {
  if (cachedRoot) return cachedRoot;

  for (const candidate of candidateRoots()) {
    if (!isWritableDir(candidate)) continue;
    if (findEnclosingGitRoot(candidate)) continue;
    cachedRoot = candidate;
    return cachedRoot;
  }

  // Every candidate (including os.tmpdir()) sits inside a git work tree.
  // Park temps in a sibling of that work tree so mkdtemp is still outside it.
  const gitRoot = findEnclosingGitRoot(os.tmpdir());
  if (gitRoot) {
    const sibling = path.join(path.dirname(gitRoot), "antigravity-plugin-test-tmp");
    if (isWritableDir(sibling) && !findEnclosingGitRoot(sibling)) {
      cachedRoot = sibling;
      return cachedRoot;
    }
  }

  throw new Error(
    `portableTmpRoot: no writable temp directory outside a git work tree (os.tmpdir()=${os.tmpdir()})`
  );
}

/**
 * Assert `dir` is not inside a git work tree. Used by tests that need
 * an absolutely-not-a-git-repo location, matching the original `/tmp`
 * override.
 *
 * @param {string} dir
 */
export function assertNotGitWorkTree(dir) {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    if (findEnclosingGitRoot(dir)) {
      throw new Error(`expected ${dir} not to be inside a git work tree`);
    }
    return;
  }
  if (result.status === 0 && String(result.stdout).trim() === "true") {
    throw new Error(`expected ${dir} not to be inside a git work tree`);
  }
}
