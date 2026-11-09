/**
 * `review --models a,b` (plan 153 p2, package E, "E1"): the value option
 * parsing, the two-token model resolution, and the findings comparison
 * that `review-compare.mjs` owns. `review.mjs`'s own command-level wiring
 * (argv shape, job records, the paired envelope, the exit code rule) is
 * covered by `tests/review-models.test.mjs`.
 *
 *   node --test tests/review-compare.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  compareReviewFindings,
  parseModelsOption,
  resolveModelsPair,
} from '../scripts/lib/review-compare.mjs';

function finding(overrides = {}) {
  return {
    severity: 'high',
    file: 'src/app.js',
    line: 12,
    description: 'Unchecked null.',
    recommendation: 'Guard the value.',
    ...overrides,
  };
}

const HUNKS = [
  { path: 'src/app.js', newStart: 10, newEnd: 20 },
  { path: 'src/app.js', newStart: 50, newEnd: 60 },
  { path: 'src/other.js', newStart: 1, newEnd: 5 },
];

describe('parseModelsOption', () => {
  it('accepts two distinct non-empty tokens', () => {
    assert.deepEqual(parseModelsOption('gemini-a,gemini-b'), { ok: true, tokens: ['gemini-a', 'gemini-b'] });
  });

  it('accepts alias:<name> tokens verbatim, without judging the alias name', () => {
    assert.deepEqual(parseModelsOption('alias:flash,alias:argon'), { ok: true, tokens: ['alias:flash', 'alias:argon'] });
  });

  it('refuses one token', () => {
    const result = parseModelsOption('gemini-a');
    assert.equal(result.ok, false);
    assert.match(result.reason, /exactly two/);
  });

  it('refuses three tokens', () => {
    const result = parseModelsOption('a,b,c');
    assert.equal(result.ok, false);
    assert.match(result.reason, /exactly two/);
  });

  it('refuses an empty token', () => {
    const result = parseModelsOption('gemini-a,');
    assert.equal(result.ok, false);
    assert.match(result.reason, /empty/);
  });

  it('refuses two equal tokens', () => {
    const result = parseModelsOption('gemini-a,gemini-a');
    assert.equal(result.ok, false);
    assert.match(result.reason, /distinct/);
  });
});

describe('resolveModelsPair', () => {
  it('resolves two exact ids with no listing probe at all', async () => {
    let probed = false;
    const result = await resolveModelsPair(['gemini-a', 'gemini-b'], { probe: async () => { probed = true; return { ok: false, reason: 'unused' }; } });
    assert.deepEqual(result, {
      ok: true,
      resolved: [{ model: 'gemini-a', request: {} }, { model: 'gemini-b', request: {} }],
    });
    assert.equal(probed, false, 'an exact id is never looked up');
  });

  it('resolves one alias token and one exact id with a single listing probe', async () => {
    let probeCalls = 0;
    const probe = async () => {
      probeCalls += 1;
      return { ok: true, text: 'gemini-flash-3.8-medium\tFlash\ngemini-argon-2-medium\tArgon\n' };
    };
    const result = await resolveModelsPair(['alias:flash', 'gemini-exact'], { probe, effort: 'medium' });
    assert.equal(result.ok, true);
    assert.equal(result.resolved[0].model, 'gemini-flash-3.8-medium');
    assert.deepEqual(result.resolved[0].request, {
      requestedAlias: 'flash', resolvedModel: 'gemini-flash-3.8-medium',
    });
    assert.deepEqual(result.resolved[1], { model: 'gemini-exact', request: {} });
    assert.equal(probeCalls, 1, 'one listing call for the pair, not one per alias token');
  });

  it('fetches the listing once for two alias tokens', async () => {
    let probeCalls = 0;
    const probe = async () => {
      probeCalls += 1;
      return { ok: true, text: 'gemini-flash-3.8-medium\tFlash\ngemini-argon-2-medium\tArgon\n' };
    };
    const result = await resolveModelsPair(['alias:flash', 'alias:argon'], { probe, effort: 'medium' });
    assert.equal(result.ok, true);
    assert.equal(result.resolved[0].model, 'gemini-flash-3.8-medium');
    assert.equal(result.resolved[1].model, 'gemini-argon-2-medium');
    assert.equal(probeCalls, 1);
  });

  it('refuses an unknown alias name once the listing is fetched', async () => {
    const probe = async () => ({ ok: true, text: 'gemini-flash-3.8-medium\tFlash\n' });
    const result = await resolveModelsPair(['alias:nope', 'gemini-exact'], { probe });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown model alias/);
  });

  it('refuses when the listing itself is unavailable', async () => {
    const probe = async () => ({ ok: false, reason: 'agy not found' });
    const result = await resolveModelsPair(['alias:flash', 'gemini-exact'], { probe });
    assert.equal(result.ok, false);
    assert.match(result.reason, /listing unavailable/);
  });
});

describe('compareReviewFindings', () => {
  it('matches findings on the same file and the same hunk', () => {
    const a = [finding({ line: 12 })];
    const b = [finding({ line: 15, severity: 'low' })];
    const result = compareReviewFindings(a, b, HUNKS);
    assert.equal(result.bothFlagged.length, 1);
    assert.equal(result.onlyA.length, 0);
    assert.equal(result.onlyB.length, 0);
    // Severity is reported on both sides of a match, never used to split it.
    assert.equal(result.bothFlagged[0].a.severity, 'high');
    assert.equal(result.bothFlagged[0].b.severity, 'low');
  });

  it('does not match the same file in a different hunk', () => {
    const a = [finding({ line: 12 })];
    const b = [finding({ line: 55 })];
    const result = compareReviewFindings(a, b, HUNKS);
    assert.equal(result.bothFlagged.length, 0);
    assert.equal(result.onlyA.length, 1);
    assert.equal(result.onlyB.length, 1);
  });

  it('matches two null-line findings on the same file', () => {
    const a = [finding({ line: null })];
    const b = [finding({ line: null, severity: 'nit' })];
    const result = compareReviewFindings(a, b, HUNKS);
    assert.equal(result.bothFlagged.length, 1);
  });

  it('does not match a null-line finding against a non-null one', () => {
    const a = [finding({ line: null })];
    const b = [finding({ line: 12 })];
    const result = compareReviewFindings(a, b, HUNKS);
    assert.equal(result.bothFlagged.length, 0);
    assert.equal(result.onlyA.length, 1);
    assert.equal(result.onlyB.length, 1);
  });

  it('one-to-one matches duplicates on one side, leaving the rest as onlyA', () => {
    const a = [finding({ line: 12 }), finding({ line: 13 })];
    const b = [finding({ line: 14 })];
    const result = compareReviewFindings(a, b, HUNKS);
    assert.equal(result.bothFlagged.length, 1);
    assert.equal(result.onlyA.length, 1);
    assert.equal(result.onlyB.length, 0);
  });

  it('reports every finding as onlyA when B is empty', () => {
    const a = [finding({ line: 12 }), finding({ line: 55 })];
    const result = compareReviewFindings(a, [], HUNKS);
    assert.equal(result.bothFlagged.length, 0);
    assert.equal(result.onlyA.length, 2);
    assert.equal(result.onlyB.length, 0);
  });

  it('never matches a finding whose line falls outside every hunk on its file', () => {
    const a = [finding({ file: 'src/app.js', line: 999 })];
    const b = [finding({ file: 'src/app.js', line: 999 })];
    const result = compareReviewFindings(a, b, HUNKS);
    assert.equal(result.bothFlagged.length, 0, 'no hunk contains line 999, so there is no hunk to share');
    assert.equal(result.onlyA.length, 1);
    assert.equal(result.onlyB.length, 1);
  });

  it('treats a missing hunks array as empty, never matching anything', () => {
    const a = [finding({ line: 12 })];
    const b = [finding({ line: 12 })];
    const result = compareReviewFindings(a, b, null);
    assert.equal(result.bothFlagged.length, 0);
    assert.equal(result.onlyA.length, 1);
    assert.equal(result.onlyB.length, 1);
  });
});
