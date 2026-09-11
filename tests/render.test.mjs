/**
 * Tests for scripts/lib/render.mjs — pure rendering, no I/O, no clocks.
 *
 * Each render helper is exercised on representative input so that all
 * conditional branches (verdict, scope, missing fields, event tail,
 * elapsed buckets, follow-up commands) are covered.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  createJsonEnvelope,
  renderStatusSnapshot,
  renderSingleJobStatus,
  renderResultOutput,
  renderCancelReport,
  renderSetupReport,
  outputCommandResult,
  renderDeniedActionLines,
  formatDeniedActionLabel,
  reportWarnings,
  stripBypassAdvice,
  redactBypassFlag,
} from '../scripts/lib/render.mjs';

describe('createJsonEnvelope', () => {
  it('builds the stable versioned outer shape', () => {
    assert.deepEqual(createJsonEnvelope('task', {
      status: 'completed',
      jobId: 'job-1',
      answer: 'free-form model text',
      details: { durationSeconds: 2 },
    }), {
      schemaVersion: 1,
      command: 'task',
      status: 'completed',
      jobId: 'job-1',
      answer: 'free-form model text',
      details: { durationSeconds: 2 },
    });
  });

  it('rejects invalid stable field types', () => {
    assert.throws(() => createJsonEnvelope('task', { status: 'ok', jobId: 1 }), /jobId/);
    assert.throws(() => createJsonEnvelope('task', { status: 'ok', answer: {} }), /answer/);
    assert.throws(() => createJsonEnvelope('task', { status: 'ok', details: [] }), /details/);
    assert.throws(() => createJsonEnvelope('task', {
      status: 'ok', schemaVersion: 2,
    }), /reserved/);
  });
});

describe('renderStatusSnapshot', () => {
  it('renders the empty snapshot', () => {
    const out = renderStatusSnapshot({
      workspaceRoot: '/tmp',
      config: {},
      runtimeStatus: {},
      running: [],
      latestFinished: null,
      recent: [],
      needsReview: false,
    });
    assert.match(out, /Antigravity Status/);
    assert.match(out, /Review gate: disabled/);
    assert.match(out, /No antigravity jobs/);
  });

  it('renders running + recent tables and review-gate enabled', () => {
    const now = new Date().toISOString();
    const out = renderStatusSnapshot({
      workspaceRoot: '/tmp',
      config: {},
      runtimeStatus: {},
      running: [{ id: 'r1', kind: 'task', status: 'running', startedAt: now }],
      latestFinished: null,
      recent: [
        { id: 'd1', kind: 'task', status: 'completed', startedAt: now, completedAt: now, summary: 'ok' },
        { id: 'f1', kind: 'rescue', status: 'failed', startedAt: now, completedAt: now },
      ],
      needsReview: true,
    });
    assert.match(out, /Review gate: enabled/);
    assert.match(out, /## Active Jobs/);
    assert.match(out, /\| r1 /);
    assert.match(out, /## Recent Jobs/);
    assert.match(out, /\/antigravity:result d1/);
    // Failed jobs render "-" as follow-up, not the result command.
    assert.doesNotMatch(out, /\/antigravity:result f1/);
  });

  // 076-T7 R1: answerBytes/answerLines shown in the Recent Jobs table (and
  // the single-job view), "-" when absent (legacy records, running jobs).
  it('shows a Size column with answerBytes/answerLines, or "-" when absent', () => {
    const now = new Date().toISOString();
    const out = renderStatusSnapshot({
      workspaceRoot: '/tmp',
      config: {},
      running: [],
      latestFinished: null,
      recent: [
        { id: 'd1', kind: 'task', status: 'completed', startedAt: now, completedAt: now, answerBytes: 42, answerLines: 3 },
        { id: 'd2', kind: 'task', status: 'completed', startedAt: now, completedAt: now },
      ],
      needsReview: false,
    });
    assert.match(out, /\| Size \|/);
    assert.match(out, /\| 42B\/3L \|/);
    assert.match(out, /\| d2 \| task \| completed \| \d+m?s \| - \|/);
  });

  it('escapes a pipe and folds CR/LF in a summary at the table row, keeping the raw value everywhere else (F5)', () => {
    const now = new Date().toISOString();
    const out = renderStatusSnapshot({
      workspaceRoot: '/tmp',
      config: {},
      runtimeStatus: {},
      running: [{ id: 'r1', kind: 'task', status: 'running', startedAt: now, summary: 'a | b\nc' }],
      latestFinished: null,
      recent: [{ id: 'd1', kind: 'task', status: 'completed', startedAt: now, completedAt: now, summary: 'a | b\nc' }],
      needsReview: false,
    });
    assert.match(out, /\| a \\\| b c \|/);
    assert.doesNotMatch(out, /a \| b\nc/);
  });

  it('escapes a trailing backslash before a pipe so the cell does not still split (item 3)', () => {
    const now = new Date().toISOString();
    const out = renderStatusSnapshot({
      workspaceRoot: '/tmp',
      config: {},
      runtimeStatus: {},
      running: [],
      latestFinished: null,
      recent: [{ id: 'd1', kind: 'task', status: 'completed', startedAt: now, completedAt: now, summary: 'a\\|b c' }],
      needsReview: false,
    });
    assert.match(out, /\| a\\\\\\\|b c \|/);
  });

  // Plan 085 T2 item 4: a trailing Denied column on both tables — a count,
  // or "-" when none/absent. Appended after existing columns so it never
  // disturbs a sequential-column assertion elsewhere in this file.
  it('shows a Denied column with a count, or "-" when none, on both tables', () => {
    const now = new Date().toISOString();
    const out = renderStatusSnapshot({
      workspaceRoot: '/tmp',
      config: {},
      running: [{ id: 'r1', kind: 'task', status: 'running', startedAt: now, deniedActionsCount: 2 }],
      latestFinished: null,
      recent: [
        { id: 'd1', kind: 'task', status: 'completed', startedAt: now, completedAt: now, deniedActionsCount: 1 },
        { id: 'd2', kind: 'task', status: 'completed', startedAt: now, completedAt: now },
      ],
      needsReview: false,
    });
    assert.match(out, /\| Denied \|/);
    assert.match(out, /\| r1 \|.*\| 2 \|/);
    assert.match(out, /\| d1 \|.*\| 1 \|/);
    assert.match(out, /\| d2 \|.*\| - \|/);
  });

  it('falls back to deniedActions.length when deniedActionsCount is absent', () => {
    const now = new Date().toISOString();
    const out = renderStatusSnapshot({
      workspaceRoot: '/tmp',
      config: {},
      running: [],
      latestFinished: null,
      recent: [{
        id: 'd3', kind: 'task', status: 'completed', startedAt: now, completedAt: now,
        deniedActions: [{ action: 'read_url', displayName: null, source: 'json' }],
      }],
      needsReview: false,
    });
    assert.match(out, /\| d3 \|.*\| 1 \|/);
  });
});

describe('renderSingleJobStatus', () => {
  it('handles a bare job object with minimal fields', () => {
    const out = renderSingleJobStatus({ id: 'job1', status: 'queued' });
    assert.match(out, /Antigravity Job: job1/);
    assert.match(out, /Kind.*unknown/);
    assert.match(out, /Status.*queued/);
  });

  it('handles a wrapper { job } and includes error + progress', () => {
    const job = {
      id: 'job2',
      kind: 'task',
      status: 'failed',
      phase: 'failed',
      title: 'demo',
      summary: 'broke',
      healthStatus: 'failed',
      healthMessage: 'oom',
      recommendedAction: 'retry',
      pid: 123,
      createdAt: '2024-01-01T00:00:00Z',
      startedAt: '2024-01-01T00:00:01Z',
      completedAt: '2024-01-01T00:00:02Z',
      errorMessage: 'segfault',
      recentProgress: ['line a', 'line b'],
    };
    const out = renderSingleJobStatus({ workspaceRoot: '/w', job }, { now: Date.parse('2024-01-01T00:00:05Z') });
    assert.match(out, /Antigravity Job: job2/);
    assert.match(out, /## Error/);
    assert.match(out, /segfault/);
    assert.match(out, /## Recent Progress/);
    assert.match(out, /line a/);
  });

  // Plan 085 T2: `job.deniedActions` here is expected to already carry
  // `remedy` (the caller's contract — status.mjs attaches it).
  it('renders a "## Denied Actions" section, one line per action with its remedy', () => {
    const job = {
      id: 'job3', status: 'failed',
      deniedActions: [
        { action: 'read_url', displayName: 'ReadUrlContent', remedy: 'Headless runs cannot grant "read_url"; the host must run this step itself.' },
        { action: 'write_to_file', displayName: null, remedy: 'Pass --mode accept-edits to grant file edits inside the workspace for this run.' },
      ],
    };
    const out = renderSingleJobStatus(job);
    assert.match(out, /## Denied Actions/);
    assert.match(out, /read_url \(ReadUrlContent\)/);
    assert.match(out, /cannot grant "read_url"/);
    assert.match(out, /write_to_file/);
    assert.match(out, /--mode accept-edits/);
  });

  it('has no Denied Actions section when the job has no denials', () => {
    const out = renderSingleJobStatus({ id: 'job4', status: 'completed' });
    assert.doesNotMatch(out, /Denied Actions/);
  });
});

describe('renderDeniedActionLines', () => {
  it('is empty for null, undefined, or an empty list', () => {
    assert.deepEqual(renderDeniedActionLines(null), []);
    assert.deepEqual(renderDeniedActionLines(undefined), []);
    assert.deepEqual(renderDeniedActionLines([]), []);
  });

  it('one line per action, with the display name in parentheses when present', () => {
    const lines = renderDeniedActionLines([
      { action: 'read_url', displayName: 'ReadUrlContent', remedy: 'r1' },
      { action: 'write_to_file', displayName: null, remedy: 'r2' },
    ]);
    assert.equal(lines[0], '');
    assert.equal(lines[1], '## Denied Actions');
    assert.equal(lines[2], '');
    assert.equal(lines[3], '- **read_url (ReadUrlContent)**: r1');
    assert.equal(lines[4], '- **write_to_file**: r2');
  });

  // Plan 086 T3 item 2: the target, when known, is named in the line;
  // absent target renders exactly as before (item 6).
  it('names the target when present, in the shape "action (displayName) for \\"target\\""', () => {
    const lines = renderDeniedActionLines([
      { action: 'read_url', displayName: 'ReadUrlContent', target: 'example.com', remedy: 'r1' },
      { action: 'command', displayName: 'RunCommand', target: 'echo hello', remedy: 'r2' },
      { action: 'write_to_file', displayName: null, target: null, remedy: 'r3' },
    ]);
    assert.equal(lines[3], '- **read_url (ReadUrlContent) for "example.com"**: r1');
    assert.equal(lines[4], '- **command (RunCommand) for "echo hello"**: r2');
    assert.equal(lines[5], '- **write_to_file**: r3');
  });
});

describe('formatDeniedActionLabel', () => {
  it('action alone when there is no displayName and no target', () => {
    assert.equal(formatDeniedActionLabel({ action: 'read_url' }), 'read_url');
  });

  it('action (displayName) when there is no target', () => {
    assert.equal(
      formatDeniedActionLabel({ action: 'read_url', displayName: 'ReadUrlContent' }),
      'read_url (ReadUrlContent)',
    );
  });

  it('action for "target" when there is no displayName', () => {
    assert.equal(
      formatDeniedActionLabel({ action: 'read_url', target: 'example.com' }),
      'read_url for "example.com"',
    );
  });

  it('action (displayName) for "target" when both are known', () => {
    assert.equal(
      formatDeniedActionLabel({ action: 'read_url', displayName: 'ReadUrlContent', target: 'example.com' }),
      'read_url (ReadUrlContent) for "example.com"',
    );
  });
});

// Plan 086 T3 item 4: the plugin no longer relays agy's own bypass advice.
describe('stripBypassAdvice', () => {
  const BYPASS_LINE =
    'jetski: no output produced — a tool required the "read_url" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. read_url(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.';

  it('drops only the bypass sentence, keeping the rest of the line', () => {
    const out = stripBypassAdvice(BYPASS_LINE);
    assert.doesNotMatch(out, /--dangerously-skip-permissions/);
    assert.doesNotMatch(out, /Alternatively/);
    assert.match(out, /Add an allow-rule under permissions\.allow in settings\.json \(e\.g\. read_url\(<target>\)\)\.$/);
  });

  it('leaves a line with no bypass flag untouched', () => {
    assert.equal(stripBypassAdvice('agent-runtime: Headless runs cannot grant "read_url".'),
      'agent-runtime: Headless runs cannot grant "read_url".');
  });

  it('is a no-op on empty, null, or non-string input', () => {
    assert.equal(stripBypassAdvice(''), '');
    assert.equal(stripBypassAdvice(null), null);
    assert.equal(stripBypassAdvice(undefined), undefined);
  });

  it('strips the sentence on only the matching line in a multi-line blob, leaving other lines intact', () => {
    const blob = `first line\n${BYPASS_LINE}\nlast line`;
    const out = stripBypassAdvice(blob);
    assert.match(out, /^first line\n/);
    assert.match(out, /\nlast line$/);
    assert.doesNotMatch(out, /--dangerously-skip-permissions/);
  });
});

// Plan 086 T5e F3: a denied target whose text IS the bypass flag itself
// (model-chosen, not agy's own advisory sentence) must not reach the
// plugin's own stderr echo either.
describe('redactBypassFlag', () => {
  it('replaces the flag wherever it appears, not only after "Alternatively,"', () => {
    const line = 'antigravity:task — denied command (RunCommand) for "--dangerously-skip-permissions": Headless runs cannot grant "command"; the host must run this step itself.';
    const out = redactBypassFlag(line);
    assert.doesNotMatch(out, /--dangerously-skip-permissions/);
    assert.match(out, /for "\[flag redacted\]"/);
  });

  it('replaces every occurrence when the flag appears more than once', () => {
    const out = redactBypassFlag('--dangerously-skip-permissions and --dangerously-skip-permissions again');
    assert.doesNotMatch(out, /--dangerously-skip-permissions/);
    assert.equal(out, '[flag redacted] and [flag redacted] again');
  });

  it('leaves a line with no flag untouched', () => {
    assert.equal(redactBypassFlag('agent-runtime: Headless runs cannot grant "read_url".'),
      'agent-runtime: Headless runs cannot grant "read_url".');
  });

  it('is a no-op on empty, null, or non-string input', () => {
    assert.equal(redactBypassFlag(''), '');
    assert.equal(redactBypassFlag(null), null);
    assert.equal(redactBypassFlag(undefined), undefined);
  });
});

// Plan 086 T3 item 4: reportWarnings prints each warning through
// stripBypassAdvice; the source `result.warnings` array (and therefore
// `--json`'s `details.warnings`) is never mutated.
describe('reportWarnings — drops the bypass sentence, never mutates result.warnings', () => {
  it('the printed line has no bypass flag; result.warnings keeps the full text', () => {
    const BYPASS_LINE =
      'jetski: no output produced — a tool required the "read_url" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. read_url(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.';
    const result = { warnings: [BYPASS_LINE] };
    const chunks = [];
    const errMock = mock.method(process.stderr, 'write', (s) => { chunks.push(s); return true; });
    try {
      reportWarnings('rescue', result);
    } finally { errMock.mock.restore(); }
    assert.doesNotMatch(chunks.join(''), /--dangerously-skip-permissions/);
    assert.match(result.warnings[0], /--dangerously-skip-permissions/);
  });
});

describe('renderResultOutput', () => {
  it('renders raw stdout', () => {
    const out = renderResultOutput(
      '/cwd',
      { id: 'j' },
      { result: { rawOutput: 'final answer' } }
    );
    assert.match(out, /final answer/);
    assert.doesNotMatch(out, /Conversation ID/);
  });

  it('renders raw stdout from the legacy agy.stdout shape', () => {
    const out = renderResultOutput('/cwd', { id: 'j' }, { result: { agy: { stdout: 'hi' } } });
    assert.match(out, /hi/);
    assert.doesNotMatch(out, /Conversation ID/);
  });

  it('renders pre-rendered markdown when present', () => {
    const out = renderResultOutput('/cwd', { id: 'j' }, { rendered: '## Done' });
    assert.match(out, /## Done/);
  });

  it('falls back to metadata when no raw output and no rendered', () => {
    const out = renderResultOutput(
      '/cwd',
      { id: 'j2', title: 'T', status: 'completed', summary: 'sum' },
      { errorMessage: 'oops' }
    );
    // Title takes precedence over the default "Antigravity Result" header.
    assert.match(out, /# T/);
    assert.match(out, /Job: j2/);
    assert.match(out, /Status: completed/);
    assert.match(out, /Summary: sum/);
    assert.match(out, /oops/);
  });

  it('uses default header "Antigravity Result" when title is missing', () => {
    const out = renderResultOutput('/cwd', { id: 'j4', status: 'failed' }, {});
    assert.match(out, /Antigravity Result/);
    assert.match(out, /No captured result payload/);
  });

  it('falls back with no metadata produces the empty-result message', () => {
    const out = renderResultOutput('/cwd', { id: 'j3', status: 'queued' }, {});
    assert.match(out, /No captured result payload/);
  });
});

describe('renderCancelReport / renderSetupReport / outputCommandResult', () => {
  it('renders cancel without optional fields', () => {
    const out = renderCancelReport({ id: 'j', status: 'cancelled' });
    assert.match(out, /Antigravity Cancel/);
    assert.match(out, /Cancelled j/);
    assert.match(out, /Status: cancelled/);
  });

  it('renders cancel with title and kind', () => {
    const out = renderCancelReport({ id: 'j', status: 'cancelled', title: 'T', kind: 'task' });
    assert.match(out, /Title: T/);
    assert.match(out, /Kind: task/);
  });

  it('renders setup with all fields', () => {
    const out = renderSetupReport({
      agyAvailable: true,
      agyVersion: '1.0.1',
      authenticated: true,
      authMethod: 'oauth',
      npmAvailable: true,
      reviewGate: true,
      message: 'all good',
    });
    assert.match(out, /agy CLI: installed \(1\.0\.1\)/);
    assert.match(out, /Authentication: authenticated/);
    assert.match(out, /Auth method: oauth/);
    assert.match(out, /npm: available/);
    assert.match(out, /Review gate: enabled/);
    assert.match(out, /all good/);
  });

  it('renders setup with negative branches', () => {
    const out = renderSetupReport({
      agyAvailable: false,
      authenticated: false,
      npmAvailable: false,
      reviewGate: false,
    });
    assert.match(out, /not installed/);
    assert.match(out, /not authenticated/);
    assert.match(out, /npm: not available/);
    assert.match(out, /Review gate: disabled/);
  });

  it('outputCommandResult emits markdown or JSON based on flag', () => {
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s, ...rest) => {
      if (typeof s !== 'string') return origWrite(s, ...rest);
      chunks.push(s); return true;
    };
    try {
      outputCommandResult({ ok: 1 }, '# Markdown\n', false);
      outputCommandResult({ ok: 2 }, 'IGNORED', true);
    } finally {
      process.stdout.write = origWrite;
    }
    assert.equal(chunks[0], '# Markdown\n');
    assert.match(chunks[1], /"ok": 2/);
  });
});
