/**
 * `review --models a,b`: the value option
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
  escapeControls,
  escapeForLine,
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

  // Control characters (C0, DEL, C1) and over-long tokens are refused, and a
  // refusal is always ONE line that shows the token escaped and cut to 80.
  const CONTROL_TOKENS = [
    ['a newline', 'x' + String.fromCharCode(10) + 'INJECTED'],
    ['a carriage return', 'x' + String.fromCharCode(13) + 'INJECTED'],
    ['a tab', 'x' + String.fromCharCode(9) + 'y'],
    ['an ESC', 'x' + String.fromCharCode(27) + '[2J'],
    ['a DEL', 'x' + String.fromCharCode(127) + 'y'],
    ['a C1 control', 'x' + String.fromCharCode(0x85) + 'y'],
    ['a Unicode line separator', 'x' + String.fromCharCode(0x2028) + 'y'],
  ];
  const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  for (const [label, token] of CONTROL_TOKENS) {
    for (const position of ['first', 'second']) {
      it(`refuses ${label} in the ${position} token, on one line`, () => {
        const result = parseModelsOption(position === 'first' ? `${token},ok` : `ok,${token}`);
        assert.equal(result.ok, false);
        assert.match(result.reason, /control character/);
        assert.doesNotMatch(result.reason, ANY_CONTROL);
      });
    }
  }

  it('refuses a duplicate token holding a newline without splitting the refusal', () => {
    const token = 'x' + String.fromCharCode(10) + 'INJECTED';
    const result = parseModelsOption(`${token},${token}`);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.reason, ANY_CONTROL);
  });

  it('refuses a token of 201 characters and accepts 200', () => {
    const refused = parseModelsOption(`${'x'.repeat(201)},ok`);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /longer than 200 characters/);
    assert.ok(!refused.reason.includes('x'.repeat(81)), 'the refusal shows at most 80 characters of the token');
    assert.equal(parseModelsOption(`${'x'.repeat(200)},ok`).ok, true);
  });

  it('shows a long duplicate token cut to 80 characters', () => {
    const token = 'y'.repeat(150);
    const result = parseModelsOption(`${token},${token}`);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('"' + 'y'.repeat(80) + '"...'));
    assert.ok(!result.reason.includes('y'.repeat(81)));
  });

  for (const token of ['a b', 'models/gemini-x', 'gemini-3.8-flash', 'vendor:model']) {
    it(`still accepts ${JSON.stringify(token)} as an exact id`, () => {
      assert.deepEqual(parseModelsOption(`${token},other`), { ok: true, tokens: [token, 'other'] });
    });
  }
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

  const SAME_LISTING = 'gemini-flash-3.8-medium\tFlash\ngemini-argon-2-medium\tArgon\n';

  it('refuses alias:flash together with the exact id it resolves to, naming both tokens and the id', async () => {
    const probe = async () => ({ ok: true, text: SAME_LISTING });
    const result = await resolveModelsPair(['alias:flash', 'gemini-flash-3.8-medium'], { probe, effort: 'medium' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /"alias:flash"/);
    assert.match(result.reason, /"gemini-flash-3.8-medium" both resolve to the model "gemini-flash-3.8-medium"/);
  });

  it('refuses two aliases that resolve to one id', async () => {
    const probe = async () => ({ ok: true, text: 'gemini-4-flash-argon-medium\tBoth\n' });
    const result = await resolveModelsPair(['alias:flash', 'alias:argon'], { probe, effort: 'medium' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /both resolve to the model "gemini-4-flash-argon-medium"/);
  });

  it('allows two different exact ids and two aliases that resolve to different ids', async () => {
    const probe = async () => ({ ok: true, text: SAME_LISTING });
    assert.equal((await resolveModelsPair(['gemini-a', 'gemini-b'], { probe })).ok, true);
    const aliases = await resolveModelsPair(['alias:flash', 'alias:argon'], { probe, effort: 'medium' });
    assert.equal(aliases.ok, true);
  });

  it('cuts a long alias name out of an alias refusal', async () => {
    const probe = async () => ({ ok: true, text: SAME_LISTING });
    const result = await resolveModelsPair([`alias:${'z'.repeat(150)}`, 'gemini-b'], { probe });
    assert.equal(result.ok, false);
    assert.equal(result.reason, `unknown model alias "${'z'.repeat(80)}"...`);
  });

  it('cuts a long alias name that holds backslashes and quotes before it escapes it', async () => {
    const probe = async () => ({ ok: true, text: SAME_LISTING });
    const result = await resolveModelsPair([`alias:${'x\\'.repeat(70)}`, 'gemini-b'], { probe });
    assert.equal(result.ok, false);
    assert.equal(result.reason, `unknown model alias "${'x\\\\'.repeat(40)}"...`);
    const quoted = await resolveModelsPair([`alias:${'"'.repeat(150)}`, 'gemini-b'], { probe });
    assert.equal(quoted.reason, `unknown model alias "${'\\"'.repeat(80)}"...`);
  });

  it('shows a short unknown alias whole, as before', async () => {
    const probe = async () => ({ ok: true, text: SAME_LISTING });
    const result = await resolveModelsPair(['alias:no\\such', 'gemini-b'], { probe });
    assert.equal(result.reason, 'unknown model alias "no\\\\such"');
  });
});

describe('escapeForLine and escapeControls', () => {
  it('quotes plain text and keeps it unchanged', () => {
    assert.equal(escapeForLine('gemini-a'), '"gemini-a"');
  });

  it('escapes newline, ESC, DEL, C1 and the Unicode line separator', () => {
    const text = 'a' + String.fromCharCode(10, 27, 127, 0x85, 0x2028) + 'b';
    assert.equal(escapeForLine(text), '"a\\n\\u001b\\u007f\\u0085\\u2028b"');
  });

  it('cuts at 80 characters and marks the cut after the closing quote', () => {
    assert.equal(escapeForLine('x'.repeat(81)), `"${'x'.repeat(80)}"...`);
    assert.equal(escapeForLine('x'.repeat(80)), `"${'x'.repeat(80)}"`);
  });

  it('escapeControls leaves printable text alone and escapes controls without quotes', () => {
    assert.equal(escapeControls('plain text'), 'plain text');
    assert.equal(escapeControls('a' + String.fromCharCode(27) + 'b'), 'a\\u001bb');
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
