# Antigravity plugin 2.x compatibility contract

This document defines the public contract for `antigravity-plugin` 2.0.0 and
later 2.x releases. The implementation at 0.2.4 is the baseline from which
the original contract was frozen. 2.0.0 is the baseline for 2.x. A behavior
is public only when this document or the
[commands reference](./COMMANDS.md) says it is promised.

Plugin 1.3.0 is this package's version number. agy 1.1.15 to 1.2.1 is the
tested range of Google's Antigravity CLI, with 1.2.1 as the newest measured
version. The two version lines advance independently. A new agy release does
not change the plugin version.

## Supported matrix

| Surface | Supported in 2.x |
|---|---|
| Hosts | Claude Code (`/antigravity:<verb>`), Codex CLI (`$antigravity <verb>`), agy-native (install/list/validate; interactive TUI `/antigravity:<verb>` via the copied command files; standalone CLI as the fallback that always works), and the standalone CLI (`npx @southcarpet/antigravity-plugin <verb>`, `antigravity-plugin <verb>` after install, or `node bin/antigravity.mjs <verb>`) |
| Operating systems | Linux, Windows, and macOS. All three run the full CI suite. Release-tree commit `4f9b317` was tested in CI run 34289858536 (created 2026-09-08 23:16:08): six cells green, CodeQL run 34289858532 green. `macos-latest` used runner image `macos-26-arm64` (Node 22.3.x and Node 24: 886 tests, 873 passed, 13 skipped, 0 failed). `windows-latest` used `windows-2025-vs2026` (886 tests, 881 passed, 5 skipped, 0 failed). `ubuntu-latest` used `ubuntu-24.04` (886 tests, 873 passed, 13 skipped, 0 failed). Other Node platforms remain best-effort. Live `agy` runs (see the verbs-exercised-live tables below) have not happened on macOS; that coverage stays best-effort until they do. |
| Node.js | `>=22.3.0` |
| Google Antigravity CLI | `agy` 1.1.15 to 1.2.1; newest measured 1.2.1. This range forms the tested and supported matrix. Live coverage differs by version as shown below. |

The standalone package-binary spelling (`antigravity-plugin`) is the CLI
interface name after install. The published npm package is
`@southcarpet/antigravity-plugin`. The supported distributed path is
`npx @southcarpet/antigravity-plugin <verb>`; a clone may still run
`node bin/antigravity.mjs <verb>`.

The Node floor is 22.3.0 because Node 18 and 20 are EOL as of this contract,
and 22.3.0 is the first Node 22 release on which this repository's full test
suite can run (`mock.module()` and `--experimental-test-module-mocks`). The
runtime has no npm dependencies.

The tested agy matrix is intentionally narrow. Every delegated verb uses
agy's stream-JSON input and output. agy 1.1.15 rejected the input envelope
accepted by 1.1.14. This broke every delegated verb until this plugin changed
its transport. The same envelope was confirmed on 1.1.17. `setup` probes and
displays the installed version but does not enforce this matrix. A successful
probe does not promise that an unlisted agy version is compatible.

| agy version | Verbs exercised live | Date |
|---|---|---|
| 1.1.15 | All eight: `setup`, `review`, `rescue`, `task`, `vision`, `status`, `result`, and `cancel` | 2026-08-21 |
| 1.1.17 | All eight: `setup`, `review`, `rescue`, `task`, `vision`, `status`, `result`, and `cancel` | 2026-08-21 |
| 1.1.24 | `rescue`, `task`, `vision`, and `result` | 2026-09-02 |
| 1.1.27 | `task`, `rescue`, `review`, `vision`, `status`, `result`, and `cancel`. `setup` was not run live. | 2026-09-09 |
| 1.2.1 | `task`, `rescue`, `review`, `vision`, `status`, `result`, and `cancel`. `setup` was not run live. | 2026-09-11 |

The 1.1.15 and 1.1.17 runs included the usage trailer on `vision` and
`result`. The 1.1.24 runs covered foreground and background `rescue` and
`task`, `--add-dir`, and `--mode`. They also covered five `vision` runs, the
offloaded-copy fallback, a negative `vision` run, and `result` on a background
job. The runs also covered headless auto-denial detection and the
`--print-timeout` error shape. `review`, `status`, `cancel`, and `setup` use
the same runtime paths and pass the fake-agy suite. They were not run live on
1.1.24.

The newest version measured live is agy 1.2.1, on 2026-09-11, from commit
`3b75be6`. The table below lists the saved transcripts for 1.1.27 and 1.2.1.
`setup` has no transcript for either version.

