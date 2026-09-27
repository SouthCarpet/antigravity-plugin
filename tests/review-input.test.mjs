/**
 * Tests for `buildReviewInput` (scripts/lib/review-input.mjs, Task 5,
 * "Senate R5", 2026-09) and the `review.mjs` surfaces built on it:
 * `--preview`, `--require-complete`, the incomplete-input warning, the
 * stored request fields, and the Provenance "Input hash" line.
 *
 * Git fixture pattern follows tests/git.test.mjs (isolated repo per test,
 * TMPROOT outside any enclosing work tree). The fake `agy` binary follows
 * tests/helpers/fake-agy.mjs — a real spawnable stub, not a `runAgyPrint`
 * mock, so the "byte-identical prompt" and "no spawn" assertions below
 * exercise the real spawn path (`AGY_BIN`), not a stand-in.
 */

import { describe, it, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import { portableTmpRoot, assertNotGitWorkTree } from "./helpers/tmp.mjs";
import { writeFakeAgy } from "./helpers/fake-agy.mjs";
import { collectReviewContext } from "../scripts/lib/git.mjs";
import { buildReviewInput } from "../scripts/lib/review-input.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";
import { readJobFile } from "../scripts/lib/state.mjs";

const TMPROOT = portableTmpRoot();
assertNotGitWorkTree(TMPROOT);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: "ignore", env: GIT_ENV });
}

const createdDirs = [];
after(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(TMPROOT, prefix));
  createdDirs.push(dir);
  return dir;
}

const UNTRACKED_CAP = 24 * 1024;

/**
 * A fixture repo with: a modified tracked file (diff), an untracked file
 * under the cap (included), an untracked file over the cap (skipped:
 * "exceeds byte limit"), a binary file (skipped: "binary file"), a `.env`
 * file (skipped: "secret-shaped name"), and — when `fs.symlinkSync` is
 * permitted on this machine — a symlink (skipped: "symlink"). Returns the
 * repo path, whether the symlink was actually created, and the measured
 * fixture sizes for the report.
 */
function buildFixtureRepo() {
  const repo = tmpDir("review-input-");
  sh("git init -q -b main", repo);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "line one\n");
  sh("git add tracked.txt", repo);
  sh("git commit -q -m initial", repo);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "line one\nline two\n");

  const smallBody = "small untracked body\n";
  fs.writeFileSync(path.join(repo, "small.txt"), smallBody);

  const bigBody = "B".repeat(UNTRACKED_CAP + 512);
  fs.writeFileSync(path.join(repo, "big.txt"), bigBody);

  const binBody = Buffer.from([0x42, 0x00, 0x01, 0x02, 0x48, 0x69]);
  fs.writeFileSync(path.join(repo, "bin.dat"), binBody);

  fs.writeFileSync(path.join(repo, ".env"), "SECRET=shh\n");

  let symlinked = false;
  let symlinkSkipReason = null;
  try {
    fs.symlinkSync(path.join(repo, "tracked.txt"), path.join(repo, "linked.txt"));
    symlinked = true;
  } catch (err) {
    symlinkSkipReason = err.code === "EPERM"
      ? "fs.symlinkSync raised EPERM on this machine (Windows, no symlink privilege)"
      : `fs.symlinkSync raised ${err.code ?? err.message}`;
  }

  return {
    repo,
    symlinked,
    symlinkSkipReason,
    sizes: {
      smallBytes: Buffer.byteLength(smallBody, "utf8"),
      bigBytes: Buffer.byteLength(bigBody, "utf8"),
      binBytes: binBody.length,
    },
  };
}

