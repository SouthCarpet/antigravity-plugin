/**
 * `update`: a standalone dispatcher convenience, not a runtime verb.
 *
 * The registry is a fake fetch, hosts are stub files on a fake PATH, and
 * `--apply` gets an injected runner, so nothing here touches the network,
 * a real host, or the real cache. The last block is the contract: `update`
 * is absent from every host surface and reachable only through the bin.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CACHE_TTL_MS,
  DIST_TAGS_URL,
  PACKAGE_NAME,
  applyPlan,
  buildHostPlan,
  compareVersions,
  detectHosts,
  findOnPath,
  parseInstalledRoot,
  parseMarketplaceSource,
  readInstalledPluginVersion,
  readUpdateNotice,
  resolveLatest,
  runUpdate,
  tarballFromPackOutput,
} from '../scripts/lib/update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'antigravity.mjs');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function fakeFetch(body, { ok = true, status = 200, fail = null } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (fail) throw fail;
    return { ok, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

function captureStdio() {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

/** A PATH holding only `names` as plain files; findOnPath accepts the bare name on every OS. */
function stubPath(dir, names) {
  for (const name of names) fs.writeFileSync(path.join(dir, name), '');
  return { PATH: dir };
}

let tmp;
let cacheFile;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-update-test-'));
  cacheFile = path.join(tmp, 'cache', 'update-check.json');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('update: registry cache', () => {
  it('miss: asks the registry once and writes the cache', async () => {
    const fetch = fakeFetch({ latest: '1.2.0' });
    const result = await resolveLatest({ env: {}, now: NOW, fetchImpl: fetch, cacheFile });
    assert.deepEqual(result, {
      latest: '1.2.0',
      source: 'registry',
      checkedAt: new Date(NOW).toISOString(),
      message: null,
    });
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, DIST_TAGS_URL);
    assert.match(DIST_TAGS_URL, /%2F/);
    const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.deepEqual(written, { latest: '1.2.0', checkedAt: new Date(NOW).toISOString() });
  });

  it('hit: a fresh cache answers without any request', async () => {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const checkedAt = new Date(NOW - 2 * HOUR).toISOString();
    fs.writeFileSync(cacheFile, JSON.stringify({ latest: '1.1.0', checkedAt }));
    const fetch = fakeFetch({ latest: '9.9.9' });
    const result = await resolveLatest({ env: {}, now: NOW, fetchImpl: fetch, cacheFile });
    assert.equal(result.source, 'cache');
    assert.equal(result.latest, '1.1.0');
    assert.equal(result.checkedAt, checkedAt);
    assert.equal(fetch.calls.length, 0);
  });

  it('expired: after 24 h the registry is asked again and the cache rewritten', async () => {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const stale = new Date(NOW - CACHE_TTL_MS - 1).toISOString();
    fs.writeFileSync(cacheFile, JSON.stringify({ latest: '1.1.0', checkedAt: stale }));
    const fetch = fakeFetch({ latest: '1.3.0' });
    const result = await resolveLatest({ env: {}, now: NOW, fetchImpl: fetch, cacheFile });
    assert.equal(result.source, 'registry');
    assert.equal(result.latest, '1.3.0');
    assert.equal(fetch.calls.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).latest, '1.3.0');
  });

  it('disabled: ANTIGRAVITY_NO_UPDATE_CHECK=1 makes no request and writes nothing', async () => {
    const fetch = fakeFetch({ latest: '9.9.9' });
    const result = await resolveLatest({
      env: { ANTIGRAVITY_NO_UPDATE_CHECK: '1' },
      now: NOW,
      fetchImpl: fetch,
      cacheFile,
    });
    assert.equal(result.source, 'disabled');
    assert.equal(result.latest, null);
    assert.match(result.message, /ANTIGRAVITY_NO_UPDATE_CHECK=1/);
    assert.equal(fetch.calls.length, 0);
    assert.equal(fs.existsSync(cacheFile), false);
  });

  it('unreachable: a network failure is a message, never a throw', async () => {
    const fetch = fakeFetch(null, { fail: new Error('getaddrinfo ENOTFOUND registry.npmjs.org') });
    const result = await resolveLatest({ env: {}, now: NOW, fetchImpl: fetch, cacheFile });
    assert.equal(result.source, 'unreachable');
    assert.equal(result.latest, null);
    assert.match(result.message, /could not reach the npm registry: getaddrinfo ENOTFOUND/);
    assert.equal(fs.existsSync(cacheFile), false);
  });

  it('an HTTP error or a malformed answer is unreachable too', async () => {
    const http = await resolveLatest({ env: {}, now: NOW, fetchImpl: fakeFetch({}, { ok: false, status: 503 }), cacheFile });
    assert.match(http.message, /HTTP 503/);
    const shape = await resolveLatest({ env: {}, now: NOW, fetchImpl: fakeFetch({ nope: true }), cacheFile });
    assert.match(shape.message, /no dist-tags\.latest/);
  });
});

