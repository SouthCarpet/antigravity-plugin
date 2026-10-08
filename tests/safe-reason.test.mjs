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
  ['redacts a 20-character mixed run', 'failed ABCDEFGHIJ0123456789', 'failed [redacted]', 'ABCDEFGHIJ0123456789'],
  ['keeps a 32-character token with short runs', 'failed abcdefghij-abcdefghij-abcdefghij', 'failed abcdefghij-abcdefghij-abcdefghij'],
  ['keeps a token-shaped string that fits the grammar', 'ya29.SYNTHETIC-token-0123456789', 'ya29.SYNTHETIC-token-0123456789'],
  ['redacts the Basic-auth bypass', 'request failed: Authorization: Basic dXNlcjpwYXNz', 'request failed: Authorization: [redacted]', 'dXNlcjpwYXNz'],
  ['redacts the underscore URL bypass', 'request failed error_https://alice:secret@example.test/path', 'request failed [redacted-url]', 'alice:secret'],
  ['V2 row 3 redacts the whole token with a zero-width separator', 'request failed: Bearer\u200bshortSecret', 'request failed: [redacted]', 'shortSecret', '\u200b', '\ue000'],
  ['removes ANSI from the Bearer bypass', 'request failed: Be\u001b[31marer shortSecret', 'request failed: Bearer [redacted]', 'shortSecret'],
  ['redacts the 40-letter bypass', 'request failed with AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'request failed with [redacted]', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['redacts a percent-encoded token', 'request failed access%5Ftoken%3Dabc123', 'request failed [redacted]', 'abc123'],
  ['redacts a URL in angle brackets', 'request failed <https://alice:secret@example.test/path>', 'request failed [redacted-url]', 'alice:secret'],
  ['redacts token= inside quotes', 'request failed "token=shortSecret"', 'request failed [redacted]', 'shortSecret'],
  ['redacts a cookie header and two values', 'request failed Cookie: sid=shortSecret theme=dark retry', 'request failed Cookie: [redacted] retry', 'shortSecret'],
  ['redacts an x-api-key header and the following token', 'request failed x-api-key: shortSecret rejected retry', 'request failed x-api-key: [redacted] retry', 'shortSecret'],
  ['normalizes fullwidth Bearer before redaction', 'request failed: Ｂｅａｒｅｒ shortSecret rejected retry', 'request failed: Bearer [redacted] retry', 'shortSecret'],
  ['redacts a bidi override inside a credential', 'request failed: Bearer short\u202eSecret retry', 'request failed: Bearer [redacted]', 'short', 'Secret'],
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
  ['redacts a nonkeyword with default-ignorable code points', 'first\ufe0fsecond\u034fthird\u3164last', null, 'first', 'second', 'third', 'last', '\ue000'],
  ['redacts a nonkeyword with BOM and bidi format controls', '\ufefffirst\u200bsecond\u202ethird', null, 'first', 'second', 'third', '\ue000'],
  ['removes OSC with a BEL terminator', 'request \u001b]0;shortSecret\u0007failed', 'request failed', 'shortSecret'],
  ['removes OSC with an ESC-backslash terminator', 'request \u001b]0;shortSecret\u001b\\failed', 'request failed', 'shortSecret'],
  ['redacts tokens with other ESC pairs', 'request\u001b7 failed\u001b8', null, 'request', 'failed'],
  ['returns null when only numbers and short words remain', '12 ab xy [redacted] [redacted-url]', null],
  ['ignores readable letters in markers', 'a=secret https://one.test', null, 'secret', 'one.test'],
  ['keeps a three-letter ASCII run', 'abc 12', 'abc 12'],
  // Oracle: T4b items 1 to 5 and the numbered V2 verifier probes.
  ['V2 row 9 redacts a glued header and its value', 'failed Authorization:Basic dXNlcjpwYXNz retry', 'failed [redacted] retry', 'Authorization:Basic', 'dXNlcjpwYXNz'],
  ['V2 row 10 redacts a glued password and next token', 'failed password:hunter2 retry', 'failed [redacted]', 'hunter2'],
  ['V2 row 11 redacts a glued API key and next token', 'failed api_key:abcd1234ef retry', 'failed [redacted]', 'abcd1234ef'],
  ['V2 row 12 redacts glued Basic credentials', 'failed Basic:dXNlcjpwYXNz retry', 'failed [redacted]', 'dXNlcjpwYXNz'],
  ['V2 row 13 redacts a glued token', 'failed token:ya29.shortValue retry', 'failed [redacted]', 'ya29.shortValue'],
  ['V2 row 14 redacts a glued Bearer value', 'failed Bearer:hunter2please retry', 'failed [redacted]', 'hunter2please'],
  ['V2 row 15 redacts pwd with 20 letters', `failed pwd:${'p'.repeat(20)} retry`, 'failed [redacted]', 'p'.repeat(20)],
  ['V2 row 16 also masks the word after an oversized glued pwd', `failed pwd:${'p'.repeat(21)} now`, 'failed [redacted]', 'p'.repeat(21), 'now'],
  ['V2 row 18 redacts an AWS key mixed run', 'failed AKIAIOSFODNN7EXAMPLE retry', 'failed [redacted] retry', 'AKIAIOSFODNN7EXAMPLE'],
  ['V2 row 20 redacts 16 digits', 'failed 4111111111111111 retry', 'failed [redacted] retry', '4111111111111111'],
  ['V2 row 23 rejoins a zero-width split long run and redacts it', `failed ${'A'.repeat(20)}\u200b${'A'.repeat(20)} retry`, 'failed [redacted] retry', 'A'.repeat(20)],
  ['V2 row 25 rejoins a soft-hyphen split long run and redacts it', `failed ${'A'.repeat(20)}\u00ad${'A'.repeat(20)} retry`, 'failed [redacted] retry', 'A'.repeat(20)],
  ['V2 row 27 rejoins and redacts a split ghp token', `failed ghp_${'a'.repeat(16)}\u200b${'b'.repeat(20)} retry`, 'failed [redacted] retry', 'ghp_', 'a'.repeat(16), 'b'.repeat(20)],
  ['V2 row 28 redacts a long run with a generic ESC pair', `failed ${'A'.repeat(20)}\u001bA retry`, 'failed [redacted] retry', 'A'.repeat(20)],
  ['V2 row 29 rejoins Bearer and masks both values', 'failed Be\u200barer hunter2 retry', 'failed Bearer [redacted]', 'hunter2', 'retry'],
  ['V2 row 30 rejoins password and masks both values', 'failed pass\u00adword hunter2 retry', 'failed password [redacted]', 'hunter2', 'retry'],
  ['V2 row 32 normalizes and redacts a fullwidth glued colon', 'failed password：hunter2 retry', 'failed [redacted]', 'hunter2'],
  ['V2 row 45 applies the digit cap to a numeric status slot', 'failed (code 12345678901234567890): text', 'failed (code [redacted] text', '12345678901234567890'],
  ['V2 row 67 returns null after the cut removes the only word', `${'12 '.repeat(100)}abc`, null, '12', 'abc'],
  ['V2 row 68 returns null after the cut removes an oversized keyword', `${'('.repeat(295)}bearer`, null, 'bearer'],
  ['V2 row 69 redacts an unterminated OSC token', 'failed \u001b]0;hunter2 still visible', 'failed [redacted] still visible', 'hunter2', '0;hunter2'],
  ['redacts a source path with a colon before a line number', 'failed src/index.mjs:12 retry', 'failed [redacted] retry', 'src/index.mjs:12'],
  ['redacts a letter-colon-digit sequence', 'failed trace:1 retry', 'failed [redacted] retry', 'trace:1'],
  ['masks the next value after a glued keyword with a nonletter suffix', 'failed token:123 value retry', 'failed [redacted] retry', '123', 'value'],
  ['keeps a 20-letter run', 'failed AAAAAAAAAAAAAAAAAAAA retry', 'failed AAAAAAAAAAAAAAAAAAAA retry'],
  ['keeps an 11-character mixed run', 'failed abcdef12345 retry', 'failed abcdef12345 retry'],
  ['redacts a 12-character mixed run', 'failed abcdef123456 retry', 'failed [redacted] retry', 'abcdef123456'],
  ['keeps a 12-digit run', 'failed 123456789012 retry', 'failed 123456789012 retry'],
  ['redacts a 13-digit run', 'failed 1234567890123 retry', 'failed [redacted] retry', '1234567890123'],
  ['keeps the documented newline split limit', `failed ${'A'.repeat(20)}\n${'A'.repeat(20)} retry`, `failed ${'A'.repeat(20)} ${'A'.repeat(20)} retry`],
  ['keeps the documented NBSP split limit', `failed ${'A'.repeat(20)}\u00a0${'A'.repeat(20)} retry`, `failed ${'A'.repeat(20)} ${'A'.repeat(20)} retry`],
  ['keeps a short value after an unlisted word', 'failed authToken hunter2 retry', 'failed authToken hunter2 retry'],
  ['checks the word after a numeric status as an ordinary token', 'UNAVAILABLE (code 503): hunter2 remains today', 'UNAVAILABLE (code 503): hunter2 remains today'],
  ['V2 row 50 redacts a slash-separated base64 mixed run', 'failed YWJjZGVm/YWJjZGVmMTIzNDU2Nzg5 retry', 'failed [redacted] retry', 'YWJjZGVm', 'YWJjZGVmMTIzNDU2Nzg5'],
  // Oracle: T4c keeps a joined keyword; it replaces any other token with a format sentinel.
  ['T4c redacts a format-glued Bearer value and keeps retry', 'Bearer\u200bshortSecret retry', '[redacted] retry', 'shortSecret', '\ue000'],
  ['T4c rejoins Bearer and masks its next two tokens', 'Be\u200barer hunter2 retry', 'Bearer [redacted]', 'hunter2', 'retry', '\ue000'],
  ['T4c rejoins password and masks its next two tokens', 'pass\u00adword hunter2 retry', 'password [redacted]', 'hunter2', 'retry', '\ue000'],
  ['T4c returns null for a format-split long run alone', `${'A'.repeat(20)}\u200b${'A'.repeat(20)}`, null, 'A'.repeat(20), '\ue000'],
  ['T4c redacts a nonkeyword with a raw sentinel', 'failed short\ue000Secret retry', 'failed [redacted] retry', 'short', 'Secret', '\ue000'],
  ['T4c recognizes a keyword with a raw sentinel', 'Be\ue000arer hunter2 retry', 'Bearer [redacted]', 'hunter2', 'retry', '\ue000'],
  ['T4c rejoins a keyword with two format characters', 'Be\u200ba\u00adrer hunter2 retry', 'Bearer [redacted]', 'hunter2', 'retry', '\ue000'],
  ['T4c redacts a nonkeyword with two format characters', 'failed short\u200bSe\u00adcret retry', 'failed [redacted] retry', 'short', 'Secret', '\ue000'],
  ['T4c rejoins a keyword with surrounding punctuation', 'failed ("Be\u200barer"), hunter2 retry later', 'failed ("Bearer"), [redacted] later', 'hunter2', 'retry', '\ue000'],
  ['T4c rejoins a colon keyword and masks its next token', 'failed Auth\u200borization:Basic dXNlcjpwYXNz retry', 'failed [redacted] retry', 'dXNlcjpwYXNz', '\ue000'],
  ['T4c recognizes surrounding punctuation before the first colon', 'failed ("pass\u00adword"):hunter2 value retry', 'failed [redacted] retry', 'hunter2', 'value', '\ue000'],
  ['T4c strips leading punctuation before a colon keyword check', 'failed :\u200bBearer:hunter2 value retry', 'failed [redacted] retry', 'hunter2', 'value', '\ue000'],
  ['T4c redacts a token made only of raw sentinels', 'failed \ue000\ue000 retry', 'failed [redacted] retry', '\ue000'],
];

describe('safeFailureReason: exact allow-list outputs', () => {
  for (const [name, input, expected, ...secrets] of CASES) {
    it(name, () => {
      const output = safeFailureReason(input);
      assert.equal(output, expected);
      assert.equal((output ?? '').includes('\ue000'), false, 'retained format sentinel');
      for (const secret of secrets) assert.equal((output ?? '').includes(secret), false, `retained ${JSON.stringify(secret)}`);
    });
  }
});

// Oracle: T4b requires an unchanged diagnostic for each of the five filter changes.
describe('safeFailureReason: each T4b fix preserves diagnostics', () => {
  for (const item of [1, 2, 3, 4, 5]) {
    it(`item ${item} keeps the capacity line, ERROR status and model id`, () => {
      assert.equal(safeFailureReason(CAPACITY), CAPACITY);
      assert.equal(safeFailureReason('agy result status was "ERROR", not SUCCESS'), 'agy result status was "ERROR", not SUCCESS');
      assert.equal(safeFailureReason('model gemini-3.6-flash-high'), 'model gemini-3.6-flash-high');
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
  it('returns null when an oversized keyword token has no boundary that fits', () => {
    assert.equal(safeFailureReason(`${'('.repeat(295)}bearer`), null);
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
