/**
 * Process spawning and management utilities.
 */

import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

export const GIT_TIMEOUT_MS = 120_000;
const PROCESS_START_CACHE_TTL_MS = 5_000;
// Fix brief 076-T4-fix2 F3: measured on this machine across 5 freshly
// spawned node processes (one "cold" call each, immediately followed by 2
// "warm" calls in the same process, 500 ms apart) — 15 samples of the exact
// PowerShell command below ranged 548.4-631.8 ms, with no measurable
// cold/warm gap (every call launches a brand new powershell.exe regardless).
// A prior reviewer saw this query return null once on a cold run of
// tests/process-deep.test.mjs (a spike this measurement did not reproduce).
// Kept at ~3x this run's worst reading over the old 2000 ms bound to absorb
// that kind of spike without turning a slow tick into a lost stale-lock
// identity check (a null result here only makes recovery conservative, it
// is never on the hot lock-acquisition path).
const PROCESS_START_QUERY_TIMEOUT_MS = 5_000;
const processStartCache = new Map();

/**
 * Run a command synchronously and return the result.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, maxBuffer?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ stdout: string, stderr: string, status: number | null, error: Error | null }}
 */
export function runCommand(command, args, options = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      encoding: "utf8",
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
      error: result.error?.code === "ETIMEDOUT"
        ? Object.assign(new Error(`${command} timed out after ${options.timeoutMs ?? GIT_TIMEOUT_MS} ms`), { code: "ETIMEDOUT" })
        : result.error ?? null
    };
  } catch (/** @type {any} */ error) {
    return {
      stdout: "",
      stderr: error.message ?? "",
      status: 1,
      error
    };
  }
}

/**
 * Format a failed command result into a human-readable error message.
 *
 * @param {{ stdout: string, stderr: string, status: number | null }} result
 * @returns {string}
 */
export function formatCommandFailure(result) {
  const parts = [`Command exited with status ${result.status ?? "unknown"}.`];
  const stderr = (result.stderr ?? "").trim();
  if (stderr) {
    parts.push(`stderr: ${stderr}`);
  }
  return parts.join("\n");
}

/**
 * Return whether a PID currently refers to a process. EPERM means the process
 * exists but belongs to another principal, so it is considered running.
 *
 * @param {number} pid
 * @param {typeof process.kill} [killImpl]
 * @returns {boolean}
 */