describe('update: version compare', () => {
  it('orders semver cores and treats a prerelease as older than its release', () => {
    assert.equal(compareVersions('1.1.0', '1.0.1'), 1);
    assert.equal(compareVersions('1.0.1', '1.1.0'), -1);
    assert.equal(compareVersions('1.0.1', '1.0.1'), 0);
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(compareVersions('1.1.0-rc.1', '1.1.0'), -1);
    assert.equal(compareVersions('v1.1.0', '1.1.0'), 0);
  });
});

describe('update: host detection by PATH', () => {
  it('lists a host as present only when its binary is on PATH', () => {
    const env = stubPath(tmp, ['claude', 'agy']);
    const hosts = detectHosts({ env });
    const byId = Object.fromEntries(hosts.map((h) => [h.id, h]));
    assert.equal(byId.npx.present, true);
    assert.equal(byId['claude-code'].present, true);
    assert.equal(byId['claude-code'].binary, path.join(tmp, 'claude'));
    assert.equal(byId.agy.present, true);
    assert.equal(byId.codex.present, false);
    assert.equal(byId.codex.binary, null);
    assert.equal(findOnPath('codex', { env }), null);
  });

  it('on win32 also accepts .exe/.cmd/.bat spellings', () => {
    fs.writeFileSync(path.join(tmp, 'codex.cmd'), '');
    const found = findOnPath('codex', { env: { PATH: tmp }, platform: 'win32' });
    assert.equal(found, path.join(tmp, 'codex.cmd'));
  });
});