| Verb | Flags | agy | Date | Result | Transcript |
|---|---|---|---|---|---|
| `task` | `--foreground --json` | 1.1.27 | 2026-09-09 | exit 0, `status: "completed"`, answer `PROBE.` | `t5-live-task-foreground.txt` |
| `task` | `--foreground --json`, prompt `/model` then `Reply with exactly OK.` | 1.1.27 | 2026-09-09 | exit 0, `status: "completed"`, answer `OK.` Slash text was inert. | `t5-live-task-slash-inert.txt` |
| `task` | `--foreground --effort low --json` | 1.1.27 | 2026-09-09 | exit 0, `status: "completed"`, answer `LOW` | `t5-live-task-effort-low.txt` |
| `task` | `--foreground --effort high --json` | 1.1.27 | 2026-09-09 | exit 0, `status: "completed"`, answer `HIGH` | `t5-live-task-effort-high.txt` |
| `task` | `--json` (background default) | 1.1.27 | 2026-09-09 | exit 0, `status: "queued"`, job `1cd3190f559c` | `t5-live-task-background-start.txt` |
| `task` | `--foreground --json`, URL-read prompt | 1.1.27 | 2026-09-09 | exit 1, no stdout envelope. stderr: `Headless runs cannot grant "read_url"; the host must run this step itself.` | `t5-live-task-denied-foreground.txt` |
| `rescue` | `--json` | 1.1.27 | 2026-09-09 | exit 0, `status: "completed"`, answer `RESCUE` | `t5-live-rescue-foreground.txt` |
| `status` | `--json` | 1.1.27 | 2026-09-09 | exit 0, `status: "ok"` | `t5-live-status-list.txt` |
| `status` | (none) | 1.1.27 | 2026-09-09 | exit 0. Table includes a `Denied` column (`1` on the failed job, `-` on the others). | `t5-live-status-list-md.txt` |
| `status` | `1cd3190f559c --json` | 1.1.27 | 2026-09-09 | exit 0, `status: "completed"` | `t5-live-status-single-json.txt` |
| `status` | `1cd3190f559c` | 1.1.27 | 2026-09-09 | exit 0, markdown job view | `t5-live-status-single-md.txt` |
| `result` | `1cd3190f559c --json` | 1.1.27 | 2026-09-09 | exit 0, `status: "completed"`, answer `BG`. stderr `usage: total=14186 in=14117 out=69` | `t5-live-result-json.txt` |
| `status` | `--json` | 1.1.27 | 2026-09-09 | exit 0, `status: "ok"` (second list snapshot) | `t5-live-status-list-json-2.txt` |
| `status` | `fbbab048795d --json` | 1.1.27 | 2026-09-09 | exit 0, `status: "failed"`. `details.job.deniedActions`: `action` `read_url`, `displayName` `ReadUrlContent`, `remedy` `Headless runs cannot grant "read_url"; the host must run this step itself.` `deniedActionsCount` `1` | `t5-live-status-denied-json.txt` |
| `status` | `fbbab048795d` | 1.1.27 | 2026-09-09 | exit 0. `## Denied Actions` line: `- **read_url (ReadUrlContent)**: Headless runs cannot grant "read_url"; the host must run this step itself.` | `t5-live-status-denied-md.txt` |
| `result` | `fbbab048795d --json` | 1.1.27 | 2026-09-09 | exit 1, `status: "failed"`. `details.deniedActions`: `action` `read_url`, `displayName` `ReadUrlContent`, `remedy` `Headless runs cannot grant "read_url"; the host must run this step itself.` stderr `usage: total=14342 in=14131 out=211` | `t5-live-result-denied-json.txt` |
| `vision` | `<png> --prompt "Reply with the single word PROBE and the color you see."` | 1.1.27 | 2026-09-09 | exit 0. stderr `usage: total=33567 in=30598 out=2969` | `t5-live-vision.txt` |
| `review` | `--json` | 1.1.27 | 2026-09-09 | exit 0, `status: "no_changes"`, `jobId` `null` | `t5-live-review.txt` |
| `task` | `--json` (long prompt, for cancel) | 1.1.27 | 2026-09-09 | exit 0, `status: "queued"`, job `0ad4b1632d38` | `t5-live-task-cancel-start.txt` |
| `cancel` | `0ad4b1632d38 --json` | 1.1.27 | 2026-09-09 | exit 0, `status: "cancelled"` | `t5-live-cancel.txt` |
| `status` | `0ad4b1632d38 --json` | 1.1.27 | 2026-09-09 | exit 0, `status: "cancelled"` | `t5-live-status-cancelled-json.txt` |
| `task` | `--foreground --json` | 1.2.1 | 2026-09-11 | exit 1 during a real `503 UNAVAILABLE` outage. The plugin used agy's `error:` line as the job's `errorMessage`. | `t5a-task-foreground-json.txt`, `t5a-fatal-error-job-record.txt` |
| `task` | `--foreground --json`, prompt `/model` then `Reply with exactly OK.` | 1.2.1 | 2026-09-11 | exit 0, `status: "completed"`, answer `OK`. Slash text was inert. | `t5a-task-slash-inert.txt` |
| `task` | `--foreground --json`, no `--effort` | 1.2.1 | 2026-09-11 | exit 0, `status: "completed"`, answer `DEFAULT`. The job stored `request.effort: "medium"`. | `t5a-task-default-effort.txt`, `t5a-effort-job-records.txt` |
| `task` | `--foreground --effort low --json` | 1.2.1 | 2026-09-11 | exit 0, `status: "completed"`, answer `LOW`. The job stored `request.effort: "low"`. | `t5a-task-effort-low.txt`, `t5a-effort-job-records.txt` |
| `rescue` | `--json` | 1.2.1 | 2026-09-11 | exit 0, `status: "completed"`, answer `RESCUE` | `t5a-rescue-json.txt` |
| `review` | `--json`, one staged line in a scratch repository | 1.2.1 | 2026-09-11 | exit 0, `status: "completed"`, verdict `APPROVE` | `t5a-review-json.txt` |
| `task` | `--foreground --json`, URL-read prompt | 1.2.1 | 2026-09-11 | exit 1. The printed denial dropped agy's bypass advice and named `read_url` (`ReadUrlContent`) for target `example.com`. The stored result kept the complete upstream line. | `t5a-task-denied-url.txt`, `t5a-denied-job-record.txt` |
| `task`, `status`, `result`, `cancel` | background lifecycle, JSON and Markdown status, JSON result, then cancellation | 1.2.1 | 2026-09-11 | exit 0 throughout. The first job moved from `queued` to `completed`; the second job became `cancelled`. | `t5a-background-lifecycle.txt` |
| `vision` | `<png> --json` | 1.2.1 | 2026-09-11 | exit 0, `status: "completed"`, model `gemini-3.6-flash-high`. stderr carried a usage trailer. | `t5a-vision-json.txt` |

