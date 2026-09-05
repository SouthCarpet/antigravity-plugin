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
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';

import { loadImageResult, MAX_FRAME_BYTES, serveVision } from '../scripts/mcp/vision-server.mjs';
import { canonicalComparePath } from '../scripts/lib/paths.mjs';
import { VISION_ALLOWLIST_ENV } from '../scripts/lib/vision-capability.mjs';
import { fakeVolume, LONG_DIR, SHORT_DIR, TINY_PNG_BASE64 } from './helpers/fake-volume.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'scripts', 'mcp', 'vision-server.mjs');

/**
 * Real `node:fs` seen through one extra 8.3-style alias: every call that
 * names `aliasDir` (or something under it) is served from `longDir`, which
 * is what an NTFS volume with 8.3 names on does for `RUNNER~1`. This lets a
 * test run alias expansion against a real reparse point on disk without
 * needing the OS to mint an alias.
 */
function aliasedFs(aliasDir, longDir) {
  const rewrite = (input) => {
    const s = String(input);
    if (s === aliasDir || s.startsWith(aliasDir + path.sep)) return longDir + s.slice(aliasDir.length);
    return s;
  };
  return {
    lstatSync: (p) => fs.lstatSync(rewrite(p)),
    readdirSync: (p) => fs.readdirSync(rewrite(p)),
    realpathSync: { native: (p) => fs.realpathSync.native(rewrite(p)) },
    statSync: (p) => fs.statSync(rewrite(p)),
    readFileSync: (p) => fs.readFileSync(rewrite(p)),
  };
}

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
    // Brief R1: retain the documented text-then-image success shape and pixels.
    assert.deepEqual(out.content.map((part) => part.type), ['text', 'image']);
    assert.equal(imagePart.data, TINY_PNG_BASE64);
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

  it('blocks a Windows UNC path before filesystem access', () => {
    const out = loadImageResult('\\\\server\\share\\secret.png', tmpDir, [pngPath]);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /not authorized/);
  });

  it('blocks a Windows extended-length path before filesystem access', () => {
    const out = loadImageResult('\\\\?\\C:\\secret.png', tmpDir, [pngPath]);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /not authorized/);
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

  it('still refuses a real junction after short-name canonicalization', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-vision-junc-canon-'));
    tmpDirs.push(outsideDir);
    const outsidePath = path.join(outsideDir, 'secret.png');
    fs.writeFileSync(outsidePath, Buffer.from(TINY_PNG_BASE64, 'base64'));
    const linkDir = path.join(tmpDir, 'canonical-looking');
    fs.symlinkSync(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedPath = path.join(linkDir, 'secret.png');
    // The junction seen through an 8.3-style alias, served by the real fs.
    const aliasDir = path.join(tmpDir, 'CANONI~1');
    const shortLinked = path.join(aliasDir, 'secret.png');
    const seam = { fs: aliasedFs(aliasDir, linkDir) };

    // Only Windows expands `~` aliases; on POSIX `CANONI~1` is a literal
    // name, so the alias and long spelling stay distinct there. Either way
    // the request below must be refused: the alias is on the allowlist, but
    // the file resolves through the junction.
    const expandsAliases = process.platform === 'win32';
    assert.equal(
      canonicalComparePath(shortLinked, seam) === canonicalComparePath(linkedPath, seam),
      expandsAliases,
    );
    assert.notEqual(
      canonicalComparePath(linkedPath),
      canonicalComparePath(fs.realpathSync.native(linkedPath)),
      'canonical form of a junction path must not equal its realpath target',
    );

    const out = loadImageResult(shortLinked, tmpDir, [shortLinked, linkedPath], seam);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /symlink|junction/);
  });

  it('allows a legitimate image reached via a Windows 8.3 short path (fixture volume)', () => {
    const seam = { platform: 'win32', fs: fakeVolume() };
    const shortPng = `${SHORT_DIR}\\probe.png`;
    const longPng = `${LONG_DIR}\\probe.png`;

    // Allowlist in short form, and allowlist in long form with a short cwd:
    // both spellings of one file must be accepted, and the realpath check
    // must not mistake the alias for a junction escape.
    for (const allowed of [[shortPng], [longPng]]) {
      const out = loadImageResult('probe.png', SHORT_DIR, allowed, seam);
      assert.equal(out.isError, undefined, out.content[0].text);
      const imagePart = out.content.find((c) => c.type === 'image');
      assert.ok(imagePart, 'expected an image content block');
      assert.equal(imagePart.data, TINY_PNG_BASE64);
    }
  });

  it('refuses a junction reached via a Windows 8.3 short path (fixture volume)', () => {
    const seam = { platform: 'win32', fs: fakeVolume() };
    const viaAlias = `${SHORT_DIR}\\junction\\secret.png`;
    const out = loadImageResult(viaAlias, SHORT_DIR, [viaAlias], seam);
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

  // Oracle for the race, cap and descriptor cases: binding brief 076-T2 R1.
  it('refuses a real junction/symlink substitution scheduled after the pre-open stat', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-vision-race-'));
    tmpDirs.push(dir);
    const allowedDir = path.join(dir, 'allowed');
    const outsideDir = path.join(dir, 'unlisted');
    fs.mkdirSync(allowedDir);
    fs.mkdirSync(outsideDir);
    const allowedPath = path.join(allowedDir, 'probe.png');
    const secretPath = path.join(outsideDir, 'probe.png');
    fs.writeFileSync(allowedPath, Buffer.from(TINY_PNG_BASE64, 'base64'));
    fs.writeFileSync(secretPath, 'unlisted secret');
    const seam = { fs: { ...fs, statSync(p) {
      const stat = fs.statSync(p);
      fs.unlinkSync(allowedPath);
      if (process.platform === 'win32') {
        fs.rmdirSync(allowedDir);
        fs.symlinkSync(outsideDir, allowedDir, 'junction');
      } else {
        fs.symlinkSync(secretPath, allowedPath);
      }
      return stat;
    } } };

    const out = loadImageResult(allowedPath, dir, [allowedPath], seam);
    assert.equal(out.isError, true);
    assert.equal(out.content[0].text, 'ERROR: image identity changed; refusing access');
    assert.equal(out.content.length, 1);
  });

  for (const [condition, change] of [
    ['non-file handle', { isFile: () => false }],
    ['changed device', { dev: -1 }],
    ['changed inode', { ino: -1 }],
  ]) {
    it(`refuses and closes a ${condition}`, () => {
      let closes = 0;
      const seam = { fs: { ...fs,
        fstatSync: (fd) => Object.assign(fs.fstatSync(fd), change),
        closeSync(fd) { closes++; fs.closeSync(fd); },
      } };
      const out = loadImageResult(pngPath, tmpDir, [pngPath], seam);
      assert.equal(out.isError, true);
      assert.equal(out.content[0].text, 'ERROR: image identity changed; refusing access');
      assert.equal(closes, 1);
    });
  }

  it('refuses a changed canonical path even when the opened identity matches', () => {
    let opened = false;
    let closes = 0;
    const seam = { fs: { ...fs,
      openSync(p, flags) { const fd = fs.openSync(p, flags); opened = true; return fd; },
      realpathSync: { native: (p) => opened ? path.join(tmpDir, 'unlisted.png') : fs.realpathSync.native(p) },
      closeSync(fd) { closes++; fs.closeSync(fd); },
    } };
    const out = loadImageResult(pngPath, tmpDir, [pngPath], seam);
    assert.equal(out.isError, true);
    assert.equal(out.content[0].text, 'ERROR: image identity changed; refusing access');
    assert.equal(closes, 1);
  });

  it('refuses growth past 10 MiB after stat and closes the handle', () => {
    const growingPath = path.join(tmpDir, 'growing.png');
    fs.writeFileSync(growingPath, Buffer.from(TINY_PNG_BASE64, 'base64'));
    let closes = 0;
    const seam = { fs: { ...fs,
      statSync(p) { const stat = fs.statSync(p); fs.truncateSync(p, 10 * 1024 * 1024 + 1); return stat; },
      closeSync(fd) { closes++; fs.closeSync(fd); },
    } };
    const out = loadImageResult(growingPath, tmpDir, [growingPath], seam);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /too large.*byte cap/);
    assert.equal(out.content.length, 1);
    assert.equal(closes, 1);
  });

  it('accepts an image exactly at the 10 MiB cap', () => {
    const exactPath = path.join(tmpDir, 'exact.png');
    fs.writeFileSync(exactPath, Buffer.alloc(10 * 1024 * 1024, 42));
    const out = loadImageResult(exactPath, tmpDir, [exactPath]);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out.content.map((part) => part.type), ['text', 'image']);
    assert.equal(Buffer.from(out.content[1].data, 'base64').length, 10 * 1024 * 1024);
  });

  it('returns all image bytes when handle reads are short', () => {
    const seam = { fs: { ...fs,
      readSync: (fd, buffer, offset, length, position) =>
        fs.readSync(fd, buffer, offset, Math.min(length, 7), position),
    } };
    const out = loadImageResult(pngPath, tmpDir, [pngPath], seam);
    assert.equal(out.content[1].data, TINY_PNG_BASE64);
  });

  it('closes the handle exactly once and hides details when reading throws', () => {
    let closes = 0;
    const seam = { fs: { ...fs,
      readSync() { throw new Error(`sensitive read failure at ${SERVER}`); },
      closeSync(fd) { closes++; fs.closeSync(fd); },
    } };
    const out = loadImageResult(pngPath, tmpDir, [pngPath], seam);
    assert.equal(out.isError, true);
    assert.equal(out.content[0].text, 'ERROR: unable to read image');
    assert.equal(closes, 1);
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

// A complete stdin session proves recovery and a clean exit, rather than
// killing the server as soon as a response arrives. Oracle: brief 076-T2 R2.
async function exchangeFrames(t, input) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: tmpDir,
    env: { ...process.env, [VISION_ALLOWLIST_ENV]: '[]' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => {}); // A premature exit is asserted below.
  const closed = once(child, 'close');
  child.stdin.end(input);
  const [code, signal] = await closed;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.equal(stderr, '');
  return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('vision-server malformed input recovery (brief R2)', () => {
  const ping = '{"jsonrpc":"2.0","id":99,"method":"ping"}\n';
  const invalidRequests = [
    ['null', 'null', null],
    ['array', '[1,2]', null],
    ['string', '"str"', null],
    ['wrong version', '{"jsonrpc":"1.0","id":1,"method":"ping"}', 1],
    ['missing version', '{"id":1,"method":"ping"}', 1],
    ['non-string method', '{"jsonrpc":"2.0","id":1,"method":{}}', 1],
    ['unusable id', '{"jsonrpc":"2.0","id":{},"method":"ping"}', null],
  ];
  for (const [label, frame, id] of invalidRequests) {
    it(`answers ${label} with invalid request, then ping, and exits 0`, { timeout: 10000 }, async (t) => {
      const replies = await exchangeFrames(t, `${frame}\n${ping}`);
      assert.equal(replies.length, 2);
      assert.deepEqual(replies[0], {
        jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request' },
      });
      assert.deepEqual(replies[1], { jsonrpc: '2.0', id: 99, result: {} });
    });
  }

  for (const [label, args] of [
    ['object with non-callable toString', { path: { toString: 1 } }],
    ['empty path', { path: '' }],
    ['missing path', {}],
  ]) {
    it(`rejects ${label} without leaking details and still answers ping`, { timeout: 10000 }, async (t) => {
      // Deliberately omit name: path validation must catch the brief's exact payload.
      const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { arguments: args } });
      const replies = await exchangeFrames(t, `${frame}\n${ping}`);
      assert.equal(replies.length, 2);
      assert.deepEqual(replies[0].error, { code: -32602, message: 'path must be a non-empty string' });
      assert.doesNotMatch(JSON.stringify(replies[0]), /\bat\s+\S+|vision-server\.mjs|toString/);
      assert.ok(!JSON.stringify(replies[0]).includes(SERVER));
      assert.deepEqual(replies[1], { jsonrpc: '2.0', id: 99, result: {} });
    });
  }

  it('does not echo an object supplied as an unknown tool name', { timeout: 10000 }, async (t) => {
    const replies = await exchangeFrames(t,
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":{"toString":1},"arguments":{"path":"probe.png"}}}\n' + ping);
    assert.equal(replies.length, 2);
    assert.deepEqual(replies[0].error, { code: -32602, message: 'unknown tool' });
    assert.equal(replies[1].id, 99);
  });

  it('never answers notifications, including malformed and unknown ones', { timeout: 10000 }, async (t) => {
    const input = [
      '{"jsonrpc":"2.0","method":"ping"}',
      '{"jsonrpc":"2.0","method":"tools/call","params":{"arguments":{"path":{}}}}',
      '{"jsonrpc":"2.0","method":"unknown"}',
      '{"jsonrpc":"1.0","method":42}',
      '{}',
    ].join('\n');
    const replies = await exchangeFrames(t, `${input}\n${ping}`);
    assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 99, result: {} }]);
  });

  it('answers invalid JSON with a parse error and continues at the next line', { timeout: 10000 }, async (t) => {
    const replies = await exchangeFrames(t, `{broken\n${ping}`);
    assert.equal(replies.length, 2);
    assert.deepEqual(replies[0].error, { code: -32700, message: 'parse error' });
    assert.equal(replies[1].id, 99);
  });

  it('drops a frame over the byte cap with one error, then answers ping and exits 0', { timeout: 10000 }, async (t) => {
    const replies = await exchangeFrames(t, `${'x'.repeat(MAX_FRAME_BYTES * 3)}\n${ping}`);
    assert.equal(replies.length, 2);
    assert.deepEqual(replies[0], {
      jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request frame exceeds byte cap' },
    });
    assert.deepEqual(replies[1], { jsonrpc: '2.0', id: 99, result: {} });
  });

  it('caps UTF-8 bytes rather than characters', { timeout: 10000 }, async (t) => {
    const replies = await exchangeFrames(t, `"${'é'.repeat(MAX_FRAME_BYTES / 2)}"\n${ping}`);
    assert.equal(replies.length, 2);
    assert.equal(replies[0].error.message, 'request frame exceeds byte cap');
    assert.equal(replies[1].id, 99);
  });

  it('accepts a frame exactly at the byte cap and a final line without a newline', { timeout: 10000 }, async (t) => {
    const exactFrame = ping.trimEnd().padEnd(MAX_FRAME_BYTES, ' ');
    const replies = await exchangeFrames(t, `${exactFrame}\n${ping.trimEnd()}`);
    assert.deepEqual(replies, [
      { jsonrpc: '2.0', id: 99, result: {} },
      { jsonrpc: '2.0', id: 99, result: {} },
    ]);
  });
});

