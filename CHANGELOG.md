# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **agy print-timeout truncation reporting.** Since agy 1.1.28, a `--print-timeout`
  that expires while a turn is still in progress exits 0 and writes one
  stable stderr line instead of failing outright. The plugin detects that
  marker and reports it as `agyPrintTimeout: { limit: '<duration>' | null }`
  on the job record and the stored result. `--json` sets
  `details.agyPrintTimeout` on a completed foreground envelope and on
  `result <id> --json`, and `details.job.agyPrintTimeout` on `status <id>
  --json`; job lists carry the same field per job. Markdown `status <id>`
  and `result` add a "Note:" line; the `status` tables add a `Partial`
  column. A non-empty answer with the marker present stays `completed` — a
  partial answer is still an answer; an empty answer with the marker present
  is reclassified `failed`, the same treatment a starved headless denial
  already gets. This field is distinct from the pre-existing
  `details.truncated` boolean on `result` (`--head`/`--tail`).
- **agy fatal-error marker.** Since agy 1.1.28, a fatal headless failure
  writes a stable `error: <reason>` line on stderr. When a run fails and
  such a line is present, it becomes the job's `errorMessage` (trimmed,
  sanitized, bounded) instead of the raw stderr dump, unless a
  plugin-authored termination reason (timeout, output-limit, cancellation)
  already explains the failure.

### Changed

- **`task` and `rescue` default `--effort` to `medium`.** A run without
  `--effort` sent no effort field at all, so the value agy used came from
  whatever that machine had saved — not reproducible across machines. When
  the caller passes no `--effort`, the plugin now sends `medium`; an
  explicit `--effort <value>` still wins. The stored `request.effort` on a
  job record records the effective value either way. `review` and `vision`
  have no `--effort` flag and are unaffected.

### Security

- **Vision MCP tool schema closes to undeclared arguments.** agy 1.1.27
  rejected an argument a server's schema never declared; agy 1.2.1
  "preserves open object schemas ... instead of rejecting undeclared
  arguments on schemas that allow them". `scripts/mcp/vision-server.mjs`'s
  `view_image` schema declared no `additionalProperties`, which JSON Schema
  treats as permissive, so on 1.2.1 an invented argument would reach the
  server again. The schema now declares `additionalProperties: false`.

## [1.3.0] — 2026-09-09

### Added

- **Structured denial reporting.** Since agy 1.1.27, a headless run's
  `denied_actions` JSON list is parsed. The plugin validates each member,
  drops exact repeats, and caps the list at 32 members and 200 characters
  per string. It merges that list with the existing stderr sentinel. The
  JSON list wins when it is present. Older agy without the field still gets
  one denial from the stderr sentinel. Each member gets a computed remedy:
  `--add-dir <dir>` for read-type actions, `--mode accept-edits` for
  edit-type actions, or `Headless runs cannot grant "<action>"; the host
  must run this step itself.` for every other action. `--json` sets
  `details.deniedActions` on a completed foreground envelope and on
  `result <id> --json`. `--json` sets `details.job.deniedActions` on
  `status <id> --json`. Job lists carry `deniedActionsCount`. Markdown
  `status <id>` and `result` add a `## Denied Actions` section. The
  `status` tables add a `Denied` column. A live 1.1.27 denial of `read_url`
  (`displayName` `ReadUrlContent`) printed `Headless runs cannot grant
  "read_url"; the host must run this step itself.` A failed foreground
  `--json` run still writes no stdout envelope. The fail-vs-warn decision
  and every exit code stay unchanged.
- **`--effort <low|medium|high>` on `task` and `rescue`.** Both verbs accept
  `--effort`. They forward it to agy as `--effort <value>`. This applies in
  the foreground and in the background. The flag sits right after `--model`,
  or in its place when there is no model. The plugin has no default. When
  the flag is absent, nothing is forwarded. Live 1.1.27 runs with
  `--effort low` and `--effort high` completed. The plugin does not probe
  what agy does with the value beyond forwarding it.

### Changed

- **CI matrix.** `macos-latest` joins `ubuntu-latest` and `windows-latest`.
  The test matrix uses Node 22.3.x and Node 24. The lint gate still runs on
  the Node 24 jobs only. It now runs on all three operating systems.
  Release-tree CI run 34289858536 on commit `4f9b317` was green on all six
  cells.

### Fixed

- **Long runs no longer end at agy's 5-minute default.** Every print-mode
  `agy` invocation (`review`, `rescue`, `task`, `vision`; foreground,
  background, plain, `--continue`, and `--conversation`) now forwards
  `--print-timeout` as the plugin execution budget plus 60 seconds of
  headroom (`1860s` for the 30-minute default). The plugin deadline fires
  first. agy's default `--print-timeout 5m0s` no longer ends the run early
  with `status: ERROR` / `"timeout waiting for response"`. A `0` budget
  forwards a fixed `24h` ceiling. agy treats a literal `0` as an immediate
  timeout.
- **Vision allowlist on macOS.** The vision MCP server refused every image
  on macOS. `os.tmpdir()` sits under `/var`, a symlink to `/private/var`,
  so the resolved path never matched the request's own logical spelling.
  `vision` now records the allowlist in its resolved (realpath) form. The
  server accepts a request whose own realpath is itself an authorized
  entry. The requested file's own final component being a symlink is still
  refused. The identity checks made while reading an image are unchanged.
