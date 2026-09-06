/**
 * Tests for scripts/lib/plugin-root.mjs's own exports (076-T7 R5b).
 *
 * `tests/command-wrappers.test.mjs` covers `hostBootstrapSource`/`hostBangLine`
 * against the real commands/*.md wrapper files and against a live
 * `require()`-able plugin tree end to end. This file covers the module's
 * exports directly: the generated one-line snippet's shape (no string-built
 * refusal logic left in it after R5b), and the message builders it no longer
 * embeds inline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hostBootstrapSource,
  hostBangLine,
  invalidPluginRootMessage,
  missingRuntimeMessage,
  isPluginRoot,
  resolvePluginRoot,
  agyPluginInstallDir,
  AGY_PLUGIN_INSTALL_SEGMENTS,
} from '../scripts/lib/plugin-root.mjs';

describe('plugin-root.mjs: hostBootstrapSource is a thin one-line handoff (R5b)', () => {
  it('resolves the root the same way as before and requires host-bootstrap.cjs with the verb', () => {
    const source = hostBootstrapSource('status');
    assert.match(source, /process\.env\.CLAUDE_PLUGIN_ROOT\|\|/);
    assert.match(source, /'scripts','lib','host-bootstrap\.cjs'/);
    assert.match(source, /\.run\(root,'status'\)/);
    assert.match(source, /process\.exit\(/);
  });

  it('carries no interpolated refusal message or manifest-check logic any more', () => {
    const source = hostBootstrapSource('status');
    assert.equal(source.includes('is not an antigravity plugin tree'), false);
    assert.equal(source.includes('runtime not found at'), false);
    assert.equal(source.includes('plugin.json'), false);
    assert.equal(source.includes('JSON.parse'), false);
    assert.equal(source.includes('spawnSync'), false);
  });

  it('is free of $ and % so shells do not interpolate it', () => {
    const source = hostBootstrapSource('review');
    assert.equal(source.includes('$'), false, source);
    assert.equal(source.includes('%'), false, source);
    assert.equal(
      source.includes(AGY_PLUGIN_INSTALL_SEGMENTS.map((s) => `'${s}'`).join(',')),
      true,
    );
  });

  it('rejects a verb that would break the generated snippet', () => {
    assert.throws(() => hostBootstrapSource('review.mjs'), /invalid verb/);
    assert.throws(() => hostBootstrapSource("review';process.exit(0)//"), /invalid verb/);
  });

  it('the regenerated bang line of commands/task.md stays under 400 characters', () => {
    const line = hostBangLine('task');
    assert.ok(line.length < 400, `bang line is ${line.length} chars: ${line}`);
  });

  it('hostBangLine keeps the frozen shape: bang-backtick, node -e, -- $ARGUMENTS', () => {
    const line = hostBangLine('status');
    assert.match(line, /^!`node -e "/);
    assert.match(line, /" -- \$ARGUMENTS`$/);
  });
});

describe('plugin-root.mjs: message builders (still ESM, used by tests and docs)', () => {
  it('invalidPluginRootMessage names the root and the standalone CLI', () => {
    assert.equal(
      invalidPluginRootMessage('/tmp/foreign', 'status'),
      'antigravity-plugin: /tmp/foreign is not an antigravity plugin tree ' +
        '(plugin.json missing or name mismatch). ' +
        'Run: npx @southcarpet/antigravity-plugin status',
    );
  });

  it('missingRuntimeMessage names the path and the standalone CLI', () => {
    const message = missingRuntimeMessage('/tmp/missing.mjs', 'status');
    assert.match(message, /runtime not found at \/tmp\/missing\.mjs/);
    assert.match(message, /npx @southcarpet\/antigravity-plugin status/);
  });
});

describe('plugin-root.mjs: root resolution (unchanged by R5b)', () => {
  it('CLAUDE_PLUGIN_ROOT wins when set and non-empty', () => {
    assert.equal(
      resolvePluginRoot({ env: { CLAUDE_PLUGIN_ROOT: '/opt/claude-plugin' }, homedir: '/home/nobody' }),
      '/opt/claude-plugin',
    );
  });

  it('falls back to the agy install copy under homedir', () => {
    const home = '/home/agy-user';
    assert.equal(resolvePluginRoot({ env: {}, homedir: home }), agyPluginInstallDir(home));
  });

  it("accepts this repository's own tree", () => {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    assert.equal(isPluginRoot(ROOT), true);
  });
});
