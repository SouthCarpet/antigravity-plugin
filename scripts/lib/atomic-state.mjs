/**
 * Cross-process mutex helpers and atomic JSON write helper.
 *
 * `withJobMutex` and `withWorkspaceMutex` use one workspace-wide lock. A
 * local FIFO avoids self-contention; an atomic lock directory under the OS
 * temp root serializes the same key across independent Node processes.
 *
 * `writeJsonAtomic` writes the serialized JSON payload to a unique temporary
 * sibling file and then renames it into place. If serialization or the write
 * itself fails the target file is left untouched and the temp file is cleaned
 * up on a best-effort basis.
 *
 * Workspace-wide (rather than per-file) locking lets callers make the job
 * index and detail file one read-modify-write transaction.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reapFileLockOwnedBy, withFileLock } from "./file-lock.mjs";
import { canonicalComparePath, expandShortPath } from "./paths.mjs";

const mutexes = new Map();
const LOCK_ROOT = path.join(expandShortPath(os.tmpdir()), "antigravity-state-locks");
const STATE_LOCK_TIMEOUT_MS = 30_000;

function lockPathFor(key) {
  const canonical = canonicalComparePath(String(key));
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");
  return path.join(LOCK_ROOT, `${hash}.lock`);
}

async function runWithMutex(map, key, fn) {
  const prev = map.get(key) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  // Chain: next waiter awaits the tail of the queue, so concurrent calls
  // serialize in FIFO order.
  map.set(
    key,
    prev.then(() => next)
  );
  try {
    await prev;
    return await withFileLock(lockPathFor(key), fn, { lockTimeoutMs: STATE_LOCK_TIMEOUT_MS });
  } finally {
    const tail = map.get(key);
    release();
    // Drop the entry only when the most recently queued promise resolves with
    // no later waiters queued, so the map does not grow unbounded.
    if (tail) {
      tail.then(() => {
        if (map.get(key) === tail) {
          map.delete(key);
        }
      });
    }
  }
}

export function withJobMutex(workspaceRoot, _jobId, fn) {
  return runWithMutex(mutexes, String(workspaceRoot), fn);
}

export function withWorkspaceMutex(workspaceRoot, fn) {
  return runWithMutex(mutexes, String(workspaceRoot), fn);
}

export function recoverWorkspaceMutex(workspaceRoot, ownerPids) {
  return reapFileLockOwnedBy(lockPathFor(String(workspaceRoot)), ownerPids);
}

export function writeJsonAtomic(targetPath, value) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(
    dir,
    `${base}.tmp.${crypto.randomBytes(6).toString("hex")}`
  );

  // Serialize BEFORE opening the temp file so a BigInt / circular value
  // failure does not leave an empty sibling.
  const body = JSON.stringify(value, null, 2);

  try {
    fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }

  try {
    fs.renameSync(tmp, targetPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
}