- **Workspace-root canonicalization.** The job state directory is keyed off
  the realpath of the workspace root. A caller that holds a logical,
  symlinked spelling of the same directory (macOS `os.tmpdir()`) and a
  background worker whose `process.cwd()` is already the physical path
  therefore use the same leaf. An existing install's jobs, stored under the
  pre-085 logical-path leaf, stay reachable until that leaf is moved. A
  realpath leaf is preferred once it exists. The logical leaf is still read
  until then. A background job's worker receives the parent's exact
  workspace spelling. A job started through a logical spelling stays under
  the leaf it was created in.

### Security

- **Slash expansion disabled.** Every print-mode `agy` invocation now
  forwards `--disable-slash-commands`. Prompt text that starts with `/`,
  including untrusted diff, review, rescue, or task content, reaches the
  model as plain text. It is not parsed as an agy slash command or skill.
  A live 1.1.27 `task` whose prompt began with `/model` completed with
  answer `OK.`

## [1.2.0] — 2026-09-06

### Added

- **Retrievable result size.** `status` (and `status --json`) shows the
  stored answer's byte and line counts (`answerBytes`, `answerLines`) on the
  job record. `result` gains `--head <n>` and `--tail <n>` (a positive
  integer number of lines; both may be given) to show only part of a stored
  answer; when a cut happens, the markdown output ends with
  `(showing <k> of <total> lines; full answer stored)` and `--json` sets
  `details.truncated: true`. Without the flags, output is unchanged.
- **Safer registry retries for the update check.** `update` now retries a
  failed registry request up to twice on a network
  error, HTTP 429, or 5xx, waiting `500ms * 2^attempt` plus up to 250ms of
  jitter and honouring a numeric `Retry-After` header, all inside one 25
  second total budget for the whole check. A 4xx other than 429, malformed
  JSON, and the semver check never retry; `update --apply` steps never
  retry either. Before this, one failed request ended the check immediately.
- **`--model` on `task` and `rescue`.** Both verbs now accept `--model <id>`
  and forward it to agy exactly as `vision` already did, foreground and
  background. `rescue --model` previously logged the flag as ignored; it now
  reaches agy.
- **Contributor files.** A public `CONTRIBUTING.md` (the five gates, the
  frozen 1.x contract pointer, the release runbook pointer, the docs-in-
  the-same-change rule). `.cursor/rules/antigravity-plugin.mdc` and
  `.cursorignore` for contributors working in Cursor.

### Security

- **Socket-flagged host bootstrap moved to a shipped module.** The
  `node -e` snippet every `commands/*.md` wrapper runs no longer builds its
  spawn logic as one long interpolated string. That body now lives in the
  shipped, tested `scripts/lib/host-bootstrap.cjs` module. The generated
  snippet resolves the plugin root, checks `<root>/plugin.json` itself and
  refuses with one line before requiring anything from that root, checks that
  the shipped module exists and refuses with one line when it does not, and
  only then requires the module and calls into it; the module carries its own
  copy of the manifest check as a second layer. No host input is
  interpolated into executed source; the root is read from the environment
  at run time, same as before.
- **Vision image access.** Vision checks file identity while it reads an image.
  It keeps the 10 MiB limit when a file grows after the first check.
- **Vision MCP request processing.** Malformed requests do not stop the
  server. The server rejects oversized input frames. A paused client cannot
  queue unlimited replies.
- **Update command execution.** Updates reject invalid registry and cache
  versions. On Windows, updates reject unsafe batch command paths and
  arguments. Native executables take precedence over shims.
- **Background job arguments.** Background jobs reject stored agy flags other
  than the supported mode pair before they start agy. Tampered requests fail.
- **Review context labeling.** Review skips untracked files with secret-shaped
  names (`.env`, `.env.*`, `.pem`/`.key`/`.p12`/`.pfx`, default SSH key names) instead
  of sending them. Diffs, commits, and untracked file bodies sent to agy are
  wrapped in a labeled, self-escaping data block with one sentence telling the
  model that content is untrusted, not instructions. Every `commands/*.md`
  wrapper repeats that rule for the model output it hands back.
- **Git path parsing.** Untracked, staged, unstaged, and branch-comparison
  file lists are parsed the way git prints them (`-z`, no quoting), so a
  non-ASCII or space-containing name, or a rename, is no longer skipped or
  garbled.
- **Shared temp directory trust (POSIX only).** The job state root, its lock
  directory, and the update-check cache now refuse a pre-existing directory
  they do not own or that is group/other-writable, and refuse a symlinked
  root, instead of writing into it silently.

### Fixed

- **Live job retention.** Queued and running jobs no longer disappear when
  terminal history reaches its 50-job cap. Their job records and logs remain
  available for status, result, and cancellation.
- **Recoverable job state.** Job details are committed before their index
  entries. An unreadable state index is kept as a timestamped corrupt copy and
  rebuilt from valid job files; `result` now exits 1 instead of reporting
  success when a selected job file is missing or unreadable.
- **Observed worker health and waits.** Background workers now persist
  heartbeats and model-output progress, legacy running jobs use their start
  time until observations arrive, and every worker-liveness check follows the
  same permission-denied policy. Timed-out background waits now say that the
  job is still queued or running and point to `status`. Stale locks no longer
  survive merely because their recorded PID was reused by another process.
  Workspace root resolution (used by every job read/write) is cached per
  directory for the run, so a background worker no longer repeats the same
  `git rev-parse` on each state update.
