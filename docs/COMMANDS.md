# Commands reference

This is the argument and execution reference for the eight public 1.x verbs,
and for the standalone `update` convenience at the end. The broader
versioning, output, environment, and state promises are in the
[1.x compatibility contract](./COMPATIBILITY.md).

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
extra positionals may be ignored and may become errors in 1.x.

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

Every print-mode invocation also forwards agy's own `--print-timeout` as
`<budget + 60 second headroom>`, rounded up to whole seconds (`1860s` for
the 30-minute default). Without this, agy's own default `--print-timeout
5m0s` ends any run over five minutes with `status: ERROR`/`"timeout waiting
for response"` while the plugin's own budget above is still open. The
headroom keeps the plugin's own deadline first in line, so agy's timeout is
only a backstop. A `0` budget ("no deadline") forwards a fixed `24h`
ceiling instead of `0s` — agy treats a literal `0` as an immediate timeout,
not as disabled.

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

Exit status is 0 on success, 1 when vision configuration/removal or spawning
fails, and 2 when the agy version probe cannot find or run agy. A nonzero exit
from the interactive agy call is passed through unchanged. The standalone
dispatcher can return 127 earlier when an explicit `AGY_BIN` path is missing.

## `review`

```text
review [--base <ref>] [--scope <auto|working-tree|branch>]
       [--background] [--wait]
       [--continue | --conversation <id>]
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

An empty working tree (no tracked diff and no untracked files) prints
`antigravity:review — no changes to review.` and returns 0 without calling
agy. A working tree of only untracked files is reviewed.

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

## `rescue`

```text
rescue <prompt...>
       [--background] [--wait]
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
  effort for this run, forwarded verbatim as `--effort <value>`. When absent,
  the plugin sends `medium` (plan 086 T2 default; a run without `--effort`
  otherwise picks up whatever the machine has saved, so a delegated run is
  not reproducible across machines). `agy-default` (plan 086 T5i) makes the
  plugin send no `--effort` flag at all, so the user's own agy configuration
  decides instead — the run is therefore not reproducible across machines,
  the same as a pre-1.4.0 run with no `--effort` flag at all. Any other
  value is an argument error (exit 1) and agy is not started. The plugin
  does not probe what agy does with the value beyond forwarding it. `medium`
  runs longer than `low`, so a flag-less job is more likely to reach the
  execution budget above; a run that reaches it stores a failed job with no
  answer. Pass `--effort low` explicitly, or raise
  `ANTIGRAVITY_AGY_TIMEOUT_MS`, to avoid this.
- `--background` queues a worker; `--background --wait` waits for terminal
  state after printing the queued response. Without `--background`, rescue is
  foreground and `--wait` has no additional effect.
  The agy execution budget above applies in both cases; the background wait
  itself has a separate 30-minute deadline.

Exit status is 0 for completed foreground work or a successful queue, 1 for
validation/authentication/execution/state failure, and 2 for a cancelled
awaited/foreground outcome.

## `task`

```text
task <prompt...>
     [--background | --foreground] [--wait]
     [--continue | --conversation <id>]
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
- `--continue` resumes the most recent conversation and conflicts with
  `--conversation <id>`.
- `--add-dir <path>` is repeatable and forwards extra workspace directories
  to agy, verbatim and in the order given, on both the foreground and the
  background path. It is the headless read grant described under `rescue`
  and in [COMPATIBILITY.md](./COMPATIBILITY.md#headless-read-access).
- `--mode <plan|accept-edits>` is forwarded to agy on both paths, as under
  `rescue`. Any other value is an argument error.
- `--model <id>` (additive) is forwarded to agy on both paths, as under
  `rescue` and `vision`.
- `--effort <low|medium|high|agy-default>` (additive) is forwarded to agy on
  both paths, as under `rescue`: verbatim as `--effort <value>`, `medium`
  when absent (plan 086 T2 default), no `--effort` flag at all for
  `agy-default` (plan 086 T5i, the user's own agy configuration decides),
  any other value is an argument error.

`review` and `vision` have no `--effort` flag; they never send one.

Exit status is 0 for completed foreground work or a successful queue, 1 for
validation/authentication/execution/state failure, and 2 for a cancelled
awaited/foreground outcome.

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

Exit status is 0 when agy reports a completed response (including the sentinel),
1 for validation/authentication/execution/state failure, and 2 for a cancelled
agy outcome.

## `status`

```text
status [<job-reference>] [--wait] [--timeout-ms <ms>]
       [--json] [--cwd <path>]
```

Without a reference, status lists active and up to eight recent jobs for the
current session when `ANTIGRAVITY_PLUGIN_SESSION_ID` is set, or all sessions
when it is absent. With a reference, it displays one job without session
filtering.

A job reference can be an exact id, a unique id substring, or a 1-based index
into the newest-first candidate list. Extra positional arguments are not
public.

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
  returns exit 0.

Status returns 0 whenever it successfully produces a snapshot, including
after the wait timeout and when the observed terminal status is failed or
cancelled. It returns 1 when state cannot be read or a reference cannot be
resolved. It does not return 2 for a cancelled job.

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
`{ action, displayName, target, remedy }`. `target` (additive, plan 086 T3)
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

When the stored result carries one or more headless denials, the markdown
output ends with a "## Denied Actions" section, one line per action with its
remedy, and `--json` sets `details.deniedActions` to the same list as
`{ action, displayName, target, remedy }`. `target` (additive, plan 086 T3)
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

When the index selects a job whose detail file is missing, malformed, or not a
valid job record, `result` writes `antigravity:result — stored job <id> is
unreadable.` to stderr, exits 1, and writes no success envelope even with
`--json`. A valid completed record whose answer is empty keeps the normal
completed metadata response.

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

## `update`

```text
update [--apply] [--json]
```

`update` is a standalone dispatcher convenience, not one of the eight verbs.
No host wrapper reaches it, and its `--json` output is unstable in 1.x. It
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
