/**
 * Tests for scripts/bump-version.mjs.
 *
 * Every bump and --check run targets a temporary copy of the versioned
 * files. This file never writes package.json / plugin.json / CHANGELOG.md
 * in the real working tree.
 *
 * Version numbers are read from the fixture's package.json. Nothing in
 * this file names a release (past, current, or next).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bump-version.mjs');
const FAIL_WRITE_PRELOAD = pathToFileURL(
  path.join(REPO_ROOT, 'tests', 'helpers', 'fail-write-sync.mjs'),
).href;

/** Same constant the bump script writes into CHANGELOG compare links. */
const COMPARE_REPO = 'https://github.com/SouthCarpet/antigravity-plugin';

/**
 * Distinctive Unreleased bullet. Post-release trees have an empty
 * [Unreleased] section, and the script refuses to increment without
 * notes; seeding means these tests do not depend on leftover real copy.
 */
const FIXTURE_UNRELEASED_NOTE =
  '- **fixture promotion probe** — unique to bump-version tests.';

const COPY_FILES = [
  'package.json',
  'plugin.json',
  path.join('.claude-plugin', 'plugin.json'),
  path.join('.codex-plugin', 'plugin.json'),
  path.join('.claude-plugin', 'marketplace.json'),
  path.join('.agents', 'plugins', 'marketplace.json'),
  'CHANGELOG.md',
  'README.md',
];

const SCALAR_READERS = [
  ['package.json version', (root) => readJson(root, 'package.json').version],
  ['plugin.json version', (root) => readJson(root, 'plugin.json').version],
  [
    '.claude-plugin/plugin.json version',
    (root) => readJson(root, path.join('.claude-plugin', 'plugin.json')).version,
  ],
  [
    '.codex-plugin/plugin.json version',
    (root) => readJson(root, path.join('.codex-plugin', 'plugin.json')).version,
  ],
  [
    '.claude-plugin/marketplace.json metadata.version',
    (root) => readJson(root, path.join('.claude-plugin', 'marketplace.json')).metadata.version,
  ],
  [
    '.claude-plugin/marketplace.json plugins[0].version',
    (root) => readJson(root, path.join('.claude-plugin', 'marketplace.json')).plugins[0].version,
  ],
  [
    '.agents/plugins/marketplace.json metadata.version',
    (root) => readJson(root, path.join('.agents', 'plugins', 'marketplace.json')).metadata.version,
  ],
];

const PLUGIN_COPIES = [
  'plugin.json',
  path.join('.claude-plugin', 'plugin.json'),
  path.join('.codex-plugin', 'plugin.json'),
];

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function currentVersion(root) {
  const version = readJson(root, 'package.json').version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package.json version missing in test fixture');
  }
  return version;
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSemverCore(version) {
  const match = String(version).match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/);
  if (!match) {
    throw new Error(`test fixture version is not semver: ${version}`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Independent expected increment; not imported from the script under test. */
function nextVersion(current, kind) {
  let { major, minor, patch } = parseSemverCore(current);
  if (kind === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === 'minor') {
    minor += 1;
    patch = 0;
  } else if (kind === 'patch') {
    patch += 1;
  } else {
    throw new Error(`unknown increment ${kind}`);
  }
  return `${major}.${minor}.${patch}`;
}

/** A strict semver that cannot equal `current`, used as a drift / explicit target. */
function otherVersion(current) {
  const { major } = parseSemverCore(current);
  return `${major + 8}.9.9`;
}

function previousFromChangelog(root) {
  const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const match = text.match(/^\[Unreleased\]:\s+\S+\/compare\/v([^/\s]+)\.\.\.HEAD/m);
  return match ? match[1] : currentVersion(root);
}

function seedUnreleasedNotes(root, note = FIXTURE_UNRELEASED_NOTE) {
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const text = fs.readFileSync(changelogPath, 'utf8');
  const next = text.replace(
    /^## \[Unreleased\][ \t]*$/m,
    `## [Unreleased]\n\n### Fixed\n\n${note}`,
  );
  if (next === text) {
    throw new Error('CHANGELOG.md ## [Unreleased] heading not found in test fixture');
  }
  fs.writeFileSync(changelogPath, next);
}

function runBump(root, args, options = {}) {
  const nodeArgs = [];
  const env = { ...process.env };
  if (options.failWrite) {
    nodeArgs.push('--import', FAIL_WRITE_PRELOAD);
    env.ANTIGRAVITY_TEST_FAIL_WRITE = options.failWrite;
  }
  return spawnSync(process.execPath, [...nodeArgs, SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env,
  });
}

function snapshotCopyFiles(root) {
  /** @type {Map<string, Buffer>} */
  const snap = new Map();
  for (const rel of COPY_FILES) {
    snap.set(rel, fs.readFileSync(path.join(root, rel)));
  }
  return snap;
}

function leftoverStagingTemps(root) {
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.\d+\.tmp$/.test(ent.name)) hits.push(path.relative(root, p));
    }
  };
  walk(root);
  return hits;
}