- **Bounded agy runs.** Foreground and background jobs fail after 30 minutes
  instead of waiting forever. Set `ANTIGRAVITY_AGY_TIMEOUT_MS` to change the
  budget, or `0` to disable it. Excess output (16 MiB stdout or 4 MiB stderr)
  also fails the job with a diagnostic; timeout and output failures terminate
  the agy process tree. Git commands and update steps now have timeouts.
- **Interrupted foreground runs.** Ctrl+C during a foreground verb terminates
  agy and its child processes before the command exits.
- **Final output capture.** Answers and permission denials arriving as agy
  exits are retained until its streams close. Pipes that stay open five
  seconds after exit are closed with a warning.
- **Background launch failures.** A worker must acknowledge its spawn before
  a command reports a queued job. Launch or PID-recording failures now fail
  the job and command; an untracked worker is terminated.
- **Command argument boundaries.** Quoted prompts and image paths keep their
  argument boundaries. Prompt words cannot select permission modes or extra
  directories.
- **Review base references.** Review rejects unknown and option-like base
  references before it compares commits.
- **Auth classification false positive.** A completed review that quotes the
  Google sign-in URL inside its answer (for example, a change that touches
  the sign-in flow) no longer reports `auth_required`. That classification
  now applies only when the run did not succeed, or the answer looks like
  agy's own short auth sentinel.
- **Table-cell escaping.** The `status` table escapes backslashes as well as
  pipes in summaries, so a summary ending in a backslash before a pipe no
  longer splits the cell.

### Changed

- **Unknown flags.** Unknown flags exit 1 with guidance to put prompt text
  after `--`.
- **Workspace root resolved once per command.** Each verb resolves its
  workspace root once and passes it down; `status`, `result`, and `cancel`
  no longer re-resolve it once per stored job they read.
- **Bounded log tails.** `status` and the single-job view now read at most
  64 KB from the end of a job log to show its last lines, instead of loading
  the whole file.
- **Foreground runs now store their conversation id.** A foreground
  `rescue`, `review`, `task`, or `vision` run stores `agyConversationId` in
  its job record the same way a background run always did. It appears under
  `details.result` in `result --json`'s unstable nested `details` metadata,
  not as a promised envelope field.
- **Auth-required message wording.** `review`, `rescue`, `task`, and `vision`
  now print the same not-authenticated message on a foreground OAuth prompt.
  Each verb had its own slightly different wording before. Diagnostic and
  error text is not part of the frozen 1.x contract.
- **Background auth-required message wording.** A background job's stored
  `healthMessage` for `auth_required` now uses the same wording as the
  foreground message above. It appears in the status snapshot inside
  `status --json`'s unstable nested `details` metadata, not as a promised
  envelope field.
- **Empty or missing progress log.** `status`'s `recentProgress` (in
  `--json` `details`) is now `[]` for a job whose log is empty or missing.
  Before, an empty log gave `[""]` and a missing log left the field absent.
- **Cyclomatic complexity lint gate.** `npm run lint` (ESLint 10 flat config,
  `complexity: max 20` on `bin/**`/`scripts/**`, globs also cover `.js`/`.cjs`)
  runs in CI on the Node 24 jobs and in the release workflow. `devDependencies`
  gains its one entry, `eslint@^10.10.0`, pinned by the new
  `package-lock.json`; zero runtime dependencies stays true. `npm run lint`
  needs a Node version eslint 10 supports (`^20.19.0 || ^22.13.0 || >=24`);
  CI runs it on Node 24. Tests still run on the 22.3 floor.
- **Functions split under the complexity ceiling.** No behavior change.
  `runAgyPrint` (`scripts/lib/agent-runtime.mjs`), `terminateProcessTree`
  (`scripts/lib/process.mjs`), `renderSingleJobStatus`
  (`scripts/lib/render.mjs`), the verb `run` functions (`task`, `rescue`,
  `review`, `result`, `cancel`), `_worker.mjs`'s worker `main`,
  `classifyRuntimeHealth` (`scripts/lib/job-control.mjs`), `parseArgs`
  (`scripts/lib/args.mjs`), and a handful of other functions above the
  ceiling are each split into smaller named helpers.
- **Smaller published tarball.** `package.json` `files` now lists
  `scripts/commands`, `scripts/lib`, and `scripts/mcp` instead of the whole
  `scripts` directory, so the maintainer-only scripts
  (`bump-version.mjs`, `check-pack.mjs`, `check-manifests.mjs`, `smoke.sh`)
  no longer ship in the installed package; `CONTRIBUTING.md` is added to the
  tarball instead.
- **Agent orientation files stay local.** `CLAUDE.md` and `AGENTS.md` are
  gitignored going forward (they stay on disk; they were never part of the
  product). `.verify-*.md`, `.audit-*.md`, and `.report-*.md` (verifier and
  audit reports) are gitignored the same way.

### Removed

- **Unused `scripts/lib` exports.** Nothing in the plugin called these, and
  `docs/COMPATIBILITY.md` states direct imports of `scripts/lib` modules are
  not promised in 1.x: `spawnAgyDetached`, `spawnDetached`, `binaryAvailable`,
  `runCommandChecked`, `readJsonFile`, `readFileSafe`, `withJobMutex`,
  `readJobLog` (its bounded replacement is `readLogTail`), `getStagedDiff`,
  `getUnstagedDiff`, `measureGitOutputBytes`, `normalizeMaxInlineFiles`,
  `normalizeMaxInlineDiffBytes`.
- **Never-populated fields in `status <id>`.** `Session ID`, `Transport`,
  and `Recent Events` never appeared (nothing ever recorded a conversation
  thread id, a runtime transport, or ACP-era events on a job), and
  `Last Tool Call` always read `-`. All four lines are gone from the
  single-job status view.
