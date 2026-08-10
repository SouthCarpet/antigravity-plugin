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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'scripts', 'mcp', 'vision-server.mjs');

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let tmpDir;
let pngPath;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-vision-'));
  pngPath = path.join(tmpDir, 'probe.png');
  fs.writeFileSync(pngPath, Buffer.from(TINY_PNG_BASE64, 'base64'));
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ───────────────────────────── loadImageResult (pure) ─────────────────────────────

describe('vision-server.loadImageResult', () => {
  it('returns an image content block for a valid PNG', () => {
    const out = loadImageResult('probe.png', tmpDir);
    assert.equal(out.isError, undefined);
    const imagePart = out.content.find((c) => c.type === 'image');
    assert.ok(imagePart, 'expected an image content block');
    assert.equal(imagePart.mimeType, 'image/png');
    assert.ok(imagePart.data.length > 0);
  });

  it('resolves relative paths against the provided cwd', () => {
    const out = loadImageResult('./probe.png', tmpDir);
    assert.equal(out.isError, undefined);
  });

  it('is a no-op error for a missing file', () => {
    const out = loadImageResult('does-not-exist.png', tmpDir);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /file not found/);
  });

  it('is an error for an unsupported extension', () => {
    const txtPath = path.join(tmpDir, 'note.txt');
    fs.writeFileSync(txtPath, 'hello');
    const out = loadImageResult('note.txt', tmpDir);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /unsupported image extension/);
  });

  it('is an error for a file over the 10MB cap', () => {
    const bigPath = path.join(tmpDir, 'big.png');
    fs.writeFileSync(bigPath, Buffer.alloc(10 * 1024 * 1024 + 1));
    const out = loadImageResult('big.png', tmpDir);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /too large/);
  });
});

// ───────────────────────────── real server round-trip ─────────────────────────────

function startServer(cwd) {
  const child = spawn(process.execPath, [SERVER], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const srv = startServer(tmpDir);
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

  it('missing file over the wire produces isError', async () => {
    const srv = startServer(tmpDir);
    try {
      const call = await srv.send('tools/call', { name: 'view_image', arguments: { path: 'nope.png' } });
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /file not found/);
    } finally {
      srv.close();
    }
  });

  it('unsupported extension over the wire produces isError', async () => {
    const srv = startServer(tmpDir);
    try {
      const call = await srv.send('tools/call', { name: 'view_image', arguments: { path: 'note.txt' } });
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /unsupported image extension/);
    } finally {
      srv.close();
    }
  });

  it('oversize file over the wire produces isError', async () => {
    const srv = startServer(tmpDir);
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