function makeTree() {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'tree-'));
  for (const rel of COPY_FILES) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), dest);
  }
  seedUnreleasedNotes(root);
  return root;
}

function allScalars(root) {
  return SCALAR_READERS.map(([label, get]) => ({ label, value: get(root) }));
}

function assertSevenAgree(root, version) {
  const values = allScalars(root);
  assert.equal(values.length, 7);
  for (const { label, value } of values) {
    assert.equal(value, version, label);
  }
}

function assertPluginCopiesIdentical(root) {
  const bodies = PLUGIN_COPIES.map((rel) => fs.readFileSync(path.join(root, rel)));
  for (const other of bodies.slice(1)) {
    assert.equal(Buffer.compare(bodies[0], other), 0);
  }
}

function desyncPackageJson(root, version) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** Same token the bump script pins: a line starting `> **vX.Y.Z.**`. */
const README_STATUS_RE = /^> \*\*v([^*]+)\.\*\*/m;

function desyncReadmeStatus(root, version) {
  const readmePath = path.join(root, 'README.md');
  const text = fs.readFileSync(readmePath, 'utf8');
  const next = text.replace(README_STATUS_RE, `> **v${version}.**`);
  if (next === text) {
    throw new Error('README.md Status blockquote not found in test fixture');
  }
  fs.writeFileSync(readmePath, next);
}

function readmeStatusVersion(root) {
  const text = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const match = text.match(README_STATUS_RE);
  return match ? match[1] : null;
}

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-bump-suite-'));
});

after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('bump-version --check on a coherent tree', () => {
  it('passes when the seven scalars, plugin.json copies, CHANGELOG, and README Status agree', () => {
    const root = makeTree();
    const current = currentVersion(root);
    const result = runBump(root, ['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`ok: 7 version scalars agree on ${escapeRe(current)}`));
    assert.match(result.stdout, /plugin\.json, \.claude-plugin\/plugin\.json, \.codex-plugin\/plugin\.json are byte-identical/);
    assert.match(result.stdout, new RegExp(`CHANGELOG\\.md has ## \\[${escapeRe(current)}\\]`));
    assert.match(result.stdout, new RegExp(`README\\.md Status is v${escapeRe(current)}`));
    assert.match(result.stdout, /not a git repository; not checking tags/);
  });
});

describe('bump-version --check on a desynced tree', () => {
  it('fails and names the disagreeing scalars and CHANGELOG', () => {
    const root = makeTree();
    const current = currentVersion(root);
    const drifted = otherVersion(current);
    desyncPackageJson(root, drifted);
    const result = runBump(root, ['--check']);
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /version check failed:/);
    assert.match(
      output,
      new RegExp(`plugin\\.json version: ${escapeRe(current)} \\(expected ${escapeRe(drifted)}\\)`),
    );
    assert.match(
      output,
      new RegExp(
        `\\.claude-plugin/marketplace\\.json metadata\\.version: ${escapeRe(current)} \\(expected ${escapeRe(drifted)}\\)`,
      ),
    );
    assert.match(output, new RegExp(`CHANGELOG\\.md: missing heading ## \\[${escapeRe(drifted)}\\]`));
    assert.match(
      output,
      new RegExp(`README\\.md Status: v${escapeRe(current)} \\(expected v${escapeRe(drifted)}\\)`),
    );
  });

  it('fails when only the README Status version drifts', () => {
    const root = makeTree();
    const current = currentVersion(root);
    const drifted = otherVersion(current);
    desyncReadmeStatus(root, drifted);
    const result = runBump(root, ['--check']);
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /version check failed:/);
    assert.match(
      output,
      new RegExp(`README\\.md Status: v${escapeRe(drifted)} \\(expected v${escapeRe(current)}\\)`),
    );
  });

  it('passes after an explicit bump repairs the desync', () => {
    const root = makeTree();
    const current = currentVersion(root);
    const drifted = otherVersion(current);
    desyncPackageJson(root, drifted);
    const red = runBump(root, ['--check']);
    assert.notEqual(red.status, 0);

    const bump = runBump(root, [drifted]);
    assert.equal(bump.status, 0, bump.stderr);
    assertSevenAgree(root, drifted);
    assertPluginCopiesIdentical(root);

    const green = runBump(root, ['--check']);
    assert.equal(green.status, 0, green.stderr);
    assert.match(green.stdout, new RegExp(`ok: 7 version scalars agree on ${escapeRe(drifted)}`));
    assert.match(green.stdout, new RegExp(`README\\.md Status is v${escapeRe(drifted)}`));
    assert.equal(readmeStatusVersion(root), drifted);
  });
});