- **`result`'s conversation footer.** `result`'s answer text no longer
  appends a `Conversation ID:` / `Resume conversation:` footer. Nothing ever
  wrote the field this footer read, so it could never actually appear (same
  cause as the `status <id>` fields above).

## [1.1.3] — 2026-09-04

### Changed

- **1.1.2 republished as 1.1.3.** The npm publish of 1.1.2 ran during an npm
  registry incident on 2026-09-03 and left no installable version, while npm
  still records the number as used. 1.1.3 ships the same content. The release
  runbook now checks the npm status page before a tag is pushed.

## [1.1.2] — 2026-09-03

### Added

- **`docs/` and `CHANGELOG.md` in the package.** The npm tarball now ships the
  documentation the README links to. Before this, an installed copy had a
  README whose relative links pointed at files that were not there, and the
  Troubleshooting table could not be read offline. The pack check derives the
  required list from the README links, so a new documentation link tightens
  the gate by itself.
- **A check for stale documentation.** A bump now rewrites every
  `Plugin <version>` phrase in the README and in `docs/`, and
  `bump-version --check` fails when such a phrase names a version that is not
  the one in `package.json`. The pack check also fails when the README links
  a markdown file that is not in the package.

### Changed

- **`update --apply` refreshes the Claude Code marketplace.** The plan runs
  `claude plugin marketplace update antigravity` before
  `claude plugin update antigravity@antigravity`. Without that step,
  `plugin update` reports the version you already have as the latest.
- **`update --apply` reports a local Codex marketplace.** The plan runs
  `codex plugin marketplace list` first. If the `antigravity` marketplace is a
  local clone, the command prints the path and tells you to pull that clone,
  because `plugin add` installs the version the clone holds. After the install
  it prints the installed version, and one more line when that version is not
  the latest. It never pulls or changes your clone.
- **Socket badge.** The badge now sits in the badge row at the top of the
  README and links to the Socket overview page. The image URL stays
  unversioned, so it needs no change per release.
- **Update instructions.** The README now says that Claude Code needs
  `claude plugin marketplace update antigravity` before `plugin update`, that
  Codex installs from the registered marketplace (pull a local clone first),
  and what `update --apply` does for each host. The commands reference gains
  an `update` section, and the installation guide gains a Troubleshooting row
  for a Codex reinstall of an old version. The README no longer states a test
  count, the Socket badge sits with the other badges without a version pin,
  and the compatibility contract notes the wrapper manifest check.

## [1.1.1] — 2026-09-03

### Added

- **GitHub Packages mirror.** A workflow republishes each `v*` release tarball
  to GitHub Packages and supports a manual run for an existing tag.
- **Troubleshooting guide.** The installation guide now lists measured command
  failures, their first output lines, exit codes, and corrective actions.
- **Automated repository checks.** `.github/dependabot.yml` checks GitHub
  Actions pins each week. Its npm entry stays idle until a dependency exists.
  `.github/workflows/codeql.yml` scans `javascript-typescript` on pushes and
  pull requests to `main`, and each week.
- **Socket badge.** The README now links to the Socket score for the published
  npm package.

### Changed

- **Local vault notes.** `.vault/`, which contains the maintainer's local
  vault-ops notes, is no longer tracked in the repository.
- **Release documentation.** The README now uses per-host quick starts and
  includes how the plugin works, release integrity, and contributing guidance.
  The release runbook now warns that trusted publisher fields must match
  exactly. The vision reference now includes the measured model guidance.

### Fixed

- **The host wrapper spawned a script from any plugin root.** The wrapper took
  `CLAUDE_PLUGIN_ROOT` as given and ran `<root>/scripts/commands/<verb>.mjs`
  from it. It now reads `<root>/plugin.json` first and exits 1 with one line
  unless that manifest names this plugin. The standalone dispatcher applies
  the same check to `ANTIGRAVITY_SCRIPT_ROOT` before it imports a verb.
- **A missing `agy` or Git surfaced as a raw Node error.** `rescue`, `task`
  and `vision` now probe `agy` first and exit 1 with
  `antigravity:<verb> — \`agy\` is not on PATH (<reason>). Run
  /antigravity:setup.` before any job record or spawn. `review` reads the
  diff first, so nothing to review still exits 0 with the `no_changes`
  result and never needs `agy`; with changes to send it prints the same
  line and exits 1. A run whose process never starts prints
  `failed: <spawn error>` instead of `failed (failed).`, and `review`
  without Git prints `git is not on PATH (spawnSync git ENOENT).`
- **`vision` started agy for a file it could never send.** An unsupported
  extension or a file over the 10 MiB cap failed only when the model called
  the local image server, which spent tokens and returned an answer-shaped
  reply. The command now checks both limits before any spawn and exits 1.
- **`update --apply` sent Codex an unqualified plugin name.** The Codex plan's
  `plugin remove` step passed `antigravity`, and Codex refuses that with
  "plugin requires --marketplace unless passed as `<plugin>@<marketplace>`",
  stopping the whole run before `plugin add` could run. The remove step now
  passes `antigravity@antigravity`. The remove and add argv now match the
  printed instruction.
- **`update --apply` could reinstall a stale cached version on agy.** The
  24 h cache is right for the plain report, but `--apply` read it too, so a
  run could pack a version the cache still remembered even after a newer
  release shipped. `--apply` now always asks the npm registry once and
  rewrites the cache. With `ANTIGRAVITY_NO_UPDATE_CHECK=1` the agy step is
  skipped with a clear message instead of packing an unknown version; Claude
  Code and Codex, which do not need a version number, still run.

