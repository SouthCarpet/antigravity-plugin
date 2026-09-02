/**
 * Tests for scripts/lib/paths.mjs — 8.3 expansion without following junctions.
 *
 * The 8.3 cases run against the deterministic volume in
 * helpers/fake-volume.mjs through the `{ platform, fs }` seam, so they
 * assert the same thing on every host. One extra check probes the real
 * volume and asserts only when the OS actually minted an alias; it never
 * skips.
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
import { fakeVolume, JUNCTION_DIR, LONG_DIR, SHORT_DIR } from './helpers/fake-volume.mjs';

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/**
 * Real Windows `%~sI` short path when this volume minted a lexical `~`
 * alias for `absPath`, else `null`: not win32, 8.3 name generation disabled
 * on the volume (cmd then echoes the long path back unchanged), or
 * `ANTIGRAVITY_TEST_NO_SHORT_NAMES=1`, which forces the "no alias" branch so
 * a run can prove the opportunistic check passes without one.
 *
 * "No alias produced" must be detected lexically — a real short alias like
 * `C:\Users\WSIACC~1` for `C:\Users\WsiAccount` still needs a caller-visible
 * `~` in the final component. Comparing through canonicalComparePath cannot
 * tell this apart from "no alias": that function's whole job is to make a
 * short and long form of the same path compare equal, so it returns equal
 * whether or not cmd actually shortened anything.
 */
function realShortAlias(absPath) {
  if (process.platform !== 'win32' || process.env.ANTIGRAVITY_TEST_NO_SHORT_NAMES === '1') return null;
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

describe('expandShortPath (fixture volume, every platform)', () => {
  const seam = { platform: 'win32', fs: fakeVolume() };

  it('expands an 8.3 alias to the long name by directory listing + inode match', () => {
    // The listing never contains RUNNER~1, so the case-insensitive name
    // match fails and only the inode match can find `runneradmin`.
    assert.equal(expandShortPath(`${SHORT_DIR}\\work`, seam), `${LONG_DIR}\\work`);
    assert.equal(expandShortPath(`\\\\?\\${SHORT_DIR}`, seam), LONG_DIR);
  });

  it('keeps a ~ component that names nothing on the volume', () => {
    assert.equal(expandShortPath('C:\\Users\\NOSUCH~1\\work', seam), 'C:\\Users\\NOSUCH~1\\work');
  });

  it('stays on a junction reached through an alias instead of following it', () => {
    const viaAlias = `${SHORT_DIR}\\junction\\secret.png`;
    assert.equal(expandShortPath(viaAlias, seam), `${JUNCTION_DIR}\\secret.png`);
    assert.notEqual(
      canonicalComparePath(viaAlias, seam),
      canonicalComparePath(seam.fs.realpathSync.native(viaAlias), seam),
    );
  });

  it('leaves ~ alone on POSIX, where it is an ordinary character', () => {
    const posix = { platform: 'linux', fs: fakeVolume() };
    assert.equal(expandShortPath('/tmp/foo~bar', posix), '/tmp/foo~bar');
    assert.equal(canonicalComparePath('/tmp/FOO~bar', posix), '/tmp/FOO~bar');
  });
});

describe('canonicalComparePath', () => {
  it('is equal for the short and long spelling of the same path (fixture volume)', () => {
    const seam = { platform: 'win32', fs: fakeVolume() };
    assert.equal(canonicalComparePath(`${SHORT_DIR}\\work`, seam), canonicalComparePath(`${LONG_DIR}\\work`, seam));
    assert.equal(canonicalComparePath(`\\\\?\\${SHORT_DIR}\\Work`, seam), 'c:\\users\\runneradmin\\work');
  });

  it('is equal for a real 8.3 alias whenever this volume minted one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-paths-'));
    tmpDirs.push(dir);
    const short = realShortAlias(dir);
    // No alias here (not Windows, 8.3 generation off, or forced by
    // ANTIGRAVITY_TEST_NO_SHORT_NAMES=1): the property "if an alias exists it
    // canonicalises equal" holds vacuously and the fixture tests above carry
    // the real proof. This test never skips.
    if (short !== null) {
      assert.notEqual(path.basename(short).toLowerCase(), path.basename(dir).toLowerCase());
      assert.equal(canonicalComparePath(short), canonicalComparePath(dir));
    }
    assert.equal(canonicalComparePath(dir), canonicalComparePath(expandShortPath(dir)));
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