export function isProcessAlive(pid, killImpl = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Live process start time in milliseconds, or null when identity is unavailable.
 * Used only for stale-lock recovery: a reused PID must not keep an old lock.
 * Permission/query failures are inconclusive, never evidence of a dead owner.
 *
 * Windows has no equivalent Node API, so the query starts PowerShell. Cache
 * briefly per PID to keep a stale live lock's 25 ms retry loop from starting a
 * shell on every attempt. The cache expires so a PID reused later is queried
 * again rather than inheriting the former process's identity indefinitely.
 *
 * @param {number} pid
 * @param {{ now?: () => number, platform?: string, spawnSyncImpl?: typeof spawnSync }} [options]
 * @returns {number | null}
 */
export function processStartedAt(pid, {
  now = Date.now,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return now() - process.uptime() * 1000;

  const checkedAt = now();
  const cached = processStartCache.get(pid);
  const cacheAge = cached ? checkedAt - cached.checkedAt : Infinity;
  if (cacheAge >= 0 && cacheAge < PROCESS_START_CACHE_TTL_MS) {
    return cached.startedAt;
  }

  let startedAt = null;
  try {
    const result = platform === "win32"
      ? spawnSyncImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
        { encoding: "utf8", windowsHide: true, timeout: PROCESS_START_QUERY_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] })
      : spawnSyncImpl("ps", ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", timeout: PROCESS_START_QUERY_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status === 0 && !result.error) {
      const parsed = Date.parse(String(result.stdout).trim());
      if (Number.isFinite(parsed)) startedAt = parsed;
    }
  } catch {
    // Query failures remain inconclusive and are cached briefly like nulls.
  }

  processStartCache.set(pid, { checkedAt, startedAt });
  return startedAt;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilGone(pid, probe, timeoutMs, pollMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (probe(pid)) {
    if (Date.now() >= deadline) return false;
    await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function deniedBy(result) {
  const text = `${result?.error?.message ?? ""}\n${result?.stderr ?? ""}`;
  return result?.error?.code === "EACCES" || result?.error?.code === "EPERM" ||
    /access (?:is )?denied|operation not permitted|permission denied/i.test(text);
}

function publicAttempt(kind, result) {
  return {
    kind,
    status: result?.status ?? null,
    signal: result?.signal ?? null,
    errorCode: result?.error?.code ?? null,
    stderr: String(result?.stderr ?? "").trim() || null,
  };
}

/**
 * Terminate a process tree, verify that the root PID disappeared, and
 * escalate from a polite request to a forced kill when needed.
 *
 * @param {number | string} pid
 * @param {{ platform?: string, killImpl?: typeof process.kill,
 *   spawnSyncImpl?: typeof spawnSync, probe?: (pid: number) => boolean,
 *   graceMs?: number, forceGraceMs?: number }} [options]
 * @returns {Promise<import('./types.mjs').TerminationResult>}
 */
export async function terminateProcessTree(pid, options = {}) {
  const numericPid = Number(pid);
  const platform = options.platform ?? process.platform;
  const killImpl = options.killImpl ?? process.kill;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const probe = options.probe ?? ((candidate) => isProcessAlive(candidate, killImpl));
  const graceMs = options.graceMs ?? 500;
  const forceGraceMs = options.forceGraceMs ?? 500;
  const attempts = [];

  const finish = (outcome, message, status = null) => ({
    outcome,
    killed: outcome === "killed",
    pid: numericPid,
    status,
    attempts,
    message,
  });

  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return finish("failed", `Invalid process id: ${pid}`);
  }
  if (!probe(numericPid)) {
    return finish("not_found", `Process ${numericPid} is not running.`);
  }

  if (platform === "win32") {
    let last;
    for (const force of [false, true]) {
      try {
        last = spawnSyncImpl(
          "taskkill",
          ["/PID", String(numericPid), "/T", ...(force ? ["/F"] : [])],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 },
        );
      } catch (error) {
        last = { status: null, signal: null, stderr: error?.message ?? String(error), error };
      }
      attempts.push(publicAttempt(force ? "taskkill-force" : "taskkill", last));
      if (await waitUntilGone(numericPid, probe, force ? forceGraceMs : graceMs)) {
        return finish("killed", `Process tree ${numericPid} terminated.`, last?.status ?? null);
      }
    }
    if (deniedBy(last) || attempts.some((attempt) => /denied|permitted/i.test(attempt.stderr ?? ""))) {
      return finish("denied", `Permission denied while terminating process tree ${numericPid}.`, last?.status ?? null);
    }
    return finish(
      "failed",
      `Process tree ${numericPid} is still running after taskkill escalation.`,
      last?.status ?? null,
    );
  }

  let lastError = null;
  for (const [kind, signal] of [["group-term", "SIGTERM"], ["group-kill", "SIGKILL"]]) {
    try {
      killImpl(-numericPid, signal);
      attempts.push({ kind, status: null, signal, errorCode: null, stderr: null });
    } catch (groupError) {
      lastError = groupError;
      try {
        killImpl(numericPid, signal);
        attempts.push({ kind: kind.replace("group", "process"), status: null, signal, errorCode: null, stderr: null });
      } catch (directError) {
        lastError = directError;
        attempts.push({
          kind: kind.replace("group", "process"),
          status: null,
          signal,
          errorCode: directError?.code ?? null,
          stderr: directError?.message ?? null,
        });
      }
    }
    if (await waitUntilGone(numericPid, probe, signal === "SIGTERM" ? graceMs : forceGraceMs)) {
      return finish("killed", `Process tree ${numericPid} terminated.`);
    }
  }

  if (lastError?.code === "EPERM" || lastError?.code === "EACCES") {
    return finish("denied", `Permission denied while terminating process tree ${numericPid}.`);
  }
  return finish("failed", `Process tree ${numericPid} is still running after SIGKILL escalation.`);
}