## [1.1.0] — 2026-09-03

### Added

- **Standalone `update`.** `antigravity-plugin update` checks the npm
  registry for the latest published version. It makes one request and caches
  the result for 24 h. `ANTIGRAVITY_NO_UPDATE_CHECK=1` skips the check. The
  command compares the running copy with the latest version and prints an
  update command for each host on `PATH`. `--apply` prints and runs those
  commands. For agy, it packs the published tarball, uninstalls, then
  installs. No clone is needed. `status` prints one stderr line when the
  cache knows a newer version. `status` never calls the network. The plugin
  does not update itself. No host wrapper exposes `update`. See
  `docs/COMPATIBILITY.md`, "Public command surface".
- **npm provenance.** `.github/workflows/release.yml` publishes a `v*` tag
  through npm trusted publishing. The job holds `id-token: write` and
  `contents: read`. No token is stored. npm attaches an attestation that
  binds the tarball to this repository, the tagged commit, and the workflow
  run. The job refuses a tag that does not match `package.json`.
  `docs/RELEASING.md` is the runbook. `SECURITY.md` explains verification and
  the limits of a signature.
- **`--mode <plan|accept-edits>` for `rescue` and `task`.** The plugin
  forwards this value to agy as the execution mode for that run. This works
  on foreground and background paths. For any other value the plugin reports
  an argument error and does not start agy.
- **Vision answer shape prompt.** The prompt requires the model to answer with
  `## Transcription`, then `## Observations`, then `## Answer`.
  `## Transcription` must list every visible string of every image, verbatim,
  one per line. The prompt names `view_image` as the only way to see an image.
  It forbids `read_file` on an image path. The `VISION-UNAVAILABLE` sentinel
  is unchanged. agy does not enforce this shape. A caller must check the
  answer. An answer from this channel is not evidence. Cross-check the
  transcript against the source image.
- **`--add-dir` headless read grant.** On agy 1.1.24, no
  `read_file(<path>)` allow rule works headless except the wildcard.
  `--add-dir <dir>` grants bounded, read-only access to that directory for
  one run. `docs/COMPATIBILITY.md` has the probe table. A test for each verb
  proves that the flag reaches agy argv verbatim and in order.

### Changed

- **Owned test seams.** Tests fake seams this plugin owns, not Node built-ins.
  `scripts/lib/process-adapter.mjs` is the single spawn seam. The clock,
  `sleep`, the atomic writer, and the `{ platform, fs }` options of
  `paths.mjs` and `vision-server` are injectable with production defaults.
  The 8.3 short-name and junction cases run against a fixture volume and
  assert on every host. They no longer skip where the volume mints no alias.
  No runtime behaviour changes.

### Fixed

- **Headless permission denial reports failure.** Since agy 1.1.20, a tool
  that print mode cannot prompt for is auto-denied. The run still exits 0
  with `status: SUCCESS` and an empty response. The runtime previously
  reported this as `completed`. It now detects `auto-denied` and the quoted
  tool name on stderr. An empty answer with a denial is `failed`. The error
  names the denied tool and the remedy: `--add-dir <dir>` for `rescue` and
  `task`, and the `view_image` MCP tool for `vision`. A real answer with a
  denial remains `completed`. The denial stays on stderr and is listed in
  `details.warnings` in `--json`. An empty answer without a denial remains
  `completed`. The `CANCELED` result of older agy remains `failed`.
- **Newline after `stdin error`.** The diagnostic no longer joins the first
  line of agy's stderr.
- **Large images work with agy 1.1.24.** agy writes an MCP image result to a
  file in its conversation directory. It gives the model the note
  `[Resource offloaded to file://<X>]` instead of the pixels. The prompt now
  tells the model to open exactly that path with agy's `view_file` tool, and
  no other path. The ban on `read_file` and `view_file` for named image
  paths remains. The MCP allowlist does not change. No directory grant
  is added.
- **Failed agy results include a reason.** `parseAgyStream` reads
  `result.error`. The runtime adds `agent-runtime: agy reported error:
  <reason>` to stderr. A `--print-timeout` exits 1 with empty stderr. Before
  this change, the output did not contain the word "timeout".
- **`vision` rejects `--add-dir`.** The parser used to keep the flag without
  forwarding it to agy, so the run proceeded as if it had granted extra read
  access. `vision` now reports an argument error and exits before it reads
  or validates any image path. No directory grant exists for `vision`; the
  images named on the command line remain the only files agy can see.

## [1.0.1] — 2026-08-22

### Fixed

