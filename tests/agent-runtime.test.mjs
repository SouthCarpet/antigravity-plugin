import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_AGY_BIN,
  resolveAgyBin,
} from '../scripts/lib/agent-runtime.mjs';

describe('resolveAgyBin', () => {
  it('returns AGY_BIN env value when it points to an existing file', () => {
    const env = { AGY_BIN: process.execPath, PATH: '' };
    assert.equal(resolveAgyBin(env), process.execPath);
  });

  it('falls back to DEFAULT_AGY_BIN when nothing resolves', () => {
    const env = { PATH: '/nonexistent/dir', HOME: '/also/nonexistent' };
    assert.equal(resolveAgyBin(env), DEFAULT_AGY_BIN);
  });
});
