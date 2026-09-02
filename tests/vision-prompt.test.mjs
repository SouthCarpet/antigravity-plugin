/**
 * Shape of the vision prompt (plan 068 T2): transcription first,
 * `view_image` only, sentinel contract unchanged.
 *
 * Pure function, no spawn. The sentinel line is asserted byte-for-byte
 * because docs/COMPATIBILITY.md promises the `VISION-UNAVAILABLE: <reason>`
 * form as a stable machine-readable signal.
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
});
