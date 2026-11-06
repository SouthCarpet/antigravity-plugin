import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeAgy } from "../scripts/lib/agent-runtime.mjs";
import { probeAgyForVerb } from "../scripts/lib/job-helpers.mjs";
import { writeFakeAgy } from "./helpers/fake-agy.mjs";
// Oracle: fix-round contract: retry only timeout, once, with bounded real process calls.
test("a slow version probe times out once then succeeds on the second spawn", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = writeFakeAgy(dir, "agy", { delayMs: 10000, stdout: "test-version", readStdin: false });
  let spawns = 0;
  const result = await probeAgyForVerb("media", {
    bin,
    timeoutMs: 5000,
    probe: async (opts) => {
      spawns++;
      const result = await probeAgy(opts);
      if (spawns === 1) {
        assert.equal(result.reason, "timeout");
        writeFakeAgy(dir, "agy", { versionOk: true });
      }
      return result;
    },
  });
  assert.equal(result.line, null);
  assert.equal(spawns, 2);
});
test("missing binary is reported immediately with no retry", async () => {
  let spawns = 0;
  const result = await probeAgyForVerb("media", {
    bin: "nonexistent-agy-binary",
    probe: async (opts) => {
      spawns++;
      return probeAgy(opts);
    },
  });
  assert.match(result.line, /not on PATH/);
  assert.equal(spawns, 1);
});
test("repeated timeouts stop after two attempts", async () => {
  let spawns = 0;
  const result = await probeAgyForVerb("media", {
    probe: async () => {
      spawns++;
      return { ok: false, reason: "timeout" };
    },
  });
  assert.match(result.line, /timeout/);
  assert.equal(spawns, 2);
});
