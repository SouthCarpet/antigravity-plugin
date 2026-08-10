/**
 * Tests for scripts/lib/vision-config.mjs.
 *
 * Every test passes an explicit `homeDir` pointed at a temp directory — the
 * real `~/.gemini` is never touched.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureMcpConfig,
  ensurePermissions,
  ensureVisionConfig,
  resolveVisionServerPath,
} from '../scripts/lib/vision-config.mjs';

const FAKE_SERVER_PATH = path.join('fake', 'vision-server.mjs');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-vision-home-'));
}

function mcpConfigPath(homeDir) {
  return path.join(homeDir, '.gemini', 'config', 'mcp_config.json');
}

function settingsPath(homeDir) {
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
}

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function trackedHome() {
  const dir = freshHome();
  tmpDirs.push(dir);
  return dir;
}

describe('resolveVisionServerPath', () => {
  it('resolves to scripts/mcp/vision-server.mjs', () => {
    const p = resolveVisionServerPath();
    assert.match(p, /scripts[\\/]mcp[\\/]vision-server\.mjs$/);
    assert.ok(fs.existsSync(p), `expected real vision-server.mjs at ${p}`);
  });
});

describe('ensureVisionConfig — fresh install', () => {
  it('creates both files with the vision entries; no backups (nothing pre-existing to back up)', () => {
    const homeDir = trackedHome();
    const { mcpConfig, permissions, summary } = ensureVisionConfig({ homeDir });

    assert.equal(mcpConfig.changed, true);
    assert.equal(permissions.changed, true);
    assert.match(summary[0], /registered the vision MCP server/);
    assert.match(summary[1], /added missing vision permissions/);

    const mcp = JSON.parse(fs.readFileSync(mcpConfigPath(homeDir), 'utf8'));
    assert.equal(mcp.mcpServers.vision.command, 'node');
    assert.ok(mcp.mcpServers.vision.args[0].endsWith('vision-server.mjs'));

    const settings = JSON.parse(fs.readFileSync(settingsPath(homeDir), 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['read_file(*)', 'view_image(*)', 'mcp(*)']);

    // Nothing existed before, so there is nothing to back up yet.
    const dir = path.dirname(mcpConfigPath(homeDir));
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.bak-'));
    assert.deepEqual(backups, []);
  });
});

describe('ensureVisionConfig — merge with pre-existing config', () => {
  it('preserves unrelated keys and writes a same-day backup before changing an existing file', () => {
    const homeDir = trackedHome();
    fs.mkdirSync(path.dirname(mcpConfigPath(homeDir)), { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath(homeDir)), { recursive: true });

    fs.writeFileSync(
      mcpConfigPath(homeDir),
      JSON.stringify({ mcpServers: { other: { command: 'python', args: ['x.py'] } }, unrelated: 1 }),
    );
    fs.writeFileSync(
      settingsPath(homeDir),
      JSON.stringify({ permissions: { allow: ['some_other(*)'] }, unrelatedTop: true }),
    );

    const { mcpConfig, permissions } = ensureVisionConfig({ homeDir });
    assert.equal(mcpConfig.changed, true);
    assert.equal(permissions.changed, true);

    const mcp = JSON.parse(fs.readFileSync(mcpConfigPath(homeDir), 'utf8'));
    assert.equal(mcp.unrelated, 1);
    assert.equal(mcp.mcpServers.other.command, 'python');
    assert.equal(mcp.mcpServers.vision.command, 'node');

    const settings = JSON.parse(fs.readFileSync(settingsPath(homeDir), 'utf8'));
    assert.equal(settings.unrelatedTop, true);
    assert.deepEqual(settings.permissions.allow, ['some_other(*)', 'read_file(*)', 'view_image(*)', 'mcp(*)']);

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    assert.ok(fs.existsSync(`${mcpConfigPath(homeDir)}.bak-${stamp}`));
    assert.ok(fs.existsSync(`${settingsPath(homeDir)}.bak-${stamp}`));
  });
});

describe('ensureVisionConfig — idempotent second run', () => {
  it('makes no writes when config is already correct', () => {
    const homeDir = trackedHome();
    ensureVisionConfig({ homeDir });

    const mcpBefore = fs.statSync(mcpConfigPath(homeDir));
    const settingsBefore = fs.statSync(settingsPath(homeDir));
    const mcpContentBefore = fs.readFileSync(mcpConfigPath(homeDir), 'utf8');
    const settingsContentBefore = fs.readFileSync(settingsPath(homeDir), 'utf8');

    const { mcpConfig, permissions } = ensureVisionConfig({ homeDir });
    assert.equal(mcpConfig.changed, false);
    assert.equal(permissions.changed, false);

    const mcpAfter = fs.statSync(mcpConfigPath(homeDir));
    const settingsAfter = fs.statSync(settingsPath(homeDir));
    assert.equal(mcpAfter.mtimeMs, mcpBefore.mtimeMs);
    assert.equal(settingsAfter.mtimeMs, settingsBefore.mtimeMs);
    assert.equal(fs.readFileSync(mcpConfigPath(homeDir), 'utf8'), mcpContentBefore);
    assert.equal(fs.readFileSync(settingsPath(homeDir), 'utf8'), settingsContentBefore);
  });
});

describe('ensureMcpConfig / ensurePermissions — invalid JSON', () => {
  it('leaves an invalid mcp_config.json untouched and warns, independent of settings.json', () => {
    const homeDir = trackedHome();
    fs.mkdirSync(path.dirname(mcpConfigPath(homeDir)), { recursive: true });
    fs.writeFileSync(mcpConfigPath(homeDir), '{ not valid json');

    const before = fs.readFileSync(mcpConfigPath(homeDir), 'utf8');
    const mcpResult = ensureMcpConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    assert.equal(mcpResult.changed, false);
    assert.match(mcpResult.warning, /invalid JSON/);
    assert.equal(fs.readFileSync(mcpConfigPath(homeDir), 'utf8'), before);

    // settings.json is a separate file/function and is still configured normally.
    const permResult = ensurePermissions({ homeDir });
    assert.equal(permResult.changed, true);
    const settings = JSON.parse(fs.readFileSync(settingsPath(homeDir), 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['read_file(*)', 'view_image(*)', 'mcp(*)']);
  });

  it('leaves an invalid settings.json untouched and warns', () => {
    const homeDir = trackedHome();
    fs.mkdirSync(path.dirname(settingsPath(homeDir)), { recursive: true });
    fs.writeFileSync(settingsPath(homeDir), 'not json at all');

    const before = fs.readFileSync(settingsPath(homeDir), 'utf8');
    const result = ensurePermissions({ homeDir });
    assert.equal(result.changed, false);
    assert.match(result.warning, /invalid JSON/);
    assert.equal(fs.readFileSync(settingsPath(homeDir), 'utf8'), before);
  });
});

describe('ensureMcpConfig — empty file treated as {}', () => {
  it('handles a zero-byte existing file without erroring', () => {
    const homeDir = trackedHome();
    fs.mkdirSync(path.dirname(mcpConfigPath(homeDir)), { recursive: true });
    fs.writeFileSync(mcpConfigPath(homeDir), '');

    const result = ensureMcpConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    assert.equal(result.changed, true);
    const mcp = JSON.parse(fs.readFileSync(mcpConfigPath(homeDir), 'utf8'));
    assert.equal(mcp.mcpServers.vision.args[0], FAKE_SERVER_PATH);
  });
});
