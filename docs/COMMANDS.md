# Commands reference

This is the argument and execution reference for the eight public 1.x verbs.
The broader versioning, output, environment, and state promises are in the
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
preserves all values. Unknown flags and undocumented extra positionals may be
ignored by the current parser, but are not public behavior and may become
errors in 1.x.

`--cwd <path>` changes the working directory used to resolve the workspace on
every verb except `setup`. A Git repository root is used when one can be
found; otherwise the supplied/current directory is the workspace.

When `agy` is missing, every verb that runs it except `setup` exits 1 with
one line, `antigravity:<verb> — \`agy\` is not on PATH (<reason>). Run
/antigravity:setup.`, before it collects a diff, writes a job record or starts
anything; `setup` keeps its own line and exit 2.

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

An empty working tree (no tracked diff and no untracked files) prints
`antigravity:review — no changes to review.` and returns 0 without calling
agy. A working tree of only untracked files is reviewed.

Exit status is 0 for a completed foreground review, a successfully queued
background review, or no changes; 1 for validation, Git, authentication, agy,
or state failure; and 2 when an awaited/foreground agy outcome is cancelled.

## `rescue`

```text
rescue <prompt...>
       [--background] [--wait]
       [--resume] [--continue] [--fresh] [--conversation <id>]
       [--add-dir <path>]... [--mode <plan|accept-edits>]
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
     [--add-dir <path>]... [--mode <plan|accept-edits>]
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
  to agy, verbatim and in the order given, on both the foreground and the
  background path. It is the headless read grant described under `rescue`
  and in [COMPATIBILITY.md](./COMPATIBILITY.md#headless-read-access).
- `--mode <plan|accept-edits>` is forwarded to agy on both paths, as under
  `rescue`. Any other value is an argument error.

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
  10 MiB maximum per source file. It rejects symlink/junction resolution and
  every path not named by this invocation.
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