describe('bump-version README Status token', () => {
  it('fails --check when the Status line uses the old Pre-release shape', () => {
    const root = makeTree();
    const current = currentVersion(root);
    const readmePath = path.join(root, 'README.md');
    const text = fs.readFileSync(readmePath, 'utf8');
    const next = text.replace(README_STATUS_RE, `> **Pre-release (v${current}).**`);
    assert.notEqual(next, text);
    fs.writeFileSync(readmePath, next);

    const result = runBump(root, ['--check']);
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /README\.md: missing Status blockquote \*\*vX\.Y\.Z\.\*\*/);
  });

  it('fails --check when the Status token is a different semver', () => {
    const root = makeTree();
    const current = currentVersion(root);
    const drifted = otherVersion(current);
    desyncReadmeStatus(root, drifted);
    const result = runBump(root, ['--check']);
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(
      output,
      new RegExp(`README\\.md Status: v${escapeRe(drifted)} \\(expected v${escapeRe(current)}\\)`),
    );
  });

  it('rewrites only the version token and leaves freeze wording intact', () => {
    const root0 = makeTree();
    const current = currentVersion(root0);
    const cases = [
      ['major', nextVersion(current, 'major')],
      [nextVersion(current, 'patch'), nextVersion(current, 'patch')],
      [otherVersion(current), otherVersion(current)],
    ];
    for (const [arg, expected] of cases) {
      const root = makeTree();
      const before = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
      assert.match(before, new RegExp(`^> \\*\\*v${escapeRe(current)}\\.\\*\\*`, 'm'));
      assert.match(before, /frozen for 1\.x/);
      assert.match(before, /docs\/COMPATIBILITY\.md/);

      const result = runBump(root, [arg]);
      assert.equal(result.status, 0, `${arg}: ${result.stderr}`);
      const after = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
      assert.match(after, new RegExp(`^> \\*\\*v${escapeRe(expected)}\\.\\*\\*`, 'm'));
      assert.doesNotMatch(after, /Pre-release/);
      assert.match(after, /frozen for 1\.x/);
      assert.match(after, /docs\/COMPATIBILITY\.md/);
      assert.match(after, /CHANGELOG\.md/);
      assert.equal(readmeStatusVersion(root), expected);

      const check = runBump(root, ['--check']);
      assert.equal(check.status, 0, `${arg} --check: ${check.stderr}`);
      assert.match(check.stdout, new RegExp(`README\\.md Status is v${escapeRe(expected)}`));
    }
  });
});

