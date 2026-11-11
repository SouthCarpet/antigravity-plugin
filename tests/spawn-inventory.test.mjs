/**
 * Inventory of the ways a shipped file can start a process.
 *
 * Every shipped file starts processes through scripts/lib/process-adapter.mjs,
 * which sets the hide option. This test reads every shipped `.mjs`, `.cjs`
 * and `.js` file (the `files` list of package.json) and fails when a file
 * outside the allow-list reaches `child_process` another way. Each
 * allow-list entry carries its reason.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js']);

/** Shipped files that may load `child_process` themselves. */
const CHILD_PROCESS_ALLOW_LIST = new Map([
  ['scripts/lib/process-adapter.mjs', 'the adapter itself: the one place that calls Node'],
  ['scripts/lib/host-bootstrap.cjs',
    'CommonJS file that a host runs with `node -e` before any ES module can load; ' +
    'it cannot import the adapter, so it sets windowsHide: true itself (checked below)'],
]);

/** Shipped files that may name `spawnInteractive`, the adapter entry that does not hide the window. */
const INTERACTIVE_ALLOW_LIST = new Map([
  ['scripts/lib/process-adapter.mjs', 'defines it'],
  ['scripts/commands/setup.mjs',
    'the interactive sign-in run: agy inherits the terminal, and its start must stay ' +
    'exactly as it was, because a sign-in with a real agy cannot be tested here'],
]);

/**
 * Other ways to start a process without `child_process`: internal bindings,
 * the builtin-module getter, and helper packages that wrap `child_process`.
 */
const ESCAPE_PATTERNS = [
  ['a child_process module specifier', /['"`](?:node:)?child_process['"`]/],
  ['process.binding', /\bprocess\s*\.\s*binding\s*\(/],
  ['process._linkedBinding', /\bprocess\s*\.\s*_linkedBinding\s*\(/],
  ['process.getBuiltinModule', /\bprocess\s*\.\s*getBuiltinModule\s*\(/],
  ['a process helper package',
    /['"`](?:execa|cross-spawn|tinyexec|nano-spawn|shelljs|zx|node-pty|foreground-child|child-process-promise|spawn-command)(?:\/[^'"`]*)?['"`]/],
];

/** Lines of code: a line that is only a comment (`//`, `/*`, ` * ...`) is left out. */
function codeLines(source) {
  return source.split(/\r?\n/).filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line));
}

/** The names of the escape patterns that `source` matches. */
function findProcessEscapes(source) {
  const code = codeLines(source).join('\n');
  return ESCAPE_PATTERNS.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
}

function walk(target, out) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      if (entry !== 'node_modules') walk(path.join(target, entry), out);
    }
  } else if (CODE_EXTENSIONS.has(path.extname(target))) {
    out.push(path.relative(ROOT, target).split(path.sep).join('/'));
  }
  return out;
}

function shippedCodeFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const out = [];
  for (const entry of pkg.files) {
    const target = path.join(ROOT, entry);
    if (fs.existsSync(target)) walk(target, out);
  }
  return out.sort();
}

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('the scanner itself', () => {
  const cases = [
    ["import { spawn } from 'node:child_process';", ['a child_process module specifier']],
    ['import { spawn } from "child_process";', ['a child_process module specifier']],
    ["const cp = require('child_process');", ['a child_process module specifier']],
    ["const cp = await import('node:child_process');", ['a child_process module specifier']],
    ['const cp = await import(`node:child_process`);', ['a child_process module specifier']],
    ["const cp = process.getBuiltinModule('node:child_process');",
      ['a child_process module specifier', 'process.getBuiltinModule']],
    ["const b = process.binding('spawn_sync');", ['process.binding']],
    ["const b = process._linkedBinding('x');", ['process._linkedBinding']],
    ["import { execa } from 'execa';", ['a process helper package']],
    ["const spawn = require('cross-spawn');", ['a process helper package']],
    ["import { spawn } from './process-adapter.mjs';", []],
    [" * @param {import('node:child_process').ChildProcess} child", []],
    ["// import { spawn } from 'node:child_process';", []],
    ["/** see `node:child_process` and 'child_process' */", []],
  ];
  for (const [source, expected] of cases) {
    it(`reports ${JSON.stringify(expected)} for ${source}`, () => {
      assert.deepEqual(findProcessEscapes(source), expected);
    });
  }
});

describe('shipped files start processes only through process-adapter.mjs', () => {
  const files = shippedCodeFiles();

  it('finds the shipped code files', () => {
    // A wrong `files` walk would make every check below pass on nothing.
    for (const expected of ['bin/antigravity.mjs', 'scripts/commands/_worker.mjs', 'scripts/lib/process.mjs',
      'scripts/lib/host-bootstrap.cjs', 'scripts/mcp/vision-server.mjs', 'scripts/pack-for-agy.mjs',
      'scripts/prepare-for-agy.mjs']) {
      assert.ok(files.includes(expected), `${expected} is in the shipped file list`);
    }
  });

  it('no file outside the allow-list reaches child_process', () => {
    const offenders = files
      .filter((file) => !CHILD_PROCESS_ALLOW_LIST.has(file))
      .map((file) => ({ file, found: findProcessEscapes(read(file)) }))
      .filter((entry) => entry.found.length > 0);
    assert.deepEqual(offenders, []);
  });

  it('every allow-list entry is a shipped file that still needs its entry', () => {
    for (const [file, reason] of CHILD_PROCESS_ALLOW_LIST) {
      assert.ok(files.includes(file), `${file} is shipped`);
      assert.ok(reason.length > 0);
      assert.deepEqual(findProcessEscapes(read(file)), ['a child_process module specifier'], file);
    }
  });

  it('only setup.mjs calls spawnInteractive', () => {
    const users = files.filter((file) => /\bspawnInteractive\b/.test(codeLines(read(file)).join('\n')));
    assert.deepEqual(users, [...INTERACTIVE_ALLOW_LIST.keys()].sort());
  });

  it('host-bootstrap.cjs starts one process and sets the hide option on it', () => {
    const code = codeLines(read('scripts/lib/host-bootstrap.cjs')).join('\n');
    const calls = code.match(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g) ?? [];
    assert.deepEqual(calls, ['spawnSync(']);
    const call = code.slice(code.indexOf('spawnSync('));
    const optionsLiteral = call.slice(0, call.indexOf('});'));
    assert.match(optionsLiteral, /^\s*windowsHide: true,$/m);
  });
});
