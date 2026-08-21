/**
 * Deterministic acquisition-error regressions for scripts/lib/file-lock.mjs.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE_LOCK_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "lib", "file-lock.mjs")).href;
const FAIL_MKDIR_PRELOAD = pathToFileURL(
  path.join(REPO_ROOT, "tests", "helpers", "fail-mkdir-sync.mjs"),
).href;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-file-lock-"));

const childSource = `
  const [fileLockUrl, lockPath, lockTimeoutMs] = process.argv.slice(1);
  const { withFileLockSync } = await import(fileLockUrl);
  const startedAt = Date.now();
  let acquired = false;
  let errorCode = null;
  try {
    withFileLockSync(lockPath, () => { acquired = true; }, {
      lockTimeoutMs: Number(lockTimeoutMs),
      waitMs: 5,
    });
  } catch (err) {
    errorCode = err?.code ?? null;
  }
  const attempts = globalThis[Symbol.for("antigravity.test.mkdirAttempts")]();
  console.log(JSON.stringify({ acquired, errorCode, attempts, elapsedMs: Date.now() - startedAt }));
`;

function runInjectedMkdir(code, { always = false, lockTimeoutMs = 100 } = {}) {
  const lockPath = path.join(tempRoot, `${code}-${always ? "always" : "once"}.lock`);
  const result = spawnSync(process.execPath, [
    "--import",
    FAIL_MKDIR_PRELOAD,
    "--input-type=module",
    "-e",
    childSource,
    FILE_LOCK_URL,
    lockPath,
    String(lockTimeoutMs),
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ANTIGRAVITY_TEST_FAIL_MKDIR_PATH: lockPath,
      ANTIGRAVITY_TEST_FAIL_MKDIR_CODE: code,
      ANTIGRAVITY_TEST_FAIL_MKDIR_ALWAYS: always ? "1" : "0",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

describe("file-lock acquisition errors", { concurrency: false }, () => {
  it("retries transient Windows denial codes and acquires on the next attempt", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const result = runInjectedMkdir(code);
      assert.equal(result.acquired, true, code);
      assert.equal(result.errorCode, null, code);
      assert.equal(result.attempts, 2, code);
    }
  });

  it("still throws unrelated mkdir errors", () => {
    const result = runInjectedMkdir("ENOSPC");
    assert.equal(result.acquired, false);
    assert.equal(result.errorCode, "ENOSPC");
    assert.equal(result.attempts, 1);
  });

  it("times out when Windows denial codes persist", () => {
    const lockTimeoutMs = 30;
    const result = runInjectedMkdir("EPERM", { always: true, lockTimeoutMs });
    assert.equal(result.acquired, false);
    assert.equal(result.errorCode, "FILE_LOCK_TIMEOUT");
    assert.ok(result.attempts > 1);
    assert.ok(result.elapsedMs >= lockTimeoutMs);
    assert.ok(result.elapsedMs < 1000, `timeout should stay bounded, got ${result.elapsedMs}ms`);
  });
});
