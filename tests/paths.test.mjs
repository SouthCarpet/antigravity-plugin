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

/**
 * Windows `%~sI` short path, or `null` when the platform is not win32, or
 * when 8.3 name generation is disabled on the volume (cmd echoes the
 * original long path back unchanged in that case — a caller that does not
 * check for that would silently "pass" a short-path assertion without ever
 * exercising real 8.3 translation).
 *
 * "No alias produced" must be detected lexically — a real short alias like
 * `C:\Users\WSIACC~1` for `C:\Users\WsiAccount` still needs a caller-visible
 * `~` in the final component. Comparing through canonicalComparePath cannot
 * tell this apart from "no alias": that function's whole job is to make a
 * short and long form of the same path compare equal, so it returns equal
 * whether or not cmd actually shortened anything, and using that equality
 * as the "no alias" signal is inverted — it fires on every real alias too.
 */
function windowsShortPath(absPath) {
  if (process.platform !== 'win32') return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-paths-short-'));
  tmpDirs.push(dir);
  const bat = path.join(dir, 'short.bat');
  fs.writeFileSync(bat, `@echo off\r\nfor %%I in ("${absPath}") do echo %%~sI\r\n`);
  const result = spawnSync('cmd.exe', ['/c', bat], { encoding: 'utf8' });
  const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) return null;
  const shortBase = path.basename(line);
  const longBase = path.basename(absPath);
  if (!shortBase.includes('~') || shortBase.toLowerCase() === longBase.toLowerCase()) return null;
  return line;
}

describe('stripExtendedPath', () => {
  it('strips \\\\?\\ and \\\\?\\UNC\\ prefixes', () => {
    assert.equal(stripExtendedPath('\\\\?\\C:\\Users\\runneradmin'), 'C:\\Users\\runneradmin');
    assert.equal(stripExtendedPath('\\\\?\\UNC\\server\\share\\file'), '\\\\server\\share\\file');
    assert.equal(stripExtendedPath('C:\\Users\\runneradmin'), 'C:\\Users\\runneradmin');
  });
});

describe('canonicalComparePath', () => {
  it('is stable for a path and its 8.3 short form of the same directory', (t) => {
    if (process.platform !== 'win32') { t.skip('8.3 short names are a Windows-only concept'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-paths-'));
    tmpDirs.push(dir);
    const short = windowsShortPath(dir);
    if (short === null) {
      t.skip('8.3 name generation is disabled on this volume — no short alias was produced to compare against');
      return;
    }
    assert.notEqual(short, dir, 'short path fixture must actually differ from the long path to prove translation happened');
    assert.equal(canonicalComparePath(short), canonicalComparePath(dir));
    assert.equal(canonicalComparePath(dir), canonicalComparePath(expandShortPath(dir)));
  });

  it('expands a real 8.3 ~ alias when the volume has one', (t) => {
    if (process.platform !== 'win32') {
      assert.equal(expandShortPath('/tmp/foo~bar'), path.resolve('/tmp/foo~bar'));
      return;
    }
    const users = 'C:\\Users';
    for (const name of fs.readdirSync(users)) {
      const longPath = path.join(users, name);
      let st;
      try { st = fs.lstatSync(longPath); } catch { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      // windowsShortPath already returns null unless it produced a real
      // lexical `~` alias, so a non-null result here is proof, not a guess.
      const short = windowsShortPath(longPath);
      if (short === null) continue;
      assert.equal(canonicalComparePath(short), canonicalComparePath(longPath));
      assert.notEqual(path.basename(short).toLowerCase(), name.toLowerCase());
      return;
    }
    // No candidate under C:\Users produced a real ~ alias — most likely 8.3
    // name generation is disabled on this volume (`fsutil 8dot3name query`).
    // Skip visibly instead of asserting something that proves nothing.
    t.skip('no directory under C:\\Users produced a real 8.3 ~ alias on this volume');
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
