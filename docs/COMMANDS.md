# Commands reference

This is the argument and execution reference for the nine public 2.x verbs,
and for the standalone `update` convenience at the end. The broader
versioning, output, environment, and state promises are in the
[2.x compatibility contract](./COMPATIBILITY.md).

## Invocation forms

All hosts route to the same `scripts/commands/<verb>.mjs` implementation:

```text
/antigravity:<verb> ...                              # Claude Code
$antigravity <verb> ...                              # Codex CLI
/antigravity:<verb> ...                              # agy interactive TUI (copied plugin tree)
npx @southcarpet/antigravity-plugin <verb> ...       # standalone; also the agy fallback that always works
node bin/antigravity.mjs <verb> ...                  # standalone from a checkout
```

`npx @southcarpet/antigravity-plugin <verb>` is the supported standalone
invocation. After install the binary name remains `antigravity-plugin`.

Documented value flags require a following token. `--` ends flag parsing.
Repeating a scalar value flag uses its last value; repeating `--add-dir`
preserves all values. Unknown flags return exit 1 with
`antigravity:<verb> — unknown flag --<name>; put prompt text after --`.
Put prompt words that begin with `--` after the `--` terminator. Undocumented
extra positionals may be ignored and may become errors in 2.x.

`--cwd <path>` changes the working directory used to resolve the workspace on
every verb except `setup`. A Git repository root is used when one can be
found; otherwise the supplied/current directory is the workspace.

When `agy` is missing, every verb that runs it except `setup` exits 1 with
one line, `antigravity:<verb> — \`agy\` is not on PATH (<reason>). Run
/antigravity:setup.`, before it writes a job record or starts anything;
`setup` keeps its own line and exit 2. `review` collects the diff first: with
nothing to review it prints the `no_changes` result and exits 0 without
touching `agy`; with changes to send and no `agy` it prints the line and
exits 1.

## Execution budgets and failure messages

Foreground and background jobs have a 30-minute agy execution budget.
`ANTIGRAVITY_AGY_TIMEOUT_MS` sets a positive integer number of milliseconds
(at most 2147483647); exactly `0` disables the budget. Invalid values are
ignored with a warning. Background jobs store this setting at enqueue and
use the full stored budget when the worker starts agy, excluding queue time.
Older job records without the setting use 30 minutes.

Every print-mode invocation forwards agy's own `--print-timeout` as the job
budget plus 60 seconds, rounded up to whole seconds (`1860s` for the
30-minute default). A `0` plugin budget ("no deadline") still forwards a fixed `24h`.
The plugin still enforces its own budget (`ANTIGRAVITY_AGY_TIMEOUT_MS`, the
`timeoutMs` deadline with 60 seconds of headroom); the forwarded
`--print-timeout` is the agy-side backstop.
Before 1.2.6, agy's default was `5m0s` and a literal `0` meant an immediate
timeout. Since 1.2.6 the default is unlimited; agy 1.2.7 help lists `0s`,
where `0` waits until the turn completes (`agy-help-1.2.7.txt`). The raw
1.2.7 `--print-timeout 0` probe answered `ZERO` and exited 0
(`raw-print-timeout-zero.txt`). The raw `--print-timeout 4s` probe printed
`[agy] print timeout after 4s with turn in progress; returning partial output`,
exited 0, and returned an empty response (`raw-print-timeout-short.txt`).

When the budget expires, the plugin terminates the agy process tree and
stores a failed job with `agy did not finish within <ms> ms`. Output above
16 MiB on stdout or 4 MiB on stderr also terminates the tree and fails with
`agy output exceeded <n> bytes`. Only output received before the offending
chunk is retained; a partial answer is never reported as success.

A foreground verb interrupted with Ctrl+C terminates agy and its child
processes before it exits, on every platform.

Final output is collected until stdio closes. Inherited pipes that remain
open five seconds after exit are closed with the stored warning
`agy stdio did not close within 5000 ms after exit`.

A worker launch failure prints
`antigravity:<verb> — failed: Worker launch failed: <reason>`, stores a
failed job, and exits 1 without a queued response. Git commands time out
after 120000 ms and update steps after 600000 ms, reporting
`<command> timed out after <ms> ms`.

For background `review`, `rescue`, and `task`, the separate `--wait` deadline
does not cancel an unfinished job or replace the queued JSON response already
written to stdout. It returns the verb's existing nonzero exit and writes
`antigravity:<verb> — wait timed out; job <id> is still <status>. Run
/antigravity:status <id>.` to stderr. If the record disappears while waiting,
the line is `antigravity:<verb> — job record vanished while waiting.`

## Denied runs: resuming and the interactive prompt

`review`, `rescue`, and `task` accept `--conversation <id>` to resume a
specific agy conversation; `vision` has no conversation concept and is never
resumable. When one of the three is denied in the foreground, its own denial
line on stderr is followed by one more line naming the exact command that
resumes the same conversation, with the id agy itself reported:
`antigravity:<verb> — resume with: /antigravity:<verb> --conversation <id>`.
This line appears only when the run was an actual denial and agy reported a
conversation id for it; it is never printed with an invented or missing id.

On a foreground `review`/`rescue`/`task` invocation that ends denied, the
runtime also asks once, on the terminal itself, whether to retry the same
conversation or stop. The plugin never offers to grant a permission and never
writes a settings file from this prompt. It asks only when every one of these
holds: `--json` was not passed; both `stdin` and `stdout` are a real
interactive terminal; and the process was not spawned by a host wrapper.
Claude Code and the agy TUI both reach every verb through the same wrapper
snippet (`scripts/lib/host-bootstrap.cjs`), which sets
`ANTIGRAVITY_HOST_WRAPPER=1` on every child it spawns — so neither host is
ever asked, even when its own process happens to inherit a real terminal,
because the plugin's output there goes to a model, not a person at a
keyboard. A background job is never asked either; the prompt exists only on
the foreground path. Choosing "stop" leaves the exit code the run already
had. Choosing "retry" re-runs the same verb against the same conversation
exactly once; a second denial is reported the same way and the plugin stops
— it never asks a second time.

## Summary

| Verb | Positional arguments | Default execution |
|---|---|---|
| `setup` | none | foreground only |
| `review` | none | foreground |
| `rescue` | prompt words | foreground |
| `task` | prompt words | background |
| `vision` | one or more image paths | foreground only |
| `status` | optional job reference | foreground state read; optionally waits |
| `result` | optional job reference | foreground state read |
| `cancel` | optional job reference | foreground control operation |
| `doctor` | none | foreground, read-only state read |

## `setup`

```text
setup [--skip-vision] [--remove-vision]
```

- `--skip-vision` runs the agy OAuth probe but leaves all vision configuration
  untouched.
