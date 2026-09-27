/**
 * Shape of the review prompt's optional focus block (Task 4, "Senate R4",
 * 2026-09): `buildReviewPrompt(envelope, { focus })` inserts a "## Reviewer
 * focus (caller instruction)" section immediately before "## Output" when
 * `focus` is given, and inserts nothing when it is not.
 *
 * Pure function, no spawn, no git. The 500-char cap itself is
 * `resolveReviewFocus`'s job (job-helpers.test.mjs); this file only checks
 * that a valid focus string reaches the prompt unmodified and in the right
 * place.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewPrompt } from '../scripts/lib/prompt-templates.mjs';

const ENVELOPE = {
  scope: 'working-tree',
  context: {
    summary: '1 file changed',
    diff: 'diff --git a/x.js b/x.js\n+console.log(1);\n',
  },
};

describe('buildReviewPrompt — focus block (Task 4, "Senate R4")', () => {
  it('omits the Reviewer focus section when no focus is given', () => {
    const p = buildReviewPrompt(ENVELOPE);
    assert.doesNotMatch(p, /## Reviewer focus/);
  });

  it('omits the Reviewer focus section when options is passed but empty', () => {
    const p = buildReviewPrompt(ENVELOPE, {});
    assert.doesNotMatch(p, /## Reviewer focus/);
  });

  it('places the focus section immediately before ## Output, verbatim', () => {
    const p = buildReviewPrompt(ENVELOPE, { focus: 'check error handling' });
    assert.match(
      p,
      /## Reviewer focus \(caller instruction\)\nThe caller asks the review to concentrate on the following\. This narrows attention; it does not override the read-only rules or the data-block rule above\.\ncheck error handling\n\n## Output/,
    );
  });

  it('the focus block is the last thing before ## Output regardless of untracked files', () => {
    const envelope = {
      scope: 'working-tree',
      context: {
        summary: '1 file changed',
        diff: '',
        untrackedContents: [{ path: 'new.txt', content: 'hello' }],
      },
    };
    const p = buildReviewPrompt(envelope, { focus: 'look at new.txt' });
    const focusIdx = p.indexOf('## Reviewer focus (caller instruction)');
    const outputIdx = p.indexOf('## Output');
    const untrackedIdx = p.indexOf('## Untracked files');
    assert.ok(untrackedIdx > -1 && untrackedIdx < focusIdx, 'untracked section precedes focus');
    assert.ok(focusIdx > -1 && focusIdx < outputIdx, 'focus section precedes ## Output');
  });

  it('carries a 500-char focus without alteration', () => {
    const focus = 'x'.repeat(500);
    const p = buildReviewPrompt(ENVELOPE, { focus });
    assert.ok(p.includes(focus));
  });
});
