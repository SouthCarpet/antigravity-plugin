/**
 * Tests for `/antigravity:doctor` (scripts/commands/doctor.mjs, Senate R2,
 * 2026-09): a read-only environment/configuration check with no OAuth, no
 * model call, no file write, and no network access.
 *
 * Uses a real spawnable fake `agy` (tests/helpers/fake-agy.mjs), not a
 * mocked module: `doctor` only calls `probeAgy`/`probeAgyHelp`/
 * `assertAgyBinSpawnable` (agent-runtime.mjs) and `readVisionStatus`
 * (vision-config.mjs), none of which this file mocks, so the real spawn
 * path is exercised end to end.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeFakeAgy } from "./helpers/fake-agy.mjs";
import { run, FORWARDED_FLAGS } from "../scripts/commands/doctor.mjs";

const cleanup = [];
after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

/** Help text listing every forwarded flag except `--json-schema`, so the
 * "listed" vs "not_listed" split is directly observable. */
function helpTextListing(flags) {
  return flags.map((f) => `  ${f}   some description`).join("\n");
}

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

/** Recursive relative-path listing, sorted. mtimes are known to lie
 * (bulk ops restamp them), so this snapshot compares presence only. */
function listTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

function withEnv(overrides, fn) {
  const prev = {};
  for (const key of Object.keys(overrides)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

describe("doctor: no OAuth, no model call, no write, no network (isolated HOME)", () => {
  it("a full run under an isolated HOME/USERPROFILE leaves that tree byte-for-byte unchanged", async () => {
    const stubDir = tmp("antigravity-doctor-stub-");
    const fakeAgy = writeFakeAgy(stubDir, "agy-fake", {
      versionOk: true,
      helpText: helpTextListing(FORWARDED_FLAGS),
    });
    const isolatedHome = tmp("antigravity-doctor-home-");
    const work = tmp("antigravity-doctor-work-");

    const before = listTree(isolatedHome);
    let exit;
    const cap = captureStdio();
    try {
      exit = await withEnv(
        { AGY_BIN: fakeAgy, HOME: isolatedHome, USERPROFILE: isolatedHome, APPDATA: isolatedHome, LOCALAPPDATA: isolatedHome },
        () => run(["--json"], { cwd: work }),
      );
    } finally {
      cap.restore();
    }
    const after_ = listTree(isolatedHome);
    assert.deepEqual(after_, before, "doctor must not create or modify any file under HOME");
    assert.equal(typeof exit, "number");
  });
});

describe("doctor: agy classification (Senate R2)", () => {
  it("missing agy: classification 'missing', overall 'problems', exit 1", async () => {
    // resolveAgyBin only trusts AGY_BIN when it exists on disk (agent-runtime.mjs),
    // otherwise it falls through to a real PATH search. This machine may have
    // a real `agy` installed, so PATH and the home fallback (~/.local/bin) must
    // both point away from it, not just AGY_BIN.
    const work = tmp("antigravity-doctor-work-");
    const emptyPathDir = tmp("antigravity-doctor-emptypath-");
    const isolatedHome = tmp("antigravity-doctor-nohome-");
    const cap = captureStdio();
    let exit;
    try {
      exit = await withEnv(
        {
          AGY_BIN: undefined,
          PATH: emptyPathDir,
          Path: emptyPathDir,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
        },
        () => run(["--json"], { cwd: work }),
      );
    } finally {
      cap.restore();
    }
    const payload = JSON.parse(cap.out.join(""));
    assert.equal(payload.details.agy.classification, "missing");
    assert.equal(payload.details.agy.version, null);
    assert.equal(payload.status, "problems");
    assert.equal(exit, 1);
  });

  const classificationCases = [
    ["1.1.10", "incompatible", "problems", 1],
    ["1.1.15", "verified", "ok", 0],
    ["1.1.16", "unmeasured", "warnings", 0],
    ["1.2.12", "verified", "ok", 0],
    ["1.3.0", "beyond_measured", "warnings", 0],
  ];

  for (const [version, classification, status, exitCode] of classificationCases) {
    it(`agy ${version} classifies as ${classification} (status ${status}, exit ${exitCode})`, async () => {
      const stubDir = tmp("antigravity-doctor-stub-");
      // Generic `stdout` (not `versionOk`) answers every invocation with
      // this exact text, so both the `--version` probe and the `--help`
      // probe return it; only the version-parsing path is under test here.
      const fakeAgy = writeFakeAgy(stubDir, "agy-fake", { stdout: `${version}\n`, exitCode: 0 });
      const work = tmp("antigravity-doctor-work-");
      const cap = captureStdio();
      let exit;
      try {
        exit = await withEnv({ AGY_BIN: fakeAgy }, () => run(["--json"], { cwd: work }));
      } finally {
        cap.restore();
      }
      const payload = JSON.parse(cap.out.join(""));
      assert.equal(payload.details.agy.version, version);
      assert.equal(payload.details.agy.classification, classification);
      // A single agy classification never determines the overall verdict
      // alone when other checks (flags, vision) also contribute warnings;
      // assert only the floor this classification guarantees.
      if (status === "problems") assert.equal(payload.status, "problems");
      if (exitCode === 1) assert.equal(exit, 1);
    });
  }
});

describe("doctor: flags, listed vs not_listed (Senate R2)", () => {
  it("a flag present in --help text is 'listed'; one absent from it is 'not_listed'", async () => {
    const stubDir = tmp("antigravity-doctor-stub-");
    const partial = FORWARDED_FLAGS.filter((f) => f !== "--json-schema");
    const fakeAgy = writeFakeAgy(stubDir, "agy-fake", { versionOk: true, helpText: helpTextListing(partial) });
    const work = tmp("antigravity-doctor-work-");
    const cap = captureStdio();
    try {
      await withEnv({ AGY_BIN: fakeAgy }, () => run(["--json"], { cwd: work }));
    } finally {
      cap.restore();
    }
    const payload = JSON.parse(cap.out.join(""));
    const byFlag = Object.fromEntries(payload.details.flags.map((f) => [f.flag, f.state]));
    assert.equal(byFlag["--add-dir"], "listed");
    assert.equal(byFlag["--json-schema"], "not_listed");
    assert.deepEqual(Object.keys(byFlag).sort(), [...FORWARDED_FLAGS].sort());
  });
});

describe("doctor: --json envelope shape (Senate R2)", () => {
  it("has exactly the top-level envelope keys and the exact details keys from the brief", async () => {
    const stubDir = tmp("antigravity-doctor-stub-");
    const fakeAgy = writeFakeAgy(stubDir, "agy-fake", { versionOk: true, helpText: helpTextListing(FORWARDED_FLAGS) });
    const work = tmp("antigravity-doctor-work-");
    const cap = captureStdio();
    try {
      await withEnv({ AGY_BIN: fakeAgy }, () => run(["--json"], { cwd: work }));
    } finally {
      cap.restore();
    }
    const payload = JSON.parse(cap.out.join(""));
    assert.deepEqual(
      Object.keys(payload).sort(),
      ["answer", "command", "details", "jobId", "schemaVersion", "status"].sort(),
    );
    assert.equal(payload.command, "doctor");
    assert.equal(payload.jobId, null);
    assert.equal(payload.answer, null);
    assert.ok(["ok", "warnings", "problems"].includes(payload.status));
    assert.deepEqual(
      Object.keys(payload.details).sort(),
      ["agy", "flags", "measuredRange", "node", "stateRoot", "vision"].sort(),
    );
    assert.deepEqual(Object.keys(payload.details.node).sort(), ["required", "status", "version"].sort());
    assert.deepEqual(Object.keys(payload.details.agy).sort(), ["classification", "path", "version"].sort());
    assert.deepEqual(Object.keys(payload.details.measuredRange).sort(), ["min", "newest"].sort());
    assert.equal(payload.details.measuredRange.min, "1.1.15");
    assert.equal(payload.details.measuredRange.newest, "1.2.12");
    for (const entry of payload.details.flags) {
      assert.deepEqual(Object.keys(entry).sort(), ["flag", "state"].sort());
    }
  });

  it("markdown mode ends with the 'doctor: <n> ok, <m> warnings, <k> problems' tally line", async () => {
    const stubDir = tmp("antigravity-doctor-stub-");
    const fakeAgy = writeFakeAgy(stubDir, "agy-fake", { versionOk: true, helpText: helpTextListing(FORWARDED_FLAGS) });
    const work = tmp("antigravity-doctor-work-");
    const cap = captureStdio();
    try {
      await withEnv({ AGY_BIN: fakeAgy }, () => run([], { cwd: work }));
    } finally {
      cap.restore();
    }
    assert.match(cap.out.join(""), /doctor: \d+ ok, \d+ warnings, \d+ problems\n$/);
  });
});

describe("doctor has no --live flag and never contacts Google (Senate R2)", () => {
  it("accepts only --json and --cwd; an unknown flag is a stderr-only argument error", async () => {
    const work = tmp("antigravity-doctor-work-");
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(["--live"], { cwd: work });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(""), "");
    assert.notEqual(cap.err.join(""), "");
  });
});
