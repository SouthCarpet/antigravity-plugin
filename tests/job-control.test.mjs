import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sortJobsNewestFirst,
  filterJobsForCurrentSession,
  SESSION_ID_ENV,
} from '../scripts/lib/job-control.mjs';
import { isProcessAlive } from '../scripts/lib/process.mjs';

describe('sortJobsNewestFirst', () => {
  it('sorts by updatedAt descending', () => {
    const jobs = [
      { id: 'a', updatedAt: '2026-05-22T10:00:00Z' },
      { id: 'b', updatedAt: '2026-05-22T12:00:00Z' },
      { id: 'c', updatedAt: '2026-05-22T11:00:00Z' },
    ];
    assert.deepEqual(sortJobsNewestFirst(jobs).map((j) => j.id), ['b', 'c', 'a']);
  });

  it('does not mutate input array', () => {
    const jobs = [{ id: 'a', updatedAt: '1' }, { id: 'b', updatedAt: '2' }];
    sortJobsNewestFirst(jobs);
    assert.deepEqual(jobs.map((j) => j.id), ['a', 'b']);
  });
});

describe('filterJobsForCurrentSession', () => {
  it('returns input unchanged when SESSION_ID_ENV is absent', () => {
    const jobs = [{ id: 'a', sessionId: 's1' }];
    assert.deepEqual(filterJobsForCurrentSession(jobs, {}), jobs);
  });

  it('keeps only jobs matching the current session id', () => {
    const jobs = [
      { id: 'a', sessionId: 's1' },
      { id: 'b', sessionId: 's2' },
      { id: 'c', sessionId: 's1' },
    ];
    const env = { [SESSION_ID_ENV]: 's1' };
    assert.deepEqual(filterJobsForCurrentSession(jobs, env).map((j) => j.id), ['a', 'c']);
  });
});

describe('shared isProcessAlive', () => {
  it('returns true for own PID', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });
  it('returns false for values that cannot identify a process', () => {
    assert.equal(isProcessAlive(undefined), false);
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(null), false);
  });
  it('returns false for a PID that does not exist', () => {
    // Very high PID unlikely to exist
    assert.equal(isProcessAlive(2 ** 22), false);
  });
});