describe('bump-version increments and explicit targets', () => {
  it('patch / minor / major / explicit update all seven scalars and keep plugin.json copies identical', () => {
    const root0 = makeTree();
    const current = currentVersion(root0);
    const previous = previousFromChangelog(root0);
    const cases = [
      ['patch', nextVersion(current, 'patch')],
      ['minor', nextVersion(current, 'minor')],
      ['major', nextVersion(current, 'major')],
      [otherVersion(current), otherVersion(current)],
    ];
    for (const [arg, expected] of cases) {
      const root = makeTree();
      const result = runBump(root, [arg]);
      assert.equal(result.status, 0, `${arg}: ${result.stderr}`);
      assertSevenAgree(root, expected);
      assertPluginCopiesIdentical(root);
      assert.equal(readmeStatusVersion(root), expected);
      const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
      assert.match(changelog, new RegExp(`^## \\[${escapeRe(expected)}\\] — \\d{4}-\\d{2}-\\d{2}`, 'm'));
      assert.match(
        changelog,
        new RegExp(
          `\\[Unreleased\\]: ${escapeRe(COMPARE_REPO)}/compare/v${escapeRe(expected)}\\.\\.\\.HEAD`,
        ),
      );
      assert.match(
        changelog,
        new RegExp(
          `\\[${escapeRe(expected)}\\]: ${escapeRe(COMPARE_REPO)}/compare/v${escapeRe(previous)}\\.\\.\\.v${escapeRe(expected)}`,
        ),
      );
    }
  });

  it('promotes [Unreleased] notes into the new version section', () => {
    const root = makeTree();
    const patch = nextVersion(currentVersion(root), 'patch');
    const before = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.match(before, /## \[Unreleased\]/);
    assert.match(before, /fixture promotion probe/);

    const result = runBump(root, ['patch']);
    assert.equal(result.status, 0, result.stderr);
    const after = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const heading = `## [${patch}]`;
    const headingAt = after.indexOf(heading);
    assert.notEqual(headingAt, -1, `missing ${heading}`);
    const unreleasedBlock = after.slice(0, headingAt);
    assert.match(unreleasedBlock, /## \[Unreleased\]/);
    assert.doesNotMatch(unreleasedBlock, /fixture promotion probe/);
    assert.match(after, new RegExp(`## \\[${escapeRe(patch)}\\]`));
    assert.match(after, /fixture promotion probe/);
  });

  it('refuses patch/minor/major when scalars already drift', () => {
    const root = makeTree();
    const current = currentVersion(root);
    desyncPackageJson(root, nextVersion(current, 'patch'));
    const result = runBump(root, ['patch']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to apply patch/);
    assert.match(result.stderr, /Pass an explicit target version to repair/);
    assert.equal(readJson(root, 'plugin.json').version, current);
  });
});

describe('bump-version invalid input', () => {
  it('rejects an invalid version string with a nonzero exit and a clear message', () => {
    const root = makeTree();
    const current = currentVersion(root);
    for (const bad of [`v${nextVersion(current, 'patch')}`, '1.2', '01.0.0', 'banana', '1.2.3.4']) {
      const result = runBump(root, [bad]);
      assert.notEqual(result.status, 0, bad);
      assert.match(result.stderr, /Invalid version/, bad);
      assert.equal(readJson(root, 'package.json').version, current, bad);
    }
  });
});

describe('bump-version git tag report', () => {
  it('reports an existing tag without creating one, and does not move tags', () => {
    const root = makeTree();
    const current = currentVersion(root);
    const patch = nextVersion(current, 'patch');
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@example.com',
    };
    const git = (args) => {
      const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv });
      assert.equal(res.status, 0, res.stderr);
      return res;
    };
    git(['init', '-q', '-b', 'main']);
    git(['add', 'package.json']);
    git(['commit', '-q', '-m', 'seed']);
    git(['tag', `v${current}`]);

    const check = runBump(root, ['--check']);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, new RegExp(`ok: git tag v${escapeRe(current)} exists`));

    const bump = runBump(root, ['patch']);
    assert.equal(bump.status, 0, bump.stderr);
    assert.match(bump.stdout, new RegExp(`git tag v${escapeRe(patch)} is absent`));

    const tags = spawnSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' });
    assert.equal(tags.stdout.trim(), `v${current}`);
  });
});

describe('bump-version write failure does not half-bump', () => {
  it('leaves every versioned file byte-identical when a later staging write fails', () => {
    const root = makeTree();
    const current = currentVersion(root);
    const before = snapshotCopyFiles(root);
    const failWrite = path.join('.agents', 'plugins', 'marketplace.json');

    const result = runBump(root, ['patch'], { failWrite });
    assert.notEqual(result.status, 0, result.stdout);
    const output = `${result.stderr}${result.stdout}`;
    assert.match(output, /injected write failure/);
    assert.match(output, /No target files were replaced/);

    for (const [rel, buf] of before) {
      const after = fs.readFileSync(path.join(root, rel));
      assert.equal(Buffer.compare(after, buf), 0, `${rel} changed after a failed bump`);
    }
    assertSevenAgree(root, current);
    assert.equal(readmeStatusVersion(root), current);
    assert.deepEqual(leftoverStagingTemps(root), []);

    const check = runBump(root, ['--check']);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, new RegExp(`ok: 7 version scalars agree on ${escapeRe(current)}`));
  });
});
