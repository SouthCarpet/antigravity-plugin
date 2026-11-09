/**
 * `media --transcript --timestamps` (3.2.0, package C, item C1): the caption
 * conversion and the option rules. The command-level cases (details,
 * preview, output file) live in tests/media-output.test.mjs.
 *
 *   node --test tests/media-timestamps.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../scripts/lib/args.mjs';
import { MEDIA_SCHEMA, transcriptText, transcriptTextWithTimestamps } from '../scripts/lib/media.mjs';

const vtt = (...cues) => `WEBVTT\n\n${cues.join('\n\n')}\n`;

// Oracle: the plan's C1 contract. Each kept line carries the start time of its own cue, floored to whole seconds.
test('each kept line starts with the floored start time of its cue', () => {
  const text = vtt(
    '00:00:01.999 --> 00:00:03.000\nHello',
    '00:01:05.001 --> 00:01:07.000\nWorld',
  );
  assert.equal(transcriptTextWithTimestamps(text), '[00:00:01] Hello\n[00:01:05] World');
});

test('hours use at least two digits and carry past one hour', () => {
  assert.equal(
    transcriptTextWithTimestamps(vtt('10:05:09.000 --> 10:05:10.000\nLate', '99:59:59.000 --> 99:59:59.900\nLast')),
    '[10:05:09] Late\n[99:59:59] Last',
  );
});

test('a cue time without hours is read as minutes and seconds', () => {
  assert.equal(transcriptTextWithTimestamps(vtt('01:05.000 --> 01:06.000\nShort form')), '[00:01:05] Short form');
});

test('SRT comma times and bare cue numbers work', () => {
  assert.equal(
    transcriptTextWithTimestamps('1\n00:00:01,500 --> 00:00:02,000\nHello\n\n2\n00:00:02,000 --> 00:00:03,000\nWorld'),
    '[00:00:01] Hello\n[00:00:02] World',
  );
});

test('VTT cue settings after the end time do not change the start time', () => {
  assert.equal(
    transcriptTextWithTimestamps('00:00:07.000 --> 00:00:08.000 align:start position:0%\nHello'),
    '[00:00:07] Hello',
  );
});

// Oracle: "deduplication of consecutive identical speech lines keeps the FIRST occurrence's timestamp".
test('a repeated consecutive line keeps the first timestamp', () => {
  const text = vtt(
    '00:00:01.000 --> 00:00:02.000\nHello world',
    '00:00:02.000 --> 00:00:03.000\nHello world',
    '00:00:03.000 --> 00:00:04.000\nNext',
  );
  assert.equal(transcriptTextWithTimestamps(text), '[00:00:01] Hello world\n[00:00:03] Next');
});

test('a line repeated after other speech is kept with its own time', () => {
  const text = vtt(
    '00:00:00.000 --> 00:00:01.000\nYes',
    '00:00:01.000 --> 00:00:02.000\nNo',
    '00:00:02.000 --> 00:00:03.000\nYes',
  );
  assert.equal(transcriptTextWithTimestamps(text), '[00:00:00] Yes\n[00:00:01] No\n[00:00:02] Yes');
});

test('lines are cleaned by the same code as the plain transcript', () => {
  const text = vtt('00:00:01.000 --> 00:00:02.000\n<c.yellow><00:00:01.500>Hello</c> <v Jawed>world</v> &amp;lt;');
  assert.equal(transcriptTextWithTimestamps(text), '[00:00:01] Hello world &lt;');
});

test('speech with a timing arrow but no cue time is kept as speech', () => {
  assert.equal(transcriptTextWithTimestamps('00:00:01.000 --> 00:00:02.000\nA --> B is an arrow'), '[00:00:01] A -- B is an arrow');
});

test('a second line of the same cue carries the cue time', () => {
  assert.equal(
    transcriptTextWithTimestamps('00:00:09.000 --> 00:00:10.000\nLine one\nLine two'),
    '[00:00:09] Line one\n[00:00:09] Line two',
  );
});

// Oracle: the invariant of the feature. Removing the prefixes gives the plain transcript.
test('without the prefixes the text equals the plain transcript', () => {
  const text = vtt(
    '00:00:01.000 --> 00:00:02.000\nHello <b>world</b>\nHello world',
    '00:00:02.000 --> 00:00:03.000\nHello world',
    '00:00:03.000 --> 00:00:04.000\n12 elephants',
    '00:00:04.000 --> 00:00:05.000\nHello world',
  );
  assert.equal(transcriptTextWithTimestamps(text).replace(/^\[[^\]]+\] /gm, ''), transcriptText(text));
});

test('an empty or speechless caption file gives an empty string', () => {
  assert.equal(transcriptTextWithTimestamps(''), '');
  assert.equal(transcriptTextWithTimestamps('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n'), '');
});

// Decision (plan silent): a line with no known cue time prints [--:--:--]; never NaN, never a crash.
test('speech before any cue time is marked with an unknown time', () => {
  assert.equal(transcriptTextWithTimestamps('Orphan\n00:00:01.000 --> 00:00:02.000\nKnown'), '[--:--:--] Orphan\n[00:00:01] Known');
});

for (const [name, cue] of [
  ['minutes above 59', '00:99:00.000 --> 00:99:01.000'],
  ['seconds above 59', '00:00:75.000 --> 00:00:76.000'],
  ['minutes above 59 without hours', '75:00.000 --> 75:01.000'],
  ['hours above 99', '100:00:00.000 --> 100:00:01.000'],
  ['four digit hours', '1000:00:00.000 --> 1000:00:01.000'],
]) {
  test(`a malformed cue time (${name}) gives an unknown time, drops the cue line and never prints NaN`, () => {
    const output = transcriptTextWithTimestamps(`${cue}\nSpoken`);
    assert.equal(output, '[--:--:--] Spoken');
    assert.doesNotMatch(output, /NaN|Infinity|undefined|null|-->/);
  });
}

test('a malformed cue time resets the time of the lines after it', () => {
  assert.equal(
    transcriptTextWithTimestamps('00:00:05.000 --> 00:00:06.000\nGood\n\n00:99:00.000 --> 00:99:01.000\nBad'),
    '[00:00:05] Good\n[--:--:--] Bad',
  );
});

// Oracle: the CLI contract. The flag is only valid with --transcript.
test('--timestamps alone is refused with the exact message', () => {
  assert.throws(() => parseArgs(['--timestamps'], MEDIA_SCHEMA), { name: 'ArgsError', message: '--timestamps requires --transcript' });
});

for (const extra of [['--audio'], ['--quality', '480p'], ['--keep'], ['--prompt', 'Summarize.']]) {
  test(`--timestamps with ${extra[0]} and no --transcript is refused with the exact message`, () => {
    assert.throws(() => parseArgs(['--timestamps', ...extra], MEDIA_SCHEMA), { message: '--timestamps requires --transcript' });
  });
}

for (const [extra, message] of [
  [['--audio'], 'cannot combine --transcript and --audio'],
  [['--quality', '480p'], 'cannot combine --transcript and --quality'],
]) {
  test(`--timestamps --transcript with ${extra[0]} keeps the existing conflict refusal`, () => {
    assert.throws(() => parseArgs(['--timestamps', '--transcript', ...extra], MEDIA_SCHEMA), { message });
  });
}

test('--timestamps with --transcript parses, with and without a prompt', () => {
  assert.equal(parseArgs(['u', '--transcript', '--timestamps'], MEDIA_SCHEMA).options.timestamps, true);
  assert.equal(parseArgs(['u', '--transcript', '--timestamps', '--prompt', 'x'], MEDIA_SCHEMA).options.timestamps, true);
});

// Oracle: literals produced by the base commit (966559d). The plain transcript path is unchanged.
test('the plain transcript output is the base output, byte for byte', () => {
  const text = vtt(
    '00:00:01.000 --> 00:00:02.000\nHello <b>world</b>\nHello world',
    '00:00:02.000 --> 00:00:03.000\nSecond',
  );
  assert.equal(transcriptText(text), 'Hello world\nSecond');
});
