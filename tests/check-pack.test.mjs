/**
 * Tests for scripts/check-pack.mjs — derived required set vs `npm pack`.
 *
 * The gate walks static imports and literal `import("…")` only. Computed
 * specifiers are out of scope; their targets must already be required by
 * an explicit rule.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deriveRequired,
  listReadmeLinkedDocs,
  readmeDeadLinkErrors,
} from '../scripts/check-pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-pack.mjs');

describe('check-pack CLI (legitimate tree)', () => {
  it('passes on the real tree', () => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.equal(res.status, 0, text);
    assert.match(text, /ok: required pack entries/);
  });
});

describe('check-pack: the documentation an installed copy needs', () => {
  it('requires CHANGELOG.md and the README itself', () => {
    const required = deriveRequired();
    assert.ok(required.has('CHANGELOG.md'), 'CHANGELOG.md must be required');
    assert.ok(required.has('README.md'), 'README.md must be required');
  });

  it('derives the docs from the README links, and finds more than one', () => {
    const linked = listReadmeLinkedDocs();
    const docs = linked.filter((rel) => rel.startsWith('docs/'));
    assert.ok(docs.length > 1, `expected several linked docs, got ${JSON.stringify(linked)}`);
    // Derived, not listed: every link target exists and is a markdown file.
    for (const rel of linked) {
      assert.match(rel, /\.md$/);
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} should exist on disk`);
    }
    const required = deriveRequired();
    for (const rel of linked) assert.ok(required.has(rel), `${rel} must be required`);
  });

  it('drops a link that leaves the package, and keeps no target that is absent', () => {
    const linked = listReadmeLinkedDocs();
    assert.ok(!linked.some((rel) => rel.startsWith('../')), 'no target may escape the package root');
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /\]\(https:\/\//, 'the README holds absolute links, which must not be required');
    assert.ok(!linked.some((rel) => rel.startsWith('http')), 'an absolute link is not a pack entry');
  });

  it('fails on a README link to a package .md file that is not on disk', () => {
    // The fixture holds one dead link, one live link, and one link that
    // leaves the package. Only the dead one may be reported.
    const fixture = 'tests/helpers/dead-link-readme.md';
    assert.ok(fs.existsSync(path.join(ROOT, fixture)), `${fixture} should exist`);
    assert.ok(!fs.existsSync(path.join(ROOT, 'tests/helpers/missing-doc.md')));

    const errors = readmeDeadLinkErrors(fixture);
    assert.deepEqual(errors, [
      `${fixture} links ./missing-doc.md but tests/helpers/missing-doc.md is not on disk`,
    ]);

    const linked = listReadmeLinkedDocs(fixture);
    assert.deepEqual(linked, ['docs/COMPATIBILITY.md']);
  });

  it('reports no dead link for the real README', () => {
    assert.deepEqual(readmeDeadLinkErrors(), []);
  });

  it('`files` ships every required documentation entry', () => {
    const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;
    const shipped = (rel) => files.includes(rel) || files.includes(rel.split('/')[0]);
    for (const rel of ['CHANGELOG.md', 'README.md', ...listReadmeLinkedDocs()]) {
      assert.ok(shipped(rel), `package.json "files" must cover ${rel}`);
    }
  });
});
