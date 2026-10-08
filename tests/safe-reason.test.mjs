/** Exact expectations come from the binding allow-list specification and the verifier's bypass inputs. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SAFE_REASON_LENGTH, safeFailureReason } from '../scripts/lib/safe-reason.mjs';

const CAPACITY = 'API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3.6-flash-high on the server';
const CASES = [
  ['keeps the capacity diagnostic verbatim', CAPACITY, CAPACITY],
  ['redacts a nonnumeric parenthesized code', 'failed (code shortSecret): retry', 'failed (code [redacted]', 'shortSecret'],
  ['redacts a bare code followed by digits', 'failed code 503 retry later', 'failed code [redacted] later', '503'],
  ['redacts a status code with a 21-digit value', 'failed (code 123456789012345678901): retry', 'failed (code [redacted]', '123456789012345678901'],
  ['keeps the ERROR status diagnostic verbatim', 'agy result status was "ERROR", not SUCCESS', 'agy result status was "ERROR", not SUCCESS'],
  ['keeps model ids and relative paths', 'model gemini-3.6-flash-high failed in src/index.mjs', 'model gemini-3.6-flash-high failed in src/index.mjs'],
  ['keeps all allowed punctuation', 'failed AZaz09.,:;!()[]\'"_-/', 'failed AZaz09.,:;!()[]\'"_-/'],
  ['keeps a 20-character alphanumeric run', 'failed ABCDEFGHIJ0123456789', 'failed ABCDEFGHIJ0123456789'],
  ['keeps a 32-character token with short runs', 'failed abcdefghij-abcdefghij-abcdefghij', 'failed abcdefghij-abcdefghij-abcdefghij'],
  ['keeps a token-shaped string that fits the grammar', 'ya29.SYNTHETIC-token-0123456789', 'ya29.SYNTHETIC-token-0123456789'],
  ['redacts the Basic-auth bypass', 'request failed: Authorization: Basic dXNlcjpwYXNz', 'request failed: Authorization: [redacted]', 'dXNlcjpwYXNz'],
  ['redacts the underscore URL bypass', 'request failed error_https://alice:secret@example.test/path', 'request failed [redacted-url]', 'alice:secret'],
  ['normalizes the zero-width Bearer bypass', 'request failed: Bearer\u200bshortSecret', 'request failed: Bearer [redacted]', 'shortSecret'],
  ['removes ANSI from the Bearer bypass', 'request failed: Be\u001b[31marer shortSecret', 'request failed: Bearer [redacted]', 'shortSecret'],
  ['redacts the 40-letter bypass', 'request failed with AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'request failed with [redacted]', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['redacts a percent-encoded token', 'request failed access%5Ftoken%3Dabc123', 'request failed [redacted]', 'abc123'],
  ['redacts a URL in angle brackets', 'request failed <https://alice:secret@example.test/path>', 'request failed [redacted-url]', 'alice:secret'],
  ['redacts token= inside quotes', 'request failed "token=shortSecret"', 'request failed [redacted]', 'shortSecret'],
  ['redacts a cookie header and two values', 'request failed Cookie: sid=shortSecret theme=dark retry', 'request failed Cookie: [redacted] retry', 'shortSecret'],
  ['redacts an x-api-key header and the following token', 'request failed x-api-key: shortSecret rejected retry', 'request failed x-api-key: [redacted] retry', 'shortSecret'],
  ['normalizes fullwidth Bearer before redaction', 'request failed: Ｂｅａｒｅｒ shortSecret rejected retry', 'request failed: Bearer [redacted] retry', 'shortSecret'],
  ['normalizes a bidi override inside a credential', 'request failed: Bearer short\u202eSecret retry', 'request failed: Bearer [redacted] retry', 'short', 'Secret'],
  ['redacts a 33-character token', 'request failed abcdefghij-abcdefghij-abcdefghij-', 'request failed [redacted]', 'abcdefghij-abcdefghij-abcdefghij-'],
  ['normalizes a newline inside a token', 'request failed: Bearer short\nSecret retry', 'request failed: Bearer [redacted] retry', 'short\nSecret'],
  ['returns null for only disallowed secrets', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA access%5Ftoken%3Dabc123', null, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'abc123'],
  ['redacts a 21-character alphanumeric run', 'failed ABCDEFGHIJ0123456789A', 'failed [redacted]', 'ABCDEFGHIJ0123456789A'],
  ['redacts a plain URL', 'see https://example.test/help for help', 'see [redacted-url] for help', 'https://example.test/help'],
  ['redacts double slash without a URL marker', 'failed abc//shortSecret retry', 'failed [redacted] retry', 'shortSecret'],
  ['redacts a Windows path', 'failed C:\\work\\repo\\file.mjs', 'failed [redacted]', 'C:\\work\\repo\\file.mjs'],
  ['redacts non-ASCII letters', 'failed café retry', 'failed [redacted] retry', 'café'],
  ['collapses adjacent generic markers', 'failed a=secret b@secret retry', 'failed [redacted] retry', 'secret'],
  ['collapses adjacent URL markers', 'failed https://one.test https://two.test retry', 'failed [redacted-url] retry', 'one.test', 'two.test'],
  ['keeps different adjacent markers separate', 'failed a=secret https://one.test b@secret retry', 'failed [redacted] [redacted-url] [redacted] retry', 'secret', 'one.test'],
  ['uses a URL marker after a keyword', 'failed Bearer https://one.test shortSecret retry', 'failed Bearer [redacted-url] [redacted] retry', 'one.test', 'shortSecret'],
  ['masks the final single token after a keyword', 'failed password shortSecret', 'failed password [redacted]', 'shortSecret'],
  ['keeps a final keyword with no following token', 'failed password', 'failed password'],
  ['does not restart masking for an already masked keyword', 'failed Authorization: Bearer shortSecret retry', 'failed Authorization: [redacted] retry', 'shortSecret'],
  ['matches mixed-case keywords with surrounding punctuation', 'failed ("ToKeN"), shortSecret value retry', 'failed ("ToKeN"), [redacted] retry', 'shortSecret'],
  ['does not strip punctuation outside the keyword list', 'failed token! shortValue retry', 'failed token! shortValue retry'],
  ['joins controls and all separator categories', ' first\nsecond\r\n\tthird\u0000fourth\u0085fifth\u2028sixth\u2029seventh\u00a0last ', 'first second third fourth fifth sixth seventh last'],
  ['replaces default-ignorable non-format code points', 'first\ufe0fsecond\u034fthird\u3164last', 'first second third last'],
  ['replaces BOM and bidi format controls', '\ufefffirst\u200bsecond\u202ethird', 'first second third'],
  ['removes OSC with a BEL terminator', 'request \u001b]0;shortSecret\u0007failed', 'request failed', 'shortSecret'],
  ['removes OSC with an ESC-backslash terminator', 'request \u001b]0;shortSecret\u001b\\failed', 'request failed', 'shortSecret'],
  ['removes other ESC pairs', 'request\u001b7 failed\u001b8', 'request failed'],
  ['returns null when only numbers and short words remain', '12 ab xy [redacted] [redacted-url]', null],
  ['ignores readable letters in markers', 'a=secret https://one.test', null, 'secret', 'one.test'],
  ['keeps a three-letter ASCII run', 'abc 12', 'abc 12'],
];

describe('safeFailureReason: exact allow-list outputs', () => {
  for (const [name, input, expected, ...secrets] of CASES) {
    it(name, () => {
      const output = safeFailureReason(input);
      assert.equal(output, expected);
      for (const secret of secrets) assert.equal((output ?? '').includes(secret), false, `retained ${JSON.stringify(secret)}`);
    });
  }
});

describe('safeFailureReason: non-text and empty input gives null', () => {
  for (const value of [undefined, null, 5, {}, [], true, '', '   ', '\n\t\r']) {
    it(`returns null for ${JSON.stringify(value)}`, () => {
      assert.equal(safeFailureReason(value), null);
    });
  }
});

// Oracle: each specified keyword keeps its spelling and masks the next two tokens.
describe('safeFailureReason: every credential keyword masks two tokens', () => {
  const keywords = [
    'bearer', 'basic', 'digest', 'negotiate', 'token', 'authorization',
    'proxy-authorization', 'cookie', 'set-cookie', 'password', 'passwd',
    'pwd', 'secret', 'apikey', 'api-key', 'api_key', 'x-api-key', 'key',
    'credential', 'credentials', 'session', 'sid', 'jwt', 'auth',
    'access_token', 'refresh_token', 'id_token', 'client_secret', 'code',
  ];
  for (const keyword of keywords) {
    it(`${keyword} keeps its spelling and replaces two values`, () => {
      const output = safeFailureReason(`failed ${keyword} shortSecret secondValue retry`);
      assert.equal(output, `failed ${keyword} [redacted] retry`);
      assert.equal(output.includes('shortSecret'), false);
      assert.equal(output.includes('secondValue'), false);
    });
  }
});

// Oracle: every excluded ASCII character causes replacement of its whole token.
describe('safeFailureReason: excluded ASCII characters cause replacement', () => {
  for (const character of ['=', '@', '?', '#', '&', '%', '+', '\\', '*', '$', '<', '>', '{', '}', '|', '~', '`', '^']) {
    it(`redacts a token containing ${JSON.stringify(character)}`, () => {
      const output = safeFailureReason(`failed short${character}Secret retry`);
      assert.equal(output, 'failed [redacted] retry');
      assert.equal(output.includes(`short${character}Secret`), false);
    });
  }
});

describe('safeFailureReason: token-boundary length limit', () => {
  it('returns empty text when an oversized keyword token has no boundary that fits', () => {
    assert.equal(safeFailureReason(`${'('.repeat(295)}bearer`), '');
  });

  it('cuts a 301-character reason at the last complete token', () => {
    const input = `error ${'word '.repeat(58)}extra`;
    assert.equal(input.length, 301);
    const output = safeFailureReason(input);
    assert.equal(output, `error ${'word '.repeat(57)}word`);
    assert.equal(output.length, 295);
    assert.equal(output.includes('extra'), false);
    assert.equal(MAX_SAFE_REASON_LENGTH, 300);
  });

  it('keeps an exactly 300-character reason', () => {
    const input = `error ${'word '.repeat(58)}last`;
    assert.equal(input.length, 300);
    assert.equal(safeFailureReason(input), input);
  });

  it('redacts before truncation without a partial marker', () => {
    const input = `${'capacity '.repeat(33)}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const output = safeFailureReason(input);
    assert.equal(output, `${'capacity '.repeat(32)}capacity`);
    assert.equal(output.includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
    assert.equal(output.includes('[red'), false);
  });
});