The denied member from agy 1.1.27 was `read_url` (`displayName`
`ReadUrlContent`). The printed remedy line was `Headless runs cannot grant
"read_url"; the host must run this step itself.` The agy 1.2.1 run reported
the same member and also carried `target: "example.com"`. The target came from
the denied tool's `step_update` error message and was joined to the member by
its `read_url` action name.

agy 1.1.24 changes how an MCP image result reaches the model. agy writes a
large result to a file in the conversation directory and gives the model the
note `[Resource offloaded to file://<X>]` in place of the pixels. The vision
prompt answers this: it tells the model to open exactly that path with agy's
`view_file` tool. Measured on 2026-09-02, a 6761-byte image was offloaded in
every run and a 790-byte image was offloaded in some runs, so there is no
size limit you can depend on.

agy is a real host for discovery and lifecycle: `agy plugin install <path-to-clone>`,
`list`, `validate`, `enable`, and `disable`. agy 1.1.15 and 1.1.17 have no
`plugin run` subcommand. After install, the eight verbs are reachable from an
interactive agy TUI as `/antigravity:<verb>` (command markdown converted to
skills) and from the standalone CLI. The TUI wrappers locate the copied runtime
in Node: `CLAUDE_PLUGIN_ROOT` when that is set and non-empty, otherwise
`<homedir>/.gemini/config/plugins/antigravity`. They do not shell-expand
`CLAUDE_PLUGIN_ROOT`. They then refuse a plugin root whose `plugin.json` is
missing, unreadable, or does not name this plugin: the wrapper prints one line
and exits 1 without running anything from that tree. If that invocation cannot
run or does not succeed, they
instruct the reading model to print the error and stop rather than perform the
task itself; `npx @southcarpet/antigravity-plugin <verb>` is the fallback that
always works. agy stores its own copy of the tree, so an upgrade takes effect
in the TUI only after `agy plugin install <path-to-clone>` is re-run. Host
installers and host-owned invocation wrappers can evolve independently. The
promise is that the four surfaces above reach the same eight runtime verbs and
accept the documented arguments when the host can load this plugin.

## Public command surface

The public verbs are exactly:

`setup`, `review`, `rescue`, `task`, `vision`, `status`, `result`, and `cancel`.

Their positional arguments, flags, defaults, conflicts, and foreground versus
background behavior are defined in [COMMANDS.md](./COMMANDS.md). Verb names,
documented flag names, documented positional meanings, and documented defaults
are stable through 2.x subject to the deprecation and emergency rules below.

The standalone dispatcher's `help`, `-h`/`--help`, and `-v`/`--version` entry
points are also public. They are dispatcher conveniences, not ninth and tenth
runtime verbs. Per-command help interception is guaranteed only through the
standalone dispatcher. `update` (from 1.1.0) is a third convenience in the
same carve-out: it is reachable only through the standalone dispatcher
(`antigravity-plugin update`, `npx @southcarpet/antigravity-plugin update`,
`node bin/antigravity.mjs update`), no host wrapper exposes it, it changes an
installed copy only with `--apply`, and its `--json` output uses the envelope
shape but is a convenience whose fields and `command` value are unstable in
2.x. `status` may print one advisory line on stderr when a cached `update`
check knows a newer version; `status` itself never calls the network.

The following are not promised command surface:

- unknown flags (they return exit 1 with one stderr line; the exact prose is not promised);
- extra positional arguments on commands that do not document them;
- direct imports from `scripts/`, including function signatures and exports;
- internal worker entry points such as `scripts/commands/_worker.mjs`;
- exact help, Markdown, diagnostic, progress, or error prose.

## Exit status

There is no single semantic meaning for every nonzero value. The implementation
has command-specific meanings, and this contract preserves that reality.

| Exit status | Current contract |
|---|---|
| `0` | The command itself succeeded. For a background launch, this means the job was queued, not that agy completed it. `status --wait` also returns 0 after its timeout and when the observed job ended failed or cancelled, because status retrieval itself succeeded. |
| `1` | General validation, authentication, execution, state, configuration, import, or persistence failure. `result` uses 1 for a failed, active, missing, or unreadable job. `cancel` uses 1 when it cannot establish and persist cancellation. |
| `2` | A cancelled agy outcome from `review`, `rescue`, `task`, or `vision`, and a cancelled stored job from `result`. The standalone dispatcher also uses 2 for an unknown command/help target or invalid command module, and `setup` uses 2 when its agy probe cannot find or run agy. It is therefore not a global “cancelled” code. |
| `127` | Standalone-dispatcher preflight only: `AGY_BIN` was explicitly set to a path that does not exist for a verb that needs agy. |
| other nonzero | `setup` passes through the exit status of its interactive agy OAuth probe. No meaning beyond “setup failed” is promised for that upstream value. |

Argument parsing failures, such as a missing value for a documented value
flag or a documented conflicting pair, return 1. Exceptions caught by the
standalone dispatcher return 1.

No stronger exit-code taxonomy is implied. In particular, callers must not
interpret every 2 as cancellation. See [COMMANDS.md](./COMMANDS.md) for the
per-verb details.

## Output contract

### Standard output and standard error

