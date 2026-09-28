/**
 * Tests for scripts/pack-for-agy.mjs — the agy-install artifact matches
 * `npm pack`, a corrupted extraction is refused, and the script never
 * spawns `agy` itself.
 *
 * `npm pack` needs no network on a checkout (it tars files already on
 * disk), so every test here runs offline.
 */
import { after, describe, it } from 'node:test';
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
const SYSTEM32 = 'C:\\Windows\\System32';

/** Every temp dir this file creates (test-owned or script-owned), removed once at the end. */
const tempDirsToClean = [];
after(() => {
  for (const dir of tempDirsToClean) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-for-agy-test-'));
  tempDirsToClean.push(dir);
  return dir;
}

/** Run the script with `--json`, assert success, and queue its temp dir for cleanup. */
function runScriptJson(args, extraEnv) {
  const result = runScript(['--json', ...args], extraEnv);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  tempDirsToClean.push(path.dirname(report.dir));
  return report;
}

describe('pack-for-agy: extracted directory matches npm pack exactly', () => {
  it('the extracted file list equals the tarball list from npm pack --dry-run --json', () => {
    const report = runScriptJson([]);

    const extracted = listFilesRecursive(report.dir);
    const expected = dryRunPackFiles();
    assert.deepEqual(extracted, expected);
    assert.equal(report.fileCount, expected.length);
  });

  it('contains no .git, tests/, .github/, or .superpowers/ entries', () => {
    const report = runScriptJson([]);
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

  it('text mode prints the extracted dir, integrity, shasum, file count, and the install command', () => {
    const result = runScript([]);
    assert.equal(result.status, 0, result.stderr);
    tempDirsToClean.push(path.dirname(result.stdout.match(/Extracted: (.+) \(\d+ files\)/)[1]));
    assert.match(result.stdout, /^Packed version /);
    assert.match(result.stdout, /integrity \(sha512\): sha512-/);
    assert.match(result.stdout, /shasum \(sha1\): [0-9a-f]{40}/);
    assert.match(result.stdout, /Extracted: .+ \(\d+ files\)/);
    assert.match(result.stdout, /agy plugin install .+[\\/]package\s*$/m);
  });

  it('--json prints one object with dir, tarball, shasum, integrity, fileCount, version, installCommand', () => {
    const report = runScriptJson([]);
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

describe('pack-for-agy: works with bsdtar (Windows System32 tar) first on PATH', () => {
  it('extracts successfully when System32 resolves before any other tar', { skip: process.platform !== 'win32' }, () => {
    const report = runScriptJson([], { PATH: `${SYSTEM32}${path.delimiter}${process.env.PATH ?? ''}` });
    assert.ok(fs.existsSync(path.join(report.dir, 'package.json')));
    assert.equal(report.fileCount, dryRunPackFiles().length);
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
    tempDirsToClean.push(path.dirname(result.stdout.match(/Extracted: (.+) \(\d+ files\)/)[1]));
  });
});

describe('pack-for-agy: never spawns agy', () => {
  it('a fake agy on PATH is never invoked', async () => {
    const { writeFakeAgy } = await import('./helpers/fake-agy.mjs');
    const binDir = makeTempDir();
    const touchFile = path.join(binDir, 'agy-was-spawned');
    writeFakeAgy(binDir, 'agy', { touchFile, versionOk: true, exitCode: 0 });

    runScriptJson([], { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` });
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

  it('manualExtractCommand() prints cd, a relative tar -xzf, and the agy install line', async () => {
    const mod = await import('../scripts/pack-for-agy.mjs');
    const message = mod.manualExtractCommand('/tmp/x/thing.tgz', '/tmp/x');
    assert.match(message, /cd "\/tmp\/x"/);
    assert.match(message, /tar -xzf "thing\.tgz"/);
    assert.doesNotMatch(message, /-C /);
    assert.match(message, /agy plugin install/);
    assert.match(message, /package/);
  });
});

describe('pack-for-agy: --pack-destination with a space in the path', () => {
  it('packToTarball() writes the tarball into a destination directory whose path contains a space', async (t) => {
    // `packToTarball`'s own doc comment names the exact bug class this
    // guards: "a destination containing a space, quoted by hand into a
    // single command string, came back mangled." The prefix itself carries
    // the space, so the directory `mkdtempSync` returns has one no matter
    // what random suffix it appends.
    let spacedDir;
    try {
      spacedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack for agy '));
    } catch (err) {
      t.skip(`os.tmpdir() cannot host a directory with a space in its name: ${err.message}`);
      return;
    }
    tempDirsToClean.push(spacedDir);
    assert.ok(spacedDir.includes(' '), `fixture directory has no space: ${spacedDir}`);

    const { packToTarball } = await import('../scripts/pack-for-agy.mjs');
    const packed = packToTarball(ROOT, spacedDir);

    assert.equal(path.dirname(packed.path), spacedDir);
    assert.ok(fs.existsSync(packed.path), `expected a tarball at ${packed.path}`);
    assert.ok(packed.filename.length > 0);
    assert.ok(packed.shasum.length > 0);
  });
});
