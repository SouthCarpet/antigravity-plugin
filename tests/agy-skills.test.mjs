import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveRequired } from '../scripts/check-pack.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERBS = ['cancel', 'doctor', 'rescue', 'result', 'review', 'setup', 'status', 'task', 'vision'];

function readSkill(verb) {
  return fs.readFileSync(path.join(ROOT, 'agy-skills', verb, 'SKILL.md'), 'utf8');
}

function commandSource(verb) {
  const match = readSkill(verb).match(/```sh\r?\nnode -e "([^"]+)" --\r?\n```/);
  assert.ok(match, `${verb} must supply an executable terminal command`);
  return match[1];
}

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-skill-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Oracle: frozen nine-verb contract, not an inventory inferred from the tree.
it('native skill discovery exposes exactly the nine public verbs', () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'agy-skills')).sort(), VERBS);
});

for (const verb of VERBS) {
  it(`native ${verb} is required by the pack gate even if its file is dropped`, () => {
    assert.equal(deriveRequired().get(`agy-skills/${verb}/SKILL.md`), 'agy native wrapper for the same runtime verb');
  });

  it(`native ${verb} runs that runtime and preserves complete argument values`, (t) => {
    // Oracle: the documented bootstrap runs exactly this verb with only
    // invocation arguments, including spaces and shell metacharacters.
    const root = tempRoot(t);
    fs.mkdirSync(path.join(root, 'scripts', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugin.json'), '{"name":"antigravity"}');
    fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', 'host-bootstrap.cjs'), path.join(root, 'scripts', 'lib', 'host-bootstrap.cjs'));
    fs.writeFileSync(path.join(root, 'scripts', 'commands', `${verb}.mjs`), 'console.log(JSON.stringify(process.argv.slice(2)));');
    const result = spawnSync(process.execPath, ['-e', commandSource(verb), '--', '--json', 'two words', 'literal $ & %'], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['--json', 'two words', 'literal $ & %']);
    // Prepared installs use the standard directory and exact public names.
    const names = [...readSkill(verb).matchAll(/^name: (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(names, [`antigravity:${verb}`]);
    assert.match(readSkill(verb), /Do not substitute your own answer/);
  });
}

it('native wrapper refuses a foreign tree before loading its bootstrap module', (t) => {
  // Oracle: app trust boundary requires a matching manifest before loading code.
  const root = tempRoot(t);
  const marker = path.join(root, 'foreign-module-ran');
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugin.json'), '{"name":"foreign"}');
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'host-bootstrap.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const result = spawnSync(process.execPath, ['-e', commandSource('doctor'), '--'], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /name mismatch/);
  assert.equal(fs.existsSync(marker), false, 'foreign module must not run');
});
