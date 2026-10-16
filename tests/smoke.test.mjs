import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASH = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe')
  : 'bash';

// These shell stubs leave only the validator's output and exit code variable.
// Oracle: agy 1.4.0 validate exits 0 for success, 1 for invalid manifests;
// older supported agy prints [ok], while 1.4.0 prints Validation passed.
const STUB_COMMANDS = `
agy() {
  if [[ "$1" == --version ]]; then printf '1.4.0\\n'; return; fi
  if [[ "$1" != plugin || "$2" != validate || "$#" != 3 ]]; then return 99; fi
  printf '%s\\n' "$VALIDATE_OUTPUT"
  return "$VALIDATE_EXIT"
}
npm() { printf '# fail 0\\n'; }
node() {
  if [[ "$1" == */scripts/check-manifests.mjs ]]; then return 0; fi
  if [[ "$1" == --version || "$2" == --version ]]; then printf '3.0.0\\n'; return; fi
  if [[ "$2" == help ]]; then printf 'usage: review flags\\n'; return; fi
  if [[ "$2" == notacommand ]]; then printf 'unknown command\\n'; return 2; fi
  printf 'https://antigravity.google/download\\n'
  return 2
}
`;

function runSmoke(t, output, exit) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-smoke-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const stubs = path.join(temp, 'stubs.sh');
  fs.writeFileSync(stubs, STUB_COMMANDS);
  return spawnSync(BASH, ['-c', 'source "$1"; source "$2"', '--', stubs, path.join(ROOT, 'scripts', 'smoke.sh')], {
    encoding: 'utf8',
    env: { ...process.env, VALIDATE_OUTPUT: output, VALIDATE_EXIT: String(exit) },
    timeout: 30_000,
  });
}

it('smoke accepts legacy [ok] validation output with exit 0', (t) => {
  const result = runSmoke(t, '[ok] antigravity\ncommands: 9 processed', 0);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /agy plugin validate exited 0/);
});

it('smoke accepts agy 1.4.0 Validation passed output with exit 0', (t) => {
  const result = runSmoke(t, 'Validating antigravity\n✔ Validation passed', 0);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Validation passed/);
});

it('smoke accepts changed success prose because exit status is the oracle', (t) => {
  const result = runSmoke(t, 'No findings.', 0);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /No findings\./);
});

it('smoke fails a nonzero validator even when its output contains success text', (t) => {
  const result = runSmoke(t, '[ok]\nValidation passed\nError: invalid manifest', 1);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /agy plugin validate exited non-zero/);
  assert.match(result.stdout, /Error: invalid manifest/);
});
