/**
 * Tests for scripts/mcp/vision-server.mjs.
 *
 * `loadImageResult` is exercised directly (fast, deterministic), and the
 * real server is also spawned as a child process and driven over its actual
 * stdio JSON-RPC protocol (initialize → tools/list → tools/call) to prove
 * the wire format agy talks to is intact end-to-end.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadImageResult } from '../scripts/mcp/vision-server.mjs';
import { VISION_ALLOWLIST_ENV } from '../scripts/lib/vision-capability.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'scripts', 'mcp', 'vision-server.mjs');

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let tmpDir;
let pngPath;
const tmpDirs = [];

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-vision-'));
  tmpDirs.push(tmpDir);
  pngPath = path.join(tmpDir, 'probe.png');
  fs.writeFileSync(pngPath, Buffer.from(TINY_PNG_BASE64, 'base64'));
});

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ───────────────────────────── loadImageResult (pure) ─────────────────────────────

describe('vision-server.loadImageResult', () => {
  it('returns an image content block for a valid PNG', () => {
    const out = loadImageResult('probe.png', tmpDir, [pngPath]);
    assert.equal(out.isError, undefined);
    const imagePart = out.content.find((c) => c.type === 'image');
    assert.ok(imagePart, 'expected an image content block');
    assert.equal(imagePart.mimeType, 'image/png');
    assert.ok(imagePart.data.length > 0);
  });

  it('resolves relative paths against the provided cwd', () => {
    const out = loadImageResult('./probe.png', tmpDir, [pngPath]);
    assert.equal(out.isError, undefined);
  });

  it('blocks an absolute path outside the per-invocation allowlist', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-vision-outside-'));
    tmpDirs.push(outsideDir);
    const outsidePath = path.join(outsideDir, 'secret.png');
    fs.writeFileSync(outsidePath, Buffer.from(TINY_PNG_BASE64, 'base64'));

    const out = loadImageResult(outsidePath, tmpDir, [pngPath]);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /not authorized/);
  });

  it('blocks .. traversal even when it reaches an existing image', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-vision-traversal-'));
    tmpDirs.push(outsideDir);
    const outsidePath = path.join(outsideDir, 'secret.png');
    fs.writeFileSync(outsidePath, Buffer.from(TINY_PNG_BASE64, 'base64'));
    const traversal = path.relative(tmpDir, outsidePath);

    const out = loadImageResult(traversal, tmpDir, [pngPath]);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /not authorized/);
  });

  it('blocks Windows UNC and extended-length path forms before filesystem access', () => {
    for (const candidate of ['\\\\server\\share\\secret.png', '\\\\?\\C:\\secret.png']) {
      const out = loadImageResult(candidate, tmpDir, [pngPath]);
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, /not authorized/);
    }
  });

  it('blocks a permitted-looking path that resolves through a symlink or junction', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-vision-symlink-'));
    tmpDirs.push(outsideDir);
    const outsidePath = path.join(outsideDir, 'secret.png');
    fs.writeFileSync(outsidePath, Buffer.from(TINY_PNG_BASE64, 'base64'));
    const linkDir = path.join(tmpDir, 'permitted-looking');
    fs.symlinkSync(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedPath = path.join(linkDir, 'secret.png');

    const out = loadImageResult(linkedPath, tmpDir, [linkedPath]);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /symlink|junction/);
  });

  it('denies all image access when the invocation capability is absent', () => {
    const out = loadImageResult(pngPath, tmpDir, []);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /not authorized/);
  });

  it('is a no-op error for a missing file', () => {
    const missing = path.join(tmpDir, 'does-not-exist.png');
    const out = loadImageResult(missing, tmpDir, [missing]);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /file not found/);
  });

  it('is an error for an unsupported extension', () => {
    const txtPath = path.join(tmpDir, 'note.txt');
    fs.writeFileSync(txtPath, 'hello');
    const out = loadImageResult(txtPath, tmpDir, [txtPath]);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /unsupported image extension/);
  });

  it('is an error for a file over the 10MB cap', () => {
    const bigPath = path.join(tmpDir, 'big.png');
    fs.writeFileSync(bigPath, Buffer.alloc(10 * 1024 * 1024 + 1));
    const out = loadImageResult(bigPath, tmpDir, [bigPath]);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /too large/);
  });
});

// ───────────────────────────── real server round-trip ─────────────────────────────

function startServer(cwd, allowedPaths = []) {
  const env = { ...process.env, [VISION_ALLOWLIST_ENV]: JSON.stringify(allowedPaths) };
  const child = spawn(process.execPath, [SERVER], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const pending = new Map();
  let nextId = 1;
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  });
  function send(method, params, { id = nextId++ } = {}) {
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function close() {
    rl.close();
    child.kill();
  }
  return { child, send, close };
}

describe('vision-server (real MCP stdio process)', () => {
  it('initialize → tools/list → tools/call round-trips real image content', async () => {
    const srv = startServer(tmpDir, [pngPath]);
    try {
      const init = await srv.send('initialize', { protocolVersion: '2025-06-18' });
      assert.equal(init.result.serverInfo.name, 'vision-server');
      assert.deepEqual(init.result.capabilities, { tools: {} });

      const list = await srv.send('tools/list', {});
      assert.equal(list.result.tools[0].name, 'view_image');

      const call = await srv.send('tools/call', { name: 'view_image', arguments: { path: 'probe.png' } });
      const imagePart = call.result.content.find((c) => c.type === 'image');
      assert.ok(imagePart, 'expected an image content block');
      assert.equal(imagePart.mimeType, 'image/png');
      assert.ok(imagePart.data.length > 0);
      assert.equal(call.result.isError, undefined);
    } finally {
      srv.close();
    }
  });

  it('denies a real MCP call when no paths were authorized for the process', async () => {
    const srv = startServer(tmpDir);
    try {
      const call = await srv.send('tools/call', { name: 'view_image', arguments: { path: pngPath } });
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /not authorized/);
    } finally {
      srv.close();
    }
  });

  it('missing file over the wire produces isError', async () => {
    const missing = path.join(tmpDir, 'nope.png');
    const srv = startServer(tmpDir, [missing]);
    try {
      const call = await srv.send('tools/call', { name: 'view_image', arguments: { path: 'nope.png' } });
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /file not found/);
    } finally {
      srv.close();
    }
  });

  it('unsupported extension over the wire produces isError', async () => {
    const txtPath = path.join(tmpDir, 'note.txt');
    const srv = startServer(tmpDir, [txtPath]);
    try {
      const call = await srv.send('tools/call', { name: 'view_image', arguments: { path: 'note.txt' } });
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /unsupported image extension/);
    } finally {
      srv.close();
    }
  });

  it('oversize file over the wire produces isError', async () => {
    const bigPath = path.join(tmpDir, 'big.png');
    const srv = startServer(tmpDir, [bigPath]);
    try {
      const call = await srv.send('tools/call', { name: 'view_image', arguments: { path: 'big.png' } });
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /too large/);
    } finally {
      srv.close();
    }
  });

  it('unknown tool name returns a JSON-RPC invalid-params error', async () => {
    const srv = startServer(tmpDir);
    try {
      const res = await srv.send('tools/call', { name: 'not_view_image', arguments: {} });
      assert.equal(res.error.code, -32602);
    } finally {
      srv.close();
    }
  });

  it('unknown method returns a JSON-RPC method-not-found error', async () => {
    const srv = startServer(tmpDir);
    try {
      const res = await srv.send('bogus/method', {});
      assert.equal(res.error.code, -32601);
    } finally {
      srv.close();
    }
  });

  it('ping replies with an empty result', async () => {
    const srv = startServer(tmpDir);
    try {
      const res = await srv.send('ping', {});
      assert.deepEqual(res.result, {});
    } finally {
      srv.close();
    }
  });
});
