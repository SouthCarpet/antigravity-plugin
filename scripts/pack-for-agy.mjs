#!/usr/bin/env node
/**
 * Build the exact tarball npm would publish, extract it, and print the
 * `agy plugin install <dir>` command for it.
 *
 * Why this script exists: `agy plugin install <path>` copies the *whole*
 * directory it is pointed at — `.git`, `tests/`, `.github/`, everything —
 * it does not read `package.json` `files` (docs/INSTALL.md "agy itself").
 * Pointing agy at a clean checkout still ships those extra trees into
 * `~/.gemini/config/plugins/antigravity/`. Pointing it at the *packed and
 * re-extracted* tarball ships exactly what `npm publish` would ship,
 * because that is the same artifact.
 *
 * This script never runs `agy` and never touches `~/.gemini`. It writes
 * only under one `fs.mkdtempSync` directory in `os.tmpdir()`, which it
 * leaves in place (there is nothing to clean up automatically: the printed
 * `agy plugin install <dir>` command still needs that directory to exist).
 *
 * Steps:
 *   1. `npm pack --json --pack-destination <tmp>` in the target checkout.
 *   2. Extract the reported tarball with `tar -xzf` into the same
 *      directory (`tar` missing -> print the manual extraction command,
 *      exit 1, run nothing else).
 *   3. Verify `<extracted>/package.json` `.version` equals the checkout's
 *      own `package.json` `.version` (a corrupted or stale tarball would
 *      disagree) -> otherwise exit 1 with a plain message.
 *   4. Print the extracted directory, the shasum, the file count, and the
 *      exact next command.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } = fs;

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return [
    'Usage:',
    '  node scripts/pack-for-agy.mjs [--json]',
    '',
    'Packs this checkout the same way `npm publish` would, extracts that',
    'tarball into a fresh temporary directory, and prints the',
    '`agy plugin install <dir>` command for the extracted copy.',
    '',
    'Options:',
    '  --json        Print one JSON object instead of plain text.',
    '  --root <dir>  Pack a different checkout (tests). Default: this repo.',
    '  --help, -h    Print this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { json: false, root: defaultRoot, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--root') {
      const root = argv[i + 1];
      if (!root) throw new Error(`--root requires a directory.\n\n${usage()}`);
      options.root = root;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

function readJson(root, rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'));
}

/**
 * `npm pack --json --pack-destination <destDir>` for `root`. Returns the
 * one report `npm pack --json` emits (it prints a one-element array).
 * On Windows, `npm` is `npm.cmd`; Node's `spawn`/`spawnSync` cannot launch
 * a `.cmd` file without `{ shell: true }` since the CVE-2024-27980 fix, so
 * this runs it through `cmd.exe /c` instead (same approach as
 * `scripts/check-pack.mjs`'s `npm pack --dry-run --json` call).
 */
