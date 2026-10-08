/**
 * Tests for scripts/lib/safe-reason.mjs: the one-line, redacted failure
 * reason that may appear in `details.error.message`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SAFE_REASON_LENGTH, safeFailureReason } from '../scripts/lib/safe-reason.mjs';

const CAPACITY =
  'API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server';

describe('safeFailureReason: text that stays as it is', () => {
  it('keeps a plain capacity reason, including "(code 503)"', () => {
    assert.equal(safeFailureReason(CAPACITY), CAPACITY);
  });

  it('keeps a URL with no query, no fragment and no credentials', () => {
    assert.equal(safeFailureReason('see https://example.com/docs/errors for help'), 'see https://example.com/docs/errors for help');
  });

  it('keeps a model id and a file path', () => {
    const text = 'model claude-sonnet-5-5-high failed in C:\\work\\repo\\src\\index.mjs';
    assert.equal(safeFailureReason(text), text);
  });
});

describe('safeFailureReason: non-text and empty input gives null', () => {
  for (const value of [undefined, null, 5, {}, '', '   ', '\n\t\r']) {
    it(`returns null for ${JSON.stringify(value)}`, () => {
      assert.equal(safeFailureReason(value), null);
    });
  }
});

describe('safeFailureReason: one line', () => {
  it('joins lines, tabs and carriage returns with single spaces', () => {
    assert.equal(safeFailureReason('first line\nsecond line\r\n\tthird\u0000line'), 'first line second line third line');
  });
});

describe('safeFailureReason: tokens', () => {
  const cases = [
    ['a bearer token', 'denied: Bearer SYNTHETIC-bearer-0123456789 rejected', 'denied: Bearer [redacted] rejected'],
    ['access_token=', 'bad request access_token=SYNTHETIC0123 now', 'bad request access_token=[redacted] now'],
    ['refresh_token:', 'refresh_token: SYNTHETIC0123 expired', 'refresh_token: [redacted] expired'],
    ['a quoted JSON value', '{"detail":"x","refresh_token":"1//SYNTHETIC0123456789abcdefghij"}', '{"detail":"x","refresh_token":[redacted]}'],
    ['code=', 'callback code=4/SYNTHETIC&state=s failed', 'callback code=[redacted]&state=s failed'],
    ['a Google access token', 'rejected ya29.A0ARrdaM-SYNTHETIC_0123456789 here', 'rejected [redacted] here'],
    ['a Google refresh token', 'rejected 1//0gSYNTHETIC0123456789abcdefgh here', 'rejected [redacted] here'],
    ['a JWT', 'rejected eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl here', 'rejected [redacted] here'],
    ['an sk- key', 'rejected sk-SYNTHETIC0123456789abcdef here', 'rejected [redacted] here'],
    ['an AIza key', 'rejected AIzaSyD-SYNTHETIC0123456789abcdef here', 'rejected [redacted] here'],
    ['a long opaque string', 'rejected Zm9vYmFyU1lOVEhFVElDMDEyMzQ1Njc4OQ here', 'rejected [redacted] here'],
    ['api_key=', 'invalid api_key=SYNTHETIC0123', 'invalid api_key=[redacted]'],
    ['an Authorization header', 'sent Authorization: Bearer SYNTHETIC0123 to the server', 'sent Authorization: [redacted] [redacted] to the server'],
  ];
  for (const [label, input, expected] of cases) {
    it(`replaces ${label}`, () => {
      assert.equal(safeFailureReason(input), expected);
    });
  }

  it('gives null when only a token is left', () => {
    assert.equal(safeFailureReason('ya29.SYNTHETIC-token-0123456789'), null);
  });
});

describe('safeFailureReason: URLs', () => {
  it('replaces an OAuth URL with a query string', () => {
    const url = 'https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost&state=s';
    assert.equal(safeFailureReason(`Sign in at ${url} to continue`), 'Sign in at [redacted-url] to continue');
  });

  it('replaces a URL with a fragment', () => {
    assert.equal(safeFailureReason('open https://example.com/cb#access_token=abc now'), 'open [redacted-url] now');
  });

  it('replaces a URL with credentials', () => {
    assert.equal(safeFailureReason('proxy https://user:pw@proxy.example.com/ refused'), 'proxy [redacted-url] refused');
  });

  it('replaces a non-http URL with a query string', () => {
    assert.equal(safeFailureReason('callback myapp://auth?code=abc failed'), 'callback [redacted-url] failed');
  });
});

describe('safeFailureReason: length', () => {
  it('cuts the redacted text at the limit', () => {
    const out = safeFailureReason('capacity '.repeat(100));
    assert.equal(out.length, MAX_SAFE_REASON_LENGTH);
    assert.equal(out, 'capacity '.repeat(100).slice(0, MAX_SAFE_REASON_LENGTH));
  });

  it('redacts before it cuts, so a token at the edge is not left in part', () => {
    const out = safeFailureReason(`${'capacity '.repeat(33)}ya29.SYNTHETIC-token-0123456789-abcdefghij`);
    assert.equal(out, `${'capacity '.repeat(33)}[redacted]`.slice(0, MAX_SAFE_REASON_LENGTH));
  });
});
