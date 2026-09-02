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
  // Deterministic virtual clock: sleep() advances it by exactly waitMs with
  // no real wall-clock wait, so the timeout path is exercised on a schedule
  // known in advance instead of raced against a real 5ms/30ms window.
  let virtualNow = 0;
  const fakeNow = () => virtualNow;
  const fakeSleep = (ms) => { virtualNow += ms; };
  let acquired = false;
  let errorCode = null;
  try {
    withFileLockSync(lockPath, () => { acquired = true; }, {
      lockTimeoutMs: Number(lockTimeoutMs),
      waitMs: 5,
      now: fakeNow,
      sleep: fakeSleep,
    });
  } catch (err) {
    errorCode = err?.code ?? null;
  }
  const attempts = globalThis[Symbol.for("antigravity.test.mkdirAttempts")]();
  console.log(JSON.stringify({ acquired, errorCode, attempts, virtualElapsedMs: virtualNow }));
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

/** Named cases, generated once at module scope — each becomes its own `it`. */
const TRANSIENT_DENIAL_CODES = ["EPERM", "EACCES", "EBUSY"];

describe("file-lock acquisition errors", { concurrency: false }, () => {
  for (const code of TRANSIENT_DENIAL_CODES) {
    it(`retries transient Windows denial code ${code} and acquires on the next attempt`, () => {
      const result = runInjectedMkdir(code);
      assert.equal(result.acquired, true);
      assert.equal(result.errorCode, null);
      assert.equal(result.attempts, 2);
    });
  }

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
    // Deterministic: the virtual clock advances by exactly waitMs (5) per
    // retry with no real wall-clock wait, so both the attempt count and the
    // elapsed virtual time at the moment of timeout are known in advance
    // rather than asserted as a loose, potentially flaky bound.
    assert.equal(result.attempts, 7);
    assert.equal(result.virtualElapsedMs, 30);
  });
});