describe('update: report', () => {
  it('prints running, latest, availability, and a per-host instruction; nothing runs without --apply', async () => {
    const env = stubPath(tmp, ['claude', 'codex', 'agy']);
    const runner = () => { throw new Error('runner must not be called without --apply'); };
    const cap = captureStdio();
    let exit;
    try {
      exit = await runUpdate([], { env, now: NOW, fetch: fakeFetch({ latest: '1.5.0' }), cacheFile, running: '1.0.1', runner });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.match(text, /running: 1\.0\.1/);
    assert.match(text, /latest: 1\.5\.0 \(npm registry/);
    assert.match(text, /update available: yes/);
    assert.match(text, /npx: nothing to do/);
    assert.match(
      text,
      /Claude Code: claude plugin marketplace update antigravity, then claude plugin update antigravity@antigravity/,
    );
    assert.match(
      text,
      /Codex CLI: codex plugin marketplace list, then codex plugin remove antigravity@antigravity, then codex plugin add antigravity@antigravity/,
    );
    assert.match(text, /agy: agy plugin uninstall antigravity, then agy plugin install/);
    assert.match(text, /never changes an installed copy by itself/);
    assert.match(text, /antigravity-plugin update --apply/);
  });

  it('names hosts that are not on PATH and reports an unknown latest when disabled', async () => {
    const env = { ...stubPath(tmp, ['claude']), ANTIGRAVITY_NO_UPDATE_CHECK: '1' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await runUpdate([], { env, now: NOW, fetch: fakeFetch({ latest: '9.9.9' }), cacheFile, running: '1.0.1' });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.match(text, /latest: unknown: update check disabled/);
    assert.match(text, /update available: unknown/);
    assert.match(text, /Codex CLI: not found on PATH \(`codex`\)/);
    assert.match(text, /agy: not found on PATH \(`agy`\)/);
  });

  it('--json is one envelope with running, latest, updateAvailable, hosts[]', async () => {
    const env = stubPath(tmp, ['agy']);
    const cap = captureStdio();
    let exit;
    try {
      exit = await runUpdate(['--json'], { env, now: NOW, fetch: fakeFetch({ latest: '1.0.1' }), cacheFile, running: '1.0.1' });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.command, 'update');
    assert.equal(payload.status, 'ok');
    assert.equal(payload.jobId, null);
    assert.equal(payload.answer, null);
    assert.equal(payload.running, '1.0.1');
    assert.equal(payload.latest, '1.0.1');
    assert.equal(payload.updateAvailable, false);
    assert.deepEqual(payload.hosts.map((h) => [h.id, h.present]), [
      ['npx', true], ['claude-code', false], ['codex', false], ['agy', true],
    ]);
    assert.equal(payload.details.source, 'registry');
    assert.match(payload.details.note, /unstable in 1\.x/);
  });
});

describe('update --apply: command plans', () => {
  const PACK_JSON = JSON.stringify([{ filename: 'southcarpet-antigravity-plugin-1.5.0.tgz', name: PACKAGE_NAME }]);

  const GITHUB_MARKETPLACE = [
    'Marketplaces:',
    '  antigravity',
    '    source: https://github.com/SouthCarpet/antigravity-plugin',
    '',
  ].join('\n');

  /**
   * `capture` reaches the runner as a boolean, so the fake picks its answer
   * from the argv the way a real CLI would: `pack`, `marketplace list`, and
   * `plugin add` each print a different thing.
   */
  function outputFor(args, outputs) {
    if (args[0] === 'pack') return outputs.pack;
    if (args[1] === 'marketplace') return outputs.marketplace;
    if (args[1] === 'add') return outputs.install;
    return '';
  }

  function recordingRunner({
    packOutput = PACK_JSON,
    marketplaceOutput = GITHUB_MARKETPLACE,
    installOutput = '',
    failOn = null,
  } = {}) {
    const outputs = { pack: packOutput, marketplace: marketplaceOutput, install: installOutput };
    const calls = [];
    const runner = ({ command, args, capture }) => {
      calls.push({ command: path.basename(command), args, capture });
      if (failOn && path.basename(command) === failOn) return { status: 1, stdout: '', error: null };
      return { status: 0, stdout: capture ? outputFor(args, outputs) : '', error: null };
    };
    runner.calls = calls;
    return runner;
  }

  it('runs each present host in order, printing every command first, and never touches an absent host', async () => {
    const env = stubPath(tmp, ['claude', 'agy']);
    const runner = recordingRunner();
    const work = path.join(tmp, 'work');
    fs.mkdirSync(work);
    const cap = captureStdio();
    let exit;
    try {
      exit = await runUpdate(['--apply'], {
        env, now: NOW, fetch: fakeFetch({ latest: '1.5.0' }), cacheFile, running: '1.0.1', runner, tmpDir: work,
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0, cap.err.join(''));
    const tarball = path.join(work, 'southcarpet-antigravity-plugin-1.5.0.tgz');
    assert.deepEqual(runner.calls, [
      { command: 'claude', args: ['plugin', 'marketplace', 'update', 'antigravity'], capture: false },
      { command: 'claude', args: ['plugin', 'update', 'antigravity@antigravity'], capture: false },
      { command: 'npm', args: ['pack', `${PACKAGE_NAME}@1.5.0`, '--pack-destination', work, '--json'], capture: true },
      { command: 'tar', args: ['-xzf', tarball, '-C', work], capture: false },
      { command: 'agy', args: ['plugin', 'uninstall', 'antigravity'], capture: false },
      { command: 'agy', args: ['plugin', 'install', path.join(work, 'package')], capture: false },
    ]);
    assert.ok(!runner.calls.some((c) => c.command === 'codex'), 'codex is absent and must not run');
    const text = cap.out.join('');
    assert.match(text, /\$ .*claude plugin update antigravity@antigravity/);
    assert.match(text, /\$ .*agy plugin install /);
    assert.equal((text.match(/^\$ /gm) ?? []).length, 6);
  });

  it('claude plan refreshes the marketplace before it updates the plugin', () => {
    const [host] = detectHosts({ env: stubPath(tmp, ['claude']) }).filter((h) => h.id === 'claude-code');
    const plan = buildHostPlan(host, { latest: '1.5.0', tmpDir: tmp });
    assert.deepEqual(plan.map((s) => s.args), [
      ['plugin', 'marketplace', 'update', 'antigravity'],
      ['plugin', 'update', 'antigravity@antigravity'],
    ]);
    assert.ok(plan.every((s) => s.command === host.binary));
  });

  it('codex plan lists the marketplace first, then removes and adds with the qualified name', () => {
    const [host] = detectHosts({ env: stubPath(tmp, ['codex']) }).filter((h) => h.id === 'codex');
    const plan = buildHostPlan(host, { latest: '1.5.0', tmpDir: tmp });
    assert.deepEqual(plan.map((s) => s.args), [
      ['plugin', 'marketplace', 'list'],
      ['plugin', 'remove', 'antigravity@antigravity'],
      ['plugin', 'add', 'antigravity@antigravity'],
    ]);
    assert.ok(plan.every((s) => s.command === host.binary));
    assert.equal(plan[2].latest, '1.5.0', 'the add step carries latest so it can report a mismatch');
  });

  it('the printed instruction names every command the plan runs, in order', () => {
    const env = stubPath(tmp, ['claude', 'codex']);
    for (const host of detectHosts({ env }).filter((h) => ['claude-code', 'codex'].includes(h.id))) {
      const plan = buildHostPlan(host, { latest: '1.5.0', tmpDir: tmp });
      let cursor = 0;
      for (const step of plan) {
        const text = `${path.basename(step.command)} ${step.args.join(' ')}`;
        const at = host.instruction.indexOf(text, cursor);
        assert.notEqual(at, -1, `${host.id}: instruction must name "${text}"\n${host.instruction}`);
        cursor = at + text.length;
      }
    }
  });

  it('agy plan falls back to the latest tag when the version is unknown', () => {
    const [host] = detectHosts({ env: stubPath(tmp, ['agy']) }).filter((h) => h.id === 'agy');
    const plan = buildHostPlan(host, { latest: null, tmpDir: tmp });
    assert.equal(plan[0].args[1], `${PACKAGE_NAME}@latest`);
  });

  it('tarball path comes from npm pack --json, or from the last plain line', () => {
    assert.equal(
      tarballFromPackOutput(PACK_JSON, tmp),
      path.join(tmp, 'southcarpet-antigravity-plugin-1.5.0.tgz'),
    );
    assert.equal(
      tarballFromPackOutput('npm notice\nsouthcarpet-antigravity-plugin-1.5.0.tgz\n', tmp),
      path.join(tmp, 'southcarpet-antigravity-plugin-1.5.0.tgz'),
    );
    assert.throws(() => tarballFromPackOutput('', tmp), /printed no tarball name/);
  });

  it('a failing step stops that host, is reported, and exits 1', async () => {
    const env = stubPath(tmp, ['codex', 'agy']);
    const runner = recordingRunner({ failOn: 'npm' });
    const cap = captureStdio();
    let exit;
    try {
      exit = await runUpdate(['--apply', '--json'], {
        env, now: NOW, fetch: fakeFetch({ latest: '1.5.0' }), cacheFile, running: '1.0.1', runner, tmpDir: tmp,
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    // codex ran fully, agy stopped after npm pack; nothing after the failure ran.
    assert.deepEqual(runner.calls.map((c) => c.command), ['codex', 'codex', 'codex', 'npm']);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.status, 'apply_failed');
    const agy = payload.hosts.find((h) => h.id === 'agy');
    assert.equal(agy.steps.length, 1);
    assert.equal(agy.steps[0].status, 1);
    assert.match(cap.err.join(''), /stopped, nothing after this step was run/);
  });

  it('applyPlan substitutes the tarball placeholder only after npm pack ran', () => {
    const lines = [];
    const outcome = applyPlan(
      [
        { command: 'npm', args: ['pack', '--pack-destination', tmp, '--json'], capture: 'pack' },
        { command: 'tar', args: ['-xzf', '<tarball>', '-C', tmp] },
      ],
      { runner: ({ capture }) => ({ status: 0, stdout: capture ? PACK_JSON : '' }), write: (t) => lines.push(t) },
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.steps[1].args[1], path.join(tmp, 'southcarpet-antigravity-plugin-1.5.0.tgz'));
    assert.equal(lines.length, 2);
  });

  it('--apply ignores a fresh cache, fetches once, and rewrites the cache with the fetched version', async () => {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ latest: '1.0.1', checkedAt: new Date(NOW - HOUR).toISOString() }));
    const env = stubPath(tmp, ['agy']);
    const fetch = fakeFetch({ latest: '1.1.0' });
    const runner = recordingRunner({
      packOutput: JSON.stringify([{ filename: 'southcarpet-antigravity-plugin-1.1.0.tgz', name: PACKAGE_NAME }]),
    });
    const work = path.join(tmp, 'work-fresh');
    fs.mkdirSync(work);
    const cap = captureStdio();
    let exit;
    try {
      exit = await runUpdate(['--apply'], { env, now: NOW, fetch, cacheFile, running: '1.0.1', runner, tmpDir: work });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0, cap.err.join(''));
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(
      runner.calls.find((c) => c.command === 'npm').args,
      ['pack', `${PACKAGE_NAME}@1.1.0`, '--pack-destination', work, '--json'],
    );
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).latest, '1.1.0');
  });

  it('without --apply, a fresh cache still answers the report and makes zero fetches', async () => {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ latest: '1.0.1', checkedAt: new Date(NOW - HOUR).toISOString() }));
    const env = stubPath(tmp, ['agy']);
    const fetch = fakeFetch({ latest: '1.1.0' });
    const cap = captureStdio();
    let exit;
    try {
      exit = await runUpdate([], { env, now: NOW, fetch, cacheFile, running: '1.0.1' });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(fetch.calls.length, 0);
    assert.match(cap.out.join(''), /latest: 1\.0\.1 \(cached/);
  });

  it('--apply with the update check disabled skips agy (no known latest) but still runs the other hosts', async () => {
    const env = { ...stubPath(tmp, ['claude', 'codex', 'agy']), ANTIGRAVITY_NO_UPDATE_CHECK: '1' };
    const fetch = fakeFetch({ latest: '9.9.9' });
    const runner = recordingRunner();
    const cap = captureStdio();
    let exit;
    try {
      exit = await runUpdate(['--apply'], { env, now: NOW, fetch, cacheFile, running: '1.0.1', runner, tmpDir: tmp });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(runner.calls.map((c) => c.command), ['claude', 'claude', 'codex', 'codex', 'codex']);
    assert.match(cap.out.join(''), /agy: update check disabled \(ANTIGRAVITY_NO_UPDATE_CHECK=1\); no known "latest" version to pack, skipping this host\./);
  });
});

describe('update --apply: a local Codex marketplace', () => {
  const LOCAL_PATH = 'A:\\projects-vault\\apps\\plugins\\antigravity-plugin';

  function localMarketplace(source) {
    return ['Marketplaces:', '  antigravity', `    source: ${source}`, ''].join('\n');
  }

  function codexRunner({ marketplaceOutput, installOutput = '' }) {
    const outputs = { marketplace: marketplaceOutput, install: installOutput };
    const calls = [];
    const runner = ({ command, args, capture }) => {
      calls.push({ command: path.basename(command), args });
      const kind = args[1] === 'marketplace' ? 'marketplace' : 'install';
      return { status: 0, stdout: capture ? outputs[kind] ?? '' : '', error: null };
    };
    runner.calls = calls;
    return runner;
  }

  async function applyCodex(runner) {
    const env = stubPath(tmp, ['codex']);
    const cap = captureStdio();
    let exit;
    try {
      exit = await runUpdate(['--apply'], {
        env, now: NOW, fetch: fakeFetch({ latest: '1.1.2' }), cacheFile, running: '1.1.2', runner, tmpDir: tmp,
      });
    } finally {
      cap.restore();
    }
    return { exit, text: cap.out.join('') };
  }

  it('parses the source and classifies it: a path is local, a URL is not', () => {
    assert.deepEqual(parseMarketplaceSource(localMarketplace(LOCAL_PATH)), {
      source: LOCAL_PATH,
      local: true,
    });
    assert.deepEqual(parseMarketplaceSource(localMarketplace('/home/me/antigravity-plugin')), {
      source: '/home/me/antigravity-plugin',
      local: true,
    });
    assert.equal(
      parseMarketplaceSource(localMarketplace('https://github.com/SouthCarpet/antigravity-plugin')).local,
      false,
      'a GitHub URL holds slashes but is not a local clone',
    );
    assert.equal(parseMarketplaceSource('Marketplaces:\n  other\n    source: /tmp/x\n'), null);
  });

  it('warns and names the path when the marketplace is a local clone', async () => {
    const { exit, text } = await applyCodex(codexRunner({ marketplaceOutput: localMarketplace(LOCAL_PATH) }));
    assert.equal(exit, 0, text);
    assert.ok(
      text.includes(`codex: the marketplace "antigravity" is a local clone at ${LOCAL_PATH}.`),
      text,
    );
    assert.match(text, /Pull that clone first/);
    assert.match(text, /This command does not change it\./);
  });

  it('does not warn when the marketplace is a GitHub source', async () => {
    const { exit, text } = await applyCodex(
      codexRunner({ marketplaceOutput: localMarketplace('https://github.com/SouthCarpet/antigravity-plugin') }),
    );
    assert.equal(exit, 0, text);
    assert.ok(!text.includes('is a local clone at'), text);
  });

  it('reads the installed version from the plugin root the add step prints, and flags a mismatch', async () => {
    const installed = path.join(tmp, 'installed');
    fs.mkdirSync(installed);
    fs.writeFileSync(path.join(installed, 'plugin.json'), JSON.stringify({ name: 'antigravity', version: '1.1.0' }));
    const runner = codexRunner({
      marketplaceOutput: localMarketplace(LOCAL_PATH),
      installOutput: `Installed plugin root: ${installed}\n`,
    });
    const { exit, text } = await applyCodex(runner);
    assert.equal(exit, 0, text);
    assert.match(text, /^codex: installed 1\.1\.0$/m);
    assert.match(text, /codex: installed 1\.1\.0 does not match latest 1\.1\.2\./);
    assert.match(text, /Pull the marketplace clone, then run update --apply again\./);
  });

  it('prints no mismatch line when the installed version is the latest', async () => {
    const installed = path.join(tmp, 'installed-current');
    fs.mkdirSync(installed);
    fs.writeFileSync(path.join(installed, 'plugin.json'), JSON.stringify({ version: '1.1.2' }));
    const { exit, text } = await applyCodex(
      codexRunner({
        marketplaceOutput: localMarketplace('https://github.com/SouthCarpet/antigravity-plugin'),
        installOutput: `Installed plugin root: ${installed}\n`,
      }),
    );
    assert.equal(exit, 0, text);
    assert.match(text, /^codex: installed 1\.1\.2$/m);
    assert.ok(!text.includes('does not match latest'), text);
  });

  it('says so, and stays exit 0, when the add output names no plugin root', async () => {
    const { exit, text } = await applyCodex(
      codexRunner({ marketplaceOutput: localMarketplace(LOCAL_PATH), installOutput: 'done\n' }),
    );
    assert.equal(exit, 0, text);
    assert.match(text, /codex: the plugin add output did not name the installed plugin root/);
  });

  it('reads the root out of one line, and reports an unreadable plugin.json', async () => {
    assert.equal(parseInstalledRoot('noise\nInstalled plugin root: C:\\x\\y\nmore\n'), 'C:\\x\\y');
    assert.equal(parseInstalledRoot('nothing here'), null);
    assert.equal(readInstalledPluginVersion(path.join(tmp, 'no-such-root')), null);
    const { exit, text } = await applyCodex(
      codexRunner({
        marketplaceOutput: localMarketplace(LOCAL_PATH),
        installOutput: `Installed plugin root: ${path.join(tmp, 'no-such-root')}\n`,
      }),
    );
    assert.equal(exit, 0, text);
    assert.match(text, /codex: could not read the installed version from /);
  });

  it('echoes the captured host output, so nothing the user would have seen is lost', async () => {
    const { text } = await applyCodex(
      codexRunner({ marketplaceOutput: localMarketplace('https://github.com/SouthCarpet/antigravity-plugin') }),
    );
    assert.match(text, /source: https:\/\/github\.com\/SouthCarpet\/antigravity-plugin/);
  });
});

describe('status: update notice from the cache only', () => {
  it('returns one line when the cache holds a newer version, else null', () => {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ latest: '1.4.0', checkedAt: new Date(NOW).toISOString() }));
    assert.equal(
      readUpdateNotice({ cacheFile, running: '1.0.1' }),
      'antigravity-plugin 1.4.0 is available; run: antigravity-plugin update',
    );
    assert.equal(readUpdateNotice({ cacheFile, running: '1.4.0' }), null);
    assert.equal(readUpdateNotice({ cacheFile, running: '2.0.0' }), null);
    assert.equal(readUpdateNotice({ cacheFile: path.join(tmp, 'missing.json'), running: '1.0.1' }), null);
  });

  it('status prints the notice on stderr and keeps --json stdout a single envelope', async () => {
    const { run } = await import('../scripts/commands/status.mjs');
    const notice = 'antigravity-plugin 1.4.0 is available; run: antigravity-plugin update';
    const snapshot = { workspaceRoot: tmp, config: {}, running: [], latestFinished: null, recent: [], needsReview: false };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--json'], {
        cwd: tmp,
        buildStatusSnapshot: () => snapshot,
        readUpdateNotice: () => notice,
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.command, 'status');
    assert.equal(cap.err.join(''), `${notice}\n`);
  });
});

