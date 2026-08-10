/**
 * Regression tests for parseCommandInput's lone-element handling.
 *
 * A single argv element with no whitespace must NOT be routed through
 * splitRawArgumentString: its backslash-escape grammar would corrupt
 * Windows paths (`C:\shots\a.png` → `C:shotsa.png`), which is exactly the
 * simplest real invocation `/antigravity:vision <path>`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseCommandInput } from "../scripts/lib/args.mjs";

describe("parseCommandInput lone-element handling", () => {
  it("preserves backslashes in a lone whitespace-free Windows path", () => {
    const { options, positionals } = parseCommandInput(
      ["C:\\Users\\Public\\shot.png"],
      { valueOptions: ["prompt", "model", "cwd"], booleanOptions: ["json"] },
    );
    assert.deepEqual(positionals, ["C:\\Users\\Public\\shot.png"]);
    assert.deepEqual(options, {});
  });

  it("still splits a lone raw string that contains whitespace and flags", () => {
    const { options, positionals } = parseCommandInput(
      ['shot.png --prompt "what is this"'],
      { valueOptions: ["prompt"], booleanOptions: ["json"] },
    );
    assert.deepEqual(positionals, ["shot.png"]);
    assert.equal(options.prompt, "what is this");
  });

  it("still splits a lone multi-positional raw string", () => {
    const { positionals } = parseCommandInput(["before.png after.png"], {});
    assert.deepEqual(positionals, ["before.png", "after.png"]);
  });

  it("passes multi-element argv through untouched (existing behavior)", () => {
    const { options, positionals } = parseCommandInput(
      ["C:\\a\\b.png", "--json"],
      { booleanOptions: ["json"] },
    );
    assert.deepEqual(positionals, ["C:\\a\\b.png"]);
    assert.equal(options.json, true);
  });
});