Final user-facing results go to stdout. Without `--json`, the output is text
or Markdown. Setup progress and the interactive agy probe also use stdout;
the probe inherits the terminal streams.

Diagnostics, validation errors, authentication guidance, upstream stderr,
and readable live model progress from foreground `review`, `rescue`, `task`,
and `vision` runs go to stderr. `--json` does not silence stderr. Consumers
that parse stdout should capture the streams separately.

The exact wording and Markdown layout are not stable. The stdout/stderr split
described above, the machine-readable usage line, and the vision sentinel are
stable.

### `--json`

`--json` is public on every verb except `setup`. It is a contract for a stable
outer envelope, not a promise that model answers are structured. When a command
reaches a normal output path with `--json`, its entire stdout stream is exactly
one pretty-printed JSON object followed by a newline. The object has these
fields in envelope version 1:

| Field | 2.x contract |
|---|---|
| `schemaVersion` | The integer `1`. An incompatible envelope change requires a new value. |
| `command` | One of `review`, `rescue`, `task`, `vision`, `status`, `result`, or `cancel`, matching the invoked verb. |
| `status` | A string describing the represented outcome or state. Foreground delegated success is `completed`; a successful background dispatch is `queued`; an empty review is `no_changes`. `status` and `result` expose the represented job's stored status when they address one job. A status list uses `ok`. Cancellation paths that emit output use `cancelled`, `cancel_failed`, or `state_busy`. |
| `jobId` | The tracked job id as a string when the output represents one job, otherwise `null`. Successful background dispatch always supplies it. Foreground `review`, `rescue`, `task`, and `vision` also supply their tracked job id. |
| `answer` | Opaque human-facing/model-generated text as a string when the command returns an answer, otherwise `null`. Its prose, Markdown, field-like conventions, and all other internal structure are explicitly unstable. Consumers may display or store it but must not parse it as a review/result schema. |
| `details` | An object containing command-specific metadata. Its field set and nested shapes are explicitly unstable in 2.x; consumers must tolerate additions, removals, and changes within it. |

Consumers must tolerate additive top-level fields. `vision` additionally
promises top-level `model` (string) and `imagePaths` (an array of absolute path
strings), because these are resolved invocation inputs rather than model
output. No other command-specific top-level field is promised.

When `--wait` is combined with a background dispatch, `review`, `rescue`, and
`task` deliberately retain the dispatch envelope with `status: "queued"` and
its `jobId`, then report the final outcome by exit status. In particular,
background-default `task --wait --json` never appends completed model text to
stdout; callers fetch that text with `result <jobId> --json`. Likewise,
`review --json` with no reviewable content (empty tracked diff and no
untracked snippets) emits an envelope with `status: "no_changes"`,
`jobId: null`, and `answer: null`. These make both previously exceptional
stdout streams valid single JSON documents.

Errors that occur before a normal output path still produce diagnostics on
stderr and no stdout body. `--json` is not a JSON error-envelope guarantee.
Therefore the precise stream promise is: if `--json` writes any stdout, that
stdout is exactly one version-1 envelope and contains no text before or after
it.

### Usage trailer

On a successful `vision`, and when `result` reads a stored result with measured
usage, the command writes this exact newline-terminated trailer to stderr:

```text
usage: total=<N> in=<N> out=<N>
```

`N` is the value reported by agy. `total` must be numeric for the line to be
emitted; a missing input or output count is rendered as `?`. The plugin does
not estimate missing usage and does not emit the line when measured total usage
is absent. The trailer remains on stderr in JSON mode.

### Vision-unavailable sentinel

The vision prompt requires agy to emit exactly this single line when the MCP
tool cannot deliver actual image content:

```text
VISION-UNAVAILABLE: <reason>
```

The plugin passes the line through verbatim on stdout (or inside the current
JSON vision field) and returns 0 when agy otherwise reported success. The
prefix and one-line form are stable machine-readable signals. The reason text
is not stable, and the sentinel is not a distinct exit status.

`agy --print` cannot prompt for a tool permission. Since agy 1.1.20 a tool
it cannot prompt for is auto-denied and the run still reports success. The
plugin treats a SUCCESS result with an empty or whitespace-only answer as
`failed` (exit 1 on the foreground path) when any of these hold: the stderr
denial sentinel, agy's JSON `denied_actions` list, agy's print-timeout
marker, or none of those (an unexplained empty answer). A SUCCESS result
with a non-empty answer stays `completed` (exit 0 on the foreground path).
A denial in that case is a warning on stderr and in `details.warnings`. The
structured fields below name the denied action and target. They do not
replace this rule.

Since agy 1.1.27, a denied run's JSON result also carries a structured
`denied_actions` list (`[{ "action": "read_url", "display_name":
"ReadUrlContent" }]`, measured on 1.1.27), in addition to the stderr
sentinel agy has always printed. The plugin parses that list (skipping a
malformed member, deduplicating exact repeats, capping at 32 members and 200
characters per string, stripping control characters), merges it with the
stderr sentinel (the JSON list wins when present; the sentinel supplies one
entry only when an older agy has no `denied_actions` field at all), and
surfaces the merged `deniedActions` list, each with a computed remedy, on
every output path:

- `--json`: `details.deniedActions` (an array of `{ action, displayName,
  target, remedy }`) on a completed foreground envelope and on `result <id>
  --json`; `details.job.deniedActions` on `status <id> --json`; a per-job
  `deniedActionsCount` on every job entry in `status --json`'s job lists.
