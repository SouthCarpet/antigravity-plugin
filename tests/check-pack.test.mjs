/**
 * Tests for scripts/check-pack.mjs — computed-import fail-closed rules.
 *
 * Two holes the pack gate must not reopen:
 *   1. `import()` inside a template-literal interpolation is executable
 *      code, not string content, and must fail naming file and line.
 *   2. NAMED_COMPUTED_IMPORTS authorizes one occurrence (file + specifier),
 *      not every computed import in that file.
 *
 * Guards the verifier already confirmed: `import()` text in a line comment
 * or a quoted string must not trip the gate, and the legitimate
 * `bin/antigravity.mjs` command-module load must still pass.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NAMED_COMPUTED_IMPORTS,
  findComputedDynamicImports,
  maskCommentsAndStrings,
  unnamedComputedImports,
} from '../scripts/check-pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-pack.mjs');
const BIN = path.join(ROOT, 'bin', 'antigravity.mjs');
const COMMAND_PREFIX_PATHS = ['scripts/commands/status.mjs'];

function hits(src, file = 'scripts/lib/args.mjs') {
  return findComputedDynamicImports(file, src);
}

function unnamed(src, file, requiredPaths = COMMAND_PREFIX_PATHS) {
  return unnamedComputedImports(hits(src, file), requiredPaths);
}

describe('maskCommentsAndStrings', () => {
  it('is length-preserving so import() indices map back to the original source', () => {
    const src = 'a /* x */ "y" `z${1}` // c\nvoid `${import("x" + ".mjs")}`;\n';
    assert.equal(maskCommentsAndStrings(src).length, src.length);
  });

  it('keeps interpolations as code after a nested template literal', () => {
    // Inner backticks would fool a "mask until next `" scanner into treating
    // the import as string content. Scanning the interpolation as code,
    // then the nested template as a string, then the rest, is required.
    const src = 'void `${ `noimport` + import("x" + ".mjs") }`;\n';
    const masked = maskCommentsAndStrings(src);
    assert.match(masked, /\bimport\s*\(/);
  });

  it('keeps interpolations as code when a nested object brace precedes the import', () => {
    const src = 'void `${ { a: 1 } + import("x" + ".mjs") }`;\n';
    const masked = maskCommentsAndStrings(src);
    assert.match(masked, /\bimport\s*\(/);
  });
});

describe('computed import() in comments and strings stays inert', () => {
  it('still fails a top-level computed import in an unnamed file', () => {
    const found = hits('void import("x" + ".mjs");\n', 'scripts/lib/args.mjs');
    assert.equal(found.length, 1);
    assert.equal(found[0].file, 'scripts/lib/args.mjs');
    assert.equal(found[0].line, 1);
  });

  it('does not trip on import() text in a line comment', () => {
    assert.deepEqual(hits('// import("x" + ".mjs")\nexport const ok = 1;\n'), []);
  });

  it('does not trip on import() text in a quoted string', () => {
    assert.deepEqual(hits('void \'import("x" + ".mjs")\';\n'), []);
    assert.deepEqual(hits('void "import(\'x\' + \'.mjs\')";\n'), []);
  });

  it('does not trip on import() text in a template string part (not interpolation)', () => {
    assert.deepEqual(hits('void `import("x" + ".mjs")`;\n'), []);
  });
});

describe('computed import() inside a template interpolation fails closed', () => {
  it('names the file and line of import() inside `${...}`', () => {
    const src = 'void `${import("x" + ".mjs")}`;\n';
    const found = hits(src, 'scripts/lib/args.mjs');
    assert.equal(found.length, 1);
    assert.equal(found[0].file, 'scripts/lib/args.mjs');
    assert.equal(found[0].line, 1);
  });

  it('scans interpolations after a nested template literal', () => {
    const src = 'void `${ `noimport` + import("x" + ".mjs") }`;\n';
    const found = hits(src, 'scripts/lib/args.mjs');
    assert.equal(found.length, 1);
    assert.equal(found[0].file, 'scripts/lib/args.mjs');
    assert.equal(found[0].line, 1);
  });

  it('scans interpolations nested inside a nested template', () => {
    const src = 'void `${ { t: `${import("x" + ".mjs")}` } }`;\n';
    const found = hits(src, 'scripts/lib/args.mjs');
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 1);
  });

  it('scans interpolations past nested object braces', () => {
    const src = 'void `${ { a: 1 } + import("x" + ".mjs") }`;\n';
    const found = hits(src, 'scripts/lib/args.mjs');
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 1);
  });
});

describe('per-occurrence computed-import authorization', () => {
  const binSrc = fs.readFileSync(BIN, 'utf8');

  it('authorizes the legitimate bin/antigravity.mjs command-module load', () => {
    const found = hits(binSrc, 'bin/antigravity.mjs');
    assert.equal(found.length, 1, `expected one computed import, got ${JSON.stringify(found)}`);
    assert.equal(found[0].line, 142);
    assert.match(found[0].specifier, /pathToFileURL\s*\(\s*modPath\s*\)\s*\.\s*href/);
    assert.deepEqual(unnamedComputedImports(found, COMMAND_PREFIX_PATHS), []);
  });

  it('fails a second computed import in the same named file, naming its line', () => {
    const extra = 'void import("x" + ".mjs");\n';
    const src = extra + binSrc;
    const found = unnamed(src, 'bin/antigravity.mjs');
    assert.equal(found.length, 1, `expected the extra import to be unnamed, got ${JSON.stringify(found)}`);
    assert.equal(found[0].file, 'bin/antigravity.mjs');
    assert.equal(found[0].line, 1);
    assert.notEqual(found[0].line, 143);
  });

  it('does not let a second identical specifier ride along with one named entry', () => {
    const src = `${binSrc}\ncmd = await import(pathToFileURL(modPath).href);\n`;
    const found = unnamed(src, 'bin/antigravity.mjs');
    assert.equal(found.length, 1);
    assert.ok(found[0].line > 142);
  });

  it('still requires the named prefix to already be in the required set', () => {
    const found = hits(binSrc, 'bin/antigravity.mjs');
    const unnamedHits = unnamedComputedImports(found, ['scripts/lib/args.mjs']);
    assert.equal(unnamedHits.length, 1);
    assert.equal(unnamedHits[0].line, 142);
  });

  it('names each authorized occurrence by specifier, not merely by filename', () => {
    assert.equal(NAMED_COMPUTED_IMPORTS.length, 1);
    const entry = NAMED_COMPUTED_IMPORTS[0];
    assert.equal(entry.file, 'bin/antigravity.mjs');
    assert.equal(entry.requiredPrefix, 'scripts/commands/');
    assert.equal(typeof entry.specifier.test, 'function');
    assert.ok(entry.specifier.test('pathToFileURL(modPath).href'));
    assert.ok(!entry.specifier.test('"x" + ".mjs"'));
  });
});

describe('check-pack CLI (legitimate tree)', () => {
  it('passes on the real tree, including the named bin/antigravity.mjs import', () => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.equal(res.status, 0, text);
    assert.match(text, /ok: required pack entries/);
    assert.doesNotMatch(text, /computed dynamic import/);
  });
});