describe('vision-server transport bounds and handler failures (brief R2)', () => {
  it('drops an oversized frame across chunks and preserves a split UTF-8 id on the next request', async () => {
    const chunks = [
      Buffer.alloc(MAX_FRAME_BYTES, 120), Buffer.from('x'), Buffer.from('discarded\n'),
      Buffer.from('{"jsonrpc":"2.0","method":"ping","id":"'),
      Buffer.from([0xc3]), Buffer.from([0xa9]), Buffer.from('"}\n'),
    ];
    const replies = [];
    const output = new Writable({ write(chunk, encoding, callback) {
      replies.push(JSON.parse(chunk.toString())); callback();
    } });
    await serveVision(Readable.from(chunks), output, []);
    assert.equal(replies.length, 2);
    assert.equal(replies[0].error.message, 'request frame exceeds byte cap');
    assert.deepEqual(replies[1], { jsonrpc: '2.0', id: 'é', result: {} });
  });

  it('turns an unexpected loader exception into one fixed internal error and keeps serving', async () => {
    const input = Readable.from([Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"view_image","arguments":{"path":"probe.png"}}}\n'
      + '{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
    )]);
    const replies = [];
    const output = new Writable({ write(chunk, encoding, callback) {
      replies.push(JSON.parse(chunk.toString())); callback();
    } });
    await serveVision(input, output, [], () => { throw new Error(`secret path ${SERVER}\n    at handler`); });
    assert.deepEqual(replies, [
      { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'internal error' } },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });

  it('turns an unexpected serialization exception into one fixed internal error and keeps serving', async () => {
    const input = Readable.from([Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"view_image","arguments":{"path":"probe.png"}}}\n'
      + '{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
    )]);
    const replies = [];
    const output = new Writable({ write(chunk, encoding, callback) {
      replies.push(JSON.parse(chunk.toString())); callback();
    } });
    // Force serialization failure independently of V8's recursion limits.
    await serveVision(input, output, [], () => ({ toJSON() {
      throw new Error(`secret path ${SERVER}\n    at serializer`);
    } }));
    assert.deepEqual(replies, [
      { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'internal error' } },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });

  it('waits for output drain before loading another requested image', { timeout: 10000 }, async () => {
    const request = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"view_image","arguments":{"path":"probe.png"}}}\n';
    let release;
    let signalWrite;
    const firstWrite = new Promise((resolve) => { signalWrite = resolve; });
    const replies = [];
    const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
      replies.push(JSON.parse(chunk.toString()));
      if (replies.length === 1) { release = callback; signalWrite(); }
      else callback();
    } });
    let loads = 0;
    const serving = serveVision(Readable.from([Buffer.from(request + request)]), output, [pngPath], () => {
      loads++;
      return loadImageResult(pngPath, tmpDir, [pngPath]);
    });
    await firstWrite;
    try {
      assert.equal(loads, 1, 'a paused client must stop subsequent image reads');
      assert.equal(replies.length, 1);
    } finally {
      release();
    }
    await serving;
    assert.equal(loads, 2);
    assert.equal(replies.length, 2);
  });
});
