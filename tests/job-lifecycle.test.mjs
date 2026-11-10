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
import { canonicalComparePath, expandShortPath } from "../scripts/lib/paths.mjs";
import { isProcessAlive, readProcessStartTime, terminateProcessTree } from "../scripts/lib/process.mjs";
import { appendJobLog, ensureStateDir, listJobs, readJobFile, readLogTail, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateRoot, saveState } from "../scripts/lib/state.mjs";
import { writeFakeAgy } from "./helpers/fake-agy.mjs";
import { writeSlowPowerShell, withPathFirst } from "./helpers/slow-powershell.mjs";
import { portableTmpRoot, removeTestDir } from "./helpers/tmp.mjs";

const cleanup = [];
const TMPROOT = portableTmpRoot();

function freshWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(TMPROOT, "antigravity-lifecycle-work-"));
  const dataRoot = fs.mkdtempSync(path.join(TMPROOT, "antigravity-lifecycle-data-"));
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
  const canonical = canonicalComparePath(resolveStateDir(workspaceRoot));
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");
  return path.join(expandShortPath(os.tmpdir()), "antigravity-state-locks", `${hash}.lock`);
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
    removeTestDir(target);
  }
});

describe("cross-process job lifecycle", { concurrency: false }, () => {
  // R1 acceptance: retention must leave an old live job reachable by cancel.
  it("keeps one active job cancellable after 50 terminal jobs and one more completion", async () => {
    const { workspaceRoot, dataRoot } = freshWorkspace();
    const savedData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataRoot;
    try {
      const active = {
        id: 'aaaaaaaaaaaa', status: 'running', workerPid: 1234,
        workerProcessStartedAt: '1999-12-31T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
      };
      const history = Array.from({ length: 50 }, (_, i) => ({
        id: i.toString(16).padStart(12, '0'), status: 'completed',
        updatedAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString(),
      }));
      ensureStateDir(workspaceRoot);
      for (const job of [active, ...history]) {
        fs.writeFileSync(resolveJobFile(workspaceRoot, job.id), JSON.stringify(job));
        appendJobLog(workspaceRoot, job.id, 'retained progress');
      }
      await saveState(workspaceRoot, { jobs: [active, ...history] });
      await patchJob(workspaceRoot, 'bbbbbbbbbbbb', { status: 'completed' });
      assert.equal(listJobs(workspaceRoot).length, 51);
      assert.equal(readJobFile(workspaceRoot, active.id).status, 'running');
      assert.match(readLogTail(resolveJobLogFile(workspaceRoot, active.id)), /retained progress/);
      assert.equal(readJobFile(workspaceRoot, '000000000000'), null);
      const { run } = await import('../scripts/commands/cancel.mjs');
      const exitCode = await run([active.id, '--json'], {
        cwd: workspaceRoot,
        // PID 1234 is a fixture: say it is alive with the recorded start time.
        isProcessAlive: () => true,
        readProcessStartTime: () => Date.parse('1999-12-31T00:00:00.000Z'),
        terminateProcessTree: async (pid) => {
          assert.equal(pid, 1234);
          return { outcome: 'killed', killed: true, pid, status: 0, attempts: [] };
        },
        outputCommandResult: () => {},
      });
      assert.equal(exitCode, 0);
      assert.equal(readJobFile(workspaceRoot, active.id).status, 'cancelled');
      assert.equal(listJobs(workspaceRoot).filter((job) => job.status !== 'running').length, 50);
    } finally {
      if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = savedData;
    }
  });

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

  it("reaps a stale lock when its live owner PID has been reused", async () => {
    const { dataRoot } = freshWorkspace();
    const lockPath = path.join(dataRoot, "reused-pid.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      token: "stale-owner",
      startedAt: "2000-01-01T00:00:00.000Z",
    }));
    const staleTime = new Date("2000-01-01T00:00:00.000Z");
    fs.utimesSync(lockPath, staleTime, staleTime);

    let replacementOwner;
    await withFileLock(lockPath, async () => {
      replacementOwner = JSON.parse(
        fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"),
      );
    }, { staleLockMs: 100, lockTimeoutMs: 1000, waitMs: 1 });

    assert.equal(replacementOwner.pid, process.pid);
    assert.notEqual(replacementOwner.token, "stale-owner");
    assert.equal(fs.existsSync(lockPath), false);
  });

  // Plan 153 package G, item G2. The fake agy of the early-cancel case used
  // to live 2 000 ms. Under load the Windows start-time query (PowerShell)
  // took longer than that: the process was gone when the query answered, the
  // worker correctly stored `agyProcessStartedAt: null`, and the case failed
  // (7 of 20 runs under load on 2026-11-09). A slow PowerShell on the
  // worker's PATH gave the same failure 3 of 3 times. The fixture no longer
  // races the query: the fake lives until the case stops it by its PID. The
  // lifetime below only bounds a fake that a failed run could not stop.
  const EARLY_CANCEL_AGY_LIFE_MS = 60_000;

  /**
   * Stop the processes that a case started, by PID, and wait until they are
   * gone. A workspace folder cannot be removed on Windows while a process
   * that runs in it is alive (`EPERM`).
   *
   * @param {Array<number | null | undefined>} pids
   * @returns {Promise<boolean>} true when none of them is running
   */
  async function stopStartedProcesses(pids) {
    const started = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
    for (const pid of started) {
      if (isProcessAlive(pid)) await terminateProcessTree(pid);
    }
    return Boolean(await waitFor(() => started.every((pid) => !isProcessAlive(pid)), 10_000));
  }

  /**
   * The early-cancel case: a cancel during the worker's first locked state
   * update, with both start times read from the OS at launch.
   *
   * @param {{ slowStartTimeQueryMs?: number }} [options] when set, the
   *   worker's start-time query takes this much longer (Windows only)
   */
  async function runEarlyCancelCase({ slowStartTimeQueryMs = 0 } = {}) {
    const { workspaceRoot, dataRoot } = freshWorkspace();
    const originalClaudeData = process.env.CLAUDE_PLUGIN_DATA;
    const originalAgyBin = process.env.AGY_BIN;
    process.env.CLAUDE_PLUGIN_DATA = dataRoot;
    process.env.AGY_BIN = writeFakeAgy(workspaceRoot, "early-cancel-agy", {
      delayMs: EARLY_CANCEL_AGY_LIFE_MS,
      stdout: "unused",
    });
    // Only the worker gets the slow query; this process keeps the real one.
    const workerBaseEnv = slowStartTimeQueryMs > 0
      ? withPathFirst(process.env, writeSlowPowerShell(dataRoot, slowStartTimeQueryMs))
      : process.env;
    const started = { workerPid: null, agyPid: null, jobId: null };
    try {
      const lockPath = stateLockPath(workspaceRoot);
      const holdMarker = path.join(workspaceRoot, "worker-lock-release-held");
      const startGate = path.join(workspaceRoot, "worker-start-gate");
      const holdReleasePreload = pathToFileURL(
        path.resolve("tests/helpers/hold-lock-release.mjs"),
      ).href;
      const { job, pid } = await startBackgroundJob({
        workspaceRoot,
        kind: "task",
        title: "early cancel",
        prompt: "stay busy",
        env: {
          ...workerBaseEnv,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${holdReleasePreload}`]
            .filter(Boolean)
            .join(" "),
          ANTIGRAVITY_TEST_HOLD_LOCK_PATH: lockPath,
          ANTIGRAVITY_TEST_HOLD_LOCK_MARKER: holdMarker,
          ANTIGRAVITY_TEST_WORKER_START_GATE: startGate,
        },
      });
      started.workerPid = pid;
      started.jobId = job.id;
      fs.writeFileSync(startGate, "go", "utf8");
      // Fix brief 076-T4-fix2 F1: staged timestamps (parent dispatch, spawn
      // ack, start-gate write, worker's own "[worker] started" log line,
      // hold marker) plus a resolveWorkspaceRoot call counter showed the
      // real cost was not the fake-agy stub or the stale-lock identity
      // check (which never runs on a fresh lock), but `resolveStateDir`
      // calling `resolveWorkspaceRoot` — a synchronous `git rev-parse` — on
      // every single state read/write. One worker run spawned it 13 times.
      // The cost of one such spawn from the freshly started background
      // worker varies by session on this machine (about 3.4 s in the fix
      // session, under 0.5 s in the re-review session; the cause of the
      // per-process gap is not identified, so it is not attributed to
      // antivirus or anything else unmeasured). The count of spawns, not the
      // cost of one, is what made this case take up to 50 s and fail a 30 s
      // budget; with the cache disabled the re-review measured 29 spawns and
      // 13.3 s. `resolveWorkspaceRoot` now caches
      // per cwd for the process lifetime (workspace.mjs) — a cwd's git
      // identity cannot change within one CLI invocation or worker run —
      // which cuts the worker down to its one unavoidable spawn. Post-fix,
      // 6 fresh runs on this machine (4 of the case alone, 2 of the whole
      // file) measured 3966.8-4044.6 ms for this case. Budget: 2x the
      // highest reading (4044.6 ms), rounded up to a whole ten seconds.
      const owner = await waitFor(() => {
        try {
          if (!fs.existsSync(holdMarker)) return null;
          return JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
        } catch {
          return null;
        }
      }, 10_000 + 2 * slowStartTimeQueryMs);
      assert.ok(owner, "worker should acquire the state lock during startup");
      assert.equal(owner.pid, pid, "the worker itself should own its startup lock");
      const agyPid = readJobFile(workspaceRoot, job.id)?.agyPid;
      assert.ok(Number.isInteger(agyPid) && agyPid > 0, "startup should publish the agy pid");
      started.agyPid = agyPid;
      // Both start times are real OS reads taken at launch. The real cancel
      // below confirms each against a fresh read before it signals, so this
      // case is the end-to-end positive control for process identity.
      const launched = readJobFile(workspaceRoot, job.id);
      for (const field of ["workerProcessStartedAt", "agyProcessStartedAt"]) {
        assert.equal(typeof launched[field], "string", `${field} is recorded at launch`);
        assert.ok(Number.isFinite(Date.parse(launched[field])), `${field} is a timestamp`);
      }

      // Cancel reads the start time of each live target once, and refuses to
      // signal a target whose read fails (by design; the user retries). On
      // Windows one read is one PowerShell run capped at 5 s, and under full
      // CPU load a run can be slower than that. This case is about the lock,
      // not about the speed of that query, so each read gets one retry here,
      // the same rule the product uses at launch. Both are real OS reads.
      const readStartTimeWithRetry = (targetPid) =>
        readProcessStartTime(targetPid) ?? readProcessStartTime(targetPid);
      let cancelReport = null;
      const startedCancelAt = Date.now();
      const exitCode = await (await import("../scripts/commands/cancel.mjs")).run(
        [job.id, "--json"],
        {
          cwd: workspaceRoot,
          readProcessStartTime: readStartTimeWithRetry,
          terminateProcessTree: async (targetPid) => {
            assert.ok(
              targetPid === pid || targetPid === agyPid,
              `unexpected cancellation target ${targetPid}`,
            );
            const currentOwner = JSON.parse(
              fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"),
            );
            assert.deepEqual(
              currentOwner,
              owner,
              "the same worker lock should still be owned when termination begins",
            );
            const isWorker = targetPid === pid;
            return {
              outcome: isWorker ? "killed" : "not_found",
              killed: true,
              pid: targetPid,
              status: isWorker ? 0 : 128,
              attempts: [],
              message: isWorker
                ? `Process tree ${targetPid} terminated.`
                : `Process ${targetPid} is not running.`,
            };
          },
          outputCommandResult: (payload) => { cancelReport = payload; },
        },
      );

      // Cancel now reads the start time of each live target before it
      // signals it (two targets here; on Windows each read starts PowerShell
      // and is capped at 5 s, and this case allows one retry per target, so
      // the worst case is 20 s). The whole case took about 2.2 s alone, but
      // the cancel took more than 5 s once under the full suite. 25 s stays
      // under the 30 s state-lock timeout this bound guards against.
      assert.ok(Date.now() - startedCancelAt < 25_000, "cancellation should stay bounded");
      assert.equal(exitCode, 0, `cancel failed: ${JSON.stringify(cancelReport)}`);
      assert.equal(readJobFile(workspaceRoot, job.id)?.status, "cancelled");

      // The preload exits the worker when cancellation reaps its lock. Wait
      // for it and assert it actually happened: a discarded wait result
      // would let a real "process never exits" regression pass silently.
      const workerExited = await waitFor(() => !isProcessAlive(pid), 6000);
      assert.ok(workerExited, 'the worker process should exit after cancellation');
      // The injected terminator above stops nothing. On Windows the fake agy
      // ends with the worker (Node puts a child that is not detached into a
      // job object that ends with its parent). On POSIX agy is detached and
      // still runs. The case started it, so the case stops it, by its PID.
      assert.ok(await stopStartedProcesses([agyPid]), 'the agy process should be gone when the case ends');
    } finally {
      // Also after a failed assertion: nothing that this case started may
      // still run when the workspace folder is removed.
      const recordedAgyPid = started.jobId ? readJobFile(workspaceRoot, started.jobId)?.agyPid : null;
      await stopStartedProcesses([started.workerPid, started.agyPid, recordedAgyPid]);
      if (originalClaudeData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = originalClaudeData;
      if (originalAgyBin === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = originalAgyBin;
    }
  }

  it("cancels during the worker's first locked state update", async () => {
    await runEarlyCancelCase();
  });

  // The deterministic form of the load failure above: the worker's
  // start-time query answers 3 000 ms late, which is later than the old
  // 2 000 ms fixture lived. The start time must still be recorded.
  it("cancels during the worker's first locked state update when the start-time query is slow", {
    skip: process.platform === "win32" ? false : "Windows only: the slow query stand-in is a powershell.exe",
  }, async () => {
    await runEarlyCancelCase({ slowStartTimeQueryMs: 3000 });
  });

  it("cancels a queued worker before it acquires the startup lock", async () => {
    const { workspaceRoot, dataRoot } = freshWorkspace();
    const originalClaudeData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataRoot;
    try {
      const job = await createTrackedJob({
        workspaceRoot,
        kind: "task",
        title: "cancel before startup",
      });
      const workerPid = 2 ** 22;
      await patchJob(workspaceRoot, job.id, { pid: workerPid, workerPid });
      assert.equal(fs.existsSync(stateLockPath(workspaceRoot)), false);

      const exitCode = await (await import("../scripts/commands/cancel.mjs")).run(
        [job.id, "--json"],
        {
          cwd: workspaceRoot,
          terminateProcessTree: async (targetPid) => {
            assert.equal(targetPid, workerPid);
            return {
              outcome: "not_found",
              killed: true,
              pid: targetPid,
              status: 128,
              attempts: [],
              message: `Process ${targetPid} is not running.`,
            };
          },
          outputCommandResult: () => {},
        },
      );

      assert.equal(exitCode, 0);
      assert.equal(readJobFile(workspaceRoot, job.id)?.status, "cancelled");
    } finally {
      if (originalClaudeData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = originalClaudeData;
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
        workerProcessStartedAt: "2026-10-08T12:00:00.000Z",
      });
      const { run } = await import("../scripts/commands/cancel.mjs");
      const exitCode = await run([job.id, "--json"], {
        cwd: workspaceRoot,
        isProcessAlive: () => true,
        readProcessStartTime: () => Date.parse("2026-10-08T12:00:00.000Z"),
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
      assert.match(reported.details.message, /retry shortly/i);
      assert.doesNotMatch(reported.details.message, /FileLockTimeoutError|\n\s+at /);
    } finally {
      if (originalClaudeData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = originalClaudeData;
    }
  });

  it("patchJob serializes concurrent same-process patches without losing fields", async () => {
    // Smaller, deterministic complement to the cross-process stress case
    // below: 12 patchJob calls fired in the same tick, in the same process.
    // No external gate is needed — this exercises the existing in-process
    // FIFO queue in withWorkspaceMutex (atomic-state.mjs), and the outcome
    // (every field present) is guaranteed regardless of how the event loop
    // happens to interleave them, not dependent on real OS process timing.
    const { workspaceRoot, dataRoot } = freshWorkspace();
    const originalClaudeData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataRoot;
    try {
      const job = await createTrackedJob({ workspaceRoot, kind: "task", title: "in-process race" });
      await Promise.all(
        Array.from({ length: 12 }, (_, index) => patchJob(workspaceRoot, job.id, { [`raceField${index}`]: index })),
      );

      const stored = readJobFile(workspaceRoot, job.id);
      for (let index = 0; index < 12; index += 1) {
        assert.equal(stored[`raceField${index}`], index, `lost raceField${index}`);
      }
    } finally {
      if (originalClaudeData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = originalClaudeData;
    }
  });

  // High-fidelity integration/stress case: 12 real OS processes contend for
  // the same job file through the real cross-process file lock. This is not
  // a claim that concurrent calls interleave deterministically at the unit
  // level — that property is covered separately, in-process, above. The
  // explicit `gate` file (written only after every child has spawned and is
  // already polling for it) is the start signal, and the assertion is the
  // caller-visible on-disk job state, not an internal call count.
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
