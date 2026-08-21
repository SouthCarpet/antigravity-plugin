/**
 * Tests for scripts/check-pack.mjs — derived required set vs `npm pack`.
 *
 * The gate walks static imports and literal `import("…")` only. Computed
 * specifiers are out of scope; their targets must already be required by
 * an explicit rule.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-pack.mjs');

describe('check-pack CLI (legitimate tree)', () => {
  it('passes on the real tree', () => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.equal(res.status, 0, text);
    assert.match(text, /ok: required pack entries/);
  });
});
