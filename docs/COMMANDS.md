# Commands reference

This is the argument and execution reference for the eight public 1.x verbs.
The broader versioning, output, environment, and state promises are in the
[1.x compatibility contract](./COMPATIBILITY.md).

## Invocation forms

All hosts route to the same `scripts/commands/<verb>.mjs` implementation:

```text
/antigravity:<verb> ...                 # Claude Code
$antigravity <verb> ...                 # Codex CLI
agy plugin run antigravity <verb> ...   # agy-native
antigravity-plugin <verb> ...           # standalone package binary
node bin/antigravity.mjs <verb> ...     # standalone from a checkout
```

The package-binary spelling is the stable CLI interface name, but this fork
is not currently published to npm. Use the checkout form today.

Documented value flags require a following token. `--` ends flag parsing.
Repeating a scalar value flag uses its last value; repeating `--add-dir`
preserves all values. Unknown flags and undocumented extra positionals may be
ignored by the current parser, but are not public behavior and may become
errors in 1.x.

`--cwd <path>` changes the working directory used to resolve the workspace on
every verb except `setup`. A Git repository root is used when one can be
found; otherwise the supplied/current directory is the workspace.

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
- `--base <ref>` is currently honored only with `--scope branch`.
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

An empty tracked diff prints `antigravity:review — no changes to review.` and
returns 0 without calling agy. Because the current no-change gate tests the
tracked diff, an untracked-only working tree also takes this path even though
auto-scope detected the untracked files. This edge case may be corrected in a
1.x release.

Exit status is 0 for a completed foreground review, a successfully queued
background review, or no changes; 1 for validation, Git, authentication, agy,
or state failure; and 2 when an awaited/foreground agy outcome is cancelled.

## `rescue`

```text
rescue <prompt...>
       [--background] [--wait]
       [--resume] [--continue] [--fresh] [--conversation <id>]
       [--add-dir <path>]...
       [--model <id>] [--json] [--cwd <path>]
```

All positional tokens are joined with spaces to form the prompt. A prompt is
required unless `--resume`, `--continue`, or `--conversation` is supplied.

- Fresh conversation is the default. `--fresh` makes it explicit.
- `--resume` and `--continue` are equivalent and resume the most recent
  conversation. They may be supplied together.
- `--conversation <id>` selects a specific conversation and conflicts with
  `--resume`, `--continue`, and `--fresh`.
- `--fresh` conflicts with `--resume` and `--continue`.
- `--add-dir <path>` is repeatable and forwards extra workspace directories
  to agy.
- `--model <id>` is accepted but currently ignored, with a diagnostic on
  stderr. No model-selection behavior is promised for this flag until the
  documentation says it is active.
- `--background` queues a worker; `--background --wait` waits for terminal
  state after printing the queued response. Without `--background`, rescue is
  foreground and `--wait` has no additional effect.

Exit status is 0 for completed foreground work or a successful queue, 1 for
validation/authentication/execution/state failure, and 2 for a cancelled
awaited/foreground outcome.

## `task`

```text
task <prompt...>
     [--background | --foreground] [--wait]
     [--continue | --conversation <id>]
     [--add-dir <path>]...
     [--json] [--cwd <path>]
```

All positional tokens are joined with spaces to form the prompt. A prompt is
required unless `--continue` or `--conversation` is supplied.

- Background is the default. `--background` explicitly retains that default.
- `--foreground` runs inline and conflicts with `--background`.
- On the background path, `--wait` waits for terminal state. When successful,
  the implementation may append the stored raw result to stdout after the
  initial queued response. On the foreground path, `--wait` has no additional
  effect.
- `--continue` resumes the most recent conversation and conflicts with
  `--conversation <id>`.
- `--add-dir <path>` is repeatable and forwards extra workspace directories
  to agy.

Exit status is 0 for completed foreground work or a successful queue, 1 for
validation/authentication/execution/state failure, and 2 for a cancelled
awaited/foreground outcome.

## `vision`

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
  10 MiB maximum per source file. It rejects symlink/junction resolution and
  every path not named by this invocation.

Run `setup` first to register the MCP server and permission. Failure to obtain
actual image content is reported through the stable
`VISION-UNAVAILABLE: <reason>` response described in the compatibility
contract, not through a special exit code.

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

- `--wait` waits for the selected job to reach `completed`, `failed`, or
  `cancelled`. Without a reference it waits until the session-filtered active
  list is empty.
- `--timeout-ms` applies only with `--wait` and defaults to 900000 (15 minutes).
  Polling is once per second.

Status returns 0 whenever it successfully produces a snapshot, including
after the wait timeout and when the observed terminal status is failed or
cancelled. It returns 1 when state cannot be read or a reference cannot be
resolved. It does not return 2 for a cancelled job.

## `result`

```text
result [<job-reference>] [--json] [--cwd <path>]
```

The reference accepts the same exact-id, unique-substring, and 1-based-index
forms as `status`. Without a reference, result selects the newest finished job
in the current session when `ANTIGRAVITY_PLUGIN_SESSION_ID` is set, or the
newest finished job across sessions otherwise. An explicit reference is not
session-filtered. Active jobs are rejected with guidance to use `status`.

If measured usage was stored, the stable usage trailer is written to stderr.
Exit status is 0 for a completed job, 1 for a failed, active, missing, or
unreadable job, and 2 for a cancelled job. A failed or cancelled job can still
produce a result payload before its nonzero exit.

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