export function packToTarball(root, destDir) {
  const quotedDest = destDir.includes(' ') ? `"${destDir}"` : destDir;
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/c', `npm pack --json --pack-destination ${quotedDest}`], {
          cwd: root,
          encoding: 'utf8',
        })
      : spawnSync('npm', ['pack', '--json', '--pack-destination', destDir], {
          cwd: root,
          encoding: 'utf8',
        });

  if (result.status !== 0) {
    throw new Error(
      `npm pack failed (exit ${result.status}).\n${result.stderr || result.stdout || ''}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`could not parse npm pack JSON: ${err.message}\n${result.stdout}`);
  }
  const report = Array.isArray(parsed) ? parsed[0] : parsed;
  return {
    filename: report.filename,
    shasum: report.shasum,
    integrity: report.integrity,
    path: join(destDir, report.filename),
  };
}

/** `tar --version` on PATH, or null when `tar` cannot be spawned at all. */
export function resolveTar() {
  const result = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return 'tar';
}

/** Printed when `tar` is missing: the same extraction done by hand. */
export function manualExtractCommand(tarballPath, destDir) {
  return [
    '`tar` is not on PATH. Extract the tarball yourself, then install that directory:',
    '',
    `  tar -xzf "${tarballPath}" -C "${destDir}"`,
    `  agy plugin install "${join(destDir, 'package')}"`,
  ].join('\n');
}

/**
 * Extract `tarballPath` into `destDir` and return the extracted `package/`
 * dir. `--force-local` is required on Windows: GNU tar treats an archive
 * path with a colon right after the drive letter (`C:\Users\...`) as a
 * `host:file` remote-archive spec unless told the path is always local.
 */
export function extractTarball(tarballPath, destDir) {
  const result = spawnSync('tar', ['--force-local', '-xzf', tarballPath, '-C', destDir], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `tar extraction failed (exit ${result.status}).\n${result.stderr || result.stdout || ''}`,
    );
  }
  return join(destDir, 'package');
}

/** Every file under `dir`, recursively (directories are not counted). */
export function countFiles(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const abs = join(current, name);
      const stat = statSync(abs);
      if (stat.isDirectory()) stack.push(abs);
      else if (stat.isFile()) count += 1;
    }
  }
  return count;
}

/**
 * Compare `<extractedDir>/package.json` `.version` to `expectedVersion`
 * (the checkout's own version). A mismatch means the tarball this script
 * just built and extracted does not match the checkout it came from —
 * a corrupted or stale extraction, never a normal outcome.
 */
export function verifyVersion(extractedDir, expectedVersion) {
  const pkg = readJson(extractedDir, 'package.json');
  return { ok: pkg.version === expectedVersion, actual: pkg.version };
}

export function buildReport({ dir, tarball, shasum, integrity, fileCount, version }) {
  return {
    dir,
    tarball,
    shasum,
    integrity,
    fileCount,
    version,
    installCommand: `agy plugin install ${dir}`,
  };
}

function printReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Packed version ${report.version}`);
  console.log(`Tarball: ${report.tarball}`);
  console.log(`sha256: ${report.shasum}`);
  console.log(`Extracted: ${report.dir} (${report.fileCount} files)`);
  console.log('');
  console.log('Next:');
  console.log(`  ${report.installCommand}`);
  console.log('');
  console.log(`Delete ${dirname(report.dir)} when you no longer need it.`);
}

export function run(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const root = resolve(options.root);
  if (!existsSync(join(root, 'package.json'))) {
    throw new Error(`${root} has no package.json.\n\n${usage()}`);
  }
  const expectedVersion = readJson(root, 'package.json').version;

  // The prefix deliberately avoids "anti"/"antigravity": Git for Windows'
  // MSYS `tar` mis-parses an archive path whose immediate parent directory
  // contains that substring (reproduced 2026-09-27 — the same tarball
  // extracts fine one directory level down; the tarball's own filename,
  // which does contain "antigravity-plugin", is unaffected). The Windows
  // System32 `tar.exe` (bsdtar) does not have this bug, but this prefix
  // change avoids it for whichever `tar` PATH resolves to.
  const destDir = mkdtempSync(join(os.tmpdir(), 'pack-for-agy-'));
  const packed = packToTarball(root, destDir);

  if (!resolveTar()) {
    throw new Error(manualExtractCommand(packed.path, destDir));
  }

  const extractedDir = extractTarball(packed.path, destDir);
  const { ok, actual } = verifyVersion(extractedDir, expectedVersion);
  if (!ok) {
    throw new Error(
      `Extracted package.json version ${actual} does not match ${root}'s package.json ` +
        `version ${expectedVersion}. The tarball may be stale or corrupted; run this again.`,
    );
  }

  const report = buildReport({
    dir: extractedDir,
    tarball: packed.filename,
    shasum: packed.shasum,
    integrity: packed.integrity,
    fileCount: countFiles(extractedDir),
    version: actual,
  });
  printReport(report, options.json);
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  let modulePath;
  let entryPath;
  try {
    modulePath = resolve(fileURLToPath(import.meta.url));
    entryPath = resolve(entry);
  } catch {
    return false;
  }
  if (process.platform === 'win32') {
    return modulePath.toLowerCase() === entryPath.toLowerCase();
  }
  return modulePath === entryPath;
}

if (isMainModule()) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