- Markdown: one line per denied action with its remedy, in the single-job
  `status <id>` view, in the foreground failure/warning text, and appended
  to `result` when the stored result carries denials; the `status` job
  tables gain a trailing `Denied` column (a count, or `-`).

**Target (additive, plan 086 T3).** agy's `result.denied_actions` names only
the action; what was actually refused arrives separately, in a `step_update`
event whose `tool_info.error.message` begins `permission check failed for
<action> "<target>":` (measured on agy 1.2.1). The plugin extracts that
target and joins it onto the matching `denied_actions` member **by the
action name parsed out of that message, never by the step's `tool_name`**
(agy's own tool name and action differ: `read_url_content` vs `read_url`,
`run_command` vs `command`). `target` is `null` on a member no `step_update`
matched, and on every member sourced from the stderr sentinel alone (older
agy). The target is model-chosen tool-parameter text, so every output path
above (`--json`'s `target` field, the markdown line, and the stderr hint)
shows it sanitized and capped the same way `action`/`displayName` are, and
never assembles it into a `permissions.allow` line or a wildcard — a rule a
user would add is described in prose, never handed over ready to paste.

The remedy is table-driven by action, not derived from the action's name:
a read-type action (`read_file` and similar) names `--add-dir <dir>`; an
edit-type action (`write_to_file` and similar) names `--mode accept-edits`;
everything else (`read_url`, command execution, MCP tools) states plainly
that headless mode cannot grant that action and the host must run the step
itself. `vision` always gets its own fixed hint (`view_image`, never
`--add-dir`) regardless of which action was denied. No remedy ever suggests
`--dangerously-skip-permissions` or implies a retry. A job record from
before this field existed has no `deniedActions` at all — absent, not an
empty array — and stays a valid, readable record.

**The plugin no longer relays agy's own bypass advice (plan 086 T3 item 4).**
agy's headless-denial sentinel ends with "Alternatively, re-run with
`--dangerously-skip-permissions` to auto-approve all tools." Printing that
sentence on the plugin's own stderr would repeat advice `SECURITY.md`
disclaims, so the console echo of a failed run's stderr drops just that
sentence. The stored result and `result --json` still keep the complete
upstream line unmodified.

The way to give a headless `rescue` or `task` run read access to files is
`--add-dir <dir>` on the invocation. It is not an allow rule in
`~/.gemini/antigravity-cli/settings.json`: on agy 1.1.24 twelve
`read_file(<path>)` rule forms (absolute with and without drive, relative,
trailing slash, `*`, `**`, `/A:/...`, `/a/...`) were all denied headless even
though the rule was confirmed loaded; only `read_file(*)` matched, and a
wildcard is not something this plugin writes. With no rule at all
(probed 2026-09-02):

| Probe | Invocation | Result |
|---|---|---|
| P3 | `--add-dir A:\projects-vault`, read inside | granted |
| P2 | `--add-dir <evidence dir>`, read inside | granted |
| B2 | `--add-dir <evidence dir>`, read `STATE.md` outside it | denied |
| B3 | `--add-dir <evidence dir>`, write inside it | denied, no file created |

So the grant is bounded to the named directory, read-only, and lasts for
that run only; nothing is persisted in the user's settings. `setup` has no
flag for this on purpose: a persistent rule is either too narrow to work or a
wildcard. `--add-dir` is forwarded verbatim and in order on `rescue` and
`task`, foreground and background. `vision` does not take it; its images
travel through the MCP tool with a per-run allowlist.

## Print timeout and fatal-error reporting

agy >= 1.1.28 changed two headless behaviours. The fatal-error path was
measured on the installed agy 1.2.1 through the plugin's own stream-json
transport (plan 086 T1). The print-timeout behaviour was measured directly
against agy 1.2.1 in `t0d-stream-json-print-timeout.txt`, not end to end
through the plugin. An end-to-end run would have to run longer than agy's
five-minute default because the plugin provides no way to select a shorter
print timeout. The two behaviours are:

- **Print-timeout truncation.** When agy's own `--print-timeout` deadline
  expires while a turn is still in progress, the run exits 0 and writes
  exactly one stderr line: `[agy] print timeout after <duration> with turn
  in progress; returning partial output`. Before 1.1.28 this path failed
  outright; now a truncated answer is indistinguishable from a complete one
  for a caller that reads only the exit code and the response. The plugin
  detects this marker (matching only the stable parts — `[agy] print
  timeout` and `returning partial output` on the same line, not the full
  sentence, since agy may reword the middle) and reports it as
  `agyPrintTimeout: { limit: '<duration>' | null }`:
  - `--json`: `details.agyPrintTimeout` on a completed foreground envelope
    of `review`, `rescue`, `task`, `vision` and on `result <id> --json`;
    `details.job.agyPrintTimeout` on `status <id> --json`; the same field on
    every job entry in `status --json`'s job lists. This is a distinct key
    from `details.truncated` (the pre-existing `--head`/`--tail` display
    cut, a boolean, section "`result`" in `docs/COMMANDS.md`) — the two
    never collide.
  - Markdown: one "Note:" line in the single-job `status <id>` view and in
    `result` naming the expired print timeout; the `status` job tables gain
    a trailing `Partial` column (`partial`, or `-`).
  - stderr: one warning line on the foreground path, next to the existing
    warning and denied-action lines.
  - The plugin's own execution budget still fires before agy's own ceiling
    in the normal case (`--print-timeout` is forwarded as the budget plus 60
    seconds of headroom), so this path is rare but reachable when the
    plugin's own termination unwind overruns that headroom, or on a
    `timeoutMs: 0` ("no deadline") job.
  - The fail-vs-complete decision is unchanged when the run answered: a
    non-empty response with the marker present stays `completed` — a
    partial answer is still an answer. An **empty** response with the
    marker present is reclassified `failed`, the same treatment a headless
    denial that starved the answer already gets (see above); stderr gains
    an `agent-runtime:` line naming the expired timeout.
- **Fatal-error marker.** A fatal headless failure (for example an invalid
  `--model` value) now writes a stable `error: <reason>` line on stderr,
  measured verbatim: `error: invalid model selection (--model
  "no-such-model-xyz" --effort ""): model no-such-model-xyz is not
  recognized as a known model or custom model in settings`. When the run
  failed and stderr carries such a line, that line (trimmed, sanitized, and
  bounded) becomes the job's `errorMessage` instead of the raw stderr dump.
  A run that succeeded never gets an `errorMessage` from this path, and a
  plugin-authored termination reason (timeout, output-limit, cancellation)
  always wins over agy's own marker when both are present.

A job record from before this field existed has no `agyPrintTimeout` at all
— absent, not `null` — and stays a valid, readable record.

## Slash and skill command expansion in print mode

Every print-mode invocation (`review`, `rescue`, `task`, `vision`;
foreground, background, plain, `--continue`, and `--conversation`) forwards
agy's `--disable-slash-commands` flag. Without it, prompt text starting with
`/` — including untrusted diff, review, rescue, or task content this plugin
sends as a plain prompt — is parsed and executed as an agy slash command
instead of reaching the model as text (measured: `/model\n<rest>` sent as a
prompt was executed as the `/model` command and failed with `/model takes no
arguments, got "<rest>"`, exit 2, before this flag was added). This is a
print-mode parsing switch, not an OS sandbox: it stops slash/skill expansion
of the prompt this plugin sends, not what a tool agy itself later chooses to
run mid-conversation. The argv shape (quoted): `... --print-timeout <duration>
--disable-slash-commands --input-format stream-json --output-format
stream-json --print ""`.

## Environment variables

These variables have direct semantics in the shipped code:

| Variable | Contract |
|---|---|
| `AGY_BIN` | Optional exact path to the agy executable. It wins over binary discovery when the file exists. The standalone dispatcher returns 127 when an explicitly configured path is missing; direct command-module invocation can fall back to normal discovery. |
| `ANTIGRAVITY_AGY_TIMEOUT_MS` | Execution budget for foreground and background jobs, in milliseconds; defaults to 1800000 (30 minutes). A positive decimal safe integer up to 2147483647 overrides it; exactly `0` disables it. Invalid values are ignored with one stderr warning. Background jobs store the budget when queued and receive the full budget when the worker starts agy. |
| `PATH` / `Path` | Searched for `agy`; Windows accepts its conventional `Path` casing when `PATH` is absent. |
| `HOME` / `USERPROFILE` | Used, in that order, for the fallback `<home>/.local/bin/agy` search. Node's platform home directory also determines the `~/.gemini` paths used by vision setup. |
| `CLAUDE_PLUGIN_ROOT` | Supplied by Claude Code and used by the shipped slash-command wrappers to locate `scripts/commands/*.mjs`. When unset or empty, the wrappers resolve the plugin root in Node as `path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity')` — the tree `agy plugin install` copies to. That fallback is not a shell `${VAR:-fallback}` expansion. Since 1.1.1 the wrappers read `<root>/plugin.json` first and exit 1 with one line unless it names this plugin. |
| `CLAUDE_PLUGIN_DATA` | First-priority host state root; state lives below `<value>/state`. |
| `CODEX_PLUGIN_DATA` | Second-priority host state root; state lives below `<value>/state`, subject to the legacy fallback described below. |
| `AGY_PLUGIN_DATA` | Third-priority host state root; state lives below `<value>/state`, subject to the legacy fallback described below. |
| `ANTIGRAVITY_PLUGIN_SESSION_ID` | Associates new jobs with a host session and filters no-argument status/result selection to that session. If absent, jobs are not session-filtered. |
| `ANTIGRAVITY_VISION_ALLOWED_PATHS` | Internal per-process JSON array of absolute image paths. `vision` sets it for the MCP server. Missing or invalid data grants no image access. Users should not set it globally. |

`CLAUDE_ENV_FILE`, `CODEX_HOME`, `CODEX_SESSION_ID`, `AGY_HOME`, and
`AGY_SESSION_ID` are not used for state-root selection and do not override
the priority above.

`ANTIGRAVITY_SCRIPT_ROOT` redirects the standalone dispatcher to a different
command-module directory. That directory must contain this plugin's manifest
(`plugin.json` with `"name": "antigravity"`); otherwise the dispatcher exits 1
with one line before it imports anything. It exists for tests and is
explicitly not a public 2.x integration point.

All other inherited environment variables are passed to child processes in
the normal Node fashion but have no plugin-specific compatibility promise.

## Job state and configuration locations

The workspace is the Git repository root when one can be resolved, otherwise
the command's working directory. Each workspace gets a leaf named from a
sanitized directory basename plus a 12-character hash of the resolved
(realpath) path, since this version. A leaf written under the workspace's
logical, pre-resolution spelling by an older version keeps being used until
the resolved-path leaf exists, so an existing install's jobs do not become
invisible when the workspace is reached through a symlink or junction. A
background job's worker process receives the caller's exact workspace
spelling and reuses it, so a job started against a logical (symlinked)
spelling stays under the leaf it was created in rather than splitting across
two leaves. A caller that addresses the same workspace by a different
spelling while only the older leaf exists starts a new leaf there instead of
finding the existing one: use one spelling consistently, or move the leaf.

```text
<state-root>/<workspace-slug>-<path-hash>/
  state.json
  state.json.corrupt-<ISO-timestamp-with-colons-replaced-by-dashes>
  jobs/
    <job-id>.json
    <job-id>.log
```

The `state.json.corrupt-*` sibling is additive and appears only when
`state.json` cannot be read or parsed. The damaged index is renamed there and
kept while the plugin rebuilds `state.json` from valid `jobs/*.json` records;
the persistent state and job locations themselves do not move.

The state root is selected from the first non-empty variable in this exact
order:

1. `${CLAUDE_PLUGIN_DATA}/state`
2. `${CODEX_PLUGIN_DATA}/state`
3. `${AGY_PLUGIN_DATA}/state`
4. `${os.tmpdir()}/antigravity`

For Codex and agy, if the preferred workspace leaf does not exist but the
legacy `${os.tmpdir()}/antigravity/<workspace-leaf>` does, the implementation
continues using that legacy leaf. This prevents an upgrade from making
existing jobs disappear. New workspaces use the host-owned root. Transient
workspace lock directories live under
`${os.tmpdir()}/antigravity-state-locks`.

If a 2.x release moves or changes persistent state, it must preserve access to
existing jobs, including jobs written by 1.x, through automatic migration or a
compatibility read path.
It must not silently orphan existing state. A manual migration may be required
only when automatic migration cannot be made safe, and must be documented in
the release notes before the new location becomes the default.

### Vision configuration

Successful `setup` without `--skip-vision` updates these user-wide files:

- `~/.gemini/config/mcp_config.json`: `mcpServers.vision`, using the exact
  current Node executable and bundled `scripts/mcp/vision-server.mjs` path;
- `~/.gemini/antigravity-cli/settings.json`: the exact allow rule
  `mcp(vision/view_image)`;
- `~/.gemini/antigravity-plugin-vision.json`: an ownership receipt recording
  only entries the plugin added;
- `~/.gemini/antigravity-plugin-vision.lock`: a transient configuration lock.

Existing config files are read-modify-written, unrelated keys are preserved,
a foreign `mcpServers.vision` is not overwritten, and an existing file gets at
most one backup per day at `<file>.bak-YYYYMMDD` before modification.

`setup --remove-vision` does not require agy. It removes the vision MCP entry
when ownership can be established from the receipt or the supported legacy
plugin shape. It removes `mcp(vision/view_image)` only when the receipt says
the plugin added that rule; a recognized receipt-less legacy install instead
removes only its old wildcard rules. It then removes the ownership receipt.
Unrelated MCP servers, settings, permissions, same-day backups, OAuth
credentials, images, and job state are preserved. If the named MCP entry has
changed ownership or the JSON/config shape is unsafe, removal fails without
applying a partial configuration change.

## Additive surface added after 1.0.0

These shipped after 1.0.0 as additive changes (docs/COMMANDS.md has the full
flag/field detail); none changes an existing verb, flag, exit code, or field
meaning:

- `--model <id>` on `task` and `rescue`, forwarded to agy exactly as
  `vision`'s `--model` already was.
- `--effort <low|medium|high>` on `task` and `rescue`, forwarded to agy
  verbatim as `--effort <value>` right after `--model` (or in its place when
  there is no model); the plugin does not probe what agy does with the value
  beyond forwarding it. **Default changed in 2.0.0 (plan 086 T2):** when the
  caller passes no `--effort`, the plugin now sends `medium` (a run without
  `--effort` otherwise picks up whatever the machine has saved, so a
  delegated run was not reproducible across machines). `review` and `vision`
  have no `--effort` flag and never send one. `medium` runs longer than
  `low`, so a flag-less job is more likely to reach the agy execution
  budget (docs/COMMANDS.md, "Execution budgets and failure messages"); a
  run that reaches it stores a failed job with no answer. Pass `--effort
  low` explicitly, pass `--effort agy-default`, or raise
  `ANTIGRAVITY_AGY_TIMEOUT_MS`, to avoid this.
- `agy-default` (plan 086 T5i) as a fourth accepted `--effort` value on
  `task` and `rescue`: the plugin sends no `--effort` flag at all, so the
  user's own agy configuration decides, and the run is therefore not
  reproducible across machines. That is the same argv shape releases through
  1.3.0 had when `--effort` was absent. It is an opt-in value, not the
  default. `review` and `vision` still have no `--effort` flag. Stored
  `request.effort` keeps `"agy-default"` verbatim; the background worker's
  revalidation accepts it.
- **agy 1.2.1 vision MCP schema (plan 086 T2 D5):** `scripts/mcp/vision-server.mjs`'s
  `view_image` tool now declares `additionalProperties: false` on its input
  schema. agy 1.1.27 rejected an undeclared argument outright; agy 1.2.1
  "preserves open object schemas ... instead of rejecting undeclared
  arguments on schemas that allow them", so a schema with no
  `additionalProperties` (open by JSON Schema default) would let an invented
  argument reach the server again. `loadImageResult`'s own handling of the
  `path` argument is unchanged.
- `details.deniedActions` on a completed foreground `--json` envelope of
  `review`, `rescue`, `task`, `vision` and on `result <id> --json`. The field is an
  array of `{ action, displayName, target, remedy }` for headless denials
  reported by agy 1.1.27 `denied_actions` or by the stderr sentinel. The
  field is absent when nothing was denied. Section "Headless read access"
  has the detail. `docs/COMMANDS.md` `status` and `result` sections have the
  field shapes.
- `details.job.deniedActions` on `status <id> --json`. The single-job
  envelope wraps the job snapshot under `details.job`.
- `target` (plan 086 T3) on every `deniedActions` member above: the denied
  tool-parameter value agy named in a `step_update` error message, joined by
  action name, or `null` when unknown. Section "Headless read access" has
  the join rule and the sanitizing/display rules.
- `deniedActionsCount` on every job index entry (`status` job lists and
  `status --json`). The count is `0` when nothing was denied.
  `deniedActions` is stored on the job record and on the stored result.
  Records written by older versions have neither field and still render.
- Stored `request.effort` (string, one of `low|medium|high|agy-default`) on
  `task` and `rescue` job records: the caller's explicit `--effort` value, or
  `medium` since 2.0.0 when the caller passed none (plan 086 T2 default).
  `task`/`rescue` records written before 2.0.0 have no `request.effort`
  field; `review`/`vision` records never do. The background worker revalidates the
  stored value and fails the job before starting agy on an unknown one.
- Job state leaf keyed by the resolved (realpath) workspace path. The
  legacy logical-path leaf is still read while the realpath leaf does not
  exist. The background worker receives the caller's exact workspace
  spelling. Section "Job state and configuration locations" has the rule.
- Every print-mode `agy` invocation now carries `--print-timeout` derived
  from the execution budget and `--disable-slash-commands`. This is
  argv-internal (no new plugin flag). It is listed here because it changes
  what agy receives. Sections "Slash and skill command expansion in print
  mode" and the budget paragraph in `docs/COMMANDS.md` have the detail.
- `--head <n>` / `--tail <n>` on `result`, cutting the stored answer to the
  named number of lines from the start and/or end.
- `answerBytes` / `answerLines` on a finished job's index entry (`status`
  and `status --json`), and the `--json` `details.truncated` field on
  `result` when `--head`/`--tail` cut the answer.