- `--remove-vision` skips the agy probe and removes only plugin-owned vision
  configuration described in [COMPATIBILITY.md](./COMPATIBILITY.md#vision-configuration).
- If both flags are supplied, the current implementation takes the
  `--remove-vision` path. Relying on that combination is not recommended.

Setup is always foreground and has no `--json` mode. A normal setup probes
`agy --version`, then runs an interactive authenticated `agy --print` call
with inherited terminal streams. It enables vision only after that probe exits
successfully.

Right after the `using <bin> v<version>` line, when that version is
`beyond_measured` or `unmeasured` (see [`doctor`](#doctor) and
[COMPATIBILITY.md](./COMPATIBILITY.md#supported-matrix)), setup prints one
more line: `antigravity:setup — agy <v> is newer than the last measured
version <newest>; see docs/COMPATIBILITY.md.` (or `... is not in the
measured matrix; see docs/COMPATIBILITY.md.`). Setup never refuses to run
on an unmeasured or newer version; the line is advisory only.

Exit status is 0 on success, 1 when vision configuration/removal or spawning
fails, and 2 when the agy version probe cannot find or run agy. A nonzero exit
from the interactive agy call is passed through unchanged. The standalone
dispatcher can return 127 earlier when an explicit `AGY_BIN` path is missing.

## `doctor`

```text
doctor [--json] [--cwd <path>]
```

Read-only environment and configuration check. Unlike `setup`, `doctor`
never runs OAuth, never calls a model, never writes a file, and never opens
the network: it reads `process.version`, `package.json` `engines.node`,
`agy --version`, `agy --help`, the two agy config files `setup`'s vision
step writes, and the job-state root. There is no `--live` flag: `setup`
already is this plugin's live probe, so a read-only verb stays read-only.

Five checks, one line each in markdown mode:

1. **Node.** `process.version` compared against `package.json`'s
   `engines.node` (`>=22.3.0`): `ok` or `incompatible`.
2. **agy binary.** The resolved path (`resolveAgyBin`), whether it is
   spawnable, and its version (`agy --version`). The version is classified
   against this plugin's measured range (`scripts/lib/compat.mjs`):
   `verified` (a
   [matrix](./COMPATIBILITY.md#supported-matrix) row), `beyond_measured`
   (newer than the newest measured row), `unmeasured` (inside the range but
   not a matrix row), `incompatible` (older than the oldest measured row),
   or `missing` (agy was not found).
3. **Flags.** One `agy --help` call, checked once, for every flag this
   plugin forwards (`--add-dir`, `--model`, `--effort`, `--mode`,
   `--continue`, `--conversation`, `--print-timeout`,
   `--disable-slash-commands`, `--input-format`, `--output-format`,
   `--print`, `--json-schema`): `listed` when the flag's text appears in
   that output, `not_listed` otherwise. A `listed` flag is not a promise
   that the flag still works; the report header says so.
4. **Vision configuration.** A read-only presence check of the
   plugin-owned entry in `~/.gemini/config/mcp_config.json`
   (`mcpServers.vision`) and the `mcp(vision/view_image)` permission in
   `~/.gemini/antigravity-cli/settings.json`
   ([vision configuration](./COMPATIBILITY.md#vision-configuration)):
   `registered`, `absent` (normal before `setup` has run without
   `--skip-vision`), or `unreadable` (a file exists but could not be
   parsed).
5. **Job-state root.** Which environment variable selected it
   (`CLAUDE_PLUGIN_DATA`, `CODEX_PLUGIN_DATA`, `AGY_PLUGIN_DATA`, or the
   standalone temp default), the resulting workspace directory, whether it
   exists yet, and whether this workspace is still on an older ("legacy")
   leaf (see [job state and configuration
   locations](./COMPATIBILITY.md#job-state-and-configuration-locations)).

Markdown output ends with `doctor: <n> ok, <m> warnings, <k> problems`.
`--json` returns `command: "doctor"`, `jobId: null`, `answer: null`, and
`details: { node, agy: { path, version, classification }, flags: [{ flag,
state }], vision, stateRoot: { source, dir, exists, legacyLeaf },
measuredRange: { min, newest } }`. `status` is `"ok"`, `"warnings"`, or
`"problems"`. `beyond_measured` and `unmeasured` are warnings, never
problems. Exit status is 0 for `ok` or `warnings`, and 1 for `problems`
(an incompatible or missing agy, an incompatible Node version, or a
job-state root that could not be read).

## `review`

```text
review [--base <ref>] [--scope <auto|working-tree|branch>]
       [--background] [--wait] [--show-result]
       [--continue | --conversation <id>]
       [--model <id>] [--effort <low|medium|high|agy-default>]
       [--focus <text>]
       [--preview] [--require-complete]
       [--findings-json]
       [--check-locations]
       [--json] [--cwd <path>]
```

- `--scope` defaults to `auto`. Invalid values return 1.
- `auto` chooses the working tree when staged, unstaged, or untracked files
  are detected. Otherwise it compares HEAD with local `main`, then local
  `master`; if neither exists, it falls back to the working tree.
- `--base <ref>` must resolve to a commit; an unknown ref (including one
  starting with `-`) returns exit 1 with `antigravity:review — unknown base ref <ref>`.
  The comparison uses the base only with `--scope branch`.
  `--scope branch` without `--base` falls back to a working-tree review.
  This is current implementation behavior, despite the shorter standalone
  help text implying that `--base` alone selects a branch diff.
- `--continue` resumes the most recent agy conversation.
- `--conversation <id>` resumes the named conversation and conflicts with
  `--continue`.
- `--background` queues a worker and returns immediately. Adding `--wait`
  waits for that job to finish but does not print its final stored result; use
  `result` to retrieve it. Without `--background`, review is foreground and
  `--wait` has no additional effect.
  The agy execution budget above applies in both cases; the background wait
  itself has a separate 30-minute deadline.
- `--show-result` (additive) prints the finished job's own result instead of
  the dispatch envelope, after `--background --wait` completes. It requires
  both flags: without `--wait` it is an argument error, `--show-result
  requires --wait`; with `--wait` but without `--background` it is
  `--show-result requires --background`. Both are stderr-only, exit 1, before
  any Git collection or agy probe. With the flag, the queued dispatch prints
  nothing on stdout; the one-line notice
  `Background review started: <job-id>` moves to stderr instead, in text mode
  and under `--json` alike. See [`--show-result`](#--show-result-all-three-verbs)
  below for the shared completion contract.
- `--model <id>` (additive) selects the agy model for this run, forwarded to
  agy on both the foreground and the background path, exactly as `rescue`'s
  `--model` already was.
- `--effort <low|medium|high|agy-default>` (additive) selects agy's
  reasoning effort for this run. Unlike `task`/`rescue`, review has no
  plugin-side default: with neither `--effort` nor `--model` given, no
  `--effort` flag reaches agy, unchanged from before this addition. An
  explicit `low`, `medium`, or `high` is forwarded verbatim as
  `--effort <value>`. `agy-default` sends no `--effort` flag, the same as
  omitting it. Any other value is an argument error (exit 1) and agy is not
  started. The stored `request.effort` keeps whatever value the caller gave,
  including `agy-default` itself, the same way `task`/`rescue` store their
  own explicit values; only the argv sent to agy collapses `agy-default` to
  no `--effort` flag.
- `--focus <text>` (additive) narrows the review's attention. Optional; never
  required and never derived from repository content. The value is trimmed;
  empty or whitespace-only, or longer than 500 characters after trimming, is
  a validation error (exit 1) and agy is not started. When given, the prompt
  gains a "## Reviewer focus (caller instruction)" section immediately before
  "## Output", the job's stored `request.focus` carries the trimmed text, and
  the job title gets a ` focus: <first 40 characters>` suffix.
- `--preview` (additive) shows exactly what a real run would send, without
  calling agy: the included files (with their kind, `diff` or `untracked`,
  and byte size), the skipped files with their reasons, whether the diff was
  cut by the 196 KB cap, the file/byte counts, and the SHA-256 hash of the
  prompt. No file changes, no job record, no agy probe. Exit 0 always.
  `--json` returns `status: "preview"`, `jobId: null`, `answer: null`, and
  the same fields under `details`. `--preview` cannot combine with
  `--background`, `--wait`, `--continue`, or `--conversation`; combining
  them is an argument error (exit 1, stderr only).
- `--require-complete` (additive) refuses to send a run whose input left
  something out (a skipped file or a diff cut by the cap), instead of
  sending it with a warning. On a refusal: stderr prints
  `antigravity:review — input is incomplete; --require-complete refused to
  send it.`, agy is never probed or spawned, and exit is 1. `--json` returns
  `status: "invalid_input"`, `error.code: "input_incomplete"`,
  `error.phase: "collect"`, and `details.skipped`/`details.truncated`.
  Without `--require-complete`, the same condition instead prints one
  warning line before sending:
  `antigravity:review — warning: input is incomplete (<n> files skipped,
  diff truncated by <b> bytes); run review --preview for the list.`
- `--findings-json` (additive) asks agy for structured findings as well as
  the review. The plugin passes `--json-schema <path>` to agy, where the
  path is the absolute path of the schema file the plugin ships
  (`scripts/lib/review-findings.schema.json`). The flag goes immediately
  before `--print-timeout`. The prompt's Output section gains one sentence:
  the structured result must follow that schema. The schema has three
  required keys: `verdict` (`APPROVE`, `CHANGES_REQUESTED`, or
  `NEEDS_DISCUSSION`), `summary`, and `findings`. `findings` is a list of at
  most 200 entries. Each entry has `severity` (`critical`, `high`, `medium`,
  `low`, or `nit`), `file`, `line` (an integer or `null`), `description`,
  and `recommendation`. No other keys are allowed, and no string may be
  longer than 2000 characters. The plugin checks agy's structured output
  against the schema itself:
  - valid: `details.findings` is the parsed object and
    `details.findingsStatus` is `"valid"`;
  - not valid, or not sent: `details.findings` is `null`,
    `details.findingsStatus` is `"invalid"` or `"missing"`,
    `details.findingsError` gives the reason in one line, and stderr gets
    one line: `antigravity:review — warning: structured findings <status>:
    <reason>`.

  `answer` (and the text-mode stdout) stays agy's raw response text. Under
  this flag, that text is JSON text, not the Markdown review: agy 1.2.12 was
  measured to return JSON there, with keys the schema does not allow. Use
  `details.findings`, never a parse of `answer`. A findings problem does not
  change the exit code: a completed review exits 0. On the background path
  the job stores `request.findingsJson: true` and agy's structured output as
  `result.structuredRaw`; `result <job-id>` and `--show-result` report the
  same three fields (see [`result`](#result)). Without the flag, nothing
  changes: no `--json-schema` in argv and no findings fields in `details`.
- `--check-locations` (additive) heuristically checks each `path:line`
  citation the answer names against the diff this run actually sent, using
  the hunks the diff carried (`request.hunks`, stored on every review job,
  not only under this flag). Local only: it never calls agy again and never
  changes `argv`, `answer`, or the exit code. Each citation is classified
  `in_diff` (the path matches a hunk and the cited line, or the whole cited
  range, lies inside it), `outside_diff` (the path matches but the line does
  not), or `unknown_path` (no hunk names that path at all). This is a
  heuristic, not a truth check: a citation outside the diff is not by itself
  a model error — reviewers legitimately cite context lines and related
  files the diff never touched. `--json` adds `details.locationCheck: {
  heuristic: true, citations: [{ text, path, line, state }], counts: {
  in_diff, outside_diff, unknown_path } }`, and one stderr line,
  `antigravity:review — location check (heuristic): <in> in diff, <out>
  outside diff, <unknown> unknown paths.`, also appended to the markdown
  output after the answer. `result <job-id> --check-locations` runs the same
  check later, from the stored answer and hunks, and works even on a job
  reviewed without this flag. See [Heuristic location
  check](./COMPATIBILITY.md#heuristic-location-check).

An empty working tree (no tracked diff and no untracked files) prints
`antigravity:review — no changes to review.` and returns 0 without calling
agy. A working tree of only untracked files is reviewed.

On a completed run, if agy reported measured usage the stable usage trailer
(see [Usage trailer](./COMPATIBILITY.md#usage-trailer)) is written to stderr.

Untracked file bodies are capped at 24 KB total (not per file); once the cap
is reached, remaining files are skipped whole rather than truncated. A file
whose basename looks like a secret (`.env` and its variants,
`.pem`/`.key`/`.p12`/`.pfx`, or a default SSH private-key name) is always
skipped, regardless of the cap. Every skipped file is still listed in the
prompt sent to agy, by path and skip reason (`secret-shaped name`, `exceeds
byte limit`, `binary file`, `symlink`, `not a regular file`, `outside
workspace`, or `read error`); it is never sent as content.

Exit status is 0 for a completed foreground review, a successfully queued
background review, or no changes; 1 for validation, Git, authentication, agy,
or state failure; and 2 when an awaited/foreground agy outcome is cancelled.

Once `--json` is accepted, an invalid `--scope`, an unresolved `--base`, an
invalid `--focus`, a `--require-complete` refusal, a missing `agy` binary, or
a foreground run that did not complete emits one error envelope
(`details.error`, see [COMPATIBILITY.md](./COMPATIBILITY.md#--json)) instead
of an empty stdout body; the stderr line is unchanged either way.

## `rescue`

```text
rescue <prompt...>
       [--background] [--wait] [--show-result] [--request-id <id>]
       [--resume] [--continue] [--fresh] [--conversation <id>]
       [--add-dir <path>]... [--mode <plan|accept-edits>]
       [--model <id>] [--effort <low|medium|high|agy-default>] [--json] [--cwd <path>]
```

All positional tokens are joined with spaces to form the prompt. A prompt is
required unless `--resume`, `--continue`, or `--conversation` is supplied.

The `rescue` wrapper's host model composes the shell call and must quote the
task text as one argument to preserve its boundaries.

- Fresh conversation is the default. `--fresh` makes it explicit.
- `--resume` and `--continue` are equivalent and resume the most recent
  conversation. They may be supplied together.
- `--conversation <id>` selects a specific conversation and conflicts with
  `--resume`, `--continue`, and `--fresh`.
- `--fresh` conflicts with `--resume` and `--continue`.
- `--add-dir <path>` is repeatable and forwards extra workspace directories
  to agy, verbatim and in the order given. This is the way to give a
  headless run read access to files outside the workspace: on agy 1.1.24 a
  `read_file(<path>)` allow rule in `settings.json` does not grant it, while
  `--add-dir <dir>` grants reads bounded to that directory, read-only, for
  that run only (evidence in [COMPATIBILITY.md](./COMPATIBILITY.md#headless-read-access)).
  A run that needed a file it was not granted fails with the denied tool
  named and this flag as the remedy.
- `--mode <plan|accept-edits>` is forwarded to agy as its execution mode
  for this run (`plan`: propose without editing; `accept-edits`: apply file
  edits without a prompt). Any other value is an argument error (exit 1)
  and agy is not started.
- `--model <id>` (additive) selects the agy model for this run, forwarded to
  agy exactly as `vision`'s `--model` already was.
- `--effort <low|medium|high|agy-default>` (additive) selects agy's reasoning
  effort for this run. An explicit `low`, `medium`, or `high` is forwarded
  verbatim as `--effort <value>`. With neither `--effort` nor `--model`, the
  plugin sends `medium`, unchanged since 2.0.0. With `--model` and no
  `--effort`, the plugin sends no `--effort` flag. agy applies the level
  carried by a variant id such as `gemini-3.1-pro-high`, and rejects a base id
  that needs one (`raw-base-gemini-3.1-pro-no-effort.txt`). This applies since
  2.0.2 because agy 1.2.11 validates the model and effort pair
  (`raw-model-gemini-3.1-pro-high-effort-medium.txt`,
  `raw-model-claude-sonnet-4-6-effort-medium.txt`). `agy-default` still makes
  the plugin send no `--effort` flag, so the user's own agy configuration
  decides instead. The run is therefore not reproducible across machines,
  the same as a run through 1.3.0 with no `--effort` flag at all. Any other
  value is an argument error (exit 1) and agy is not started. `medium` runs
  longer than `low`, so a job with neither `--model` nor `--effort` is more
  likely to reach the execution budget above; a run that reaches it stores a
  failed job with no answer. Pass `--effort low` explicitly, or raise
  `ANTIGRAVITY_AGY_TIMEOUT_MS`, to avoid this.
- `--background` queues a worker; `--background --wait` waits for terminal
  state after printing the queued response. Without `--background`, rescue is
  foreground and `--wait` has no additional effect.
  The agy execution budget above applies in both cases; the background wait
  itself has a separate 30-minute deadline.
- `--show-result` (additive) prints the finished job's own result instead of
  the dispatch envelope, after `--background --wait` completes. It needs both
  flags, with the same two argument errors and the same stderr-only queued
  notice as `review`'s `--show-result` above. See
  [`--show-result`](#--show-result-all-three-verbs) below.
- `--request-id <id>` (additive) makes a background dispatch idempotent: a
  repeat of the same request with the same id reports the existing job and
  starts nothing. It needs `--background`; without it, the flag is refused
  with `--request-id applies to background jobs only`. See
  [`--request-id`](#--request-id-task-and-rescue) below.

On a completed run (foreground, or an awaited `--background --wait` run), if
agy reported measured usage the stable usage trailer (see [Usage
trailer](./COMPATIBILITY.md#usage-trailer)) is written to stderr.

Exit status is 0 for completed foreground work or a successful queue, 1 for
validation/authentication/execution/state failure, and 2 for a cancelled
awaited/foreground outcome.

Once `--json` is accepted, a missing prompt, a missing `agy` binary, or a
foreground run that did not complete emits one error envelope
(`details.error`, see [COMPATIBILITY.md](./COMPATIBILITY.md#--json)) instead
of an empty stdout body; the stderr line is unchanged either way. A
background job whose worker never started reports the same way.

## `task`

```text
task <prompt...>
     [--background | --foreground] [--wait] [--show-result] [--request-id <id>]
     [--continue | --conversation <id>] [--prompt-file <path>]
     [--add-dir <path>]... [--mode <plan|accept-edits>]
     [--model <id>] [--effort <low|medium|high|agy-default>] [--json] [--cwd <path>]
```

All positional tokens are joined with spaces to form the prompt. A prompt is
required unless `--continue` or `--conversation` is supplied.

- Background is the default. `--background` explicitly retains that default.
- `--foreground` runs inline and conflicts with `--background`.
- On the background path, `--wait` waits for terminal state. When successful,
  the implementation may append the stored raw result to stdout after the
  initial queued response. On the foreground path, `--wait` has no additional
  effect.
  The agy execution budget above applies in both cases; the background wait
  itself has a separate 30-minute deadline.
- `--show-result` (additive) prints the finished job's own result instead of
  the dispatch envelope, after a background `--wait` completes. `task` has no
  separate flag for "opt into background"; its default already is
  background, so the argument error names `--foreground` instead:
  `--show-result --foreground` is refused with the same
  `--show-result requires --wait` message an absent `--wait` gets, because
  foreground has no `--wait` semantics at all. See
  [`--show-result`](#--show-result-all-three-verbs) below.
- `--request-id <id>` (additive) makes the background dispatch idempotent:
  a repeat of the same request with the same id reports the existing job
  and starts nothing. With `--foreground`, the flag is refused with
  `--request-id applies to background jobs only`. See
  [`--request-id`](#--request-id-task-and-rescue) below.
- `--continue` resumes the most recent conversation and conflicts with
  `--conversation <id>`.
- `--prompt-file <path>` (additive) reads the prompt from a file instead of
  a positional prompt: UTF-8, resolved against the invocation working
  directory, capped at 512 KiB. Combining it with a positional prompt is an
  argument error (`cannot combine --prompt-file with a positional prompt`).
  It may be combined with `--continue`/`--conversation`: the file's content
  becomes the new turn on the resumed conversation. `--prompt-file -` reads
  the prompt from stdin to EOF instead of a file, and only from the
  standalone CLI run directly by a person or script; through Claude Code,
  Codex CLI, or the agy TUI it is refused with `--prompt-file - (stdin) is
  available in the standalone CLI only`, because those hosts own stdio for
  their own protocol. An oversized, missing/unreadable, or empty/
  whitespace-only source is refused with one `invalid_input` error envelope
  under `--json` (`prompt_file_too_large`, `prompt_file_unreadable`, or
  `prompt_file_empty`); the file's path and the prompt's content never
  appear in a diagnostic. The job's title becomes the first non-empty
  line of the source, truncated the same way a positional prompt's title
  is. `rescue` does not gain this flag; it is unchanged.
- `--add-dir <path>` is repeatable and forwards extra workspace directories
  to agy, verbatim and in the order given, on both the foreground and the
  background path. It is the headless read grant described under `rescue`
  and in [COMPATIBILITY.md](./COMPATIBILITY.md#headless-read-access).
- `--mode <plan|accept-edits>` is forwarded to agy on both paths, as under
  `rescue`. Any other value is an argument error.
- `--model <id>` (additive) is forwarded to agy on both paths, as under
  `rescue` and `vision`.
- `--effort <low|medium|high|agy-default>` (additive) follows the same rule
  on both paths as under `rescue`: an explicit `low`, `medium`, or `high` is
  forwarded verbatim; with neither `--effort` nor `--model` the plugin sends
  `medium`; with `--model` and no `--effort` the plugin sends no `--effort`
  flag. agy applies the level carried by a variant id such as
  `gemini-3.1-pro-high`, and rejects a base id that needs one
  (`raw-base-gemini-3.1-pro-no-effort.txt`). `agy-default` still sends no flag.
  Any other value is an argument error.

`vision` has no `--effort` flag; it never sends one. `review` gained
`--effort` in a later additive change; see the `review` section above for its
own rule (no plugin-side default).

On a completed run (foreground, or an awaited `--wait` background run), if
agy reported measured usage the stable usage trailer (see [Usage
trailer](./COMPATIBILITY.md#usage-trailer)) is written to stderr.

Exit status is 0 for completed foreground work or a successful queue, 1 for
validation/authentication/execution/state failure, and 2 for a cancelled
awaited/foreground outcome.

Once `--json` is accepted, a missing prompt, a missing `agy` binary, or a
foreground run that did not complete emits one error envelope
(`details.error`, see [COMPATIBILITY.md](./COMPATIBILITY.md#--json)) instead
of an empty stdout body; the stderr line is unchanged either way. A
background job whose worker never started reports the same way.

### `--show-result` (all three verbs)

`--show-result` is an opt-in outcome report for a background `--wait` on
`review`, `rescue`, and `task`. Without it, the three verbs keep the frozen
1.x contract: the dispatch's own queued envelope stays on stdout, and the
caller fetches the finished job separately with `result <job-id>`
(`task --wait` also appends the raw text on completion, unchanged; see the
`task` section above). With it, the dispatch prints nothing on stdout at
all; the queued notice moves to stderr as
`Background <verb> started: <job-id>`, in text mode and under `--json`
alike; and after the wait, one of four outcomes is reported:

- **completed**: text mode prints the stored `rawOutput` on stdout,
  preceded by the usage trailer on stderr when agy reported measured usage.
  `--json` prints one envelope: `status: "completed"`, the job id, `answer`
  set to the raw output, and `details` built the same way `result <job-id>
  --json` builds its own (`conversationId`, `agyConversationId`,
  `provenance`, `inputHash`, `reportedModel`, the full stored `result`
  object with `usage` and `durationSeconds`, plus `deniedActions` with
  remedies and `agyPrintTimeout` when present). Exit 0.
- **failed**: text mode prints the job's own stored reason on stderr and
  nothing on stdout. `--json` prints the matching error envelope with
  `error.code: "job_failed"`, phase `run`. Exit 1.
- **cancelled**: nothing on stdout, and nothing extra on stderr beyond the
  dispatch notice. `--json` prints the error envelope with
  `error.code: "job_cancelled"`, phase `run`. Exit 2.
- **wait timeout** (the job is still `queued` or `running` when the wait's
  own 30-minute deadline passes): text mode prints the existing
  `wait timed out; job <id> is still <status>.` line, unchanged, and nothing
  on stdout. `--json` prints `status` as the job's own live status
  (`"queued"` or `"running"`), `answer: null`, and
  `error.code: "wait_timeout"`, phase `wait`. This never reports completion:
  a job that finishes after the deadline is not retroactively shown. Exit 1.

`--show-result` takes no `--head`/`--tail`; the printed or returned answer is
always the complete stored text.

### `--request-id` (task and rescue)

`--request-id <id>` is an opt-in idempotency key for a background dispatch:
`task` on its default background path, and `rescue --background`. A caller
that does not know if its first call went through (for example after a lost
connection or a host restart) can send the same call again, and no second
agy run starts.

The id is 1 to 128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, and `-`.
Any other value is an argument error that names the flag. On
`task --foreground`, or on `rescue` without `--background`, the flag is
refused with `--request-id applies to background jobs only`. Both refusals
are stderr only, exit 1, before agy is probed and before a job exists.

An id is scoped to the workspace's job state directory. The plugin stores a
fingerprint of the request with the job: a sha256 hash over the verb, the
prompt, the conversation mode and id, the `--add-dir` values, the agy mode
arguments, `--model`, the effective effort, and the workspace root. The
claim of the id and the creation of its job happen under one state lock, so
two concurrent calls with the same id create one job. There are three
outcomes:

- **New id**: the job is created and dispatched as without the flag, with
  the same queued envelope. The stored request of the job adds `requestId`
  and `requestFingerprint`.
- **Same id, same request**: no job is created and no worker starts. The
  plugin prints a queued-style envelope for the existing job: `status` is
  the current status of that job (for example `"queued"`, `"running"`, or
  `"completed"`), `jobId` is its id, and `details` holds
  `deduplicated: true` and `message`. Text mode prints
  `Background <verb> already started for request id <id>: <job-id>` and the
  status hint. Exit 0, whatever that status is. `--wait` then waits on the
  existing job, and `--show-result` reports it, the same as for a new job;
  with `--show-result` the notice goes to stderr.
- **Same id, different request**: no job is created and no worker starts.
  One stderr line names the id and the existing job. `--json` prints the
  error envelope with `status: "invalid_input"`,
  `error.code: "request_id_conflict"`, phase `validate`, and
  `details.existingJobId`. Exit 1.

The plugin never retries a call by itself. A job that failed to start keeps
its id: a repeat reports it as deduplicated with `status: "failed"`. An id
stays claimed while its job stays in the job history; when the history
limit drops the job, the id is free again. Without `--request-id`, dispatch
is unchanged and the job record has no request id fields.

## `vision`

`agy --print` has no native image input. Its `read_file` tool sends file bytes
as text, and `@file` does not create image parts. The CLI has no attachment
flag, and the internal send-message request uses `media=0`.

The local MCP server at `scripts/mcp/vision-server.mjs` returns an MCP image
content block. `vision` tells agy to call its `view_image` tool for every
named image.

```text
vision <image-path> [<image-path>...]
       [--prompt <text>]
       [--model <id>]
       [--expect <text>]...
       [--json] [--cwd <path>]
```

At least one image path is required. Paths are resolved from `--cwd` or the
current directory and must name existing regular files.

- `--prompt` defaults to: “Describe this image in concrete, specific detail:
  layout, elements, colors, text, and anything unusual.”
- `--model` defaults to `gemini-3.6-flash-high` and is forwarded to agy.
- Vision is foreground-only. `--background` and `--wait` are not public flags.
- The MCP server accepts `.png`, `.jpg`, `.jpeg`, `.webp`, and `.gif`, with a
  10 MiB maximum per source file. A directory symlink among the ancestors is
  accepted only when the resolved file is itself named by this invocation; a
  requested file that is itself a symlink or junction is always refused;
  every path not named by this invocation is refused.
- `vision` applies the same extension list and the same 10 MiB cap before it
  starts agy, and exits 1 on the first file that breaks either limit, so a
  file the server would refuse costs no tokens.

Measured on 2026-09-02 with agy 1.1.24, `gemini-3.6-flash-high` transcribed
`ZETA-4471`, `Bežné účty`, and `1 435,50 €` exactly in three of four runs;
one run wrote `Běžné`. The `gemini-3.7-flash-high` model transcribed all
three strings exactly in one run and used about twice the input tokens,
65k compared with 33k, so the default stays; pass
`--model gemini-3.7-flash-high` when exact diacritics matter.

Run `setup` first to register the MCP server and permission. Failure to obtain
actual image content is reported through the stable
`VISION-UNAVAILABLE: <reason>` response described in the compatibility
contract, not through a special exit code.

The prompt asks for a fixed answer shape: `## Transcription` (every visible
text string of every image, verbatim, one per line, `(no text)` when there is
none), then `## Observations` (visual facts only), then `## Answer`. It tells
the model that `view_image` is the only way to see an image and that
`read_file` on an image returns bytes, not pixels. An answer from this
channel is not evidence. Cross-check the transcript against the source image
before you use the answer. The cross-checked transcript is the evidence. The
shape is requested by the prompt. agy does not enforce it, so a model can
still deviate from it. A model has returned a confident PASS while it
described UI elements that were not present.

On agy 1.1.24 a large image does not arrive inline. agy writes the MCP result
to a file in its own conversation directory and gives the model the note
`[Resource offloaded to file://<X>]` in place of the pixels. The prompt tells
the model to open exactly the `<X>` from that note with agy's `view_file`
tool, and no other path, then to answer in the same shape. Measured on
2026-09-02, a 6761-byte image was offloaded in every run and a 790-byte image
was offloaded in some runs, so do not depend on a size limit. Read the
transcript to see which path a run used.

`vision` does not accept `--add-dir`. That flag is the headless read grant
for agy's own file tools (see `rescue` and `task`); `vision` hands the
images to agy through the MCP tool with a per-run allowlist instead, so the
run never needs a directory grant. Passing `--add-dir` to `vision` is an
argument error: the command exits 1 before it validates any image path or
spawns agy.

On a completed run, if agy reported measured usage the stable usage trailer
(see [Usage trailer](./COMPATIBILITY.md#usage-trailer)) is written to stderr.

Exit status is 0 when agy reports a completed response (including the sentinel),
1 for validation/authentication/execution/state failure, and 2 for a cancelled
agy outcome.

Once `--json` is accepted, a missing image path, a rejected image, a missing
`agy` binary, or a run that did not complete emits one error envelope
(`details.error`, see [COMPATIBILITY.md](./COMPATIBILITY.md#--json)) instead
of an empty stdout body; the stderr line is unchanged either way.

### `--expect`

Repeatable. Each value is trimmed; an empty value or more than 32 values is
an argument error, stderr only, exit 1. After a completed run, each value is
checked against the `## Transcription` section of the answer: found when it
equals one transcription line exactly (both trimmed) or is a substring of
the section. This is a substring check on what agy already transcribed, not
a truth check of the image itself — cross-check the transcript against the
source image the same way the rest of this section already asks.

If the `## Transcription` heading is missing, or the whole answer is the
single `VISION-UNAVAILABLE: <reason>` line, every value comes back
unverifiable instead of found or missing: there is nothing to check against.

Under `--json`, `details.expectations` lists `{ value, found, reason? }` per
value (`found` is `true`, `false`, or `null` when unverifiable) and
`details.expectationSummary` is `all_found`, `missing`, or `unverifiable`.
In markdown, a block prints after the answer:

```text
Expectations: missing
  missing: <value that was not found>
```

or, when unverifiable:

```text
Expectations: unverifiable
  unverifiable: no transcription section
```

The exit code is unaffected by `--expect` in this first version, whether
values are found, missing, or unverifiable.

## `status`

```text
status [<job-reference>] [--wait] [--timeout-ms <ms>] [--exit-status]
       [--json] [--cwd <path>]
```

Without a reference, status lists active and up to eight recent jobs for the
current session when `ANTIGRAVITY_PLUGIN_SESSION_ID` is set, or all sessions
when it is absent. With a reference, it displays one job without session
filtering.

A job reference can be an exact id, a unique id substring, or a 1-based index
into the newest-first candidate list. Extra positional arguments are not
public.

Without a reference, if `review`, `rescue`, `task`, or `vision` cached an
agy version outside this plugin's measured range (see
[`doctor`](#doctor)), status prints one stderr line: `antigravity:status —
agy <v> (seen <date>) is newer than the last measured version <newest>.`
This reads only the cached value; status itself never calls agy. `status
<id>` never prints this line.

For queued and running jobs, health is observed from the worker PID, a
persisted heartbeat written every 15 seconds, and persisted model-output
progress. Output and heartbeat updates share a five-second write throttle.
Until an older job has either observation, its `startedAt` value is used, so a
live worker is `active` for recent activity, `quiet` after two minutes, and
only `possibly_stalled` after ten minutes without activity. A missing worker
is `worker_missing`; persisted diagnostic states such as `auth_required`,
`failed`, and `cancel_failed` remain authoritative.

- `--wait` waits for the selected job to reach `completed`, `failed`, or
  `cancelled`. Without a reference it waits until the session-filtered active
  list is empty.
- `--timeout-ms` applies only with `--wait` and defaults to 900000 (15 minutes).
  Polling is once per second. This observation deadline is independent of the
  agy execution budget; reaching it does not terminate the job and still
  returns exit 0, unless `--exit-status` is given (see below).
- `--exit-status` (added 2026-09) is opt-in and requires both a job
  reference and `--wait`; without either, it is refused before any job
  lookup: `antigravity:status — --exit-status requires a job id and --wait`
  (stderr only, exit 1). The recent list is truncated to eight jobs, so a
  list-wide judgement would be wrong; this is why the flag needs one named
  job, not the plain list. With the flag, `status <id> --wait` exits by
  that job's own outcome instead of the usual 0:

  | Outcome | Exit |
  |---|---|
  | `completed` | `0` |
  | `failed` | `1` |
  | `cancelled` | `2` |
  | wait deadline passed, job still `queued`/`running` | `3` |

  The `3` case also prints one stderr line: `antigravity:status — wait
  timed out; job <id> is still <status>.` Markdown and `--json` output are
  identical with and without `--exit-status`; only the exit code (and, on
  the timeout outcome, that one stderr line) differs.

Status returns 0 whenever it successfully produces a snapshot, including
after the wait timeout and when the observed terminal status is failed or
cancelled, unless `--exit-status` changes this per the table above. It
returns 1 when state cannot be read or a reference cannot be resolved. It
does not return 2 for a cancelled job outside of `--exit-status`.

Once `--json` is accepted, a reference that resolves to no job, or lock
contention on the job state, emits one `state_error` error envelope
(`details.error`, see [COMPATIBILITY.md](./COMPATIBILITY.md#--json)) instead
of an empty stdout body; the stderr line is unchanged either way.

A finished job's index entry (and therefore the "Recent Jobs" table and
`--json`) additionally carries `answerBytes` (UTF-8 byte length of the stored
answer) and `answerLines` (line count; a trailing newline does not add a
line), set once the job reaches a terminal state. These fields are additive
and `null`/absent on legacy records.

A job with one or more headless denials (agy >= 1.1.20; see [headless read
access](./COMPATIBILITY.md#headless-read-access)) carries a `Denied` column
in both status tables (a count, or `-`), and `--json` carries a per-job
`deniedActionsCount` on every job in a list. `status <id>` (single job) adds
a "## Denied Actions" markdown section, one line per action with its remedy,
and `--json`'s `details.job.deniedActions` carries the same list as
`{ action, displayName, target, remedy }`. `target` (added in 2.0.0)
is the denied tool-parameter value agy named, or `null` when it is unknown;
the markdown line and `target` both name it when present. Absent on a clean
run or a legacy record.

A job whose answer was cut short by agy's own print timeout (agy >= 1.1.28;
see [print timeout and fatal-error reporting](./COMPATIBILITY.md#print-timeout-and-fatal-error-reporting))
carries a `Partial` column in both status tables (`partial`, or `-`), and
`--json` carries the same `agyPrintTimeout` field on every job in a list.
`status <id>` (single job) adds a "Note:" markdown line naming the expired
timeout, and `--json`'s `details.job.agyPrintTimeout` carries
`{ limit: string | null }`. Absent on a clean run or a legacy record.

A job's own agy conversation id, whenever agy reported one, is carried at
`--json`'s `details.job.agyConversationId` for `status <id>` and as a
per-job `agyConversationId` field in the all-jobs list — present on a
completed job and also on a failed or denied one, so a host can resume the
conversation even when it never passed `--conversation` itself (see [denied
runs](#denied-runs-resuming-and-the-interactive-prompt) above). This is
distinct from `conversationId` (the same envelope's existing field), which
is only the id the *caller* passed in via `--conversation`; `null` when agy
never reported a conversation id, including on a legacy record.

A job's `provenance` record (`pluginVersion`, `agyVersion`, `model`,
`effort`, `mode`, `addDirCount`, `requestedAt`) is set once when the job is
created and carried at `--json`'s `details.job.provenance` for `status <id>`
and as a per-job `provenance` field in the all-jobs list (it lives on the
index entry, so a list needs no per-job disk read for it). `status <id>`
(single job) adds a "## Provenance" markdown section, one line per non-null
field; a field is omitted, not shown as `null`. The Recent Jobs table adds
`Model` and `Effort` columns only when at least one listed job's provenance
names either one; otherwise the table is unchanged. `null`/absent on a
legacy record written before this field existed.

`status <id> --json` also carries `details.job.result.reportedModel`: the
model agy's own `result` event named, when that event carries one; `null`
otherwise, including on every record measured so far.

For a `review` job that computed an input hash (see [`review`'s
`--preview`/`--require-complete`](#review) above), `details.job.request.inputHash`
carries `sha256:<hex>` of the exact prompt string sent to agy, and the
"## Provenance" markdown section adds a line `Input hash: sha256:...`. This
does not add a field to the `provenance` record itself; it reads the job's
own `request.inputHash`. Absent for any job that never reached input
selection (a non-`review` job, or a `no_changes` run).

## `result`

```text
result [<job-reference>] [--head <n>] [--tail <n>] [--json] [--cwd <path>]
```

The reference accepts the same exact-id, unique-substring, and 1-based-index
forms as `status`. Without a reference, result selects the newest finished job
in the current session when `ANTIGRAVITY_PLUGIN_SESSION_ID` is set, or the
newest finished job across sessions otherwise. An explicit reference is not
session-filtered. Active jobs are rejected with guidance to use `status`.

`--head <n>` and `--tail <n>` (additive) each take a positive integer number
of lines and may be combined; `--head 0` (or any non-positive value) is an
argument error. Without either flag, output is unchanged. When a flag cuts
the stored answer, the markdown output ends with a line `(showing <k> of
<total> lines; full answer stored)`, and `--json` sets `details.truncated:
true` while `answer` holds the cut text; `details.result.rawOutput` carries
the same cut text too, not the full stored answer, so the `--json` path
saves the same bytes the markdown path does. The cut is applied to the
stored answer text itself (lines only; a multi-byte UTF-8 character is never
split), not to the metadata-fallback shape a job without a stored answer
renders.

If measured usage was stored, the stable usage trailer is written to stderr.
Exit status is 0 for a completed job, 1 for a failed, active, missing, or
unreadable job, and 2 for a cancelled job. A failed or cancelled job can still
produce a result payload before its nonzero exit.

A stored `failed` job keeps its normal envelope (`status: "failed"`, `answer`
as stored) and adds `details.error.code: "job_failed"` under `--json`, naming
why without repeating the raw upstream stderr. A reference that resolves to
no job, one that is still active, or lock contention on the job state emits
one `state_error` error envelope instead (see
[COMPATIBILITY.md](./COMPATIBILITY.md#--json)); the stderr line is unchanged
either way.

When the stored result carries one or more headless denials, the markdown
output ends with a "## Denied Actions" section, one line per action with its
remedy, and `--json` sets `details.deniedActions` to the same list as
`{ action, displayName, target, remedy }`. `target` (added in 2.0.0)
is the denied tool-parameter value agy named, or `null` when it is unknown;
the markdown line and `target` both name it when present. This is appended
after the answer text and is never folded into the opaque `answer` field.
Absent when the run had no denial.

When the stored result carries agy's own print-timeout marker (agy >= 1.1.28;
see [print timeout and fatal-error reporting](./COMPATIBILITY.md#print-timeout-and-fatal-error-reporting)),
the markdown output ends with a "Note:" line naming the expired timeout
(appended after the denied-actions section when both are present), and
`--json` sets `details.agyPrintTimeout` to `{ limit: string | null }`. This
is a distinct key from `details.truncated` above, which already means the
`--head`/`--tail` display cut — the two never collide. Absent when the run
had no print-timeout marker.

`--json` also carries the same agy-reported conversation id at the top level,
`details.agyConversationId` — the same value already nested under
`details.result.agyConversationId`, surfaced in the same place `status <id>
--json` puts it (`details.job.agyConversationId`). Distinct from
`details.conversationId` (the id the caller passed in). `null` when agy
never reported one.

`--json` carries `details.provenance` (the same job provenance record
`status <id> --json` puts at `details.job.provenance`), `details.inputHash`
(the same `review`-only field `status <id> --json` puts at
`details.job.request.inputHash`), and `details.reportedModel` (the same
field `status <id> --json` puts at `details.job.result.reportedModel`). All
three are `null`/absent on a legacy record or a non-`review` job.
The markdown output appends the same "## Provenance" section `status <id>`
uses, one line per non-null field including `Input hash: sha256:...` when
present, after the answer text and after any denied-actions/print-timeout
sections. It is never folded into the opaque `answer` field.

For a completed `review --findings-json` job, `--json` also carries
`details.findings`, `details.findingsStatus`, and (when not valid)
`details.findingsError`, the same three fields the review itself reports
(see [`review`](#review)). They are checked when `result` runs, from the
stored `details.result.structuredRaw` (agy's structured output as JSON text,
`null` when agy sent none). The markdown output gets one line,
`Findings: <valid|invalid|missing>`, before the "## Provenance" section.
Without the flag, or for a job that did not complete, none of this appears.

`result <job-id> --check-locations` (additive, 2026-09)
runs the same heuristic citation-location check `review --check-locations`
runs, against the job's already-stored answer and hunks — it never calls agy
again. It works even on a job reviewed without `--check-locations` at review
time, because `request.hunks` is stored on every review job. `--json` adds
`details.locationCheck`, the same shape [`review`](#review) documents, or
`null` on a job stored before `request.hunks` existed. Either way, one
stderr line and one appended markdown line report the outcome: the summary
line when the check ran, or `antigravity:result — location check
unavailable: this job predates hunk storage.` when it could not. Without the
flag, `details` carries no `locationCheck` key. See [Heuristic location
check](./COMPATIBILITY.md#heuristic-location-check).

When the index selects a job whose detail file is missing, malformed, or not a
valid job record, `result` writes `antigravity:result — stored job <id> is
unreadable.` to stderr and exits 1. Under `--json` this is the
`state_error`/`invalid_job_record` error envelope described above, not a
success envelope. A valid completed record whose answer is empty keeps the
normal completed metadata response.

## `cancel`

```text
cancel [<job-reference>] [--json] [--cwd <path>]
```

Only active (`queued` or `running`) jobs are candidates. The reference accepts
an exact id, a unique id substring, or a 1-based index into the newest-first
active list. Without a reference, cancel selects the newest active job. It is
not session-filtered.

The command attempts to terminate the persisted worker process tree and the
recorded agy process, then records `cancelled` only when all known targets are
confirmed killed or already absent. A job with no recorded process id, a
termination failure, or a state persistence failure remains an error and can
be retried.

Exit status is 0 only when cancellation is established and persisted, and 1
for resolution, termination, state-lock, or persistence failure.

Once `--json` is accepted, a reference that resolves to no active job emits
one `state_error` error envelope (`details.error`, see
[COMPATIBILITY.md](./COMPATIBILITY.md#--json)) instead of an empty stdout
body; the stderr line is unchanged either way. A termination or persistence
failure keeps its own existing `cancel_failed`/`state_busy` envelope
(unchanged by this).

## `update`

```text
update [--apply] [--json]
```

`update` is a standalone dispatcher convenience, not one of the nine verbs.
No host wrapper reaches it, and its `--json` output is unstable in 2.x. It
reads the running version, asks the npm registry for the latest version
(cached 24 hours), and prints the update command of every host it finds on
`PATH`. Without `--apply` it changes nothing.

The registry check retries at most twice on a network error, HTTP 429, or
5xx, waiting `500ms * 2^attempt` plus up to 250ms of jitter between
attempts, honouring a numeric `Retry-After` header when the registry sends
one. All of this, delays and body reading included, fits inside one 25
second total budget: no new attempt starts once starting it would exceed
that budget, and each attempt's own 10 second per-request timeout is capped
at whatever of the 25 seconds remains when that attempt starts, so no single
request can carry the whole call past its budget. The effective
`Retry-After` cap under this budget is therefore whatever of the 25 seconds
remains when a retry is scheduled, not the full 30 seconds the header format
allows. A 4xx other than 429, malformed JSON, and the semver check above
never retry; an `update --apply` step never retries either.

`--apply` runs those commands for the hosts that are present, and prints each
command before it runs it. It stops a host at the first failing step and
exits 1. On Windows, `update --apply` refuses a `.cmd`/`.bat` step before
spawning when its command path or any argument contains `&`, `|`, `<`, `>`,
`^`, `%`, `!`, `"`, or a carriage return/newline.

Per host, `--apply` does this:

- Claude Code: `plugin marketplace update antigravity` first, then
  `plugin update antigravity@antigravity`. Without the marketplace refresh,
  `plugin update` reports the version you already have as the latest.
- Codex CLI: `plugin marketplace list` first, then `plugin remove` and
  `plugin add`, both with the qualified `antigravity@antigravity` name. If
  the `antigravity` marketplace is a local clone, the command prints the path
  and tells you to pull that clone first, because `plugin add` installs the
  version the clone holds. After the install it reads the version from the
  plugin root that `plugin add` prints, prints `installed <version>`, and adds
  one line when that version is not the latest. It never pulls or changes your
  clone.
- agy: `npm pack` of the latest version, `tar -x`, `plugin uninstall`, then
  `plugin install` of the extracted directory. With the registry check
  disabled there is no known latest version, so this host is skipped.
- npx: nothing. An unversioned `npx` resolves the latest version on every run.

`ANTIGRAVITY_NO_UPDATE_CHECK=1` skips the registry check.