describe('update is on no host surface', () => {
  function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  }

  it('has no command markdown, no verb module, no openai.yaml entry, no SKILL.md row, and is not in KNOWN', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'commands', 'update.md')), false);
    assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'commands', 'update.mjs')), false);
    assert.doesNotMatch(read('agents/openai.yaml'), /^\s+- name:\s+update\s*$/m);
    assert.doesNotMatch(read('SKILL.md'), /^\|\s*`update`\s*\|/m);
    const known = read('bin/antigravity.mjs').match(/\bconst KNOWN = \[([^\]]*)\]/)[1];
    assert.doesNotMatch(known, /'update'/);
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'update.mjs')), 'the module lives under scripts/lib');
  });

  it('is reachable through the standalone dispatcher', () => {
    const help = spawnSync(process.execPath, [BIN, 'update', '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /antigravity-plugin update/);
    assert.match(help.stdout, /--apply/);

    const stub = stubPath(tmp, ['claude']);
    const res = spawnSync(process.execPath, [BIN, 'update'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: stub.PATH, Path: stub.PATH, ANTIGRAVITY_NO_UPDATE_CHECK: '1' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes(`running: ${PKG_VERSION}`), res.stdout);
    assert.match(res.stdout, /update check disabled/);
    assert.match(res.stdout, /Claude Code: claude plugin marketplace update antigravity, then claude plugin update/);
    assert.match(res.stdout, /Codex CLI: not found on PATH/);
  });
});