- `agyPrintTimeout` (plan 086 T1): `{ limit: string | null }` on the job
  record and the stored result when agy's own print-timeout marker (agy >=
  1.1.28) was seen on stderr, else `null`/absent. `details.agyPrintTimeout`
  on a completed foreground `--json` envelope and on `result <id> --json`;
  `details.job.agyPrintTimeout` on `status <id> --json`; the same field on
  every job entry in `status --json`'s job lists. Distinct from the
  pre-existing `details.truncated` boolean on `result` (`--head`/`--tail`).
  Section "Print timeout and fatal-error reporting" has the detail. A run
  that failed with an empty answer and the marker present is reclassified
  `failed`, matching the treatment a starved headless denial already gets;
  a non-empty answer with the marker stays `completed`.
- `errorMessage` on a failed job now prefers agy's own stable `error:`
  fatal-marker line (agy >= 1.1.28) over the raw stderr dump, when one is
  present and no plugin-authored termination reason already explains the
  failure. Section "Print timeout and fatal-error reporting" has the
  detail. This does not add a field; it changes what a pre-existing
  free-text field's value is derived from.
- `agyConversationId` (plan 086 T5k F1): agy's own conversation id, distinct
  from the pre-existing `conversationId` field (the id the *caller* passed
  in via `--conversation`) — present whenever agy reported one, including on
  a failed or denied run, so a host can resume the conversation even when it
  passed none itself. On the job record and the stored result. `--json`:
  `details.job.agyConversationId` on `status <id> --json` and per job in
  `status --json`'s job lists; `details.agyConversationId` on `result <id>
  --json` (already carried, nested, as `details.result.agyConversationId`
  before this). A denied foreground run of `review`, `rescue`, or `task`
  also prints it on stderr beside the existing denial line, as the exact
  resume command: `antigravity:<verb> — resume with: /antigravity:<verb>
  --conversation <id>`. `vision` has no conversation concept and is
  excluded. `null`/absent on a legacy record or a run agy never reported an
  id for. `docs/COMMANDS.md`'s "Denied runs" and `status`/`result` sections
  have the detail.
- The interactive retry prompt (plan 086 T5k F2): on a foreground
  `review`/`rescue`/`task` invocation that ends denied, the runtime asks
  once, on the terminal itself, whether to retry the same conversation or
  stop — interactive-only, never triggered by an automated or `--json`
  invocation. It never offers to grant a permission and never writes a
  settings file. `docs/COMMANDS.md`'s "Denied runs" section has the exact
  conditions and the two-choice contract.

## Deprecation and compatibility changes

2.0.0 changed the documented default on `task` and `rescue`: with no
`--effort`, the plugin now sends `medium`. Through 1.3.0 it sent no flag.

A documented public 2.x surface will be marked deprecated in release notes
and documentation and retained through at least one subsequent 2.x minor
release. Ordinary removal or another backward-incompatible change then waits
for 3.0.0. Additive commands, flags, fields, and behavior may ship in a 2.x
minor release.

There are two exceptions:

- An urgent security or privacy fix may disable or remove unsafe behavior in a
  2.x patch without the normal deprecation period. The release notes must name
  the affected surface, risk, and replacement or mitigation.
- An upstream agy change that breaks agy's own interface may force an
  immediate transport, flag, output-parsing, or supported-version change.
  The plugin may make that smallest necessary change in a 2.x patch and must
  document the upstream break and resulting compatibility boundary.

Neither exception authorizes unrelated breaking changes. Explicitly unstable
surfaces may change in 2.x without deprecation, but the change must still be
called out when it affects observable output.
