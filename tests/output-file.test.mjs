/**
 * output-file: the shared "write one NEW local file" rule behind
 * `result --export` and `media --output` (3.2.0, package C).
 *
 *   node --test tests/output-file.test.mjs
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OutputTargetError,
  assertNewFileTarget,
  displayTargetPath,
  outputPathLimit,
  resolveOutputPath,
  writeNewTextFile,
} from '../scripts/lib/output-file.mjs';

let dir;
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'output-file-')));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function refusal(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof OutputTargetError, String(error));
    return error;
  }
  assert.fail('expected an OutputTargetError');
}

// Oracle: the brief's path rules. The target is resolved against the given cwd.
describe('resolveOutputPath', () => {
  test('resolves a relative path against the given cwd', () => {
    assert.equal(resolveOutputPath('out.txt', dir, { noun: 'Export' }), path.join(dir, 'out.txt'));
  });

  test('keeps an absolute path as it is', () => {
    const target = path.join(dir, 'a', 'b.txt');
    assert.equal(resolveOutputPath(target, '/somewhere/else', { noun: 'Export' }), target);
  });

  for (const [name, value] of [['empty', ''], ['blank', '   '], ['not a string', undefined]]) {
    test(`refuses a ${name} value`, () => {
      const error = refusal(() => resolveOutputPath(value, dir, { noun: 'Export' }));
      assert.equal(error.reason, 'empty_path');
      assert.equal(error.message, 'Export path is empty. Give a file path after the flag.');
    });
  }

  for (const [name, char] of [['newline', '\n'], ['carriage return', '\r'], ['NUL', '\u0000'], ['escape', '\u001b'], ['DEL', '\u007f'], ['C1 control', '\u0085']]) {
    test(`refuses a ${name} in the path, and the message holds no raw control character`, () => {
      const error = refusal(() => resolveOutputPath(`out${char}evil.txt`, dir, { noun: 'Output' }));
      assert.equal(error.reason, 'control_character');
      assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f]/);
      assert.match(error.message, /^Output path holds a control character \(shown escaped\): out/);
    });
  }

  test('refuses a path longer than the platform limit', () => {
    const error = refusal(() => resolveOutputPath('x'.repeat(5000), dir, { noun: 'Export' }));
    assert.equal(error.reason, 'path_too_long');
    assert.equal(error.message, `Export path is longer than the ${outputPathLimit()} characters this platform allows.`);
  });

  test('the limit is 259 on win32 and 4095 elsewhere', () => {
    assert.equal(outputPathLimit('win32'), 259);
    assert.equal(outputPathLimit('linux'), 4095);
    assert.equal(outputPathLimit('darwin'), 4095);
  });

  test('a path of exactly the limit is accepted', () => {
    const limit = outputPathLimit('linux');
    const root = path.resolve('/');
    const padded = path.join(root, 'x'.repeat(limit - root.length));
    assert.equal(padded.length, limit);
    assert.equal(resolveOutputPath(padded, dir, { noun: 'Export', platform: 'linux' }), padded);
    const over = refusal(() => resolveOutputPath(`${padded}x`, dir, { noun: 'Export', platform: 'linux' }));
    assert.equal(over.reason, 'path_too_long');
  });
});

describe('displayTargetPath', () => {
  test('puts the path on one line with control characters escaped and backticks neutralized', () => {
    assert.equal(displayTargetPath('a\nb\r\nc`d\u001be\u007f'), "a\\nb\\nc'd\\u001be\\u007f");
  });
});

// Oracle: "the target must not exist, checked without following a link; its parent must exist".
describe('assertNewFileTarget', () => {
  test('accepts a new file in an existing directory', () => {
    assert.doesNotThrow(() => assertNewFileTarget(path.join(dir, 'new.txt'), { noun: 'Export' }));
  });

  test('refuses an existing file and leaves it unchanged', () => {
    const target = path.join(dir, 'keep.txt');
    fs.writeFileSync(target, 'original');
    const error = refusal(() => assertNewFileTarget(target, { noun: 'Export' }));
    assert.equal(error.reason, 'exists_file');
    assert.equal(error.message, `Export target already exists as a file: ${target}. The plugin never overwrites.`);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  });

  test('refuses an existing directory', () => {
    const target = path.join(dir, 'folder');
    fs.mkdirSync(target);
    const error = refusal(() => assertNewFileTarget(target, { noun: 'Output' }));
    assert.equal(error.reason, 'exists_directory');
    assert.match(error.message, /^Output target already exists as a directory: /);
  });

  test('refuses a link without following it, also when the link target is missing', (t) => {
    const real = path.join(dir, 'real-dir');
    fs.mkdirSync(real);
    const link = path.join(dir, 'link');
    try {
      fs.symlinkSync(real, link, 'junction');
    } catch (error) {
      t.skip(`cannot create a link here: ${error.code}`);
      return;
    }
    const error = refusal(() => assertNewFileTarget(link, { noun: 'Export' }));
    assert.equal(error.reason, 'exists_link');
    assert.match(error.message, /^Export target already exists as a link: /);
    fs.rmSync(real, { recursive: true });
    assert.equal(refusal(() => assertNewFileTarget(link, { noun: 'Export' })).reason, 'exists_link');
  });

  test('refuses a file symlink when the platform allows one, and the target of the link stays unchanged', (t) => {
    const real = path.join(dir, 'real.txt');
    fs.writeFileSync(real, 'original');
    const link = path.join(dir, 'file-link');
    try {
      fs.symlinkSync(real, link, 'file');
    } catch (error) {
      t.skip(`cannot create a file link here: ${error.code}`);
      return;
    }
    assert.equal(refusal(() => assertNewFileTarget(link, { noun: 'Export' })).reason, 'exists_link');
    assert.equal(fs.readFileSync(real, 'utf8'), 'original');
  });

  test('refuses a missing parent directory', () => {
    const target = path.join(dir, 'missing', 'out.txt');
    const error = refusal(() => assertNewFileTarget(target, { noun: 'Export' }));
    assert.equal(error.reason, 'parent_missing');
    assert.equal(error.message, `Export target directory does not exist: ${path.dirname(target)}`);
    assert.equal(fs.existsSync(path.dirname(target)), false);
  });

  test('refuses a parent that is a file', () => {
    const parent = path.join(dir, 'a-file');
    fs.writeFileSync(parent, 'x');
    const error = refusal(() => assertNewFileTarget(path.join(parent, 'out.txt'), { noun: 'Export' }));
    assert.equal(error.reason, 'parent_not_directory');
  });

  // Oracle: package J, POSIX can reject either path lookup with ENOTDIR.
  for (const stage of ['target', 'parent']) {
    test(`maps injected ENOTDIR at ${stage} lookup to parent_not_directory`, () => {
      const fail = () => { throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }); };
      const io = stage === 'target' ? { lstatSync: fail } : {
        lstatSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, statSync: fail,
      };
      assert.equal(refusal(() => assertNewFileTarget(path.join(dir, 'x'), { noun: 'Export', io })).reason, 'parent_not_directory');
    });
  }
  for (const code of ['EACCES', 'ELOOP', 'ENAMETOOLONG']) {
    test(`reports ${code} at parent lookup as check_failed`, () => {
      const io = { statSync: () => { throw Object.assign(new Error(code), { code }); } };
      assert.equal(refusal(() => assertNewFileTarget(path.join(dir, 'x'), { noun: 'Export', io })).reason, 'check_failed');
    });
  }
  test('refuses a parent link to a file when file symlinks are allowed', (t) => {
    const real = path.join(dir, 'real-parent'); fs.writeFileSync(real, 'x');
    const link = path.join(dir, 'parent-link');
    try { fs.symlinkSync(real, link, 'file'); } catch (error) { t.skip(`file symlinks unavailable: ${error.code}`); return; }
    assert.equal(refusal(() => assertNewFileTarget(path.join(link, 'out'), { noun: 'Export' })).reason, 'parent_not_directory');
  });

  test('reports a check error other than "not found" as check_failed', () => {
    const io = { lstatSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
    const error = refusal(() => assertNewFileTarget(path.join(dir, 'x'), { noun: 'Export', io }));
    assert.equal(error.reason, 'check_failed');
    assert.match(error.message, /^Export target cannot be checked \(EACCES\): /);
  });
});

// Oracle: "created exclusively (wx); a partial file is removed after a failed write".
describe('writeNewTextFile', () => {
  test('writes the exact UTF-8 bytes with no byte order mark and reports the byte count', () => {
    const target = path.join(dir, 'out.txt');
    const text = 'zlučka ✓\n';
    const result = writeNewTextFile(target, text, { noun: 'Export' });
    const bytes = fs.readFileSync(target);
    assert.deepEqual([...bytes], [...Buffer.from(text, 'utf8')]);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.deepEqual(result, { bytes: Buffer.byteLength(text, 'utf8') });
  });

  test('refuses a file that appeared after the early check, and leaves its content unchanged', () => {
    const target = path.join(dir, 'race.txt');
    assertNewFileTarget(target, { noun: 'Export' });
    fs.writeFileSync(target, 'someone else');
    const error = refusal(() => writeNewTextFile(target, 'mine', { noun: 'Export' }));
    assert.equal(error.reason, 'exists_file');
    assert.equal(fs.readFileSync(target, 'utf8'), 'someone else');
  });

  test('refuses a missing parent at write time and creates nothing', () => {
    const target = path.join(dir, 'gone', 'out.txt');
    const error = refusal(() => writeNewTextFile(target, 'x', { noun: 'Output' }));
    assert.equal(error.reason, 'parent_missing');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('removes the partial file when the write fails after the create, and says so', () => {
    const target = path.join(dir, 'partial.txt');
    const io = {
      writeFileSync: (fd, data) => {
        fs.writeSync(fd, data.subarray(0, 2));
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    };
    const error = refusal(() => writeNewTextFile(target, 'abcdef', { noun: 'Export', io }));
    assert.equal(error.reason, 'write_failed');
    assert.equal(error.message, `Export target cannot be written (ENOSPC): ${target}. No partial file is left.`);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('a failed create never removes a file this call did not create', () => {
    const target = path.join(dir, 'foreign.txt');
    fs.writeFileSync(target, 'foreign');
    const io = { unlinkSync: () => assert.fail('unlink must not run') };
    refusal(() => writeNewTextFile(target, 'mine', { noun: 'Export', io }));
    assert.equal(fs.readFileSync(target, 'utf8'), 'foreign');
  });

  test('refuses a read-only directory when the platform enforces it', (t) => {
    if (process.platform === 'win32') {
      t.skip('Windows does not enforce POSIX directory modes');
      return;
    }
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked, { mode: 0o500 });
    // Shared afterEach removes dir before t.after on Node 24. Restore first.
    try {
      const probe = path.join(locked, 'probe');
      try {
        fs.writeFileSync(probe, 'probe', { flag: 'wx' });
        fs.unlinkSync(probe);
        t.skip('process can write to a read-only directory (root or equivalent privileges)');
        return;
      } catch (error) { if (error.code !== 'EACCES') throw error; }
      const error = refusal(() => writeNewTextFile(path.join(locked, 'out.txt'), 'x', { noun: 'Export' }));
      assert.equal(error.reason, 'write_failed');
      assert.match(error.message, /^Export target cannot be written \(EACCES\): /);
    } finally {
      if (fs.existsSync(locked)) fs.chmodSync(locked, 0o700);
    }
  });

  test('an existing read-only file is refused and stays unchanged', () => {
    const target = path.join(dir, 'readonly.txt');
    fs.writeFileSync(target, 'original');
    fs.chmodSync(target, 0o444);
    const error = refusal(() => assertNewFileTarget(target, { noun: 'Export' }));
    assert.equal(error.reason, 'exists_file');
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  });
});
