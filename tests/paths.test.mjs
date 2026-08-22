/**
 * Tests for scripts/lib/paths.mjs — 8.3 expansion without following junctions.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalComparePath,
  expandShortPath,
  stripExtendedPath,
} from '../scripts/lib/paths.mjs';

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function windowsShortPath(absPath) {
  if (process.platform !== 'win32') return absPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-paths-short-'));
  tmpDirs.push(dir);
  const bat = path.join(dir, 'short.bat');
  fs.writeFileSync(bat, `@echo off\r\nfor %%I in ("${absPath}") do echo %%~sI\r\n`);
  const result = spawnSync('cmd.exe', ['/c', bat], { encoding: 'utf8' });
  const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  return line || absPath;
}

describe('stripExtendedPath', () => {
  it('strips \\\\?\\ and \\\\?\\UNC\\ prefixes', () => {
    assert.equal(stripExtendedPath('\\\\?\\C:\\Users\\runneradmin'), 'C:\\Users\\runneradmin');
    assert.equal(stripExtendedPath('\\\\?\\UNC\\server\\share\\file'), '\\\\server\\share\\file');
    assert.equal(stripExtendedPath('C:\\Users\\runneradmin'), 'C:\\Users\\runneradmin');
  });
});

describe('canonicalComparePath', () => {
  it('is stable for a path and its 8.3 short form of the same directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-paths-'));
    tmpDirs.push(dir);
    const short = windowsShortPath(dir);
    assert.equal(canonicalComparePath(short), canonicalComparePath(dir));
    assert.equal(canonicalComparePath(dir), canonicalComparePath(expandShortPath(dir)));
  });

  it('expands a real 8.3 ~ alias when the volume has one', () => {
    if (process.platform !== 'win32') {
      assert.equal(expandShortPath('/tmp/foo~bar'), path.resolve('/tmp/foo~bar'));
      return;
    }
    let found = false;
    const users = 'C:\\Users';
    for (const name of fs.readdirSync(users)) {
      const longPath = path.join(users, name);
      let st;
      try { st = fs.lstatSync(longPath); } catch { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const short = windowsShortPath(longPath);
      const shortBase = path.basename(short);
      if (!shortBase.includes('~') || shortBase.toLowerCase() === name.toLowerCase()) continue;
      assert.equal(canonicalComparePath(short), canonicalComparePath(longPath));
      assert.notEqual(shortBase.toLowerCase(), name.toLowerCase());
      found = true;
      break;
    }
    if (!found) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'has~tilde-'));
      tmpDirs.push(dir);
      assert.equal(canonicalComparePath(dir), canonicalComparePath(path.resolve(dir)));
    }
  });

  it('treats a Windows extended-length realpath prefix as the same path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-paths-ext-'));
    tmpDirs.push(dir);
    const resolved = path.resolve(dir);
    const prefixed = process.platform === 'win32' ? `\\\\?\\${resolved}` : resolved;
    assert.equal(canonicalComparePath(prefixed), canonicalComparePath(resolved));
    assert.equal(stripExtendedPath(`\\\\?\\C:\\Users\\runneradmin`), 'C:\\Users\\runneradmin');
  });

  it('does not follow a junction: lexical canonical form stays on the link', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-paths-out-'));
    const here = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-paths-here-'));
    tmpDirs.push(outside, here);
    const link = path.join(here, 'permitted-looking');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    assert.equal(canonicalComparePath(link), canonicalComparePath(path.resolve(link)));
    assert.notEqual(
      canonicalComparePath(link),
      canonicalComparePath(fs.realpathSync.native(link)),
    );
  });
});
