# Antigravity plugin 3.x compatibility contract

This document defines the public contract for `antigravity-plugin` 3.0.0 and
later 3.x releases. The implementation at 0.2.4 is the baseline from which
the original contract was frozen. 2.0.0 was the baseline for 2.x. 3.0.0 is
the baseline for 3.x. It keeps the 2.x surface and changes one default: the
model that `vision` uses (see [Deprecation and compatibility
changes](#deprecation-and-compatibility-changes)). A behavior is public only
when this document or the [commands reference](./COMMANDS.md) says it is
promised.

Plugin 3.0.0 is this package's version number. agy 1.1.15 to 1.3.1 is the
tested range of Google's Antigravity CLI, with 1.3.1 as the newest measured
version. See the [per-version table](#supported-matrix). The two version lines advance
independently. A new agy release does not change the plugin version.

## Supported matrix

| Surface | Supported in 3.x |
|---|---|
| Hosts | Claude Code (`/antigravity:<verb>`), Codex CLI (`$antigravity <verb>`), agy-native (install/list/validate; interactive TUI `/antigravity:<verb>` via the copied command files; standalone CLI as the fallback that always works), and the standalone CLI (`npx @southcarpet/antigravity-plugin <verb>`, `antigravity-plugin <verb>` after install, or `node bin/antigravity.mjs <verb>`) |
| Operating systems | Linux, Windows, and macOS. All three run the full CI suite. Release-tree commit `4f9b317` was tested in CI run 34289858536 (created 2026-09-08 23:16:08): six cells green, CodeQL run 34289858532 green. `macos-latest` used runner image `macos-26-arm64` (Node 22.3.x and Node 24: 886 tests, 873 passed, 13 skipped, 0 failed). `windows-latest` used `windows-2025-vs2026` (886 tests, 881 passed, 5 skipped, 0 failed). `ubuntu-latest` used `ubuntu-24.04` (886 tests, 873 passed, 13 skipped, 0 failed). Other Node platforms remain best-effort. Live `agy` runs (see the verbs-exercised-live tables below) have not happened on macOS; that coverage stays best-effort until they do. The Windows cells build a compiled `csc.exe` stand-in for `agy` (test-only, see `tests/helpers/fake-agy.mjs`); `node --test` runs each test file as its own process, so before 2026-09-26 those processes could race to compile the same cached output file and fail with `CS0016` (seen on `windows-latest` in CI runs on 2026-09-12 and 2026-09-25). Each compile now targets a unique temp path and is promoted into the shared cache, so no two processes write the same file. |
| Node.js | `>=22.3.0` |
| Google Antigravity CLI | `agy` 1.1.15 to 1.3.1; newest measured 1.3.1. This range forms the tested and supported matrix. See the [per-version table](#supported-matrix) for live coverage. |

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
| 1.2.7 | `task`, `rescue`, `review`, `vision`, `status`, `result`, and `cancel` (`probe-task-foreground-json.txt`, `probe-rescue-json.txt`, `probe-review-json.txt`, `probe-vision-json.txt`, `probe-background-lifecycle.txt`). `setup` was not run live. | 2026-09-19 |
| 1.2.11 | `task`, `rescue`, `review`, `vision`, `status`, `result`, and `cancel` (`probe-task-foreground-json.txt`, `probe-rescue-json.txt`, `probe-review-json.txt`, `probe-vision-json.txt`, `probe-background-lifecycle.txt`). `setup` was not run live. | 2026-09-25 |
| 1.2.12 | `setup` with `--skip-vision`, `task` foreground and background, `status` list, `result`, and smoke-only measurement. `review`, `rescue`, `vision`, and `cancel` were not run live on 1.2.12. See the [structured output flag](#structured-output-flag) probe. | 2026-09-27 |
| 1.3.1 | Measured pass: `doctor`; `task` foreground, and background with `--wait`; `status` list and by job id; `result`; `cancel` of a running job; `review`, plain and with `--findings-json`; `setup --skip-vision`; `rescue` with a trivial prompt; `--add-dir`; `vision` with `gemini-3.8-flash-high` (5 of 5 runs, one with a path that holds a space, `#`, and `%`); `vision` with `gemini-3.6-flash-high` (3 of 5 runs); `agy plugin install`, `list`, `validate`, and `uninstall` in an isolated profile. Measured failure: `vision` with `gemini-3.6-flash-high` failed 2 of 5 runs with a 503 capacity error; `rescue` with a prompt that needs a shell command failed because agy headless mode denied the `command` tool (the plugin named the tool and gave the remedy); `cancel` of a job that had already finished returned `job_not_found`, exit 1; `setup --json` is not supported. Not measured: `setup` without `--skip-vision`, `setup --remove-vision`, `review --background`, `--show-result`, `--request-id`, `--prompt-file`, `--preview`, `--check-locations`, `--mode`, and resuming a conversation with `--continue` or `--conversation`. 1.2.13 to 1.3.0 were not run live. See the [agy 1.3.1 probes](#agy-131-probes) for the raw files. | 2026-10-08 |

The 1.1.15 and 1.1.17 runs included the usage trailer on `vision` and
`result`. The 1.1.24 runs covered foreground and background `rescue` and
`task`, `--add-dir`, and `--mode`. They also covered five `vision` runs, the
offloaded-copy fallback, a negative `vision` run, and `result` on a background
job. The runs also covered headless auto-denial detection and the
`--print-timeout` error shape. `review`, `status`, `cancel`, and `setup` use
the same runtime paths and pass the fake-agy suite. They were not run live on
1.1.24.

The newest version measured live is agy 1.3.1, on 2026-10-08. The 1.3.1 row
says, per verb, what passed, what failed, and what was not run. The agy
changelogs for 1.2.13 to 1.3.0 were read, not measured. The previous smoke-only measurement is agy 1.2.12, on
2026-09-27, from commit `9c21979` (`probe-setup.txt`, `probe-task-foreground-json.txt`,
`probe-background-lifecycle.txt`, `probe-status-list.txt`). The 1.2.12 row covers smoke-only measurement: `setup` with `--skip-vision`, `task` foreground and background, `status` list, `result`, and the structured output flag probe. The table also retains the saved
transcripts for earlier versions. The 1.2.11 rows cover `task`,
`rescue`, `review`, `vision`, `status`, `result`, and `cancel`
(`probe-task-foreground-json.txt`, `probe-rescue-json.txt`,
`probe-review-json.txt`, `probe-vision-json.txt`,
`probe-background-lifecycle.txt`). The table also retains the saved
transcripts for 1.1.27 and 1.2.1. `setup` has no transcript for these versions except 1.2.12.

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
| `task` | `--foreground --json` | 1.2.7 | 2026-09-19 | exit 0, `status: "completed"`, answer `PROBE` | `probe-task-foreground-json.txt` |
| `task` | `--foreground --json`, no `--effort` | 1.2.7 | 2026-09-19 | exit 0, `status: "completed"`, answer `DEFAULT` | `probe-task-effort-default.txt` |
| `task` | `--foreground --json --effort agy-default` | 1.2.7 | 2026-09-19 | exit 0, `status: "completed"`, answer `AGYDEFAULT` | `probe-task-effort-agy-default.txt` |
| `task` | `--foreground`, URL-read prompt | 1.2.7 | 2026-09-19 | exit 1. The denial named `read_url` (`ReadUrlContent`) for target `example.com` and the resume line carried agy's conversation id. | `probe-task-denied-url.txt` |
| `rescue` | `--json` | 1.2.7 | 2026-09-19 | exit 0, `status: "completed"`, answer `RESCUE` | `probe-rescue-json.txt` |
| `review` | `--json`, one staged line in a scratch repository | 1.2.7 | 2026-09-19 | exit 0, `status: "completed"`, verdict `APPROVE` | `probe-review-json.txt` |
| `task`, `status`, `result`, `cancel` | background lifecycle, JSON status and result, then cancellation of a second job | 1.2.7 | 2026-09-19 | exit 0 throughout. The first job moved from `queued` to `completed` and `result --json` returned answer `BG`; the second job was cancelled and `status --json` reported `cancelled`. | `probe-background-lifecycle.txt` |
| `vision` | `<png> --json` | 1.2.7 | 2026-09-19 | exit 0, `status: "completed"`, model `gemini-3.6-flash-high`. stderr carried a usage trailer. | `probe-vision-json.txt` |
| `task` | `--foreground --json` | 1.2.11 | 2026-09-25 | exit 0, `status: "completed"`, answer `PROBE` | `probe-task-foreground-json.txt` |
| `task` | `--foreground --json`, no `--effort` or `--model` | 1.2.11 | 2026-09-25 | exit 0, `status: "completed"`, answer `DEFAULT` | `probe-task-effort-default.txt` |
| `task` | `--foreground --json --effort agy-default` | 1.2.11 | 2026-09-25 | exit 0, `status: "completed"`, answer `AGYDEFAULT` | `probe-task-effort-agy-default.txt` |
| `task` 2.0.1 | `--foreground --json --model gemini-3.1-pro-high`, no `--effort` | 1.2.11 | 2026-09-25 | exit 1. agy reported `--model gemini-3.1-pro-high conflicts with --effort=medium`. | `probe-task-pro-default-effort.txt` |
| `task` 2.0.2 | `--foreground --json --model gemini-3.1-pro-high`, no `--effort` | 1.2.11 | 2026-09-25 | exit 0, `status: "completed"`, answer `PRO.` | `probe-fixed-task-pro.txt` |
| `task` 2.0.1 | `--foreground --json --model claude-sonnet-4-6`, no `--effort` | 1.2.11 | 2026-09-25 | exit 1. agy reported `--effort is not supported for model "claude-sonnet-4-6"`. | `probe-task-claude-default-effort.txt` |
| `task` 2.0.2 | `--foreground --json --model claude-sonnet-4-6`, no `--effort` | 1.2.11 | 2026-09-25 | exit 0, `status: "completed"`, answer `CLAUDE.` | `probe-fixed-task-claude.txt` |
| `rescue` 2.0.2 | `--json --model gemini-3.1-pro-high`, no `--effort` | 1.2.11 | 2026-09-25 | exit 0, `status: "completed"`, answer `RESCUEPRO.` | `probe-fixed-rescue-pro.txt` |
| `task`, `status`, `result` 2.0.2 | background `--model gemini-3.1-pro-high`, no `--effort` | 1.2.11 | 2026-09-25 | Queue exit 0; the job completed and `result --json` returned answer `BGPRO`. | `probe-fixed-task-background-pro.txt` |
| `task` | `--foreground`, URL-read prompt | 1.2.11 | 2026-09-25 | exit 1. The denial named `read_url` (`ReadUrlContent`) for target `example.com` and the resume line carried agy's conversation id. | `probe-task-denied-url.txt` |
| `rescue` | `--json` | 1.2.11 | 2026-09-25 | exit 0, `status: "completed"`, answer `RESCUE` | `probe-rescue-json.txt` |
| `review` | `--json`, one staged line in a scratch repository | 1.2.11 | 2026-09-25 | exit 0, `status: "completed"`, verdict `APPROVE` | `probe-review-json.txt` |
| `task`, `status`, `result`, `cancel` | background lifecycle, JSON status and result, then cancellation of a second job | 1.2.11 | 2026-09-25 | exit 0 throughout. The first job moved from `queued` to `completed` and `result --json` returned answer `BG`; the second job was cancelled and `status --json` reported `cancelled`. | `probe-background-lifecycle.txt` |
| `vision` | `<png> --json` | 1.2.11 | 2026-09-25 | exit 0, `status: "completed"`, model `gemini-3.6-flash-high`. stderr carried a usage trailer. | `probe-vision-json.txt` |
| `doctor` | (none) | 1.3.1 | 2026-10-08 | exit 0, `doctor: 14 ok, 2 warnings, 0 problems`. agy 1.3.1 was classed `beyond_measured` because the plugin then knew 1.2.12 as the newest. | `probe-doctor.txt` |
| `task` | `--foreground --json` | 1.3.1 | 2026-10-08 | exit 0, `status: "completed"`, answer `OK`. stderr `usage: total=12514 in=12492 out=22` | `probe-task-foreground-json.txt` |
| `task`, `status` | `--background --wait`, then `status` list | 1.3.1 | 2026-10-08 | exit 0. The job completed with answer `BG`. The list also printed the advisory line that agy 1.3.1 was newer than the last measured version. | `probe-background-wait.txt`, `probe-status-list.txt` |
| `task`, `result` | `--background --wait --json`, then `result <id> --json` | 1.3.1 | 2026-10-08 | exit 0 and 0. The dispatch envelope said `queued`. `result` gave `status: "completed"`, answer `BG3`, and a usage block. stderr `usage: total=12474 in=12472 out=2` | `probe-A2-task-bg-wait.txt`, `probe-A2-result.txt` |
| `task`, `cancel`, `status` | background job, `cancel` after the job had finished (11 s), then `status` | 1.3.1 | 2026-10-08 | `cancel` exit 1, `job_not_found`, `No active antigravity jobs to cancel.` `status` gave `completed` with summary `BG2`. A cancel of a finished job is a failure by design. | `probe-A1-task-bg.txt`, `probe-A1-cancel.txt`, `probe-A1-status.txt` |
| `task`, `cancel`, `status` | background job with a long prompt, `cancel` at once, then `status` | 1.3.1 | 2026-10-08 | `cancel` exit 0, `status: "cancelled"`, `killed: true`. The soft `taskkill` failed (status 128) and the forced kill worked. `status` gave `cancelled`, `exitCode` null, no `errorMessage`. The agy process was gone 15 seconds later. | `probe-A1b-task-bg-long.txt`, `probe-A1b-cancel.txt`, `probe-A1b-status.txt`, `probe-A1b-status-after15s.txt` |
| `review` | `--json`, one staged line in a scratch repository | 1.3.1 | 2026-10-08 | exit 0, `status: "completed"`, verdict `CHANGES REQUESTED` with a critical finding at `calc.py:2`. No `details.findings` without the flag. stderr `usage: total=14054` | `probe-A3-review-json.txt` |
| `review` | `--json --findings-json`, one staged line | 1.3.1 | 2026-10-08 | exit 0, `status: "completed"`, `details.findingsStatus: "valid"` | `probe-review-findings-json.txt` |
| `setup` | `--skip-vision` | 1.3.1 | 2026-10-08 | exit 0. The output said it left the vision configuration untouched. A hash of the real `~/.gemini` tree showed no change in `config/`, `settings.json`, `mcp_config*`, or `plugins/`. | `probe-A4b-setup-skip-vision.txt`, `gemini-hash-diff.txt` |
| `setup` | `--skip-vision --json` | 1.3.1 | 2026-10-08 | exit 1, `unknown flag --json`. `setup` has no `--json` mode. | `probe-A4-setup-skip-vision-json.txt` |
| `task` | `--foreground --json --add-dir <dir under the OS temp tree>`, prompt to read a file in it | 1.3.1 | 2026-10-08 | exit 0, correct answer, `usage: total=25556`. The control without `--add-dir` also read the file, so a file under the OS temp tree needs no grant. | `probe-A5-task-add-dir.txt`, `probe-A5b-task-no-add-dir-control.txt` |
| `task` | `--foreground --json`, prompt to read a file on another drive, no `--add-dir` | 1.3.1 | 2026-10-08 | exit 1, `agy_denied`, `read_file` denied. The remedy named `--add-dir <dir>`. | `probe-A5c-read-outside-drive-no-add-dir.txt` |
| `task` | the same prompt with `--add-dir <dir on that drive>` | 1.3.1 | 2026-10-08 | exit 0, correct answer, `usage: total=22817` | `probe-A5d-read-outside-drive-with-add-dir.txt` |
| `rescue` | `--json`, prompt `Reply with exactly RESCUE` | 1.3.1 | 2026-10-08 | exit 0, `status: "completed"`, answer `RESCUE`, `usage: total=12516` | `probe-B1-rescue-trivial.txt` |
| `rescue` | `--json --add-dir .`, prompt `summarize this repository in one sentence` | 1.3.1 | 2026-10-08 | exit 1, `agy_denied`. agy tried the `command` tool (`Get-ChildItem -Path .`) and headless mode denied it. The remedy line was `Headless runs cannot grant "command"; the host must run this step itself.` The resume line was printed. Two earlier smoke runs, whose prompts needed `Get-ChildItem -Force` and `dir`, ended the same way. | `probe-B2-rescue-adddir-summary.txt`, `probe-rescue.txt`, `probe-rescue-2.txt` |
| `task` | `--foreground --json`, prompt to start a 2-second background shell command and report its output | 1.3.1 | 2026-10-08 | exit 1, `agy_denied` for the `command` tool. Raw agy gave exit 0, `status: "SUCCESS"`, an empty `response`, and `denied_actions` with `command`. An agy-internal background command cannot be measured in headless mode. | `probe-H1-internal-background-command.txt`, `raw-H2-internal-background-command.txt` |
| `status`, `result` | a failed `vision` job from the first 1.3.1 smoke run (plugin 2.1.0) | 1.3.1 | 2026-10-08 | `status <id> --json`: `failed`, `errorMessage` held the 503 text, no `details.error`. `result <id> --json`: exit 1, `job_failed` with the generic message `job 8e37ea061fe8 failed.`, the transcript in `answer`, the 503 text only in `result.stderr`. See [Failure reason](#failure-reason) for 3.0.0. | `probe-C1-status-8e37.txt`, `probe-C2-result-8e37.txt` |
| `vision` | `<png> --expect "AGY 131 OK" --json`, default model `gemini-3.6-flash-high` | 1.3.1 | 2026-10-08 | exit 1. The transcript appeared on stderr, then `failed (failed).` and a 503 `No capacity available for model gemini-3.6-flash-high`. `answer: null`, `error.code: "run_failed"`, no usage trailer. | `probe-vision-expect.txt` |
| `vision` | the same with `--model gemini-3.8-flash-high` | 1.3.1 | 2026-10-08 | exit 0, `status: "completed"`, `all_found`, `usage: total=61493 in=58871 out=2622` | `probe-vision-38-stdout.txt`, `probe-vision-38-stderr.txt` |
| `vision` | `<png> --expect "PLAN 118 OK" --json`, default model, three runs | 1.3.1 | 2026-10-08 | Two runs exit 0, `all_found`, 39,418 and 52,066 total tokens, 63 and 64 seconds. One run exit 1, the same 503 shape (84 seconds). | `probe-E-1-default.txt`, `probe-E-3-default.txt`, `probe-E-5-default.txt` |
| `vision` | the same with `--model gemini-3.8-flash-high`, three runs | 1.3.1 | 2026-10-08 | Three runs exit 0, `all_found`, 60,765, 60,640 and 72,416 total tokens, 51, 37 and 34 seconds. | `probe-E-2-38.txt`, `probe-E-4-38.txt`, `probe-E-6-38.txt` |
| `vision` | an image in a directory named `agy118 sp#ace%20 dir`, both models | 1.3.1 | 2026-10-08 | Both exit 0, `all_found`. Default model: 40,110 total tokens, 45 seconds. `gemini-3.8-flash-high`: 57,637 total tokens, 27 seconds. | `probe-G2-vision-special-path-default.txt`, `probe-G2-vision-special-path-38.txt` |
| `task` | `--effort xhigh` | 1.3.1 | 2026-10-08 | exit 1. The plugin refused the value: `invalid value for --effort: "xhigh" (expected low\|medium\|high\|agy-default)`. | `probe-effort-xhigh.txt` |

Raw agy 1.2.11 probes retained the denied-step shape, `denied_actions`, and
stderr sentinel (`raw-denied-read-url-step.txt`). A headless `ask_question`
still appears as `step_type: "unknown"` (`raw-ask-question.txt`). A 4-second
print timeout emits the print-timeout marker, while `--print-timeout 0` waits
without a limit (`raw-print-timeout-short.txt`, `raw-print-timeout-zero.txt`).
A bad model or effort still emits an `error:` marker, and on agy 1.2.11 the
bad-effort message listed `valid: low, medium, high, max`
(`raw-fatal-bad-model.txt`, `raw-fatal-bad-effort.txt`). On agy 1.3.1 it reads
`invalid --effort "bogus" (valid: low, medium, high, xhigh, max)`
(`probe-D5-effort-bogus.txt`). The list now names `xhigh`, but no model
accepts it. The plugin keeps `low|medium|high|agy-default` for this reason
(see [Effort levels on agy 1.3.1](#effort-levels-on-agy-131)).

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

agy is a real host for discovery and lifecycle: `agy plugin install <path>`,
`list`, `validate`, `enable`, and `disable`. agy 1.1.15 and 1.1.17 have no
`plugin run` subcommand. After install, the nine verbs are reachable from an
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
in the TUI only after `agy plugin install <path>` is re-run. Host
installers and host-owned invocation wrappers can evolve independently. The
promise is that the four surfaces above reach the same nine runtime verbs and
accept the documented arguments when the host can load this plugin.

`agy plugin install <path>` copies the directory it is pointed at; it does not
read `package.json` `files`. `scripts/pack-for-agy.mjs` packs this checkout
the same way `npm publish` would, extracts that tarball into a temporary
directory, and prints the exact `agy plugin install <dir>` command for it, so
the installed copy holds the same files an npm install would hold, not the
whole working tree. A hash-guarded isolated run (fresh `HOME`/`USERPROFILE`/
`APPDATA`/`LOCALAPPDATA`, real `~/.gemini` hashed before and after every step)
confirmed on 2026-09-27 that `agy plugin install`, `plugin list`,
`plugin validate`, and `plugin uninstall` against that packed copy never
touched the real `~/.gemini` store on agy 1.2.12: verified, transcript
`probe-plugin-install-pack.txt`.

### agy 1.3.1 probes

The 1.3.1 probes ran from plugin 2.1.0 code, in scratch repositories and
scratch directories. The transcript table above lists the raw files. A hash of
the real `~/.gemini` tree before and after the whole set showed no change in
`config/`, `settings.json`, `mcp_config*`, or `plugins/`. Only agy's own
runtime data changed (`gemini-hash-diff.txt`).

**Plugin install in an isolated profile.** The profile had fresh `HOME`,
`USERPROFILE`, `APPDATA`, and `LOCALAPPDATA` values. In it, `agy plugin
install` of the packed copy, `plugin list`, `plugin validate`, and `plugin
uninstall` all exited 0 (`probe-F1-plugin-list-before.txt` to
`probe-F12-plugin-list-after-uninstall.txt`). A digest of the real `config/`
tree was the same before and after. The install skipped `mcpServers`, because
the packed copy has no server entry and `setup` registers the vision server.
An isolated `agy --print` ran without a new sign-in
(`probe-F8-isolated-agy-print-oauth.txt`), so the sign-in is not tied to the
profile directories.

**Reinstall and uninstall while the vision server runs.** The agy 1.3.1
changelog says that a plugin install on Windows stops and restarts a running
MCP server. In the probe, an isolated agy session started `vision-server.mjs`.
`agy plugin install` over the installed copy exited 0 in 0.7 seconds. `agy
plugin uninstall` then exited 0 and removed the plugin directory while the
server still ran. The server process id was the same before the reinstall,
after it, and after the uninstall (`probe-F9-reinstall-while-server-runs.txt`,
`probe-F10-reinstall-while-server-runs-pid-sampling.txt`,
`probe-F11-uninstall-while-server-runs.txt`). The restart that the changelog
describes was not observed. The probe did not run the install from inside the
same session, so it does not rule the restart out.

**Project rules and context files.** Rules in a parent directory can change an
answer. A rule file in `.agents/rules/` loads only when it carries the line
`trigger: always_on` in its frontmatter (this is from agy's built-in rules
documentation, not from a probe). The first probes used rule files without
that line, and no rule showed in the answers (`probe-G1-nested-agents-rules.txt`
to `probe-G1c-nested-rules-sayword.txt`). With the line, a rule in a parent
`.agents/rules/` directory and a parent `AGENTS.md` reached a run whose
working directory was a child directory. The prompt `Reply with exactly CTX`
then returned `CTX` plus the rule words, and a prompt to list the rules in
context listed both parent rules (`probe-G1d-nested-rules-frontmatter-hello.txt`,
`probe-G1e-nested-rules-frontmatter-ctx.txt`,
`probe-G1f-nested-rules-introspect.txt`). A run from the parent directory
loaded the same two (`probe-G1g-outer-cwd-hello.txt`). A rule in the child's
own `.agents/rules/` directory did not load, and the cause is not known. The
plugin does not read, write, or filter these files. A run of `rescue`, `task`,
or `review` can answer differently in a tree that has them.

**Conversation pruning.** After 27 new conversations, agy 1.3.1 had removed
the files of the 27 oldest ones, and the count of conversation databases was
501 before and after (`gemini-hash-diff.txt`). This looks like a cap near 500
conversations. The cap is not proven. Observed effect: an old `--conversation
<id>` can fail to resume, and the plugin is not at fault.

**Failed `vision` job.** The first 1.3.1 smoke run produced a failed job whose
503 reason did not reach `status --json` or `result --json` in plugin 2.1.0
(`probe-C1-status-8e37.txt`, `probe-C2-result-8e37.txt`). Version 3.0.0 reports
it; see [Failure reason](#failure-reason).

### Effort levels on agy 1.3.1

`agy --help` on 1.3.1 lists `xhigh` as an `--effort` value, and the error for a
bad value reads `invalid --effort "bogus" (valid: low, medium, high, xhigh,
max)` (`probe-D5-effort-bogus.txt`). Every model refused `xhigh` and `max`.
The error names the levels the model has:

- No `--model` (agy then used `gemini-3.8-flash`): `gemini-3.8-flash has no
  "xhigh" effort (available: low, medium, high)` (`probe-D1-xhigh-default-model.txt`).
- `--model gemini-3.8-flash` (`probe-D2-xhigh-gemini-base.txt`) and `--model
  claude-opus-5-5` (`probe-D3-xhigh-claude-base.txt`) gave the same kind of
  error.
- `--model gemini-3.8-flash-high --effort xhigh` gave a different error: `--model
  gemini-3.8-flash-high conflicts with --effort=xhigh`
  (`probe-D4-xhigh-conflict-high-variant.txt`). A variant id carries its own
  level, so this is a conflict and not proof about support.
- A run over seven base model ids with `xhigh` and `max` gave an error for
  each (`probe-D6-effort-matrix-extra.txt`). `gemini-3.1-pro` has only `low`
  and `high`. `gpt-oss-120b` has only `medium`.

The plugin therefore keeps `low|medium|high|agy-default`. It would add a level
that every model refuses. The plugin itself refuses `--effort xhigh` before it
starts agy (`probe-effort-xhigh.txt`). If a later agy version accepts `xhigh`
for a model, the plugin can add it after a probe shows it.

## Public command surface

The public verbs are exactly:

`setup`, `review`, `rescue`, `task`, `vision`, `status`, `result`, `cancel`,
and `doctor`.

Their positional arguments, flags, defaults, conflicts, and foreground versus
background behavior are defined in [COMMANDS.md](./COMMANDS.md). Verb names,
documented flag names, documented positional meanings, and documented defaults
are stable through 3.x subject to the deprecation and emergency rules below.

The standalone dispatcher's `help`, `-h`/`--help`, and `-v`/`--version` entry
points are also public. They are dispatcher conveniences, not tenth and
eleventh runtime verbs. Per-command help interception is guaranteed only through the
standalone dispatcher. `update` (from 1.1.0) is a third convenience in the
same carve-out: it is reachable only through the standalone dispatcher
(`antigravity-plugin update`, `npx @southcarpet/antigravity-plugin update`,
`node bin/antigravity.mjs update`), no host wrapper exposes it, it changes an
installed copy only with `--apply`, and its `--json` output uses the envelope
shape but is a convenience whose fields and `command` value are unstable in
3.x. `status` may print one advisory line on stderr when a cached `update`
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
| `0` | The command itself succeeded. For a background launch, this means the job was queued, not that agy completed it; with `--request-id`, it can also mean that an existing job was found for the same request. `status --wait` also returns 0 after its timeout and when the observed job ended failed or cancelled, because status retrieval itself succeeded (unless `--exit-status` is given; see the `3` row). |
| `1` | General validation, authentication, execution, state, configuration, import, or persistence failure. `result` uses 1 for a failed, active, missing, or unreadable job. `cancel` uses 1 when it cannot establish and persist cancellation. `status --exit-status` uses 1 for a `failed` waited job. |
| `2` | A cancelled agy outcome from `review`, `rescue`, `task`, or `vision`, and a cancelled stored job from `result`. The standalone dispatcher also uses 2 for an unknown command/help target or invalid command module, and `setup` uses 2 when its agy probe cannot find or run agy. `status --exit-status` uses 2 for a `cancelled` waited job. It is therefore not a global “cancelled” code. |
| `3` | `status <id> --wait --exit-status` only (added 2026-09): the wait's own deadline passed while the job was still `queued`/`running`. No other command uses this value. |
| `127` | Standalone-dispatcher preflight only: `AGY_BIN` was explicitly set to a path that does not exist for a verb that needs agy. |
| other nonzero | `setup` passes through the exit status of its interactive agy OAuth probe. No meaning beyond “setup failed” is promised for that upstream value. |

For a failed foreground run, agy's own nonzero exit status is stored on the
job as `exitCode`, never propagated; the verb exits 1. agy uses 1, or 3 for
agent or model API failures since 1.2.6 per its changelog
(`agy-changelog-1.2.7.txt`); the latter is not yet measured live
(`raw-api-failure-bogus-key.txt`).

Argument parsing failures, such as a missing value for a documented value
flag or a documented conflicting pair, return 1. Exceptions caught by the
standalone dispatcher return 1.

No stronger exit-code taxonomy is implied. In particular, callers must not
interpret every 2 as cancellation. See [COMMANDS.md](./COMMANDS.md) for the
per-verb details.

The opt-in exception (added 2026-09): passing `--exit-status` alongside a
job reference and `--wait` on `status` (`status <id> --wait --exit-status`)
makes the exit code report that job's own outcome instead of the plain
retrieval-succeeded `0` above: `0` completed, `1` failed, `2` cancelled, or
`3` when the wait's own deadline passes first with the job still
`queued`/`running` (with one added stderr line naming the id and its live
status). `--exit-status` requires both the job reference and `--wait`;
missing either is refused before any job lookup, stderr only, exit 1.
Markdown and `--json` output are unchanged by this flag in every case; only
the exit code, and, on the timeout outcome, that one stderr line, differ
from a call without it. See
[`docs/COMMANDS.md`](./COMMANDS.md#status) for the full table.

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

| Field | 3.x contract |
|---|---|
| `schemaVersion` | The integer `1`. An incompatible envelope change requires a new value. |
| `command` | One of `review`, `rescue`, `task`, `vision`, `status`, `result`, `cancel`, or `doctor`, matching the invoked verb. |
| `status` | A string describing the represented outcome or state. Foreground delegated success is `completed`; a successful background dispatch is `queued`; a deduplicated `--request-id` dispatch reports the current status of the existing job; an empty review is `no_changes`; `review --preview` is `preview`, `jobId: null`, `answer: null`. `status` and `result` expose the represented job's stored status when they address one job. A status list uses `ok`. Cancellation paths that emit output use `cancelled`, `cancel_failed`, or `state_busy`. `doctor` uses `"ok"`, `"warnings"`, or `"problems"`, always with `jobId: null` and `answer: null` (see [`doctor`](#additive-surface-added-after-100)). |
| `jobId` | The tracked job id as a string when the output represents one job, otherwise `null`. Successful background dispatch always supplies it. Foreground `review`, `rescue`, `task`, and `vision` also supply their tracked job id. |
| `answer` | Opaque human-facing/model-generated text as a string when the command returns an answer, otherwise `null`. Its prose, Markdown, field-like conventions, and all other internal structure are explicitly unstable. Consumers may display or store it but must not parse it as a review/result schema. For structured review findings, use `review --findings-json` and read `details.findings` (see [Structured output flag](#structured-output-flag)). |
| `details` | An object containing command-specific metadata. Its field set and nested shapes are explicitly unstable in 3.x; consumers must tolerate additions, removals, and changes within it. |

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

The opt-in exception (added 2026-09): passing `--show-result`
alongside `--wait` on a background dispatch (`review --background`, `rescue
--background`, or background-default `task`) drops the dispatch envelope
entirely: dispatch-time stdout stays empty, and the queued notice moves to
stderr as `Background <verb> started: <jobId>`, in text mode and under
`--json` alike. It then reports the awaited job's own outcome instead: a
`completed` job's stored answer and `result <jobId> --json`'s own `details`
shape; a `failed` or `cancelled` job as the matching error envelope
(`job_failed`/`job_cancelled`); or, if the wait's own deadline passes first,
`wait_timeout` with the job's still-live `status` (`"queued"` or
`"running"`) and no completion ever reported for that call. `--show-result`
requires `--wait` (and, on `review`/`rescue`, `--background` too; `task`'s
`--foreground` has no `--wait` semantics and fails the same check). See
[`docs/COMMANDS.md`](./COMMANDS.md#--show-result-all-three-verbs) for the
full per-outcome contract.

A parser error (an unknown flag, a missing value, a conflicting pair) happens
before `--json` is even known, so it is unchanged: stderr only, no stdout
body, whatever flags follow it.

Once `--json` is accepted, an expected failure on a known path (a validation
error, a missing `agy` binary, a run that did not complete, a job reference
or a stored job record that cannot be resolved) also emits exactly one
version-1 envelope: `answer` is `null`, and `details.error` carries `{ code,
phase, message }`. `message` is a plugin-authored one-line reason or an
upstream reason processed by the filter in the "Failure reason" section.
The human-readable line stays on stderr, unchanged, on these paths.
Therefore the precise stream promise is: if `--json` writes any stdout, that
stdout is exactly one version-1 envelope and contains no text before or after
it, on success or on failure. A script that used to treat any stdout as
success must now read `status` (and, on a failure, `details.error.code`).

`status` values a `details.error` envelope can carry:

- `failed`: the run did not complete, including a headless auto-denial that
  starved the answer
- `cancelled`: the run was cancelled
- `auth_required`: Antigravity needs the OAuth flow repeated
- `timeout`: the run did not finish before its execution budget
- `no_agy`: the `agy` binary could not be found or spawned
- `invalid_input`: the caller's own input failed validation
- `state_error`: a job reference or a stored job record could not be
  resolved
- `queued`/`running`: `--show-result`'s own wait timed out while the job was
  still live; the job's own current status, not a new status word

`details.error.code` values:

- `agy_not_found` (`no_agy`, phase `probe`)
- `worker_start_failed` (`failed`, phase `run`; a background worker never started)
- `spawn_failed`, `agy_denied`, `run_failed` (`failed`, phase `run`; a
  foreground run that spawned but did not complete: a process that never
  started, a headless auto-denial that starved the answer, or anything else)
- `cancelled`, `auth_required`, `timeout` (matching `status`, phase `run`)
- `invalid_scope`, `unknown_base_ref`, `review_collection_failed`
  (`invalid_input`, phase `collect`; `review` only)
- `input_incomplete` (`invalid_input`, phase `collect`; `review` only,
  `--require-complete` refusing an input with a skipped file or a truncated
  diff; `details.skipped` and `details.truncated` carry the same lists
  `--preview` would have shown)
- `missing_task_text` (`invalid_input`, phase `validate`; `task`/`rescue`)
- `request_id_conflict` (`invalid_input`, phase `validate`; `task`/`rescue`
  background dispatch whose `--request-id` another request already uses;
  `details.existingJobId` names that job, `jobId` is `null`; added 2026-09)
- `prompt_file_too_large`, `prompt_file_unreadable`, `prompt_file_empty`
  (`invalid_input`, phase `validate`; `task`'s `--prompt-file`/stdin source
  is over the byte cap, could not be found or read, or is empty/
  whitespace-only; added 2026-09). Combining `--prompt-file` with a
  positional prompt, and `--prompt-file -` outside the standalone CLI, are
  argument errors instead: stderr only, exit 1, no envelope.
- `invalid_focus` (`invalid_input`, phase `validate`; `review` only, for an
  empty/whitespace-only or over-500-character `--focus`)
- `missing_image_path`, `image_not_found`, `unsupported_image_extension`,
  `image_too_large` (`invalid_input`, phase `validate`; `vision` only)
- `job_not_found`, `job_not_ready`, `invalid_job_record`, `state_locked`
  (`state_error`, phase `state`; `status`/`result`/`cancel`)
- `job_failed` (`result <id>` on a stored failed job: `status` stays
  `"failed"` and the answer stays whatever was stored; this code names why;
  `--show-result` reuses the same code for its own awaited job ending
  `failed`, phase `run`)
- `job_cancelled` (`--show-result`'s own awaited job ending `cancelled`,
  phase `run`; added 2026-09)
- `wait_timeout` (`--show-result`'s own wait timing out while the job is
  still `queued`/`running`, phase `wait`; added 2026-09)

Quota exhaustion is not yet classified into its own `status`/`error.code`
pair. A run that fails on a provider quota limit still reports as the
generic `failed` path above.

### Failure reason

When agy ends a run with `result.status: ERROR` and a one-line
`result.error` (agy 1.3.1 sent `API error (attempt 1): UNAVAILABLE (code
503): No capacity available for model gemini-3.6-flash-high on the server`
with no `error:` line on stderr), the plugin keeps that line as the run's
failure reason. It reaches three places:

- `errorMessage` on the runtime result and on the stored job record.
- `details.error.message` of a foreground `run_failed` envelope. The stderr
  line stays `failed (failed).` after its usual prefix, and the full
  upstream text still follows it on stderr.
- `healthMessage` on the stored job record, which `result <id> --json` reads
  as `details.error.message` of a `job_failed` envelope.

The filter first removes ANSI CSI and OSC sequences. It replaces each
other ESC and next-character pair with `=`, which the token rules reject.
It then applies Unicode NFKC normalization. It replaces format characters
(Cf) and default-ignorable code points, such as zero-width characters,
soft hyphens, BOM and bidi controls, with a private U+E000 marker.
For each token with this marker, the filter removes all such markers.
If the joined token is a keyword, or the text before its first `:` is a
keyword, the keyword rule applies. This check ignores letter case and
removes the surrounding punctuation listed below. Otherwise, the filter
replaces the whole token. Thus, `Bearer` joined to `shortSecret` by a
zero-width character becomes `[redacted]`, while `Be` joined to `arer`
becomes the keyword `Bearer`. A U+E000 character in the source gets the
same treatment. No private marker reaches the output.
Control characters (Cc) and separators
(Zs, Zl and Zp) become spaces. It combines repeated spaces and removes
spaces at the start and end. It then checks each space-separated token.

The filter keeps a token only if it has at most 32 characters, contains
only ASCII letters, digits or `. , : ; ! ( ) [ ] ' " _ - /`, and does not
contain `//`. Each complete run of ASCII letters and digits has these
limits: a run with both a letter and a digit has fewer than 12 characters;
a digits-only run has at most 12; a letters-only run has at most 20.
The filter also replaces a token with an ASCII letter directly before `:`
and an ASCII letter or digit directly after it. Thus, `src/index.mjs:12`
is replaced, but `503):` and `1):` pass this rule. It replaces every other
token that fails the shape rules. A replaced token that contains `://` becomes
`[redacted-url]`. Other replaced tokens become `[redacted]`.

The keyword rule takes precedence over the shape check. The filter ignores
letter case and removes surrounding `" ' ( ) [ ] , ; :` to identify these
keywords: `bearer`, `basic`, `digest`, `negotiate`, `token`, `authorization`,
`proxy-authorization`, `cookie`, `set-cookie`, `password`, `passwd`, `pwd`,
`secret`, `apikey`, `api-key`, `api_key`, `x-api-key`, `key`, `credential`,
`credentials`, `session`, `sid`, `jwt`, `auth`, `access_token`,
`refresh_token`, `id_token`, `client_secret` and `code`. It keeps the
keyword token and replaces the next two tokens, or all remaining tokens
if fewer than two remain. A keyword in those replaced tokens does not
start another pair of replacements.
If a keyword has a value attached with `:`, such as `Authorization:Basic`
or `password:hunter2`, the filter replaces that token and the next token.
It identifies this keyword from the text before the first `:`, without
regard to letter case. A final `:` with no attached value uses the usual
keyword rule.
The filter keeps numeric status diagnostics such as `(code 503):`.
This exception applies only to `(code` followed by 1 to 20 digits and `):`.
The digit run must also pass the shape rules. The word after
`(code <digits>):` is an ordinary token.

Adjacent replacement markers of the same type become one marker. The
reason is one line of at most 300 characters, cut at the last complete
token that fits. The source is agy's own error text. These rules filter
token shapes. A secret split by a line break or a space-class character
into pieces that each fit the grammar can remain. A short secret after a
word that is not in the keyword list can remain. A secret that fits the
allowed shape can remain. After the cut, if the result is empty or has no
run of at least three ASCII letters outside the markers, the filter
returns `null`. The plugin then keeps its generic text
(`failed (failed).` for a foreground run, `job <id> failed.` for `result`).
A reason from the `error:` or `AGY_ERROR:` stderr marker follows the same
rules. Precedence is unchanged: a plugin-authored timeout, output-limit or
cancellation reason wins over any agy reason, then the stderr marker, then
`result.error`. Status words, error codes, `answer`, and exit codes do not
change. A `timeout` or `cancelled` envelope keeps its own message. When agy
gives no reason of its own, a failed job's stored `errorMessage` is its
stderr put through the same rules, or empty when nothing readable is left.
These outputs use the filtered stored reason:
the `--show-result` envelope and its text-mode line (`review`, `rescue`,
`task`), the `## Error` section of `status <id>`, and the `result <id>`
fallback text. The stored `result.stderr` contains the unredacted upstream
text and is outside the filter's scope.

### Usage trailer

On a successful `review`, `rescue`, `task`, or `vision` (foreground, or an
awaited `--wait` background run), and when `result` reads a stored result
with measured usage, the command writes this exact newline-terminated
trailer to stderr. Before 2026-09 only `vision` and `result` did this;
`review`, `rescue`, and `task` now do the same whenever agy reported
measured usage for that run.

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

**Target (added in 2.0.0).** agy's `result.denied_actions` names only
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

**The plugin no longer relays agy's own bypass advice.**
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
travel through the MCP tool with a per-run allowlist. Measured on agy 1.3.1
(`probe-A5-task-add-dir.txt`, `probe-A5b-task-no-add-dir-control.txt`,
`probe-A5c-read-outside-drive-no-add-dir.txt`,
`probe-A5d-read-outside-drive-with-add-dir.txt`): a file under the OS temp
tree could be read without `--add-dir`, and a file on another drive was denied
without it and read with it. A test of `--add-dir` must use a path outside the
OS temp tree to prove anything.

## Print timeout and fatal-error reporting

agy >= 1.1.28 changed two headless behaviours. The fatal-error path was
measured on the installed agy 1.2.1 through the plugin's own stream-json
transport. The print-timeout behaviour was measured directly
against agy 1.2.1 in `t0d-stream-json-print-timeout.txt`, not end to end
through the plugin. The end-to-end path needs a run longer than the plugin
budget, so it was measured raw with a short `--print-timeout` instead.
Before 1.2.6, agy's default was `5m0s` and a literal `0` meant an immediate
timeout. Since 1.2.6 the default is unlimited; agy 1.2.7 help lists `0s`,
where `0` waits until the turn completes (`agy-help-1.2.7.txt`). The plugin
still forwards the job budget plus 60 seconds (`1860s` for the 30-minute
default), or `24h` for a `0` budget.
The plugin still enforces its own budget (`ANTIGRAVITY_AGY_TIMEOUT_MS`, the
`timeoutMs` deadline with 60 seconds of headroom); the forwarded
`--print-timeout` is the agy-side backstop. On 1.2.7, `--print-timeout 0` answered `ZERO` and exited 0
(`raw-print-timeout-zero.txt`); `--print-timeout 4s` printed
`[agy] print timeout after 4s with turn in progress; returning partial output`,
exited 0, and returned an empty response (`raw-print-timeout-short.txt`).
The two behaviours are:

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
  Since agy 1.2.6, per its changelog, a turn that ends on an agent or model
  API failure prints one `AGY_ERROR: {...}` line on stderr and agy exits 3
  instead of 1 (`agy-changelog-1.2.7.txt`). This shape and exit 3 are not yet
  measured live: `raw-api-failure-bogus-key.txt` did not provoke the failure.
  Since agy 1.2.10, a headless run that streamed part of a response and then
  ended on a model or agent error also exits 3 with the `AGY_ERROR` line,
  while multi-turn `stream-json` sessions warn and continue; this was not
  measured live (`agy-changelog-1.2.11.txt`).
  The plugin takes that line, sanitized and capped at 300 characters, as
  `errorMessage` when no `error:` line is present. When both are present,
  `error:` wins. A plugin-authored termination reason still takes priority.
  agy's exit status is stored on the job as `exitCode`; the verb still exits
  1 on a failed foreground run.

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
explicitly not a public 3.x integration point.

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

`state.json` can hold a `requestIds` object (additive, 2026-09):
`{ "<request-id>": { "jobId", "fingerprint", "createdAt" } }`. It is
written only after a background job was started with `--request-id` (see
[`--request-id`](./COMMANDS.md#--request-id-task-and-rescue)). A
`state.json` without it reads as an empty map. An entry is removed when the
history limit drops its job. When `state.json` is rebuilt from
`jobs/*.json`, the map is rebuilt from the job files whose stored request
has both `requestId` and `requestFingerprint`.

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

If a 3.x release moves or changes persistent state, it must preserve access to
existing jobs, including jobs written by 1.x and 2.x, through automatic
migration or a compatibility read path.
The `requestIds` map follows this rule: an index without it reads as an
empty map, and a rebuilt index recreates it from the job files.
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
- `--effort <low|medium|high>` on `task` and `rescue`. An explicit value is
  forwarded verbatim. With neither `--effort` nor `--model`, the plugin sends
  `medium`, unchanged since 2.0.0. With `--model` and no `--effort`, it sends
  no `--effort` flag and stores `request.effort: "agy-default"`
  (`scripts/lib/job-helpers.mjs`, `resolveRequestEffort`;
  `tests/passthrough-argv.test.mjs`, `task --foreground --model with no
  --effort sends --model and no --effort flag`, `rescue --model with no
  --effort sends --model and no --effort flag`, and `task (background worker):
  --model with no --effort stores agy-default and reaches argv with no
  --effort flag`).
  agy applies the level carried by a variant id such as
  `gemini-3.1-pro-high`, and rejects a base id that needs one
  (`raw-base-gemini-3.1-pro-no-effort.txt`). `vision` has no `--effort` flag
  and never sends one (`review` gained one in a later additive change; see
  below). agy 1.2.11 says it improved reasoning
  effort levels for models with different support
  (`agy-changelog-1.2.11.txt`). Raw probes establish these rules:
  - A variant id accepts no `--effort` or only its own level
    (`probe-fixed-task-pro.txt`,
    `raw-model-gemini-3.1-pro-high-effort-medium.txt`,
    `raw-variant-gemini-3.6-flash-high-effort-high.txt`).
  - A base id requires a level from its own set
    (`raw-base-gemini-3.1-pro-no-effort.txt`,
    `raw-base-gemini-3.8-flash-effort-medium.txt`).
  - A model without variants rejects `--effort`
    (`raw-model-claude-sonnet-4-6-effort-medium.txt`).
  - `max` is accepted syntax, but no model on this account supports it
    (`agy-help-1.2.11.txt`, `raw-effort-max-default-model.txt`,
    `raw-base-gemini-3.1-pro-effort-max.txt`).
  This validation was measured on agy 1.2.11. The 1.2.7 matrix did not
  exercise `--model` with the plugin's default effort, so the first agy version
  that rejects the pair is not pinned. Under 2.0.1, the default `medium` made
  model-only `task`, `rescue`, and
  background `task` runs fail on agy 1.2.11
  (`probe-task-pro-default-effort.txt`,
  `probe-rescue-pro-default-effort.txt`,
  `probe-task-background-pro-default-effort.txt`,
  `probe-task-claude-default-effort.txt`). Under 2.0.2, model-only foreground
  and background `task` and `rescue` runs pass on 2.0.2 with exit 0
  (`probe-fixed-task-pro.txt`, `probe-fixed-task-claude.txt`,
  `probe-fixed-rescue-pro.txt`, `probe-fixed-task-background-pro.txt`). The
  plugin sends no `--effort` flag and stores `request.effort` as `agy-default`
  (`scripts/lib/job-helpers.mjs`, `resolveRequestEffort`;
  `tests/passthrough-argv.test.mjs`, `task --foreground --model with no
  --effort sends --model and no --effort flag`, `rescue --model with no
  --effort sends --model and no --effort flag`, and `task (background worker):
  --model with no --effort stores agy-default and reaches argv with no
  --effort flag`).
  `medium` runs longer than `low`, so a job with neither `--model` nor
  `--effort` is more likely to reach the agy execution
  budget (docs/COMMANDS.md, "Execution budgets and failure messages"); a
  run that reaches it stores a failed job with no answer. Pass `--effort
  low` explicitly, pass `--effort agy-default`, or raise
  `ANTIGRAVITY_AGY_TIMEOUT_MS`, to avoid this.
- `agy-default` as a fourth accepted `--effort` value on
  `task` and `rescue`: the plugin still sends no `--effort` flag at all, so the
  user's own agy configuration decides, and the run is therefore not
  reproducible across machines. That is the same argv shape releases through
  1.3.0 had when `--effort` was absent. It is an opt-in value, not the
  default. `vision` still has no `--effort` flag (`review` gained one in a
  later additive change; see below). Stored `request.effort` keeps
  `"agy-default"` verbatim on `task`/`rescue`; the background worker's
  revalidation accepts it.
- **agy 1.2.1 vision MCP schema:** `scripts/mcp/vision-server.mjs`'s
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
- `target` on every `deniedActions` member above: the denied
  tool-parameter value agy named in a `step_update` error message, joined by
  action name, or `null` when unknown. Section "Headless read access" has
  the join rule and the sanitizing/display rules.
- `deniedActionsCount` on every job index entry (`status` job lists and
  `status --json`). The count is `0` when nothing was denied.
  `deniedActions` is stored on the job record and on the stored result.
  Records written by older versions have neither field and still render.
- Stored `request.effort` (string, one of `low|medium|high|agy-default`) on
  `task` and `rescue` job records: `medium` when the caller passed neither
  `--effort` nor `--model`; `agy-default` when the caller passed `--model` and
  no `--effort` (since 2.0.2); the explicit value otherwise.
  `task`/`rescue` records written before 2.0.0 have no `request.effort`
  field; `vision` records never do. `review` records carry `request.effort`
  only when the caller gave one, and store the given value verbatim,
  including the `agy-default` sentinel itself (see below). This is the same
  "store what the caller gave" rule `task`/`rescue` already follow for their
  own explicit values. The background worker revalidates the stored value and
  fails the job before starting agy on an unknown one.
- `--model <id>`, `--effort <low|medium|high|agy-default>`, and
  `--focus <text>` on `review`, forwarded on both the foreground and the
  background path. Unlike `task`/`rescue`,
  `review` has no plugin-side effort default: with neither flag given, no
  `--effort` reaches agy, unchanged from before this addition. An explicit
  value, including `agy-default`, is stored verbatim on `request.effort` and
  reported the same way in `provenance.effort`
  (`scripts/lib/job-helpers.mjs`, `resolveReviewEffort`); only the argv sent
  to agy collapses `agy-default` to no `--effort` flag at all, via the same
  `agyEffortArg` translation `task`/`rescue` already use
  (`tests/passthrough-argv.test.mjs`'s `review --model/--effort reach agy
  argv` block asserts the complete argv, and the stored `request.effort`,
  for every combination). `--focus` is
  trimmed and capped at 500 characters (`MAX_REVIEW_FOCUS_CHARS`,
  `resolveReviewFocus`); an empty, whitespace-only, or over-cap value is an
  `invalid_focus` validation error, exit 1. A given focus adds a "## Reviewer
  focus (caller instruction)" section to the prompt immediately before
  "## Output" (`buildReviewPrompt`, `prompt-templates.mjs`), is stored
  verbatim as `request.focus`, and appends ` focus: <first 40 characters>`
  to the job title. `--focus` is never derived from the collected diff or
  any other repository content.
- `--preview` and `--require-complete` on `review`, plus stored
  `request.inputHash`, `request.inputCounts`, `request.headSha` on every
  `review` job (foreground and background).
  `buildReviewInput` (`scripts/lib/review-input.mjs`) is the single
  selection function every path (`--preview`, foreground, background) calls:
  it returns the included files (`{ path, kind: "diff" | "untracked",
  bytes }`), the skipped files (`{ path, reason }`, the same reasons
  `readUntrackedFiles` already produces), whether the diff was cut by the
  196 KB cap, the file/byte counts, and `sha256:<hex>` of the exact prompt
  string. `--preview` prints all of that under `details` with
  `status: "preview"` (see the `status` field row above) and calls no agy
  probe. `--require-complete` refuses to send an input that skipped a file
  or cut the diff: `status: "invalid_input"`,
  `error.code: "input_incomplete"`, phase `collect`, with
  `details.skipped`/`details.truncated`, before any agy probe. Without
  `--require-complete`, the same condition instead prints one warning line
  on stderr before sending. `request.inputHash`/`request.inputCounts` are
  additive stored fields, never a second copy of the diff or the prompt
  (the background job already stores `request.prompt`). `provenance` itself
  is unchanged; the input hash is read from `request.inputHash`, shown as
  "Input hash: sha256:..." in the "## Provenance" markdown section and at
  `details.job.request.inputHash` (`status <id> --json`) /
  `details.inputHash` (`result <id> --json`). See `docs/COMMANDS.md`
  `review` for the exact flag/envelope shapes.
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
- `agyPrintTimeout`: `{ limit: string | null }` on the job
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
- `AGY_ERROR:` is a second source for a failed job's `errorMessage`,
  sanitized and capped at 300 characters when no `error:` line is present.
  `error:` wins when both are present; a plugin-authored termination reason
  still takes priority. Per the agy 1.2.6 changelog, agent or model API
  failures print this marker and exit 3 (`agy-changelog-1.2.7.txt`), not yet
  measured live (`raw-api-failure-bogus-key.txt`). The job stores agy's exit
  status as `exitCode`; a failed foreground verb still exits 1.
- `agyConversationId`: agy's own conversation id, distinct
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
- The interactive retry prompt: on a foreground
  `review`/`rescue`/`task` invocation that ends denied, the runtime asks
  once, on the terminal itself, whether to retry the same conversation or
  stop — interactive-only, never triggered by an automated or `--json`
  invocation. It never offers to grant a permission and never writes a
  settings file. `docs/COMMANDS.md`'s "Denied runs" section has the exact
  conditions and the two-choice contract.
- `provenance` (additive, 2026-09): a top-level object on
  every job record and index entry (`{ pluginVersion, agyVersion, model,
  effort, mode, addDirCount, requestedAt }`), set once at job creation. Never
  carries the prompt, workspace path, image paths, `extraArgs` content, or a
  tool list. `--json`: `details.job.provenance` on `status <id>` and per job
  in `status --json`'s job lists (it lives on the index entry); `details.provenance`
  on `result <id> --json`. `status <id>`/`result <id>` markdown each add a
  "## Provenance" section, one line per non-null field. The Recent Jobs table
  (`status`) adds `Model`/`Effort` columns only when at least one listed
  job's provenance names either one. `null`/absent on a job record written
  before this field existed.
- `reportedModel` (additive, 2026-09): the model agy's own
  `result` event named, when that event carries a model field, on the stored
  result. Measured against agy 1.2.11 and 1.2.12, the `result` event never
  carries one, so this is always `null` today; it is never derived from the
  model the caller requested. `--json`: `details.job.result.reportedModel` on
  `status <id>` and `details.reportedModel` on `result <id> --json`.
  `null`/absent on a legacy record.
- **`doctor`** (additive, 2026-09): a ninth, read-only verb
  (`scripts/commands/doctor.mjs`). It never runs OAuth, never calls a
  model, never writes a file, and never opens the network. It reports five
  checks: Node version against `package.json`'s `engines.node`; the agy
  binary, its version, and that version's classification against this
  plugin's measured range (`verified`, `beyond_measured`, `unmeasured`,
  `incompatible`, or `missing`); for each flag this plugin forwards to agy,
  whether `agy --help` lists it (`listed`, never proof the flag still
  works, or `not_listed`); the vision configuration
  (`registered`/`absent`/`unreadable`); and the job-state root (source,
  directory, whether it exists, and whether this workspace is on a legacy
  leaf). Markdown output ends with `doctor: <n> ok, <m> warnings, <k>
  problems`. `--json`: `status: "ok" | "warnings" | "problems"`, `jobId:
  null`, `answer: null`, `details: { node, agy: { path, version,
  classification }, flags: [{ flag, state }], vision, stateRoot: { source,
  dir, exists, legacyLeaf }, measuredRange: { min, newest } }`. Exit 0 for
  `ok`/`warnings`, 1 for `problems` (an incompatible or missing agy, an
  incompatible Node version, or an unreadable job-state root).
  `beyond_measured` is always a warning, never a problem. There is no
  `--live` flag: `setup` is already this plugin's live probe. See
  [`doctor`](./COMMANDS.md#doctor).
- **`agyVersionSeen`** (additive, 2026-09): after a successful
  agy-version probe, `review`, `rescue`, `task`, and `vision` cache
  `{ version, observedAt }` in the workspace's state config
  (`setConfig`/`getConfig`, `scripts/lib/state.mjs`), at most once per 60
  minutes per workspace. Never on `review --preview`, which returns
  before probing agy at all. `doctor` and `status` only read this cache;
  neither writes it or calls agy for it.
- **Version warnings** (additive, 2026-09): when the probed or
  cached agy version classifies as `beyond_measured` or `unmeasured`
  (see `doctor` above), `setup` prints one line right after `using <bin>
  v<version>`: `antigravity:setup — agy <v> is newer than the last
  measured version <newest>; see docs/COMPATIBILITY.md.` (or `... is not
  in the measured matrix; see docs/COMPATIBILITY.md.`). A no-reference
  `status` call prints one stderr line when `agyVersionSeen` is cached and
  classifies the same way: `antigravity:status — agy <v> (seen <date>) is
  newer than the last measured version <newest>.` `status <id>` never
  prints it, and `status` never calls agy to produce it.
- **`--request-id <id>`** (additive, 2026-09): an opt-in idempotency key
  on `task` (background path) and `rescue --background`. See
  [`--request-id`](./COMMANDS.md#--request-id-task-and-rescue). A
  foreground run, or an id outside 1 to 128 characters from
  `[A-Za-z0-9._-]`, is an argument error: stderr only, exit 1.
- `request.requestId` and `request.requestFingerprint` (additive,
  2026-09): on a job record started with `--request-id`, the id and the
  sha256 hex fingerprint of the request. Absent on every other job record.
- `details.deduplicated` (additive, 2026-09): `true` on the envelope that a
  repeated `--request-id` call prints for the existing job. `status` is the
  current status of that job and the exit code is 0. This holds even when
  the existing job's own status is `failed` or `cancelled`: the dedup call
  itself succeeded, so it still exits 0 with no `details.error`; only
  `status <id>` or `result <id>` on that job's id reports the failure or
  cancellation detail. Absent on every other envelope.
- `request_id_conflict` (additive, 2026-09): the error code for a
  `--request-id` that another request already uses; see the error code
  list above.
- `requestIds` in `state.json` (additive, 2026-09): see
  [Job state and configuration locations](#job-state-and-configuration-locations).
- **`--prompt-file <path>`** (additive, 2026-09): reads `task`'s prompt from
  a file (or, as `--prompt-file -`, from stdin, standalone CLI only) instead
  of a positional prompt. See
  [`--prompt-file`](./COMMANDS.md#task) and the `prompt_file_too_large` /
  `prompt_file_unreadable` / `prompt_file_empty` error codes above. `rescue`
  does not gain this flag.
- **`--expect <text>` on `vision`** (additive, 2026-09): repeatable, opt-in.
  After a completed run, each trimmed value is checked against the answer's
  `## Transcription` section. This is a substring check on what agy already
  transcribed, never a truth check of the image itself. See
  [`--expect`](./COMMANDS.md#--expect). `--json` adds `details.expectations`
  (`[{ value, found, reason? }]`, `found` is `true`/`false`/`null`) and
  `details.expectationSummary` (`all_found`/`missing`/`unverifiable`), both
  present only when `--expect` was given. Markdown appends a matching
  `Expectations: <summary>` block after the answer. An empty value or more
  than 32 values is an argument error, stderr only, exit 1. The exit code is
  unchanged in every case; this is documented as a first version.
- **`--findings-json` on `review`** (additive, 2026-09): opt-in structured
  findings. agy gets `--json-schema <absolute path of
  scripts/lib/review-findings.schema.json>` immediately before
  `--print-timeout`, on the foreground and the background path. Without the
  flag the argv is unchanged. See
  [Structured output flag](#structured-output-flag) below and
  [`review`](./COMMANDS.md#review).
- `details.findings`, `details.findingsStatus`, `details.findingsError`
  (additive, 2026-09): on a completed `review --findings-json` run, on
  `--show-result`, and on `result <id> --json` for such a job.
  `findingsStatus` is `valid`, `invalid`, or `missing`. `findings` is the
  parsed object when valid, else `null`. `findingsError` is one line and is
  present only when the status is not `valid`. A status other than `valid`
  also prints one stderr warning line. All three are absent without the
  flag. The exit code does not change.
- **Failure reason** (3.0.0): a `result.error` line from agy now fills
  `errorMessage` when no `error:` marker is present, and the reason is
  redacted and bounded. See [Failure reason](#failure-reason).
- `details.error.message` (3.0.0): a foreground `run_failed` envelope and a
  `result <id> --json` `job_failed` envelope carry the failure reason instead
  of `failed (failed).` or `job <id> failed.` when a safe reason exists.
- `healthMessage` (3.0.0): set on a stored `failed` job when the run has a
  failure reason and no denial. It was absent for a plain `failed` job before.
- **`update --apply` working directory** (3.0.0): when the current directory
  is the agy install root or lies inside it (checked by real path), the
  steps run from the update's temporary directory, and the plugin prints one
  line saying so. If the directory cannot be changed, no step runs and the
  exit code is 1. See [`update`](./COMMANDS.md#update).
- **`vision` default model** (3.0.0, breaking): `gemini-3.8-flash-high`. It
  was `gemini-3.6-flash-high`. `--model gemini-3.6-flash-high` restores it.
- `request.findingsJson` (additive, 2026-09): `true` on a job record started
  with `review --findings-json`, absent otherwise. The background worker
  fails the job before starting agy when the stored value is not a boolean.
- `result.structuredRaw` (additive, 2026-09): agy's structured output as
  JSON text, `null` when agy sent none. It is on every new job record, so
  `details.result.structuredRaw` is `null` for every run without the flag.
- **`--check-locations` on `review` and `result`** (additive, 2026-09): an
  opt-in, local-only heuristic that checks each `path:line` citation a
  review answer names against the diff that run actually sent. It never
  calls agy again, and adds nothing to `argv` on either verb. See
  [Heuristic location check](#heuristic-location-check) below and
  [`review`](./COMMANDS.md#review)/[`result`](./COMMANDS.md#result).
- `request.hunks` (additive, 2026-09): `[{ path, newStart, newEnd }]`, the
  hunks the sent diff's own `@@ -a,b +c,d @@` headers carried (plus one
  `{ newStart: 1, newEnd: <line count> }` entry per included untracked
  file), computed by `buildReviewInput` and stored on **every** review job
  (not only under `--check-locations`), so `result --check-locations` works
  on a job reviewed without the flag. Absent on a job stored before this
  feature shipped; that absence is what makes the check "unavailable" on
  such a job.
- `details.locationCheck` (additive, 2026-09): `{ heuristic: true, citations:
  [{ text, path, line, state }], counts: { in_diff, outside_diff,
  unknown_path } }` on a completed `review --check-locations` run and on
  `result <job-id> --check-locations`; `null` when the flag was given but
  the job has no stored `request.hunks`; absent without the flag. This is a
  heuristic, not a truth check: a citation the diff never touched is not by
  itself a model error. Reviewers legitimately cite context lines and
  related files outside the diff.

### Structured output flag

`answer` stays opaque, with or without `--findings-json`. `details.findings`
is the only structured contract for review content. The plugin validates it
locally against the schema it ships, `scripts/lib/review-findings.schema.json`,
and never trusts agy to enforce the schema.

Measured on agy 1.2.12 (transcript `probe-json-schema.txt`): with
`--json-schema` and the stream-json transport, the final `result` event
carries a `structured_output` field. In the probe it parsed as JSON and
matched the schema exactly. `step_update.text_delta` still streams, and the
exit code was 0. `result.response`, which becomes `answer`, was JSON text,
not prose, and it carried keys the schema did not allow. So under
`--findings-json`, `answer` is JSON text rather than the Markdown review. The
plugin reads only `structured_output` and never parses `response`.

### Heuristic location check

`--check-locations` finds `path:line` and `path:start-end` citations in a
review answer with one regular expression, tuned to exclude two shapes it
would otherwise catch: a bare three-part version string (`1.2.11`), and a
`http(s)://` URL whose path segment happens to look like `name.ext:port`
right after the scheme. It does not chase every possible false positive. For
one, a bare `host:port` with no `http(s)://` prefix still matches and is
reported as `unknown_path`. This is why the check is heuristic: it can both
miss a real citation the model wrote in an unexpected shape and report a
path-shaped string that was never meant as one. The path class also excludes
`\`, so a Windows-separator citation such as `C:\repo\src\file.mjs:42`
truncates to `file.mjs:42`, the file name only; the directory segments are
silently dropped rather than checked.

Measured against two stored `review --json` transcripts from earlier agy
probes (agy 1.2.11 and agy 1.2.7): neither answer contains a `path:line`-shaped
citation at all: both cite the changed file with a Markdown link and a `#L1`
anchor (`[answer.txt](file:///.../answer.txt#L1)`), not a colon. The regex
matched zero times in either transcript, so the measured false-positive
count is zero for both. A synthetic hunk set was not needed, since there was
nothing to classify.

## Deprecation and compatibility changes

2.0.0 changed the documented default on `task` and `rescue`: with neither
`--effort` nor `--model`, the plugin sends `medium`. Through 1.3.0 it sent no
flag.

2.0.2 narrowed that 2.0.0 default under the upstream-break exception. With
`--model` and no `--effort`, the plugin sends no `--effort` flag because agy
1.2.11 rejects the pair (`probe-task-pro-default-effort.txt`,
`probe-task-claude-default-effort.txt`). The default `medium` for a job with
neither `--model` nor `--effort` is unchanged. This is the compatibility
boundary.

**3.0.0 changed the default model of `vision`.** With no `--model`, `vision`
now uses `gemini-3.8-flash-high`. Through 2.1.0 it used
`gemini-3.6-flash-high`. This is the only breaking change in 3.0.0. Every
verb, flag, exit code, `--json` field, and state location of 2.x keeps its
meaning.

Why. On agy 1.3.1, on 2026-10-08, the old default completed 3 of 5 `vision`
runs. The other 2 failed with `UNAVAILABLE (code 503): No capacity available
for model gemini-3.6-flash-high on the server` (`probe-vision-expect.txt`,
`probe-E-5-default.txt`). The new default completed 5 of 5 runs
(`probe-vision-38-stdout.txt`, `probe-E-2-38.txt`, `probe-E-4-38.txt`,
`probe-E-6-38.txt`, `probe-G2-vision-special-path-38.txt`). Per run, as agy
reported it, the new default used more tokens, 57,637 to 72,416 against
39,418 to 52,066 for the completed runs of the old default. It was also
faster, 27 to 51 seconds against 45 to 64 seconds (wall time of the plugin
command). The old default's completed runs are `probe-E-1-default.txt`,
`probe-E-3-default.txt`, and `probe-G2-vision-special-path-default.txt`. Five
runs per model are a small sample. The 503 is a capacity error on agy's side,
so it can come and go.

No 2.x release announced this change first. The contract above allows a
breaking change in a major release, so 3.0.0 makes it without a deprecation
period.

What you may notice: the `model` field of a `vision` `--json` envelope, and
`provenance.model` on the job, name the new model. Each run costs more
tokens. To keep the old behavior, pass `--model gemini-3.6-flash-high`. That
model can fail with the 503 capacity error again.

A documented public 3.x surface will be marked deprecated in release notes
and documentation and retained through at least one subsequent 3.x minor
release. Ordinary removal or another backward-incompatible change then waits
for 4.0.0. Additive commands, flags, fields, and behavior may ship in a 3.x
minor release.

There are two exceptions:

- An urgent security or privacy fix may disable or remove unsafe behavior in a
  3.x patch without the normal deprecation period. The release notes must name
  the affected surface, risk, and replacement or mitigation.
- An upstream agy change that breaks agy's own interface may force an
  immediate transport, flag, output-parsing, or supported-version change.
  The plugin may make that smallest necessary change in a 3.x patch and must
  document the upstream break and resulting compatibility boundary.

Neither exception authorizes unrelated breaking changes. Explicitly unstable
surfaces may change in 3.x without deprecation, but the change must still be
called out when it affects observable output.
