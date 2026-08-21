/**
 * Cross-process lock-directory helper shared by state and vision config.
 *
 * Acquisition is an atomic mkdir. The owner record carries a random token,
 * so a releasing process cannot remove a successor's lock. Ordinary stale
 * recovery requires both age and a dead owner. A caller that has independently
 * verified a specific owner was terminated may reap that exact PID at once.
 * Recovery first atomically renames the directory, avoiding a
 * delete-vs-reacquire race.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_WAIT_MS = 25;

export class FileLockTimeoutError extends Error {
  constructor(lockPath, timeoutMs) {
    super(`timed out waiting for lock: ${lockPath}`);
    this.name = "FileLockTimeoutError";
    this.code = "FILE_LOCK_TIMEOUT";
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

export function isFileLockTimeoutError(error) {
  return error?.code === "FILE_LOCK_TIMEOUT";
}

function ownerPath(lockPath) {
  return path.join(lockPath, "owner.json");
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function staleLockCanBeReaped(lockPath, staleLockMs) {
  const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
  if (ageMs <= staleLockMs) return false;
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath(lockPath), "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
    return !processExists(owner.pid);
  } catch (err) {
    if (err?.code === "ENOENT" || err instanceof SyntaxError) return true;
    // Windows can briefly deny opening owner.json while another process is
    // creating directory entries. Treat that as contention, not staleness.
    if (err?.code === "EPERM" || err?.code === "EACCES" || err?.code === "EBUSY") return false;
    throw err;
  }
}

/**
 * Reap a lock only when its owner record names a PID the caller has already
 * verified as terminated. This bypasses staleLockMs without making ordinary
 * contenders guess about the liveness of fresh Windows processes.
 */
export function reapFileLockOwnedBy(lockPath, ownerPids) {
  const expected = new Set(Array.from(ownerPids ?? [], Number));
  if (expected.size === 0) return false;
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath(lockPath), "utf8"));
    if (!expected.has(owner.pid)) return false;
    return reapStaleLock(lockPath);
  } catch (err) {
    if (err?.code === "ENOENT" || err instanceof SyntaxError) return false;
    if (err?.code === "EPERM" || err?.code === "EACCES" || err?.code === "EBUSY") return false;
    throw err;
  }
}

function reapStaleLock(lockPath) {
  const quarantine = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  try {
    fs.rmSync(quarantine, { recursive: true, force: true });
  } catch {
    // The original lock name is free; quarantine cleanup is best-effort.
  }
  return true;
}

function tryAcquire(lockPath, staleLockMs) {
  const token = crypto.randomBytes(16).toString("hex");
  try {
    fs.mkdirSync(lockPath);
  } catch (err) {
    // Windows can briefly deny mkdir while another process is creating or
    // deleting the lock directory. Treat that as contention, not staleness.
    if (err?.code === "EPERM" || err?.code === "EACCES" || err?.code === "EBUSY") return null;
    if (err?.code !== "EEXIST") throw err;
    try {
      if (staleLockCanBeReaped(lockPath, staleLockMs)) reapStaleLock(lockPath);
    } catch (staleErr) {
      if (staleErr?.code !== "ENOENT") throw staleErr;
    }
    return null;
  }

  try {
    fs.writeFileSync(ownerPath(lockPath), JSON.stringify({
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
    }), { encoding: "utf8", mode: 0o600 });
    return token;
  } catch (err) {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

function release(lockPath, token) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath(lockPath), "utf8"));
    if (owner.token === token) fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // A crashed/reaped lock or cleanup failure must not mask fn's result.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function withFileLock(
  lockPath,
  fn,
  { lockTimeoutMs = 5000, staleLockMs = 60_000, waitMs = DEFAULT_WAIT_MS } = {},
) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  let token;
  while (!(token = tryAcquire(lockPath, staleLockMs))) {
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, lockTimeoutMs);
    await delay(waitMs);
  }
  try {
    return await fn();
  } finally {
    release(lockPath, token);
  }
}

export function withFileLockSync(
  lockPath,
  fn,
  { lockTimeoutMs = 2000, staleLockMs = 60_000, waitMs = DEFAULT_WAIT_MS } = {},
) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  let token;
  while (!(token = tryAcquire(lockPath, staleLockMs))) {
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, lockTimeoutMs);
    sleepSync(waitMs);
  }
  try {
    return fn();
  } finally {
    release(lockPath, token);
  }
}
