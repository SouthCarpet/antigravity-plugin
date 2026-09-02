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
  removeVisionConfig,
  resolveVisionServerPath,
  VISION_PERMISSION,
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

function receiptPath(homeDir) {
  return path.join(homeDir, '.gemini', 'antigravity-plugin-vision.json');
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
    assert.match(summary[1], /allowed only mcp\(vision\/view_image\)/);

    const mcp = JSON.parse(fs.readFileSync(mcpConfigPath(homeDir), 'utf8'));
    assert.equal(mcp.mcpServers.vision.command, process.execPath);
    assert.ok(mcp.mcpServers.vision.args[0].endsWith('vision-server.mjs'));

    const settings = JSON.parse(fs.readFileSync(settingsPath(homeDir), 'utf8'));
    assert.deepEqual(settings.permissions.allow, [VISION_PERMISSION]);
    assert.ok(fs.existsSync(receiptPath(homeDir)));

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

    // Fixed, injected clock instead of the live system date: the backup
    // stamp is asserted against the exact date passed in, not against
    // whatever `new Date()` happens to return the moment the test runs (a
    // real midnight rollover between computing the expected stamp and the
    // library's internal `new Date()` call would otherwise make this flake).
    // Local noon, not a UTC instant: todayStamp() reads local Y/M/D, and a
    // UTC instant near midnight would round to a different local calendar
    // date in some timezones, defeating the point of fixing the clock.
    const now = new Date(2026, 2, 14, 12, 0, 0);
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const { mcpConfig, permissions } = ensureVisionConfig({ homeDir, now });
    assert.equal(mcpConfig.changed, true);
    assert.equal(permissions.changed, true);

    const mcp = JSON.parse(fs.readFileSync(mcpConfigPath(homeDir), 'utf8'));
    assert.equal(mcp.unrelated, 1);
    assert.equal(mcp.mcpServers.other.command, 'python');
    assert.equal(mcp.mcpServers.vision.command, process.execPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath(homeDir), 'utf8'));
    assert.equal(settings.unrelatedTop, true);
    assert.deepEqual(settings.permissions.allow, ['some_other(*)', VISION_PERMISSION]);

    assert.ok(fs.existsSync(`${mcpConfigPath(homeDir)}.bak-${stamp}`));
    assert.ok(fs.existsSync(`${settingsPath(homeDir)}.bak-${stamp}`));
  });
});

describe('ensureMcpConfig — conflict detection', () => {
  it('refuses to overwrite a vision server registered by someone else', () => {
    const homeDir = trackedHome();
    const filePath = mcpConfigPath(homeDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const original = {
      mcpServers: { vision: { command: 'someone-else', args: ['their-server.js'] } },
      unrelated: true,
    };
    fs.writeFileSync(filePath, JSON.stringify(original));

    const result = ensureMcpConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    assert.equal(result.changed, false);
    assert.match(result.warning, /conflict/i);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), original);
  });

  it('does not claim ownership from the server path alone when the command is foreign', () => {
    const homeDir = trackedHome();
    const filePath = mcpConfigPath(homeDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const original = { mcpServers: { vision: { command: 'foreign-runtime', args: [FAKE_SERVER_PATH] } } };
    fs.writeFileSync(filePath, JSON.stringify(original));

    const result = ensureMcpConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    assert.equal(result.changed, false);
    assert.match(result.warning, /conflict/i);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), original);
  });
});

