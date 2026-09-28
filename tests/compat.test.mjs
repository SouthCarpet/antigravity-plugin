/**
 * Consistency test (Senate R2, plan 103 T6): `scripts/lib/compat.mjs`'s
 * constants must never drift from the docs that state the same facts in
 * prose: `docs/COMPATIBILITY.md`'s matrix table and `README.md`'s "newest
 * measured <v>" phrase. Reads the docs as text; never imports doc content
 * into the constants (that would make the check trivially pass).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIN_AGY_VERSION,
  LAST_MEASURED_AGY_VERSION,
  MEASURED_AGY_VERSIONS,
  classifyAgyVersion,
} from "../scripts/lib/compat.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/** Every `| <version> | ... |` matrix row in docs/COMPATIBILITY.md, in file order. */
function matrixVersions(source) {
  return [...source.matchAll(/^\|\s*(\d+\.\d+\.\d+)\s*\|/gm)].map((m) => m[1]);
}

describe("compat.mjs stays in sync with the docs", () => {
  it("LAST_MEASURED_AGY_VERSION equals the newest row in docs/COMPATIBILITY.md's matrix table", () => {
    const rows = matrixVersions(read("docs/COMPATIBILITY.md"));
    assert.ok(rows.length > 0, "found no matrix rows in docs/COMPATIBILITY.md");
    assert.equal(rows[rows.length - 1], LAST_MEASURED_AGY_VERSION);
  });

  it("every MEASURED_AGY_VERSIONS entry has a matrix row in docs/COMPATIBILITY.md", () => {
    const rows = new Set(matrixVersions(read("docs/COMPATIBILITY.md")));
    for (const version of MEASURED_AGY_VERSIONS) {
      assert.ok(rows.has(version), `${version} has no docs/COMPATIBILITY.md matrix row`);
    }
  });

  it("README.md's 'newest measured <v>' phrase(s) all equal LAST_MEASURED_AGY_VERSION", () => {
    const matches = [...read("README.md").matchAll(/newest measured (\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.ok(matches.length > 0, "README.md has no 'newest measured <v>' phrase");
    for (const version of matches) assert.equal(version, LAST_MEASURED_AGY_VERSION);
  });

  it("docs/INSTALL.md's 'newest measured <v>' phrase(s) all equal LAST_MEASURED_AGY_VERSION", () => {
    const matches = [...read("docs/INSTALL.md").matchAll(/newest measured (\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.ok(matches.length > 0, "docs/INSTALL.md has no 'newest measured <v>' phrase");
    for (const version of matches) assert.equal(version, LAST_MEASURED_AGY_VERSION);
  });
});

describe("classifyAgyVersion", () => {
  const cases = [
    [null, "missing"],
    [undefined, "missing"],
    ["", "missing"],
    ["1.1.10", "incompatible"],
    ["1.0.0", "incompatible"],
    [MIN_AGY_VERSION, "verified"],
    ["1.1.16", "unmeasured"],
    ["1.1.17", "verified"],
    ["1.1.24", "verified"],
    ["1.1.27", "verified"],
    ["1.2.1", "verified"],
    ["1.2.7", "verified"],
    ["1.2.11", "verified"],
    [LAST_MEASURED_AGY_VERSION, "verified"],
    ["1.2.13", "beyond_measured"],
    ["2.0.0", "beyond_measured"],
  ];

  for (const [version, expected] of cases) {
    it(`classifies ${JSON.stringify(version)} as ${expected}`, () => {
      assert.equal(classifyAgyVersion(version), expected);
    });
  }
});
