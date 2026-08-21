/**
 * Process spawning and management utilities.
 */

import { execFileSync, spawnSync, spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

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
      encoding: "utf8",
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
      error: result.error ?? null
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
 * Run a command synchronously and throw on non-zero exit.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, maxBuffer?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string} stdout
 */
export function runCommandChecked(command, args, options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result.stdout;
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
 * Check whether a binary is available on PATH.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function binaryAvailable(name) {
  try {
    const command = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(command, [name], { encoding: "utf8", stdio: "pipe" });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Return whether a PID currently refers to a process. EPERM means the process
 * exists but belongs to another principal, so it is considered running.
 *
 * @param {number} pid
 */
export function isProcessRunning(pid, killImpl = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
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
 * @returns {Promise<{ outcome: "killed"|"not_found"|"denied"|"failed",
 *   killed: boolean, pid: number, status: number|null, attempts: object[], message: string }>}
 */
export async function terminateProcessTree(pid, options = {}) {
  const numericPid = Number(pid);
  const platform = options.platform ?? process.platform;
  const killImpl = options.killImpl ?? process.kill;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const probe = options.probe ?? ((candidate) => isProcessRunning(candidate, killImpl));
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
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
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

/**
 * Spawn a detached child process that outlives the parent.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, logFile?: string }} [options]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDetached(command, args, options = {}) {
  let logFd = null;
  try {
    logFd = options.logFile ? fs.openSync(options.logFile, "a") : null;
    const stdio = options.logFile
      ? ["ignore", "ignore", logFd]
      : ["ignore", "ignore", "ignore"];

    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio
    });

    child.unref();
    return child;
  } finally {
    if (typeof logFd === "number") {
      fs.closeSync(logFd);
    }
  }
}