describe('ensureVisionConfig — idempotent second run', () => {
  it('makes no writes when config is already correct', () => {
    const homeDir = trackedHome();
    ensureVisionConfig({ homeDir });

    const mcpContentBefore = fs.readFileSync(mcpConfigPath(homeDir), 'utf8');
    const settingsContentBefore = fs.readFileSync(settingsPath(homeDir), 'utf8');

    // mtimeMs before/after is not proof on its own: two synchronous calls in
    // the same test can land in the same millisecond tick, so a real write
    // could go undetected (a false green). Faking the owned atomic-writer
    // boundary (see defaultAtomicWriter in vision-config.mjs) instead of
    // mocking fs.renameSync directly proves the same thing without reaching
    // into a node:fs export this module does not own (TotT R9).
    let writeCount = 0;
    const fakeAtomicWriter = { write() { writeCount += 1; } };
    const { mcpConfig, permissions } = ensureVisionConfig({ homeDir, atomicWriter: fakeAtomicWriter });
    assert.equal(mcpConfig.changed, false);
    assert.equal(permissions.changed, false);
    assert.equal(writeCount, 0, 'ensureVisionConfig must not write any file when nothing changed');

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
    assert.deepEqual(settings.permissions.allow, [VISION_PERMISSION]);
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

  it('preflights both files so invalid settings causes no MCP partial update', () => {
    const homeDir = trackedHome();
    fs.mkdirSync(path.dirname(mcpConfigPath(homeDir)), { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath(homeDir)), { recursive: true });
    const mcpBefore = JSON.stringify({ unrelated: 'keep' });
    const settingsBefore = '{ invalid';
    fs.writeFileSync(mcpConfigPath(homeDir), mcpBefore);
    fs.writeFileSync(settingsPath(homeDir), settingsBefore);

    const result = ensureVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    assert.equal(result.ok, false);
    assert.match(result.summary.join('\n'), /invalid JSON/);
    assert.equal(fs.readFileSync(mcpConfigPath(homeDir), 'utf8'), mcpBefore);
    assert.equal(fs.readFileSync(settingsPath(homeDir), 'utf8'), settingsBefore);
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

describe('ensureVisionConfig — hardening and failure behavior', () => {
  it('migrates the legacy plugin entry, removes only its wildcard grants, and pins process.execPath', () => {
    const homeDir = trackedHome();
    fs.mkdirSync(path.dirname(mcpConfigPath(homeDir)), { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath(homeDir)), { recursive: true });
    fs.writeFileSync(mcpConfigPath(homeDir), JSON.stringify({
      mcpServers: { vision: { command: 'node', args: [FAKE_SERVER_PATH] }, other: { command: 'x' } },
      keep: 1,
    }));
    fs.writeFileSync(settingsPath(homeDir), JSON.stringify({
      permissions: { allow: ['keep(*)', 'read_file(*)', 'view_image(*)', 'mcp(*)'] },
      keep: 2,
    }));

    const result = ensureVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    assert.equal(result.ok, true);
    const mcp = JSON.parse(fs.readFileSync(mcpConfigPath(homeDir), 'utf8'));
    const settings = JSON.parse(fs.readFileSync(settingsPath(homeDir), 'utf8'));
    assert.equal(mcp.mcpServers.vision.command, process.execPath);
    assert.equal(mcp.mcpServers.other.command, 'x');
    assert.equal(mcp.keep, 1);
    assert.deepEqual(settings.permissions.allow, ['keep(*)', VISION_PERMISSION]);
    assert.equal(settings.keep, 2);
  });

  it('a foreign vision conflict prevents any permission or receipt write', () => {
    const homeDir = trackedHome();
    fs.mkdirSync(path.dirname(mcpConfigPath(homeDir)), { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath(homeDir)), { recursive: true });
    const mcpBefore = JSON.stringify({ mcpServers: { vision: { command: 'foreign', args: ['x'] } } });
    const settingsBefore = JSON.stringify({ permissions: { allow: ['keep(*)'] } });
    fs.writeFileSync(mcpConfigPath(homeDir), mcpBefore);
    fs.writeFileSync(settingsPath(homeDir), settingsBefore);

    const result = ensureVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    assert.equal(result.ok, false);
    assert.match(result.summary.join('\n'), /conflict/i);
    assert.equal(fs.readFileSync(mcpConfigPath(homeDir), 'utf8'), mcpBefore);
    assert.equal(fs.readFileSync(settingsPath(homeDir), 'utf8'), settingsBefore);
    assert.equal(fs.existsSync(receiptPath(homeDir)), false);
  });

  it('reports a write/lock-path failure without throwing or leaving config files', () => {
    const homeDir = trackedHome();
    fs.writeFileSync(path.join(homeDir, '.gemini'), 'not a directory');
    const result = ensureVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    assert.equal(result.ok, false);
    assert.match(result.summary.join('\n'), /configuration unchanged/i);
    assert.equal(fs.readFileSync(path.join(homeDir, '.gemini'), 'utf8'), 'not a directory');
  });

  it('honors a live cross-process lock and makes no writes', () => {
    const homeDir = trackedHome();
    const lock = path.join(homeDir, '.gemini', 'antigravity-plugin-vision.lock');
    fs.mkdirSync(lock, { recursive: true });
    const result = ensureVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH, lockTimeoutMs: 1 });
    assert.equal(result.ok, false);
    assert.match(result.summary.join('\n'), /locked by another process/);
    assert.equal(fs.existsSync(mcpConfigPath(homeDir)), false);
    assert.equal(fs.existsSync(settingsPath(homeDir)), false);
  });
});

describe('removeVisionConfig', () => {
  it('removes exactly entries setup added and preserves unrelated config', () => {
    const homeDir = trackedHome();
    fs.mkdirSync(path.dirname(mcpConfigPath(homeDir)), { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath(homeDir)), { recursive: true });
    fs.writeFileSync(mcpConfigPath(homeDir), JSON.stringify({
      mcpServers: { other: { command: 'python', args: ['x.py'] } },
      keepMcp: true,
    }));
    fs.writeFileSync(settingsPath(homeDir), JSON.stringify({
      permissions: { allow: ['keep(*)'] },
      keepSettings: true,
    }));
    ensureVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH });

    const result = removeVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    const mcp = JSON.parse(fs.readFileSync(mcpConfigPath(homeDir), 'utf8'));
    const settings = JSON.parse(fs.readFileSync(settingsPath(homeDir), 'utf8'));
    assert.deepEqual(mcp.mcpServers, { other: { command: 'python', args: ['x.py'] } });
    assert.equal(mcp.keepMcp, true);
    assert.deepEqual(settings.permissions.allow, ['keep(*)']);
    assert.equal(settings.keepSettings, true);
    assert.equal(fs.existsSync(receiptPath(homeDir)), false);
  });

  it('preserves an exact permission rule that existed before setup', () => {
    const homeDir = trackedHome();
    fs.mkdirSync(path.dirname(settingsPath(homeDir)), { recursive: true });
    fs.writeFileSync(settingsPath(homeDir), JSON.stringify({ permissions: { allow: [VISION_PERMISSION, 'keep(*)'] } }));
    ensureVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    removeVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH });

    const settings = JSON.parse(fs.readFileSync(settingsPath(homeDir), 'utf8'));
    assert.deepEqual(settings.permissions.allow, [VISION_PERMISSION, 'keep(*)']);
  });

  it('is idempotent after the plugin-owned entries are gone', () => {
    const homeDir = trackedHome();
    ensureVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    removeVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    const second = removeVisionConfig({ homeDir, serverPath: FAKE_SERVER_PATH });
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
  });
});
