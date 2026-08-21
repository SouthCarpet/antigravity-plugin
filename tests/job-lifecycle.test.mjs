/**
 * Cross-process job lifecycle regressions. No real `agy` process is invoked.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { FileLockTimeoutError, withFileLock } from "../scripts/lib/file-lock.mjs";
import { createTrackedJob, patchJob, startBackgroundJob } from "../scripts/lib/job-helpers.mjs";
import { readJobFile, resolveStateDir, resolveStateRoot } from "../scripts/lib/state.mjs";
import { writeFakeAgy } from "./helpers/fake-agy.mjs";

const cleanup = [];

function freshWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-lifecycle-work-"));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-lifecycle-data-"));
  cleanup.push(workspaceRoot, dataRoot);
  return { workspaceRoot, dataRoot };
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`patch child exited ${code}: ${stderr}`));
    });
  });
}

function stateLockPath(workspaceRoot) {
  const resolved = path.resolve(resolveStateDir(workspaceRoot));
  const canonical = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");
  return path.join(os.tmpdir(), "antigravity-state-locks", `${hash}.lock`);
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

after(() => {
  for (const target of cleanup) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }
});

describe("cross-process job lifecycle", { concurrency: false }, () => {
  it("records the actual holding process in the lock owner file", async () => {
    const { dataRoot } = freshWorkspace();
    const lockPath = path.join(dataRoot, "owner-test.lock");
    await withFileLock(lockPath, async () => {
      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
      assert.equal(owner.pid, process.pid);
      assert.equal(typeof owner.token, "string");
      assert.ok(owner.token.length > 0);
    });
  });

  it("cancels during the worker's first locked state update", async () => {
    const { workspaceRoot, dataRoot } = freshWorkspace();
    const originalClaudeData = process.env.CLAUDE_PLUGIN_DATA;
    const originalAgyBin = process.env.AGY_BIN;
    process.env.CLAUDE_PLUGIN_DATA = dataRoot;
    process.env.AGY_BIN = writeFakeAgy(workspaceRoot, "early-cancel-agy", {
      delayMs: 2000,
      stdout: "unused",
    });
    try {
      const { job, pid } = await startBackgroundJob({
        workspaceRoot,
        kind: "task",
        title: "early cancel",
        prompt: "stay busy",
        env: process.env,
      });
      const startedCancelAt = Date.now();
      const lockPath = stateLockPath(workspaceRoot);
      const exitCode = await (await import("../scripts/commands/cancel.mjs")).run(
        [job.id, "--json"],
        {
          cwd: workspaceRoot,
          terminateProcessTree: async (targetPid) => {
            assert.equal(targetPid, pid);
            const owner = await waitFor(() => {
              try {
                return JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
              } catch {
                return null;
              }
            });
            assert.ok(owner, "worker should acquire the state lock during startup");
            assert.equal(owner.pid, pid, "the worker itself should own its startup lock");

            // Model an abrupt successful tree kill while the worker owns the
            // lock. Changing the token prevents the still-live test worker's
            // finally block from cleaning up our simulated crash artifact.
            fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
              ...owner,
              token: "simulated-crashed-owner",
            }));
            return {
              outcome: "killed",
              killed: true,
              pid: targetPid,
              status: 0,
              attempts: [],
              message: `Process tree ${targetPid} terminated.`,
            };
          },
          outputCommandResult: () => {},
        },
      );

      assert.ok(Date.now() - startedCancelAt < 5000, "early cancellation should stay bounded");
      assert.equal(exitCode, 0);
      assert.equal(readJobFile(workspaceRoot, job.id)?.status, "cancelled");

      // The injected terminator deliberately does not kill a real process in
      // the sandbox. Let the short fake finish so cleanup does not leak it.
      await waitFor(() => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }, 6000);
    } finally {
      if (originalClaudeData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = originalClaudeData;
      if (originalAgyBin === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = originalAgyBin;
    }
  });

  it("does not record cancelled when process-tree termination fails", async () => {
    const { workspaceRoot, dataRoot } = freshWorkspace();
    const originalClaudeData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataRoot;
    try {
      const job = await createTrackedJob({ workspaceRoot, kind: "task", title: "cancel failure" });
      await patchJob(workspaceRoot, job.id, {
        status: "running",
        phase: "running",
        pid: 2 ** 22,
      });
      const { run } = await import("../scripts/commands/cancel.mjs");
      const exitCode = await run([job.id, "--json"], {
        cwd: workspaceRoot,
        terminateProcessTree: async (pid) => ({
          outcome: "denied",
          killed: false,
          pid,
          status: 1,
          attempts: [{ kind: "mock", status: 1, errorCode: "EACCES" }],
          message: `Permission denied while terminating process tree ${pid}.`,
        }),
        outputCommandResult: () => {},
      });

      const stored = readJobFile(workspaceRoot, job.id);
      assert.equal(exitCode, 1);
      assert.notEqual(stored.status, "cancelled");
      assert.match(stored.errorMessage, /terminat|kill/i);
    } finally {
      if (originalClaudeData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = originalClaudeData;
    }
  });

  it("reports state contention without exposing a lock-timeout stack", async () => {
    const { workspaceRoot, dataRoot } = freshWorkspace();
    const originalClaudeData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataRoot;
    let reported;
    try {
      const job = await createTrackedJob({ workspaceRoot, kind: "task", title: "busy state" });
      await patchJob(workspaceRoot, job.id, {
        status: "running",
        phase: "running",
        workerPid: 2 ** 22,
      });
      const { run } = await import("../scripts/commands/cancel.mjs");
      const exitCode = await run([job.id, "--json"], {
        cwd: workspaceRoot,
        terminateProcessTree: async (pid) => ({
          outcome: "not_found",
          killed: true,
          pid,
          status: 128,
          attempts: [],
          message: `Process ${pid} is not running.`,
        }),
        patchJob: async () => {
          throw new FileLockTimeoutError("test-state.lock", 10);
        },
        outputCommandResult: (payload) => { reported = payload; },
      });

      assert.equal(exitCode, 1);
      assert.equal(reported.status, "state_busy");
      assert.match(reported.message, /retry shortly/i);
      assert.doesNotMatch(reported.message, /FileLockTimeoutError|\n\s+at /);
    } finally {
      if (originalClaudeData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = originalClaudeData;
    }
  });

  it("preserves every field when real processes race patchJob read-modify-write", async () => {
    const { workspaceRoot, dataRoot } = freshWorkspace();
    const originalClaudeData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataRoot;
    try {
      const job = await createTrackedJob({ workspaceRoot, kind: "task", title: "race" });
      const helpersUrl = pathToFileURL(path.resolve("scripts/lib/job-helpers.mjs")).href;
      const gate = path.join(workspaceRoot, "go");
      const childSource = `
        import fs from "node:fs";
        const [helpersUrl, workspaceRoot, jobId, gate, key, value] = process.argv.slice(1);
        while (!fs.existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 5));
        const { patchJob } = await import(helpersUrl);
        await patchJob(workspaceRoot, jobId, { [key]: Number(value) });
      `;
      const children = Array.from({ length: 12 }, (_, index) => {
        const child = spawn(process.execPath, [
          "--input-type=module",
          "-e",
          childSource,
          helpersUrl,
          workspaceRoot,
          job.id,
          gate,
          `raceField${index}`,
          String(index),
        ], {
          env: {
            ...process.env,
            CLAUDE_PLUGIN_DATA: dataRoot,
            CODEX_PLUGIN_DATA: "",
            AGY_PLUGIN_DATA: "",
          },
          stdio: ["ignore", "ignore", "pipe"],
        });
        return waitForChild(child);
      });
      fs.writeFileSync(gate, "go");
      await Promise.all(children);

      const stored = readJobFile(workspaceRoot, job.id);
      for (let index = 0; index < 12; index += 1) {
        assert.equal(stored[`raceField${index}`], index, `lost raceField${index}`);
      }
    } finally {
      if (originalClaudeData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = originalClaudeData;
    }
  });

  it("resolves each host data root, standalone fallback, and legacy Codex state", () => {
    const { workspaceRoot, dataRoot } = freshWorkspace();
    const claude = path.join(dataRoot, "claude");
    const codex = path.join(dataRoot, "codex");
    const agy = path.join(dataRoot, "agy");
    assert.deepEqual(resolveStateRoot({ CLAUDE_PLUGIN_DATA: claude }), {
      root: path.join(claude, "state"), source: "CLAUDE_PLUGIN_DATA",
    });
    assert.deepEqual(resolveStateRoot({ CODEX_PLUGIN_DATA: codex }), {
      root: path.join(codex, "state"), source: "CODEX_PLUGIN_DATA",
    });
    assert.deepEqual(resolveStateRoot({ AGY_PLUGIN_DATA: agy }), {
      root: path.join(agy, "state"), source: "AGY_PLUGIN_DATA",
    });
    assert.equal(resolveStateRoot({}).source, "standalone-temp");
    assert.equal(resolveStateDir(workspaceRoot, { CODEX_PLUGIN_DATA: codex }).startsWith(path.join(codex, "state")), true);

    const legacyDir = resolveStateDir(workspaceRoot, {});
    fs.mkdirSync(legacyDir, { recursive: true });
    assert.equal(resolveStateDir(workspaceRoot, { CODEX_PLUGIN_DATA: codex }), legacyDir);
  });
});
