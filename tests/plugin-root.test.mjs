/**
 * Tests for scripts/lib/plugin-root.mjs's own exports (076-T7 R5b, fix
 * round 1 F1/F2).
 *
 * `tests/command-wrappers.test.mjs` covers `hostBootstrapSource`/`hostBangLine`
 * against the real commands/*.md wrapper files and against a live
 * `require()`-able plugin tree end to end, including the fixture attacks
 * (foreign module, empty/missing root) that motivated F1/F2. This file
 * covers the module's exports directly: the generated one-line snippet's
 * shape — it checks the manifest itself before requiring anything from the
 * root — and the message builders whose wording it reuses.
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

  it('checks the manifest and module presence inline before requiring from the root (F1/F2)', () => {
    const source = hostBootstrapSource('status');
    assert.equal(source.includes('plugin.json'), true, source);
    assert.equal(source.includes('JSON.parse'), true, source);
    assert.equal(source.includes('is not an antigravity plugin tree'), true, source);
    assert.equal(source.includes('runtime not found at'), true, source);
    assert.equal(source.includes('spawnSync'), false, source);
    const manifestCheckIndex = source.indexOf('plugin.json');
    const moduleCheckIndex = source.indexOf("fs.existsSync(p.join(root,'scripts','lib','host-bootstrap.cjs'))");
    const requireIndex = source.indexOf("require(p.join(root,'scripts','lib','host-bootstrap.cjs'))");
    assert.ok(
      manifestCheckIndex >= 0 && moduleCheckIndex > manifestCheckIndex && requireIndex > moduleCheckIndex,
      `manifest and module checks must precede the require() of host-bootstrap.cjs: ${source}`,
    );
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

  // 076-T7 fix round 1 (F1/F2): the manifest check the snippet now carries
  // inline pushed every wrapper's bang line past the pre-fix 400-character
  // bar. The controller's guidance is explicit that correctness wins here
  // ("the 400-character bar for the bang line yields to this check") — this
  // test keeps a sane upper bound so a future regression (e.g. duplicated
  // logic, verbose identifiers) still gets caught, without reintroducing a
  // limit the fix itself cannot meet.
  it('the regenerated bang line of commands/task.md stays reasonably short', () => {
    const line = hostBangLine('task');
    assert.ok(line.length < 900, `bang line is ${line.length} chars: ${line}`);
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
