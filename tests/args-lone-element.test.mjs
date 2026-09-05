/** Argument boundaries supplied by a host or shell are authoritative. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCommandInput } from "../scripts/lib/args.mjs";

const schema = {
  valueOptions: ["prompt", "mode"],
  repeatableOptions: ["add-dir"],
  booleanOptions: ["foreground", "json"],
};

describe("parseCommandInput preserves argv boundaries", () => {
  it("keeps flag-like words in a lone prompt", () => {
    assert.deepEqual(parseCommandInput(["Explain --mode accept-edits"], schema), {
      positionals: ["Explain --mode accept-edits"], options: {},
    });
  });

  it("keeps embedded mode and directory flags in a two-element argv prompt", () => {
    assert.deepEqual(parseCommandInput([
      "Explain --mode accept-edits --add-dir C:/x", "--foreground",
    ], schema), {
      positionals: ["Explain --mode accept-edits --add-dir C:/x"],
      options: { foreground: true },
    });
  });

  it("keeps a shell-quoted Windows image path with spaces as one positional", () => {
    assert.deepEqual(parseCommandInput(["C:\\Program Files\\shot.png"], schema), {
      positionals: ["C:\\Program Files\\shot.png"], options: {},
    });
  });

  it("keeps two shell-quoted image paths intact alongside flags", () => {
    assert.deepEqual(parseCommandInput([
      "C:\\before shots\\a.png", "C:\\after shots\\b.png", "--json",
    ], schema), {
      positionals: ["C:\\before shots\\a.png", "C:\\after shots\\b.png"],
      options: { json: true },
    });
  });

  it("preserves empty argv elements and literal quote characters", () => {
    assert.deepEqual(parseCommandInput(["", 'say "hi"'], schema), {
      positionals: ["", 'say "hi"'], options: {},
    });
  });

  it("preserves flag-like words after the terminator", () => {
    assert.deepEqual(parseCommandInput(["--", "explain", "--verbose"], schema), {
      positionals: ["explain", "--verbose"], options: {},
    });
  });
});