- **Windows 8.3 short paths are no longer treated as symlink escapes** —
  `vision-server` compared `path.resolve` against `fs.realpathSync.native()`,
  so a legitimate image under `C:\Users\RUNNER~1\…` was refused when native
  realpath expanded it to `C:\Users\runneradmin\…`. Both sides are now
  canonicalised (8.3 expanded, `\\?\` prefix stripped, case-folded) without
  following junctions, so a real junction or symlink that points elsewhere
  is still refused.
- **Windows clones no longer rewrite text to CRLF** — `.gitattributes`
  normalises text to LF and marks binary extensions as `binary`, so a
  fresh checkout matches the Unix test baseline and binary fixtures cannot
  be mangled by `core.autocrlf`.
- **One workspace no longer takes two different state locks on Windows** —
  `lockPathFor` hashed `path.resolve` output, so the short (`RUNNER~1`) and
  long (`runneradmin`) spelling of the same directory produced different
  lock paths and two processes could each hold "the" lock. It now hashes the
  canonical form. `cli-entry`'s main-module check was canonicalised for the
  same reason.
- **`spawnDetached` tests wait for the child `exit` after re-ref'ing** —
  the helper unrefs by design; tests that awaited `exit` without re-ref'ing
  left a pending promise after the event loop drained (`cancelledByParent`
  on Node 22.3, a failure on Windows).

## [1.0.0] — 2026-08-21

### Added

- **`SECURITY.md` and a README permissions/privacy section** — private
  GitHub vulnerability reporting, in-scope threat boundaries, what `setup`
  writes, how to undo it, and what each verb sends off-machine.
- **`bump-version` README Status gate** — `--check` fails if the Status
  blockquote version drifts from `package.json`; a bump rewrites it. The
  per-version README table was removed so release history lives only in
  this file.

### Changed

- **README Status line states the 1.x freeze** — the blockquote no longer
  calls the tree a pre-release or promises breaking changes until v1.0.0.
  `bump-version` still pins the `vX.Y.Z` token against `package.json`;
  `--check` fails on drift.
- **Command wrappers no longer describe their own output** — on 2026-08-21
  agy's model answered `/antigravity:status` and `/antigravity:review` with
  fabricated job tables and review verdicts, using the wrappers' column
  lists and formatting recipes as a template. Every `commands/*.md` now
  opens with a canonical refusal contract (generated by
  `hostRefusalContract` in `scripts/lib/plugin-root.mjs`, drift-tested),
  and no wrapper, `SKILL.md` row, or `agents/openai.yaml` description
  enumerates output columns, fields, or layout. A host that cannot run the
  runtime has nothing left to imitate.
- **Upgrading the agy copy needs uninstall-then-install** — a plain
  reinstall merges into `~/.gemini/config/plugins/antigravity/` instead of
  replacing it. INSTALL.md now says to run `agy plugin uninstall
  antigravity` before installing the new clone.
- **npm package is `@southcarpet/antigravity-plugin`** — standalone
  invocation is `npx @southcarpet/antigravity-plugin <command>`. The
  installed binary name remains `antigravity-plugin`.
- **`LICENSE` names the fork maintainer** — a second copyright line for
  SouthCarpet sits under the original author's. README notes that
  Antigravity, Gemini, Claude Code, and Codex are their owners' marks.
- **`SECURITY.md` only claims what this repo can see** — the plugin
  spawns `agy` and passes it prompts, context, and image bytes; what agy
  or Google does after that is out of this file's reach.
- **Dropped the `gemini-replacement` keyword** — it read as a Gemini
  substitute. This package replaced `gemini-plugin-cc`.
- **Install and invocation docs match the live hosts** — agy install is
  `agy plugin install <path-to-clone>` from a clean clone (agy copies the
  whole tree and ignores `package.json` `files`). Codex needs
  `codex plugin add antigravity@antigravity` after registering the
  marketplace. agy has no `plugin run`. After install, TUI
  `/antigravity:<verb>` locates the copied runtime; the standalone CLI is
  the fallback that always works. Tested agy versions are 1.1.15 and 1.1.17.
- **`check-pack` promises only the static pack graph** — it no longer
  tries to fail closed on computed `import()` specifiers. Distinguishing a
  regex literal from a division operator needs parser context this
  zero-dependency scanner does not have. The derived required set (host
  discovery trees, `commands/*.md`, `scripts/commands/*.mjs`,
  `scripts/mcp/*.mjs`) and the walk over static imports and literal
  `import("…")` stay. A computed specifier's target must be named by an
  explicit rule; `bin/antigravity.mjs` loading `scripts/commands/<verb>.mjs`
  already is.

### Removed

- **Unused `host-detect` and `plugin-info` modules** — they were reached
  only by tests and still shipped in the tarball. State-root selection
  stays in `state.mjs`.

### Fixed

- **agy TUI `/antigravity:<verb>` no longer looks succeeded when the plugin
  did not run** — `commands/*.md` located the runtime via
  `${CLAUDE_PLUGIN_ROOT}`, which agy does not set, so the path collapsed to
  `/scripts/commands/<verb>.mjs` and the model did the task itself. Wrappers
  now resolve the plugin root in Node (`CLAUDE_PLUGIN_ROOT` when set,
  otherwise the `agy plugin install` copy at
  `~/.gemini/config/plugins/antigravity`) and tell the reading model to
  print the error and stop if that run cannot start. The standalone CLI is
  the fallback that always works. Re-run `agy plugin install <path>` after
  upgrading; agy keeps its own copy.
- **Windows lock acquisition no longer aborts on `EPERM`/`EACCES`/`EBUSY`**
  — those codes are contention, so two concurrent job operations wait
  instead of failing.
- **`review` accepts an untracked-only working tree** — only a genuinely
  empty tree reports no changes.
- **agy binary discovery prefers `agy.exe` across `PATH`** — a `.cmd` /
  `.bat` shim is refused with an actionable message instead of failing
  with `EINVAL`.
- **`check-pack` requires every host file, not a sample** — dropping
  `commands/vision.md` or a verb module fails the gate.
- **Cancellation tests measure only cancellation** — plus coverage for
  cancelling a queued worker that has no lock yet.
- **CLI path-identity assertions run on every platform** — the suite no
  longer skips them.
- **`bump-version` no longer half-bumps on a failed write** — payloads
  are staged next to their targets first; temps are deleted if staging
  fails. Renames onto the live files are the remaining non-atomic
  window (Windows cannot atomically replace).
- **fix: host surfaces advertised different verbs** — Claude Code had no
  `commands/setup.md`, Codex's `agents/openai.yaml` omitted `vision`, and
  `review`/`rescue` were documented as background-by-default while the
  runtime is foreground unless `--background` is passed. All four hosts
  now enumerate the same verb set; docs match the code.
- **fix: `metadata.commands` broke `claude plugin validate --strict`** —
  marketplace descriptors are catalogs, not verb lists. Claude Code
  rejects the unknown field. The inventory test now derives from the
  `SKILL.md` verb table instead.

## [0.2.4] — 2026-08-19

### Fixed

- **fix: stdin envelope updated for agy 1.1.15** — the stream-json input
  message now uses the `{"event": "user", ...}` envelope. agy 1.1.15
  rejects the previous `{"type": "user", ...}` shape (accepted by 1.1.14)
  with 'stream input message is missing the "event" field', which broke
  every verb's agy call after upgrading agy. Verified live against 1.1.15
  (vision E2E, measured usage intact).

## [0.2.3] — 2026-08-19

### Fixed

- **fix: `$ARGUMENTS` blobs mangled space-bearing Windows paths** (#4) —
  `splitRawArgumentString`'s backslash-escape grammar dropped the backslash
  in front of every character (`\P` → `P`), corrupting a lone quoted blob
  like `"C:\Program Files\shot.png"`. Backslash is now always a literal
  character — there is no escape mechanism. Quotes still toggle as before;
  a literal quote inside an argument is written using the other quote type.
- **fix: `rescue`/`review`/`task` foreground progress mirrors printed raw
  NDJSON** (#1) — the three verbs still passed `onStdout` (the raw event
  stream) to their stderr progress mirror instead of `onText` (readable
  deltas), unlike `vision`, which already used it. All three now use
  `onText`, matching `vision`.
- **fix: background jobs never persisted measured `usage` /
  `durationSeconds` / `agyConversationId`** (#2) — the background worker's
  completion patch wrote `rawOutput`/`stderr`/`status`/`exitCode`/`oauthUrl`
  but dropped the measured fields `runAgyPrint` already returns.
  `/antigravity:result` now also prints a `usage: total=<N> in=<in>
  out=<out>` trailer to stderr when the stored job carries measured usage
  — the same machine-read line `vision` already prints, now for background
  jobs too.
- **fix: 13 tests failed on native Windows / Node 25** (#3) —
  `agent-runtime-deep.test.mjs` and `process-deep.test.mjs` spawned
  `#!/bin/sh` stub files (some under a literal `/tmp`), which Windows
  cannot execute and which does not exist as a path on this machine. Added
  a shared, platform-aware fake-binary factory
  (`tests/helpers/fake-agy.mjs`) and moved every affected test onto it and
  onto `os.tmpdir()`. Follow-up in the same release: the last three
  `sh`-dependent tests in `process-deep.test.mjs` now use `cmd`/`node`, so
  the suite is green regardless of whether Git-Bash `sh` is on `PATH`.
  First fully green run of the suite on native Windows.

## [0.2.2] — 2026-08-19

### Fixed

- **fix: the prompt now travels to `agy` over stdin (stream-json), not
  argv** — `runAgyPrint`/`spawnAgyDetached` used to pass the whole prompt as
  one `--print <prompt>` argv element. On Windows, `CreateProcess` caps a
  spawned command line at ~32K chars and fails outright above that (Win32
  error 206, surfaced to Node as `ENAMETOOLONG`); long review/rescue/task
  briefs routinely cross it. Every invocation now runs `agy ... --print ""`
  and writes one NDJSON line (`{"type":"user","message":{...}}`) to stdin,
  removing the limit.
- **fix: background jobs (`task --background`, `/antigravity:status`,
  `/antigravity:result`) no longer hang `queued` forever on Windows** —
  `startBackgroundJob` resolved the worker script path with
  `new URL(...).pathname`, which yields a POSIX-shaped path
  (`/A:/projects-vault/...`) that does not exist on disk. The spawned
  worker died `MODULE_NOT_FOUND` immediately, invisibly (stdio was
  `ignore`), and the job never left `queued` — `task --wait` hung until its
  timeout, or forever with none set. Now uses `fileURLToPath`, exported as
  `resolveWorkerPath()`.
- **fix: background job logs and `/antigravity:vision` progress no longer
  show raw NDJSON** — since the stdin transport fix above, `onStdout`
  delivers the raw event stream (including a ~1.2 KB `init` event) instead
  of plain text. Added `onText(delta)` to `runAgyPrint`, firing once per
  `step_update.text_delta`; the background worker's per-job log and
  `/antigravity:vision`'s stderr mirror now use it instead of raw
  `onStdout` chunks.

### Changed

- `agy` always runs with `--input-format stream-json --output-format
  stream-json` now; the old `outputFormat: 'json'` parameter on
  `runAgyPrint` is still accepted for backward compat but is a no-op — it no
  longer changes the spawned args or gates parsing.
- `usage`, `durationSeconds`, and `agyConversationId` are now always
  populated on a completed `runAgyPrint` run (previously only when
  `outputFormat: 'json'` was passed), parsed from the stream's `result`
  event via the new exported `parseAgyStream` helper.
- `runAgyPrint` no longer reports `completed` on a bare `exitCode === 0`: it
  now requires a `result` event with `status: "SUCCESS"` in the NDJSON
  stream. Exiting 0 without a `result` event, or with a non-`SUCCESS`
  result status, is `failed` with a diagnostic line in `stderr` — never a
  silent success.

## [0.2.1] — 2026-08-16

### Fixed

- **fix: command modules now execute when invoked directly** (all Claude
  Code `/antigravity:*` verbs were silently exiting 0). Every
  `commands/*.md` surface runs `node ".../scripts/commands/<verb>.mjs"
  $ARGUMENTS` directly, but the 8 command modules only exported `run()` —
  nothing called it on direct execution, so `node vision.mjs foo.png` (and
  every other verb) loaded the module and exited 0 with zero output. Added
  `scripts/lib/cli-entry.mjs` (`runIfMain`), which calls `run()` and exits
  with its code when the module is the process entrypoint, and is a no-op
  when merely `import()`ed (as `bin/antigravity.mjs` does). Applied to
  `setup`, `review`, `rescue`, `task`, `vision`, `status`, `result`,
  `cancel`.

## [0.2.0] — 2026-08-10

`agy --print` (headless print mode) has no native image ingestion path — its
`read_file` tool feeds file bytes to the model as text, `@file` prompt syntax
does not create image parts, there is no CLI attachment flag, and the
internal send-message call goes out with `media=0`. The proven fix is an MCP
tool call whose result carries an MCP image content block, which agy's
headless mode DOES pass through to the model as real pixels.

### Added

- **`/antigravity:vision`** — ask agy to look at one or more image files
  (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, ≤10 MB each). Builds a prompt
  that instructs agy to call an MCP `view_image` tool for each image before
  answering; if the tool call can't deliver real visual content, agy is
  contractually required to reply with a single `VISION-UNAVAILABLE: <reason>`
  line instead of guessing from the file name. Foreground-only in this
  version — flags: `--prompt`, `--model` (default `gemini-3.6-flash-high`),
  `--json`, `--cwd`.
- `scripts/mcp/vision-server.mjs` — the MCP stdio server behind `vision`:
  a single `view_image` tool that reads an image file off disk and returns
  it as an MCP image content block. Verified live against agy 1.1.11 /
  gemini-3.6-flash-high.
- `scripts/lib/vision-config.mjs` — idempotent, mergeable registration of
  the vision MCP server (`~/.gemini/config/mcp_config.json`) and the
  `read_file(*)` / `view_image(*)` / `mcp(*)` permissions agy needs to run
  it unattended (`~/.gemini/antigravity-cli/settings.json`). Never clobbers
  unrelated keys or invalid JSON; writes a same-day backup before the first
  change to an existing file.
- `/antigravity:setup` now runs `ensureVisionConfig()` after its OAuth probe
  succeeds (opt out with `--skip-vision`) and prints a short summary of what
  changed.
- `runAgyPrint` / `spawnAgyDetached` (`scripts/lib/agent-runtime.mjs`) accept
  optional `model` (`--model <id>`) and `extraArgs` (appended verbatim before
  `--print`) — non-breaking, both default to prior behavior when omitted.

### Fixed

- `resolveAgyBin` no longer mis-splits `PATH` on Windows (`;` via
  `path.delimiter`, not a hardcoded POSIX `:`), now probes `agy.exe` /
  `agy.cmd` / bare `agy` on `win32`, and falls back to `USERPROFILE` when
  `HOME` is unset — all silent failure modes on native Windows shells before
  this release.

## [0.1.0] — 2026-05-22

Initial release. Replaces and supersedes
[`gemini-plugin-cc`](https://github.com/sakibsadmanshajib/gemini-plugin-cc)
ahead of the June 18, 2026 Gemini CLI deprecation.

### Added

- Delegation runtime targeting **Google Antigravity CLI (`agy`)** via `agy --print`,
  `agy --continue`, and `agy --conversation <id>`. No ACP — agy 1.0.1 does not
  expose `--acp`.
- Multi-host packaging from a single source tree:
  - Claude Code (`.claude-plugin/plugin.json` + `marketplace.json`).
  - Codex CLI (`.codex-plugin/plugin.json`).
  - agy itself (`plugin.json` at root — importable via `agy plugin import claude`
    or installable via `agy plugin install antigravity@antigravity`).
  - Standalone CLI (`npx antigravity-plugin`).
- `/antigravity:setup` interactive auth wizard; background workers also surface
  the OAuth URL via `/antigravity:status` for re-auth flows.
- `/antigravity:review`, `/antigravity:rescue`, `/antigravity:status`,
  `/antigravity:result`, `/antigravity:cancel`, `/antigravity:task` commands
  (ported from `gemini-plugin-cc` v1.0.1).

### Removed

- All ACP client / broker code (`acp-client`, `acp-broker`, `acp-diagnostics`).
  agy does not speak ACP.
- Live token streaming and thought-chunk surfacing — `agy --print` returns a
  single final response.
- `gemini --experimental-acp` runtime path — deprecation deadline is too close
  to maintain a transitional fallback.

[Unreleased]: https://github.com/SouthCarpet/antigravity-plugin/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/SouthCarpet/antigravity-plugin/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/SouthCarpet/antigravity-plugin/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/SouthCarpet/antigravity-plugin/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/SouthCarpet/antigravity-plugin/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/SouthCarpet/antigravity-plugin/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/SouthCarpet/antigravity-plugin/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/SouthCarpet/antigravity-plugin/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0.2.4...v1.0.0
[0.2.4]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SouthCarpet/antigravity-plugin/releases/tag/v0.1.0
