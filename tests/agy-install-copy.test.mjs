import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAgyInstallCopy } from '../scripts/lib/agy-install-copy.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERBS = ['cancel', 'doctor', 'rescue', 'result', 'review', 'setup', 'status', 'task', 'vision'];

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-install-copy-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'package');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"@southcarpet/antigravity-plugin","version":"3.0.0"}');
  fs.writeFileSync(path.join(source, 'plugin.json'), '{"name":"antigravity","version":"3.0.0"}');
  fs.cpSync(path.join(ROOT, 'agy-skills'), path.join(source, 'agy-skills'), { recursive: true });
  fs.writeFileSync(path.join(source, 'runtime.txt'), 'unchanged runtime');
  return { source, target: path.join(temp, 'antigravity') };
}

function snapshot(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name)))
    .sort()
    .map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]);
}

it('prepares a separate canonical antigravity copy without changing source files', (t) => {
  // Oracle: prepared agy copy adds standard skills; npm/source has no root skills.
  const { source, target } = fixture(t);
  const before = snapshot(source);
  assert.equal(prepareAgyInstallCopy(source), target);
  assert.deepEqual(snapshot(source), before);
  assert.equal(fs.existsSync(path.join(source, 'skills')), false);
  assert.equal(fs.readFileSync(path.join(target, 'runtime.txt'), 'utf8'), 'unchanged runtime');
  assert.deepEqual(fs.readdirSync(path.join(target, 'skills')).sort(), VERBS);
});

for (const verb of VERBS) {
  it(`prepared ${verb} keeps its exact public name under the standard skills directory`, (t) => {
    // Oracle: live TUI discovery requires the exact name antigravity:<verb>.
    const { source } = fixture(t);
    const target = prepareAgyInstallCopy(source);
    const skill = fs.readFileSync(path.join(target, 'skills', verb, 'SKILL.md'), 'utf8');
    const names = [...skill.matchAll(/^name: (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(names, [`antigravity:${verb}`]);
    assert.equal(skill, fs.readFileSync(path.join(source, 'agy-skills', verb, 'SKILL.md'), 'utf8'));
  });
}

it('preparing the same extracted copy twice is idempotent', (t) => {
  // Oracle: retry must not change files or add duplicate skills.
  const { source, target } = fixture(t);
  prepareAgyInstallCopy(source);
  const before = snapshot(target);
  assert.equal(prepareAgyInstallCopy(source), target);
  assert.deepEqual(snapshot(target), before);
});

it('refuses a foreign manifest before creating a prepared copy', (t) => {
  const { source, target } = fixture(t);
  fs.writeFileSync(path.join(source, 'plugin.json'), '{"name":"foreign","version":"3.0.0"}');
  assert.throws(() => prepareAgyInstallCopy(source), /foreign or inconsistent/);
  assert.equal(fs.existsSync(target), false);
});

it('refuses a missing wrapper before creating a prepared copy', (t) => {
  const { source, target } = fixture(t);
  fs.unlinkSync(path.join(source, 'agy-skills', 'doctor', 'SKILL.md'));
  assert.throws(() => prepareAgyInstallCopy(source), /exactly the nine/);
  assert.equal(fs.existsSync(target), false);
});

it('refuses an extra wrapper before creating a prepared copy', (t) => {
  const { source, target } = fixture(t);
  fs.mkdirSync(path.join(source, 'agy-skills', 'extra'));
  fs.writeFileSync(path.join(source, 'agy-skills', 'extra', 'SKILL.md'), '---\nname: extra\n---');
  assert.throws(() => prepareAgyInstallCopy(source), /exactly the nine/);
  assert.equal(fs.existsSync(target), false);
});

it('refuses a path-derived name instead of accepting a namespace leak', (t) => {
  const { source, target } = fixture(t);
  const file = path.join(source, 'agy-skills', 'doctor', 'SKILL.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('name: antigravity:doctor', 'name: other:doctor'));
  assert.throws(() => prepareAgyInstallCopy(source), /doctor must declare exactly name: antigravity:doctor/);
  assert.equal(fs.existsSync(target), false);
});

it('refuses an existing prepared copy that differs without overwriting it', (t) => {
  const { source, target } = fixture(t);
  prepareAgyInstallCopy(source);
  fs.writeFileSync(path.join(target, 'runtime.txt'), 'foreign runtime');
  assert.throws(() => prepareAgyInstallCopy(source), /existing antigravity copy differs/);
  assert.equal(fs.readFileSync(path.join(target, 'runtime.txt'), 'utf8'), 'foreign runtime');
});

it('source distribution has no root skills folder or native manifest field', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'skills')), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'))), 'skills'), false);
  assert.equal(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'), fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'), fs.readFileSync(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
});
