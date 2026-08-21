/**
 * Tests for scripts/bump-version.mjs.
 *
 * Every bump and --check run targets a temporary copy of the versioned
 * files. This file never writes package.json / plugin.json / CHANGELOG.md
 * in the real working tree.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bump-version.mjs');

const COPY_FILES = [
  'package.json',
  'plugin.json',
  path.join('.claude-plugin', 'plugin.json'),
  path.join('.codex-plugin', 'plugin.json'),
  path.join('.claude-plugin', 'marketplace.json'),
  path.join('.agents', 'plugins', 'marketplace.json'),
  'CHANGELOG.md',
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

function runBump(root, args) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
}

function makeTree() {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'tree-'));
  for (const rel of COPY_FILES) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), dest);
  }
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
  it('passes when the seven scalars, plugin.json copies, and CHANGELOG agree', () => {
    const root = makeTree();
    const current = readJson(root, 'package.json').version;
    const result = runBump(root, ['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`ok: 7 version scalars agree on ${current}`));
    assert.match(result.stdout, /plugin\.json, \.claude-plugin\/plugin\.json, \.codex-plugin\/plugin\.json are byte-identical/);
    assert.match(result.stdout, new RegExp(`CHANGELOG\\.md has ## \\[${current}\\]`));
    assert.match(result.stdout, /not a git repository; not checking tags/);
  });
});

describe('bump-version --check on a desynced tree', () => {
  it('fails and names the disagreeing scalars and CHANGELOG', () => {
    const root = makeTree();
    desyncPackageJson(root, '9.9.9');
    const result = runBump(root, ['--check']);
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /version check failed:/);
    assert.match(output, /plugin\.json version: 0\.2\.4 \(expected 9\.9\.9\)/);
    assert.match(output, /\.claude-plugin\/marketplace\.json metadata\.version: 0\.2\.4 \(expected 9\.9\.9\)/);
    assert.match(output, /CHANGELOG\.md: missing heading ## \[9\.9\.9\]/);
  });

  it('passes after an explicit bump repairs the desync', () => {
    const root = makeTree();
    desyncPackageJson(root, '9.9.9');
    const red = runBump(root, ['--check']);
    assert.notEqual(red.status, 0);

    const bump = runBump(root, ['9.9.9']);
    assert.equal(bump.status, 0, bump.stderr);
    assertSevenAgree(root, '9.9.9');
    assertPluginCopiesIdentical(root);

    const green = runBump(root, ['--check']);
    assert.equal(green.status, 0, green.stderr);
    assert.match(green.stdout, /ok: 7 version scalars agree on 9\.9\.9/);
  });
});

describe('bump-version increments and explicit targets', () => {
  it('patch / minor / major / explicit update all seven scalars and keep plugin.json copies identical', () => {
    const cases = [
      ['patch', '0.2.5'],
      ['minor', '0.3.0'],
      ['major', '1.0.0'],
      ['1.2.3', '1.2.3'],
    ];
    for (const [arg, expected] of cases) {
      const root = makeTree();
      const result = runBump(root, [arg]);
      assert.equal(result.status, 0, `${arg}: ${result.stderr}`);
      assertSevenAgree(root, expected);
      assertPluginCopiesIdentical(root);
      const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
      assert.match(changelog, new RegExp(`^## \\[${expected}\\] — \\d{4}-\\d{2}-\\d{2}`, 'm'));
      assert.match(
        changelog,
        new RegExp(
          `\\[Unreleased\\]: https://github.com/SouthCarpet/antigravity-plugin/compare/v${expected}\\.\\.\\.HEAD`,
        ),
      );
      assert.match(
        changelog,
        new RegExp(
          `\\[${expected}\\]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0\\.2\\.4\\.\\.\\.v${expected}`,
        ),
      );
    }
  });

  it('promotes [Unreleased] notes into the new version section', () => {
    const root = makeTree();
    const before = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.match(before, /## \[Unreleased\]/);
    assert.match(before, /host surfaces advertised different verbs/);

    const result = runBump(root, ['patch']);
    assert.equal(result.status, 0, result.stderr);
    const after = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const unreleasedBlock = after.split('## [0.2.5]')[0];
    assert.match(unreleasedBlock, /## \[Unreleased\]/);
    assert.doesNotMatch(unreleasedBlock, /host surfaces advertised different verbs/);
    assert.match(after, /## \[0\.2\.5\]/);
    assert.match(after, /host surfaces advertised different verbs/);
  });

  it('refuses patch/minor/major when scalars already drift', () => {
    const root = makeTree();
    desyncPackageJson(root, '0.2.5');
    const result = runBump(root, ['patch']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to apply patch/);
    assert.match(result.stderr, /Pass an explicit target version to repair/);
    assert.equal(readJson(root, 'plugin.json').version, '0.2.4');
  });
});

describe('bump-version invalid input', () => {
  it('rejects an invalid version string with a nonzero exit and a clear message', () => {
    const root = makeTree();
    for (const bad of ['v0.2.5', '1.2', '01.0.0', 'banana', '1.2.3.4']) {
      const result = runBump(root, [bad]);
      assert.notEqual(result.status, 0, bad);
      assert.match(result.stderr, /Invalid version/, bad);
      assert.equal(readJson(root, 'package.json').version, '0.2.4', bad);
    }
  });
});

describe('bump-version git tag report', () => {
  it('reports an existing tag without creating one, and does not move tags', () => {
    const root = makeTree();
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
    git(['tag', 'v0.2.4']);

    const check = runBump(root, ['--check']);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /ok: git tag v0\.2\.4 exists/);

    const bump = runBump(root, ['patch']);
    assert.equal(bump.status, 0, bump.stderr);
    assert.match(bump.stdout, /git tag v0\.2\.5 is absent/);

    const tags = spawnSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' });
    assert.equal(tags.stdout.trim(), 'v0.2.4');
  });
});
