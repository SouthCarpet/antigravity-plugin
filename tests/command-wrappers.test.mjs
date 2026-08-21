/**
 * Slash-command wrappers must locate the runtime without shell-expanding
 * CLAUDE_PLUGIN_ROOT, and must tell the reading model to stop rather than
 * substitute if that runtime cannot run.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGY_PLUGIN_INSTALL_SEGMENTS,
  agyPluginInstallDir,
  hostBangLine,
  hostBootstrapSource,
  hostRefusalContract,
  missingRuntimeMessage,
  resolvePluginRoot,
  resolveVerbScript,
} from '../scripts/lib/plugin-root.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS_DIR = path.join(ROOT, 'commands');

const GIT_TEST_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function listVerbs() {
  return fs
    .readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
}

function readCommand(verb) {
  return fs.readFileSync(path.join(COMMANDS_DIR, `${verb}.md`), 'utf8');
}

function bodyAfterFrontmatter(source) {
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!match) return source;
  return source.slice(match[0].length).replace(/^\s+/, '');
}

function expectedLocator(verb) {
  return (
    'Find the runtime with Node, not the shell. Plugin root is `process.env.CLAUDE_PLUGIN_ROOT` ' +
    "when that is set and non-empty; otherwise `require('node:path').join(require('node:os').homedir(), " +
    `'.gemini', 'config', 'plugins', 'antigravity')\`. Then run \`node <root>/scripts/commands/${verb}.mjs\` ` +
    'with the user\'s arguments. Do not expand `CLAUDE_PLUGIN_ROOT` in the shell: an empty expansion ' +
    `is the wrong path \`/scripts/commands/${verb}.mjs\`.`
  );
}

function extractBangBootstrap(source) {
  const match = source.match(/!`node -e "([^"]+)" -- \$ARGUMENTS`/);
  return match ? match[1] : null;
}

function homeEnv(home) {
  return process.platform === 'win32'
    ? { USERPROFILE: home, HOME: home }
    : { HOME: home };
}

function runBootstrap(verb, { args = [], env = {}, cwd } = {}) {
  return spawnSync(process.execPath, ['-e', hostBootstrapSource(verb), '--', ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  });
}

function writeStubVerb(pluginRoot, verb, markerFile) {
  const dir = path.join(pluginRoot, 'scripts', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${verb}.mjs`),
    [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify(process.argv.slice(2)));`,
      'process.stdout.write("stub-ok\\n");',
    ].join('\n'),
    'utf8',
  );
}

describe('plugin-root resolution', () => {
  it('CLAUDE_PLUGIN_ROOT wins when set and non-empty', () => {
    const root = resolvePluginRoot({
      env: { CLAUDE_PLUGIN_ROOT: '/opt/claude-plugin' },
      homedir: '/home/nobody',
    });
    assert.equal(root, '/opt/claude-plugin');
  });

  it('trims CLAUDE_PLUGIN_ROOT and treats whitespace as empty', () => {
    assert.equal(
      resolvePluginRoot({
        env: { CLAUDE_PLUGIN_ROOT: '  /opt/claude-plugin  ' },
        homedir: '/home/nobody',
      }),
      '/opt/claude-plugin',
    );
    assert.equal(
      resolvePluginRoot({
        env: { CLAUDE_PLUGIN_ROOT: '   ' },
        homedir: '/home/nobody',
      }),
      agyPluginInstallDir('/home/nobody'),
    );
  });

  it('unset or empty CLAUDE_PLUGIN_ROOT uses the agy install copy under homedir', () => {
    const home = path.join('C:', 'Users', 'agy-user');
    const expected = path.join(home, ...AGY_PLUGIN_INSTALL_SEGMENTS);
    assert.equal(resolvePluginRoot({ env: {}, homedir: home }), expected);
    assert.equal(resolvePluginRoot({ env: { CLAUDE_PLUGIN_ROOT: '' }, homedir: home }), expected);
    assert.equal(agyPluginInstallDir(home), expected);
    assert.equal(
      resolveVerbScript('review', { env: {}, homedir: home }),
      path.join(expected, 'scripts', 'commands', 'review.mjs'),
    );
  });

  it('computed fallback on this machine is <homedir>/.gemini/config/plugins/antigravity', () => {
    const computed = agyPluginInstallDir();
    assert.equal(computed, path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity'));
    const verbsDir = path.join(computed, 'scripts', 'commands');
    if (fs.existsSync(verbsDir)) {
      for (const verb of listVerbs()) {
        assert.equal(
          fs.existsSync(path.join(verbsDir, `${verb}.mjs`)),
          true,
          `installed agy copy missing ${verb}.mjs at ${verbsDir}`,
        );
      }
    }
  });
});

describe('host bootstrap source', () => {
  it('is free of $ and % so shells do not interpolate it', () => {
    const source = hostBootstrapSource('review');
    assert.equal(source.includes('$'), false, source);
    assert.equal(source.includes('%'), false, source);
    assert.equal(source.includes('${CLAUDE_PLUGIN_ROOT}'), false);
    assert.match(source, /process\.env\.CLAUDE_PLUGIN_ROOT\|\|/);
    assert.equal(
      source.includes(AGY_PLUGIN_INSTALL_SEGMENTS.map((s) => `'${s}'`).join(',')),
      true,
    );
  });

  it('rejects a verb that would break the generated snippet', () => {
    assert.throws(() => hostBootstrapSource('review.mjs'), /invalid verb/);
    assert.throws(() => hostBootstrapSource("review';process.exit(0)//"), /invalid verb/);
  });

  it('missingRuntimeMessage names the path and the standalone CLI', () => {
    const message = missingRuntimeMessage('/tmp/missing.mjs', 'status');
    assert.match(message, /runtime not found at \/tmp\/missing\.mjs/);
    assert.match(message, /npx @southcarpet\/antigravity-plugin status/);
  });
});

describe('commands/*.md wrappers', () => {
  const verbs = listVerbs();

  it('every command file opens with the canonical refusal contract, before anything else', () => {
    assert.ok(verbs.length > 0, 'no command files');
    for (const verb of verbs) {
      const body = readCommand(verb);
      assert.equal(
        bodyAfterFrontmatter(body).startsWith(hostRefusalContract(verb)),
        true,
        `${verb}.md does not open with the canonical refusal contract`,
      );
      assert.equal(
        body.includes(expectedLocator(verb)),
        true,
        `${verb}.md is missing the Node locator instruction`,
      );
      assert.equal(
        body.includes('"${CLAUDE_PLUGIN_ROOT}/scripts/commands/'),
        false,
        `${verb}.md still shell-expands CLAUDE_PLUGIN_ROOT into the script path`,
      );
    }
  });

  it('no command file hands the model an output shape to imitate', () => {
    // The 2026-08-21 fabrication: agy's model forged a status table and a
    // review because status.md enumerated the columns of a correct answer.
    // Wrappers may say "show the output unchanged"; they must never
    // describe what that output looks like.
    const forbidden = [
      /markdown table/i,
      /render the command output/i,
      /preserve the actionable fields/i,
      /job id, kind, status, phase/i,
    ];
    for (const verb of verbs) {
      const body = readCommand(verb);
      for (const re of forbidden) {
        assert.doesNotMatch(body, re, `${verb}.md reintroduces an output recipe: ${re}`);
      }
    }
  });

  it('bang-substitution verbs embed the canonical node -e bootstrap', () => {
    for (const verb of verbs) {
      const body = readCommand(verb);
      if (verb === 'rescue') {
        assert.equal(
          body.includes(hostBootstrapSource('rescue')),
          true,
          'rescue.md is missing the canonical bootstrap source',
        );
        assert.equal(extractBangBootstrap(body), null, 'rescue.md should not use !`...` substitution');
        continue;
      }
      const embedded = extractBangBootstrap(body);
      assert.equal(embedded, hostBootstrapSource(verb), `${verb}.md bang line drifted`);
      assert.equal(
        body.includes(hostBangLine(verb)),
        true,
        `${verb}.md is missing the canonical bang line`,
      );
    }
  });
});

describe('host bootstrap execution', () => {
  let tmpRoot;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-wrapper-'));
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('CLAUDE_PLUGIN_ROOT locates a stub verb and forwards arguments', () => {
    const pluginRoot = path.join(tmpRoot, 'claude-copy');
    const marker = path.join(tmpRoot, 'claude-marker.json');
    writeStubVerb(pluginRoot, 'review', marker);

    const res = runBootstrap('review', {
      args: ['--json', 'extra'],
      env: { CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    assert.equal(res.status, 0, `stderr=${res.stderr}\nstdout=${res.stdout}`);
    assert.match(res.stdout, /stub-ok/);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), ['--json', 'extra']);
  });

  it('empty CLAUDE_PLUGIN_ROOT uses the agy install path under homedir, not /scripts/...', () => {
    const home = path.join(tmpRoot, 'home');
    const pluginRoot = agyPluginInstallDir(home);
    const marker = path.join(tmpRoot, 'agy-marker.json');
    writeStubVerb(pluginRoot, 'status', marker);

    const res = runBootstrap('status', {
      args: ['--json'],
      env: { CLAUDE_PLUGIN_ROOT: '', ...homeEnv(home) },
    });
    assert.equal(res.status, 0, `stderr=${res.stderr}\nstdout=${res.stdout}`);
    assert.match(res.stdout, /stub-ok/);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), ['--json']);
    assert.equal(res.stderr.includes('/scripts/commands/status.mjs'), false);
  });

  it('missing runtime prints the path and the standalone CLI, then exits 1', () => {
    const pluginRoot = path.join(tmpRoot, 'empty-plugin');
    fs.mkdirSync(pluginRoot, { recursive: true });
    const expectedScript = path.join(pluginRoot, 'scripts', 'commands', 'review.mjs');

    const res = runBootstrap('review', {
      env: { CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    assert.equal(res.status, 1, `stderr=${res.stderr}`);
    assert.equal(res.stdout, '');
    assert.equal(
      res.stderr.includes(missingRuntimeMessage(expectedScript, 'review')),
      true,
      res.stderr,
    );
  });

  it('Claude Code path still runs real status (no live agy)', () => {
    const cwd = fs.mkdtempSync(path.join(tmpRoot, 'status-cwd-'));
    const res = runBootstrap('status', {
      env: { CLAUDE_PLUGIN_ROOT: ROOT },
      cwd,
    });
    assert.equal(res.status, 0, `stderr=${res.stderr}\nstdout=${res.stdout}`);
    assert.ok(res.stdout.trim().length > 0, 'expected status stdout');
  });

  it('Claude Code path still runs real review on an empty tree (no live agy)', () => {
    const cwd = fs.mkdtempSync(path.join(tmpRoot, 'review-cwd-'));
    try {
      execSync('git --version', { stdio: 'ignore' });
    } catch {
      assert.fail('git is required to verify review through the host bootstrap');
    }
    const env = { ...process.env, ...GIT_TEST_ENV };
    execSync('git init -q', { cwd, stdio: 'ignore', env });
    execSync('git commit --allow-empty -q -m init', { cwd, stdio: 'ignore', env });

    const res = runBootstrap('review', {
      args: ['--json'],
      env: { CLAUDE_PLUGIN_ROOT: ROOT },
      cwd,
    });
    assert.equal(res.status, 0, `stderr=${res.stderr}\nstdout=${res.stdout}`);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.command, 'review');
    assert.equal(payload.status, 'no_changes');
  });
});
