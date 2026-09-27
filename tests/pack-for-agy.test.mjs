/**
 * Tests for scripts/pack-for-agy.mjs — the agy-install artifact matches
 * `npm pack`, a corrupted extraction is refused, and the script never
 * spawns `agy` itself.
 *
 * `npm pack` needs no network on a checkout (it tars files already on
 * disk), so every test here runs offline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'pack-for-agy.mjs');
const TAMPER_PRELOAD = pathToFileURL(
  path.join(ROOT, 'tests', 'helpers', 'tamper-extracted-version.mjs'),
).href;

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/** Every file under `dir`, as sorted paths relative to `dir` (posix separators). */
function listFilesRecursive(dir) {
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs)) {
      const childRel = toPosix(rel ? `${rel}/${name}` : name);
      const childAbs = path.join(abs, name);
      const stat = fs.statSync(childAbs);
      if (stat.isDirectory()) stack.push(childRel);
      else if (stat.isFile()) out.push(childRel);
    }
  }
  return out.sort();
}

/** `npm pack --dry-run --json` file list for `ROOT`, as sorted posix paths. */
function dryRunPackFiles() {
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/c', 'npm pack --dry-run --json'], { cwd: ROOT, encoding: 'utf8' })
      : spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  const report = Array.isArray(parsed) ? parsed[0] : parsed;
  return report.files.map((entry) => toPosix(entry.path)).sort();
}

function runScript(args, extraEnv) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return result;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pack-for-agy-test-'));
}

describe('pack-for-agy: extracted directory matches npm pack exactly', () => {
  it('the extracted file list equals the tarball list from npm pack --dry-run --json', () => {
    const result = runScript(['--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);

    const extracted = listFilesRecursive(report.dir);
    const expected = dryRunPackFiles();
    assert.deepEqual(extracted, expected);
    assert.equal(report.fileCount, expected.length);
  });

  it('contains no .git, tests/, .github/, or .superpowers/ entries', () => {
    const result = runScript(['--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const extracted = listFilesRecursive(report.dir);
    for (const forbidden of ['.git', 'tests/', '.github/', '.superpowers/']) {
      assert.ok(
        !extracted.some((rel) => rel === forbidden || rel.startsWith(forbidden)),
        `${forbidden} must not appear in the extracted tree, saw: ${JSON.stringify(
          extracted.filter((rel) => rel.startsWith(forbidden.split('/')[0])),
        )}`,
      );
    }
  });

  it('text mode prints the extracted dir, sha256, file count, and the install command', () => {
    const result = runScript([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Packed version /);
    assert.match(result.stdout, /sha256: [0-9a-f]{40}/);
    assert.match(result.stdout, /Extracted: .+ \(\d+ files\)/);
    assert.match(result.stdout, /agy plugin install .+[\\/]package\s*$/m);
  });

  it('--json prints one object with dir, tarball, shasum, integrity, fileCount, version, installCommand', () => {
    const result = runScript(['--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(typeof report.dir, 'string');
    assert.match(report.dir, /package$/);
    assert.match(report.tarball, /\.tgz$/);
    assert.match(report.shasum, /^[0-9a-f]{40}$/);
    assert.match(report.integrity, /^sha512-/);
    assert.equal(typeof report.fileCount, 'number');
    assert.ok(report.fileCount > 0);
    assert.equal(typeof report.version, 'string');
    assert.equal(report.installCommand, `agy plugin install ${report.dir}`);
    assert.ok(fs.existsSync(path.join(report.dir, 'package.json')), 'extracted package.json must exist');
  });
});

describe('pack-for-agy: version-mismatch path', () => {
  it('exits 1 with a plain message when the extracted package.json disagrees with the checkout', () => {
    const result = runScript([], {
      NODE_OPTIONS: `--import ${TAMPER_PRELOAD}`,
      ANTIGRAVITY_TEST_TAMPER_VERSION: '0.0.0-tampered',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /0\.0\.0-tampered/);
    assert.match(result.stderr, /does not match/);
  });

  it('a matching checkout still succeeds under the same preload (no env var set)', () => {
    const result = runScript([], { NODE_OPTIONS: `--import ${TAMPER_PRELOAD}` });
    assert.equal(result.status, 0, result.stderr);
  });
});

describe('pack-for-agy: never spawns agy', () => {
  it('a fake agy on PATH is never invoked', async () => {
    const { writeFakeAgy } = await import('./helpers/fake-agy.mjs');
    const binDir = makeTempDir();
    const touchFile = path.join(binDir, 'agy-was-spawned');
    writeFakeAgy(binDir, 'agy', { touchFile, versionOk: true, exitCode: 0 });

    const result = runScript(['--json'], {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(touchFile), 'agy must not be spawned by pack-for-agy.mjs');
  });
});

describe('pack-for-agy: missing package.json in --root', () => {
  it('reports a clear error and exits 1', () => {
    const emptyDir = makeTempDir();
    const result = runScript(['--root', emptyDir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has no package\.json/);
  });
});

describe('pack-for-agy: missing tar', () => {
  const ORIGINAL_PATH = process.env.PATH;

  it('resolveTar() returns null when nothing on PATH answers `tar --version`', async () => {
    const mod = await import('../scripts/pack-for-agy.mjs');
    process.env.PATH = path.dirname(process.execPath);
    try {
      assert.equal(mod.resolveTar(), null);
    } finally {
      process.env.PATH = ORIGINAL_PATH;
    }
  });

  it('manualExtractCommand() prints the manual tar and agy install lines', async () => {
    const mod = await import('../scripts/pack-for-agy.mjs');
    const message = mod.manualExtractCommand('/tmp/x/thing.tgz', '/tmp/x');
    assert.match(message, /tar -xzf "\/tmp\/x\/thing\.tgz" -C "\/tmp\/x"/);
    assert.match(message, /agy plugin install/);
    assert.match(message, /package/);
  });
});
