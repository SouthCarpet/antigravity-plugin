/**
 * Shape of the vision prompt (plan 068 T2): transcription first,
 * `view_image` only, sentinel contract unchanged.
 *
 * Pure function, no spawn. The sentinel line is asserted byte-for-byte
 * because docs/COMPATIBILITY.md promises the `VISION-UNAVAILABLE: <reason>`
 * form as a stable machine-readable signal.
 *
 * T2b adds the agy 1.1.24 offload fallback. agy hands a large tool result to
 * the model as a `[Resource offloaded to file://<X>]` note instead of pixels,
 * so the prompt sends the model to `view_file` on that one path. The cases
 * below pin the three limits that keep the fallback from becoming a general
 * file-read licence: it names `view_file` and the offload marker, it allows
 * only the path in the note, and it still forbids `read_file`/`view_file` on
 * the original image paths.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildVisionPrompt } from '../scripts/lib/prompt-templates.mjs';

const TWO = ['C:\\shots\\a.png', '/tmp/b.png'];

describe('buildVisionPrompt', () => {
  it('lists every image path, in order, under a view_image instruction', () => {
    const p = buildVisionPrompt({ imagePaths: TWO, userPrompt: 'q' });
    assert.match(p, /Call `view_image` once for EACH of the following 2 image path\(s\), in order:/);
    assert.ok(p.indexOf(TWO[0]) < p.indexOf(TWO[1]));
  });

  it('forbids read_file on an image and says why (bytes, not pixels)', () => {
    const p = buildVisionPrompt({ imagePaths: TWO, userPrompt: 'q' });
    assert.match(p, /`view_image` is the ONLY way to see an image/);
    assert.match(p, /Do NOT call `read_file`[\s\S]*bytes as text, not pixels/);
  });

  it('demands the three sections in order: Transcription, Observations, Answer', () => {
    const p = buildVisionPrompt({ imagePaths: TWO, userPrompt: 'q' });
    const t = p.indexOf('## Transcription');
    const o = p.indexOf('## Observations');
    const a = p.indexOf('## Answer');
    assert.ok(t > -1 && o > t && a > o, 'sections present and ordered');
    assert.match(p, /EVERY visible text string, verbatim, one per line/);
    assert.match(p, /No paraphrase, no omission/);
    assert.match(p, /write `\(no text\)`/);
  });

  it('places the user question after the shape and keeps it verbatim', () => {
    const p = buildVisionPrompt({ imagePaths: TWO, userPrompt: 'Is the total 1 435,50 €?' });
    assert.ok(p.indexOf('## Answer') < p.indexOf('## Question'));
    assert.match(p, /## Question\nIs the total 1 435,50 €\?\n/);
  });

  it('keeps the sentinel contract byte-compatible', () => {
    const p = buildVisionPrompt({ imagePaths: TWO, userPrompt: 'q' });
    assert.ok(p.endsWith('\nVISION-UNAVAILABLE: <one-line reason>'));
    assert.match(p, /reply with EXACTLY one line, no other text:\nVISION-UNAVAILABLE: <one-line reason>$/);
    assert.match(p, /do NOT fall back to another tool/);
  });

  it('sends an offloaded view_image result to view_file, on that path only', () => {
    const p = buildVisionPrompt({ imagePaths: TWO, userPrompt: 'q' });
    assert.match(p, /A `view_image` result can carry the note `\[Resource offloaded to file:\/\/<X>\]`/);
    assert.match(p, /call `view_file` on exactly the `<X>` from that note, copied verbatim, and on no\nother path\./);
  });

  it('still forbids read_file AND view_file on the original image paths', () => {
    const p = buildVisionPrompt({ imagePaths: TWO, userPrompt: 'q' });
    assert.match(p, /Do NOT call `read_file` or\n`view_file` on any image path listed below/);
    // "listed below" is only a ban if the originals are the list that follows.
    const banEnd = p.indexOf('and you would be guessing.');
    for (const image of TWO) assert.ok(p.indexOf(image) > banEnd, `${image} is listed after the ban`);
  });

  it('places the fallback after the path list and before the answer shape', () => {
    const p = buildVisionPrompt({ imagePaths: TWO, userPrompt: 'q' });
    const offload = p.indexOf('Resource offloaded');
    assert.ok(p.indexOf(TWO[1]) < offload, 'fallback follows the paths it can be triggered by');
    assert.ok(offload < p.indexOf('## Transcription'), 'fallback precedes the answer shape');
  });

  it('reaches the sentinel only after the offloaded-copy step was tried', () => {
    const p = buildVisionPrompt({ imagePaths: TWO, userPrompt: 'q' });
    assert.match(p, /even after the offloaded-copy step above, do NOT guess/);
    const tail = p.split('\n').slice(-2);
    assert.ok(tail[0].endsWith('Instead reply with EXACTLY one line, no other text:'));
    assert.equal(tail[1], 'VISION-UNAVAILABLE: <one-line reason>');
  });
});
