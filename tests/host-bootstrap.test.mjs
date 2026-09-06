/**
 * Tests for scripts/lib/host-bootstrap.cjs — the shipped CommonJS module the
 * generated `node -e` wrapper snippet require()s (076-T7 R5b).
 *
 * This module is CommonJS on purpose: it must be require()-able
 * synchronously from a one-line `node -e` snippet. An ESM test file can
 * still `import` a `.cjs` module directly (Node's CJS/ESM interop exposes
 * `module.exports` as the default export plus named bindings), so no
 * `createRequire` dance is needed here.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  run,
  isPluginRoot,
  invalidPluginRootMessage,
  missingRuntimeMessage,
} from '../scripts/lib/host-bootstrap.cjs';
import {
  invalidPluginRootMessage as esmInvalidPluginRootMessage,
  missingRuntimeMessage as esmMissingRuntimeMessage,
} from '../scripts/lib/plugin-root.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-host-bootstrap-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeManifest(root, name = 'antigravity') {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name, version: '0.0.0-test' }), 'utf8');
}

function writeVerbScript(root, verb, body) {
  const dir = path.join(root, 'scripts', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${verb}.mjs`), body, 'utf8');
}

describe('host-bootstrap.cjs: wording matches scripts/lib/plugin-root.mjs', () => {
  it('invalidPluginRootMessage and missingRuntimeMessage are byte-identical to the ESM versions', () => {
    assert.equal(invalidPluginRootMessage('/tmp/root', 'status'), esmInvalidPluginRootMessage('/tmp/root', 'status'));
    assert.equal(missingRuntimeMessage('/tmp/x.mjs', 'status'), esmMissingRuntimeMessage('/tmp/x.mjs', 'status'));
  });
});

describe('host-bootstrap.cjs: isPluginRoot', () => {
  it('accepts this repository\'s own tree', () => {
    assert.equal(isPluginRoot(REPO_ROOT), true);
  });

  it('rejects a missing or foreign manifest', () => {
    const foreign = path.join(tmpRoot, 'foreign-manifest-check');
    writeManifest(foreign, 'not-antigravity');
    assert.equal(isPluginRoot(foreign), false);
    assert.equal(isPluginRoot(path.join(tmpRoot, 'does-not-exist')), false);
  });
});

describe('host-bootstrap.cjs: run()', () => {
  it('valid root: spawns the verb and passes its exit code through', () => {
    const root = path.join(tmpRoot, 'valid-root');
    writeManifest(root);
    writeVerbScript(root, 'status', 'process.exit(0);');
    const messages = [];
    const origError = console.error;
    console.error = (m) => messages.push(m);
    let code;
    try {
      code = run(root, 'status', []);
    } finally {
      console.error = origError;
    }
    assert.equal(code, 0);
    assert.deepEqual(messages, []);
  });

  it('exit-code passthrough: a non-zero verb exit is returned unchanged', () => {
    const root = path.join(tmpRoot, 'exit-code-root');
    writeManifest(root);
    writeVerbScript(root, 'status', 'process.exit(7);');
    const code = run(root, 'status', []);
    assert.equal(code, 7);
  });

  it('wrong manifest name: refuses before it spawns anything', () => {
    const root = path.join(tmpRoot, 'wrong-manifest-root');
    writeManifest(root, 'not-antigravity');
    const marker = path.join(root, 'spawned.marker');
    writeVerbScript(root, 'status', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0);`);
    const messages = [];
    const origError = console.error;
    console.error = (m) => messages.push(m);
    let code;
    try {
      code = run(root, 'status', []);
    } finally {
      console.error = origError;
    }
    assert.equal(code, 1);
    assert.deepEqual(messages, [invalidPluginRootMessage(root, 'status')]);
    assert.equal(fs.existsSync(marker), false);
  });

  it('missing runtime: refuses and names the expected script path', () => {
    const root = path.join(tmpRoot, 'missing-runtime-root');
    writeManifest(root);
    const messages = [];
    const origError = console.error;
    console.error = (m) => messages.push(m);
    let code;
    try {
      code = run(root, 'status', []);
    } finally {
      console.error = origError;
    }
    assert.equal(code, 1);
    assert.deepEqual(messages, [missingRuntimeMessage(path.join(root, 'scripts', 'commands', 'status.mjs'), 'status')]);
  });

  it('spawn failure: a nonexistent Node binary reports "failed to start" and returns 1', () => {
    const root = path.join(tmpRoot, 'spawn-failure-root');
    writeManifest(root);
    writeVerbScript(root, 'status', 'process.exit(0);');
    const origExecPath = process.execPath;
    process.execPath = path.join(tmpRoot, 'no-such-node-binary.exe');
    const messages = [];
    const origError = console.error;
    console.error = (m) => messages.push(m);
    let code;
    try {
      code = run(root, 'status', []);
    } finally {
      console.error = origError;
      process.execPath = origExecPath;
    }
    assert.equal(code, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /failed to start/);
  });

  it('argv passthrough: a quoted element with spaces reaches the verb intact', () => {
    const root = path.join(tmpRoot, 'argv-root');
    writeManifest(root);
    const marker = path.join(root, 'argv.json');
    writeVerbScript(
      root,
      'status',
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))); process.exit(0);`,
    );
    const code = run(root, 'status', ['plain', 'has a space and "quotes"', '--json']);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), ['plain', 'has a space and "quotes"', '--json']);
  });
});