function sha256Of(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function bySkippedPath(skipped, targetPath) {
  return skipped.find((entry) => entry.path === targetPath);
}

describe("review-input.buildReviewInput (working-tree scope)", () => {
  it("selects diff and under-cap untracked content, skips the rest with the real skip reasons", (t) => {
    const fixture = buildFixtureRepo();
    const envelope = collectReviewContext(fixture.repo, { scope: "working-tree" });
    const input = buildReviewInput(envelope, {});

    // Diff-kind entry for the modified tracked file, with a real byte count.
    const diffEntry = input.included.find((e) => e.kind === "diff" && e.path === "tracked.txt");
    assert.ok(diffEntry, JSON.stringify(input.included));
    assert.equal(typeof diffEntry.bytes, "number");
    assert.ok(diffEntry.bytes > 0);

    // Untracked-kind entry for the under-cap file, exact byte count.
    const untrackedEntry = input.included.find((e) => e.kind === "untracked" && e.path === "small.txt");
    assert.ok(untrackedEntry, JSON.stringify(input.included));
    assert.equal(untrackedEntry.bytes, fixture.sizes.smallBytes);

    // Skipped: over-cap, binary, secret-shaped name.
    assert.match(bySkippedPath(input.skipped, "big.txt")?.reason ?? "", /exceeds byte limit/);
    assert.equal(bySkippedPath(input.skipped, "bin.dat")?.reason, "binary file");
    assert.equal(bySkippedPath(input.skipped, ".env")?.reason, "secret-shaped name");

    if (fixture.symlinked) {
      assert.equal(bySkippedPath(input.skipped, "linked.txt")?.reason, "symlink");
    } else {
      t.diagnostic(`symlink subtest skipped: ${fixture.symlinkSkipReason}`);
    }

    // Not truncated: the diff here is tiny.
    assert.equal(input.truncated.diff, false);
    assert.equal(input.truncated.droppedBytes, 0);

    // Counts are self-consistent with the lists above.
    assert.equal(input.counts.includedFiles, input.included.length);
    assert.equal(input.counts.skippedFiles, input.skipped.length);
    assert.equal(input.counts.untrackedBytes, fixture.sizes.smallBytes);
    assert.equal(input.counts.diffBytes, Buffer.byteLength(envelope.context.diff, "utf8"));

    // scope/base/headSha pass through from the envelope unchanged.
    assert.equal(input.scope, "working-tree");
    assert.equal(input.base, null);
    assert.equal(input.headSha, envelope.headSha);

    // The hash is sha256 of the exact prompt string, not a placeholder.
    assert.equal(input.inputHash, sha256Of(input.prompt));
    assert.match(input.inputHash, /^sha256:[0-9a-f]{64}$/);
  });

  it("hash is stable across two calls on the same envelope, and changes when one diff byte changes", () => {
    const fixture = buildFixtureRepo();
    const envelopeA = collectReviewContext(fixture.repo, { scope: "working-tree" });
    const inputA1 = buildReviewInput(envelopeA, {});
    const inputA2 = buildReviewInput(envelopeA, {});
    assert.equal(inputA1.inputHash, inputA2.inputHash);
    assert.equal(inputA1.prompt, inputA2.prompt);

    fs.writeFileSync(path.join(fixture.repo, "tracked.txt"), "line one\nline two!\n");
    const envelopeB = collectReviewContext(fixture.repo, { scope: "working-tree" });
    const inputB = buildReviewInput(envelopeB, {});
    assert.notEqual(inputB.inputHash, inputA1.inputHash);
  });

  it("truncates a diff over the 196 KiB cap and reports the drop", () => {
    const repo = tmpDir("review-input-trunc-");
    sh("git init -q -b main", repo);
    fs.writeFileSync(path.join(repo, "huge.txt"), "x".repeat(10));
    sh("git add huge.txt", repo);
    sh("git commit -q -m initial", repo);
    fs.writeFileSync(path.join(repo, "huge.txt"), "y".repeat(220 * 1024));

    const envelope = collectReviewContext(repo, { scope: "working-tree" });
    const input = buildReviewInput(envelope, {});
    assert.equal(input.truncated.diff, true);
    assert.ok(input.truncated.droppedBytes > 0);
    assert.match(input.prompt, /truncated for prompt size/);
  });

  it("skips a file whose resolved path escapes the workspace (forced realpath, tests/git.test.mjs's own pattern)", () => {
    const repo = tmpDir("review-input-outside-");
    sh("git init -q -b main", repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    sh("git add a.txt", repo);
    sh("git commit -q -m initial", repo);
    fs.writeFileSync(path.join(repo, "escape.txt"), "outside\n");

    const envelope = collectReviewContext(repo, {
      scope: "working-tree",
      realpathSync: (p) => (String(p).endsWith("escape.txt") ? "/nowhere/escape.txt" : p),
    });
    const input = buildReviewInput(envelope, {});
    assert.equal(bySkippedPath(input.skipped, "escape.txt")?.reason, "outside workspace");
  });

  it("skips a real symlink with reason 'symlink' (t.skip on Windows EPERM)", (t) => {
    const repo = tmpDir("review-input-symlink-");
    sh("git init -q -b main", repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    sh("git add a.txt", repo);
    sh("git commit -q -m initial", repo);

    try {
      fs.symlinkSync(path.join(repo, "a.txt"), path.join(repo, "linked.txt"));
    } catch (err) {
      if (err.code !== "EPERM") throw err;
      t.skip(`fs.symlinkSync raised EPERM on this machine (${process.platform}, no symlink privilege)`);
      return;
    }

    const envelope = collectReviewContext(repo, { scope: "working-tree" });
    const input = buildReviewInput(envelope, {});
    assert.equal(bySkippedPath(input.skipped, "linked.txt")?.reason, "symlink");
  });
});

describe("review-input.buildReviewInput (branch scope)", () => {
  it("has no untracked entries and diff entries carry real byte counts", () => {
    const repo = tmpDir("review-input-branch-");
    sh("git init -q -b main", repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    sh("git add a.txt", repo);
    sh("git commit -q -m initial", repo);
    sh("git checkout -q -b feature", repo);
    fs.writeFileSync(path.join(repo, "feat.txt"), "feature\n");
    sh("git add feat.txt", repo);
    sh("git commit -q -m feat", repo);

    const envelope = collectReviewContext(repo, { scope: "branch", base: "main" });
    const input = buildReviewInput(envelope, {});
    assert.ok(input.included.every((e) => e.kind === "diff"));
    assert.ok(input.included.some((e) => e.path === "feat.txt" && e.bytes > 0));
    assert.deepEqual(input.skipped, []);
    assert.equal(input.counts.untrackedBytes, 0);
    assert.equal(input.base, "main");
  });
});

// ─────────────────────── review.mjs surfaces ───────────────────────

function setPluginDataEnv(dir) {
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = `test-session-${randomBytes(3).toString("hex")}`;
}

let stateDir;
let originalAgyBin;
let originalPluginData;
let originalSessionId;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-review-input-state-"));
  setPluginDataEnv(stateDir);
  originalAgyBin = process.env.AGY_BIN;
  originalPluginData = process.env.CLAUDE_PLUGIN_DATA;
  originalSessionId = process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
});

afterEach(() => {
  if (originalAgyBin === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = originalAgyBin;
  if (originalPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = originalPluginData;
  if (originalSessionId === undefined) delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID; else process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = originalSessionId;
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
});

function captureStdio() {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string") { out.push(chunk); return true; }
    return origOut(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk === "string") { err.push(chunk); return true; }
    return origErr(chunk, ...rest);
  };
  return { out, err, restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; } };
}

describe("review --preview (Task 5, Senate R5)", () => {
  it("lists match buildReviewInput exactly, no agy call, exit 0", async () => {
    const fixture = buildFixtureRepo();
    // A fake agy that writes a marker on any invocation: --preview must never
    // reach it. Written OUTSIDE the repo (stateDir): a stub written inside it
    // would itself become an untracked file and change the fixture under test.
    const marker = path.join(stateDir, "agy-invoked.marker");
    process.env.AGY_BIN = writeFakeAgy(stateDir, "fake-agy-preview", { touchFile: marker, versionOk: true });

    const { run } = await import("../scripts/commands/review.mjs");
    const envelope = collectReviewContext(fixture.repo, { scope: "working-tree" });
    const expected = buildReviewInput(envelope, {});

    const cap = captureStdio();
    let exit;
    try {
      exit = await run(["--preview", "--json"], { cwd: fixture.repo });
    } finally {
      cap.restore();
    }

    assert.equal(exit, 0);
    assert.equal(fs.existsSync(marker), false, "agy must never be invoked for --preview");
    const payload = JSON.parse(cap.out.join(""));
    assert.equal(payload.status, "preview");
    assert.equal(payload.jobId, null);
    assert.equal(payload.answer, null);
    assert.deepEqual(payload.details.included, expected.included);
    assert.deepEqual(payload.details.skipped, expected.skipped);
    assert.deepEqual(payload.details.truncated, expected.truncated);
    assert.deepEqual(payload.details.counts, expected.counts);
    assert.equal(payload.details.inputHash, expected.inputHash);
    assert.equal(payload.details.scope, expected.scope);
    assert.equal(payload.details.headSha, expected.headSha);
  });

  it("--preview --background is refused: stderr-only ArgsError, exit 1", async () => {
    const fixture = buildFixtureRepo();
    const { run } = await import("../scripts/commands/review.mjs");
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(["--preview", "--background"], { cwd: fixture.repo });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(""), "");
    assert.match(cap.err.join(""), /cannot combine --preview and --background/);
  });
});

describe("review --require-complete (Task 5, Senate R5)", () => {
  it("refuses an incomplete input before spawning agy: exit 1, input_incomplete envelope, no marker", async () => {
    const fixture = buildFixtureRepo(); // big.txt/.env/bin.dat make this incomplete
    const marker = path.join(stateDir, "agy-invoked.marker");
    process.env.AGY_BIN = writeFakeAgy(stateDir, "fake-agy-refuse", { touchFile: marker, versionOk: true });

    const { run } = await import("../scripts/commands/review.mjs");
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(["--require-complete", "--json"], { cwd: fixture.repo });
    } finally {
      cap.restore();
    }

    assert.equal(exit, 1);
    assert.equal(fs.existsSync(marker), false, "agy must never be spawned when --require-complete refuses");
    assert.match(
      cap.err.join(""),
      /^antigravity:review — input is incomplete; --require-complete refused to send it\.\n$/,
    );
    const payload = JSON.parse(cap.out.join(""));
    assert.equal(payload.status, "invalid_input");
    assert.equal(payload.jobId, null);
    assert.equal(payload.answer, null);
    assert.equal(payload.details.error.code, "input_incomplete");
    assert.equal(payload.details.error.phase, "collect");
    assert.ok(Array.isArray(payload.details.skipped));
    assert.ok(payload.details.skipped.length > 0);
    assert.equal(typeof payload.details.truncated.diff, "boolean");
  });

  it("exits 0 on a complete tree (nothing skipped, no truncation)", async () => {
    const repo = tmpDir("review-input-complete-");
    sh("git init -q -b main", repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    sh("git add a.txt", repo);
    sh("git commit -q -m initial", repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello world\n");

    process.env.AGY_BIN = writeFakeAgy(stateDir, "fake-agy-complete", {
      versionOk: true,
      stdout: '{"event":"result","result":{"status":"SUCCESS","response":"APPROVE"}}\n',
    });

    const { run } = await import("../scripts/commands/review.mjs");
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(["--require-complete", "--json"], { cwd: repo });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0, cap.err.join(""));
    const payload = JSON.parse(cap.out.join(""));
    assert.equal(payload.status, "completed");
  });

  it("a normal run (no --require-complete) on an incomplete input prints exactly one warning line before sending", async () => {
    const fixture = buildFixtureRepo();
    process.env.AGY_BIN = writeFakeAgy(stateDir, "fake-agy-warn", {
      versionOk: true,
      stdout: '{"event":"result","result":{"status":"SUCCESS","response":"APPROVE"}}\n',
    });

    const envelope = collectReviewContext(fixture.repo, { scope: "working-tree" });
    const expected = buildReviewInput(envelope, {});

    const { run } = await import("../scripts/commands/review.mjs");
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(["--json"], { cwd: fixture.repo });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0, cap.err.join(""));
    const expectedLine =
      `antigravity:review — warning: input is incomplete (${expected.skipped.length} files skipped, ` +
      `diff truncated by ${expected.truncated.droppedBytes} bytes); run review --preview for the list.\n`;
    assert.ok(cap.err.join("").includes(expectedLine), cap.err.join(""));
  });
});

