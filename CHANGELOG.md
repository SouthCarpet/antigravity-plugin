# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  onto `os.tmpdir()`. First fully green run of the suite on native Windows.

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

[Unreleased]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/SouthCarpet/antigravity-plugin/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SouthCarpet/antigravity-plugin/releases/tag/v0.1.0