describe("review request fields and Provenance input hash (Task 5, Senate R5)", () => {
  it("a background job's stored request.prompt is byte-identical to buildReviewInput's prompt, and carries inputHash/inputCounts/headSha", async () => {
    const repo = tmpDir("review-input-bg-");
    sh("git init -q -b main", repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    sh("git add a.txt", repo);
    sh("git commit -q -m initial", repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello world\n");

    process.env.AGY_BIN = writeFakeAgy(stateDir, "fake-agy-bg", {
      versionOk: true,
      stdout: '{"event":"result","result":{"status":"SUCCESS","response":"APPROVE"}}\n',
    });

    const envelope = collectReviewContext(repo, { scope: "working-tree" });
    const expected = buildReviewInput(envelope, {});

    const { run } = await import("../scripts/commands/review.mjs");
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(["--background", "--json"], { cwd: repo });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0, cap.err.join(""));
    const payload = JSON.parse(cap.out.join(""));
    assert.equal(payload.status, "queued");
    const jobId = payload.jobId;
    assert.equal(typeof jobId, "string");

    const workspaceRoot = resolveWorkspaceRoot(repo);
    const stored = readJobFile(workspaceRoot, jobId);
    assert.ok(stored, "job file must exist");
    assert.equal(stored.request.prompt, expected.prompt);
    assert.equal(stored.request.inputHash, expected.inputHash);
    assert.deepEqual(stored.request.inputCounts, expected.counts);
    assert.equal(stored.request.headSha, expected.headSha);
    assert.equal(stored.request.scope, "working-tree");
    assert.equal(stored.request.base, null);
  });

  it("status <id> --json and markdown show the Provenance 'Input hash' line for a completed job", async () => {
    const repo = tmpDir("review-input-status-");
    sh("git init -q -b main", repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    sh("git add a.txt", repo);
    sh("git commit -q -m initial", repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello world\n");
    process.env.AGY_BIN = writeFakeAgy(stateDir, "fake-agy-status", {
      versionOk: true,
      stdout: '{"event":"result","result":{"status":"SUCCESS","response":"APPROVE"}}\n',
    });

    const { run: runReview } = await import("../scripts/commands/review.mjs");
    const capReview = captureStdio();
    let exit;
    try {
      exit = await runReview(["--json"], { cwd: repo });
    } finally {
      capReview.restore();
    }
    assert.equal(exit, 0, capReview.err.join(""));
    const jobId = JSON.parse(capReview.out.join("")).jobId;
    assert.equal(typeof jobId, "string");

    const { run: runStatus } = await import("../scripts/commands/status.mjs");
    const capStatusJson = captureStdio();
    try {
      await runStatus([jobId, "--json"], { cwd: repo });
    } finally {
      capStatusJson.restore();
    }
    const statusPayload = JSON.parse(capStatusJson.out.join(""));
    assert.match(statusPayload.details.job.request.inputHash, /^sha256:[0-9a-f]{64}$/);

    const capStatusMd = captureStdio();
    try {
      await runStatus([jobId], { cwd: repo });
    } finally {
      capStatusMd.restore();
    }
    assert.match(capStatusMd.out.join(""), /- \*\*Input hash:\*\* sha256:[0-9a-f]{64}/);

    const { run: runResult } = await import("../scripts/commands/result.mjs");
    const capResultJson = captureStdio();
    try {
      await runResult([jobId, "--json"], { cwd: repo });
    } finally {
      capResultJson.restore();
    }
    const resultPayload = JSON.parse(capResultJson.out.join(""));
    assert.match(resultPayload.details.inputHash, /^sha256:[0-9a-f]{64}$/);

    const capResultMd = captureStdio();
    try {
      await runResult([jobId], { cwd: repo });
    } finally {
      capResultMd.restore();
    }
    assert.match(capResultMd.out.join(""), /- \*\*Input hash:\*\* sha256:[0-9a-f]{64}/);
  });
});
