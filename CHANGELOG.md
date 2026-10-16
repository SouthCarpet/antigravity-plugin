# Changelog

All notable changes to this project are listed here, as short user-facing notes.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.1] — 2026-10-16

### Changed

- Shorten the README and historical release notes. Keep future release notes brief.
- Load all nine native commands in agy. Existing agy users must reinstall from a prepared copy; see the installation guide.
- Accept both legacy and current agy validation output in smoke checks.
- Keep Linux builds on Ubuntu 24.04.

## [3.0.0] — 2026-10-08

### Breaking

- **`vision` now defaults to `gemini-3.8-flash-high`** (was `gemini-3.6-flash-high`). This is the only breaking change; all other verbs, flags, exit codes, `--json` fields, and state locations of 2.x keep their meaning.
  - Why: on agy 1.3.1, the old default failed 2 of 5 test runs with a "no capacity" error; the new one completed 5 of 5. It uses more tokens per run. Five runs per model is a small sample.
  - Action: to keep the old model, pass `--model gemini-3.6-flash-high`. It can fail with the capacity error again.

### Security

Upgrade to 3.0.0 to get all of these fixes.

- **`update --apply` verifies the agy package.** It now checks the downloaded package against the npm registry record and stops before uninstalling the old copy if the check fails. Affects users of `update --apply` for agy. If the registry is unreachable, the agy step is skipped.
- **Stricter checks on shared temp state.** Shared POSIX hosts now get ownership and access checks on job state and update caches. Unsafe job state is refused; an unsafe cache is ignored. State locations do not change.
- **Safer `cancel`.** The plugin now checks that a process is still the one it started before stopping it, which reduces the risk of stopping an unrelated process. The check has timing limits and is not a guarantee. A mismatch is reported as `unconfirmed` (exit 1). **Action:** for jobs created by older versions, `cancel` does not signal their processes; stop them yourself.
- **`vision` checks the image path before touching the filesystem.** Affects Windows users. A path that is not on the per-run allowlist, including a different spelling of an allowed file, is refused.
- **Claude Code wrappers no longer pre-approve every `node` command.** Each wrapper now allows only its own command, and agy output is shown as untrusted data. Affects Claude Code users. `rescue` is now user-invoked only and supports `--background`, `--wait`, `--show-result`, and `--request-id`.
- **Only agy's own sign-in prompt reports `auth_required`.** Model text no longer triggers that status. Run `setup` to sign in. `status --json` reports `oauthUrl` as `null`.
- **Google OAuth URLs are removed from plugin output** and replaced with `[oauth-url-removed]`, including in older stored job records.

### Changed

- The 3.x compatibility contract starts here: a documented surface is marked deprecated first, stays for at least one more 3.x minor release, and is removed only in 4.0.0.
- agy 1.3.1 is now the newest measured version, with per-verb results in `docs/COMPATIBILITY.md`. 1.2.13 to 1.3.0 are not claimed as measured.
- `--effort` still accepts `low`, `medium`, `high`, and `agy-default`; the probes did not support `xhigh` or `max`.
- Failed jobs now show agy's own one-line failure reason, shortened and redacted, in `errorMessage` and in `--json` errors. Error codes, statuses, and exit codes do not change.
- Troubleshooting gained rows for a prompt that needs a shell command, a `vision` capacity error, and a reinstall blocked by another process.
- README "Why this plugin" is shorter. The release checklist asks for one docs bullet per new field and an independent fact check.

### Fixed

- A failed job no longer stores raw stderr as its failure reason.
- `update --apply` run from inside the agy install directory now moves out of it first, or stops with exit 1, instead of leaving the uninstall half-done.

## [2.1.0] — 2026-09-28

### Added

- **`doctor`**, a ninth, read-only verb. It checks Node, the `agy` binary and version, forwarded flags, the vision setup, and the job-state location. No login, no model call, no writes, no network.
- **`review` options:** `--preview` (show what would be sent), `--require-complete` (refuse an incomplete input), `--findings-json` (schema-checked findings), `--check-locations` (check cited lines against the diff; also on `result`), and `--model`, `--effort`, `--focus`.
- **`--show-result`** on `review`, `rescue`, and `task`: after a background `--wait`, print the finished answer.
- **`--request-id`** on `task` and `rescue --background`: a repeated request returns the existing job instead of starting a second one.
- **`task --prompt-file`:** read the prompt from a file, or from stdin in the standalone CLI.
- **`status --exit-status`:** exit by the waited job's outcome (0 completed, 1 failed, 2 cancelled, 3 still running at timeout).
- **`vision --expect`:** check named text against the transcription.
- **Job provenance** (plugin, agy, model, effort, mode) on every job, and the `usage:` line on stderr for `review`, `rescue`, and `task`.
- agy version warnings on `setup` and `status` when agy is outside the measured range.
- `scripts/pack-for-agy.mjs` packs the same files `npm publish` ships, for `agy plugin install`.
- A release check that blocks internal planning references in user-facing docs.

### Changed

- With `--json`, expected failures now print one error envelope on stdout instead of nothing. **Action:** scripts that treated any stdout as success should read `status`.
- Tested agy range extends to 1.2.12.
- README, commands reference, compatibility contract, and help text were brought back into agreement.

### Fixed

- Windows CI race when compiling the test helper.
- Stale "eight commands" and agy version numbers in docs.

## [2.0.2] — 2026-09-25

### Fixed

- `task` and `rescue` with `--model` and no `--effort` work again on agy 1.2.11. The plugin sends no `--effort` in that case. With neither flag, the default is still `medium`.

### Changed

- Tested agy range extends to 1.2.11. The plugin still rejects `--effort max`.

## [2.0.1] — 2026-09-19

### Added

- agy's `AGY_ERROR:` stderr line is used as the failure reason when no `error:` line is present.

### Changed

- Tested agy range extends to 1.2.7.
- `update` explains why agy needs uninstall-then-install before agy 1.1.28.

### Fixed

- Docs describe the agy 1.2.6 print-timeout change and the 1.1.28 reinstall behavior.
- Internal identifiers removed from the command and compatibility references.

## [2.0.0] — 2026-09-12

### Breaking

- **`task` and `rescue` without `--effort` now send `medium`.** Before, no effort was sent, so results depended on each machine's saved setting. `medium` can run longer and hit the time budget. **Action:** pass `--effort low` or raise `ANTIGRAVITY_AGY_TIMEOUT_MS` if needed, or `--effort agy-default` to use your own agy setting.
- **Empty SUCCESS answers are now `failed`** (exit 1 in the foreground), including runs where the only sign of trouble was a denied action. A non-empty answer with a denial stays `completed` with a warning.

### Added

- Denied actions now name the refused target when agy reports it.
- A run cut short by agy's print timeout is reported as `agyPrintTimeout`; an empty answer in that case is `failed`.
- agy's fatal `error:` line becomes the job's failure reason.
- `--effort agy-default` on `task` and `rescue`.
- A self-contained how-it-works diagram in the README, and a pack check for README images.

### Changed

- Tested agy range is 1.1.15 to 1.2.1.

### Security

- The plugin no longer repeats agy's advice to bypass permission checks.
- The `view_image` tool now rejects undeclared arguments.

## [1.3.0] — 2026-09-09

### Added

- Structured reporting of actions agy denied in headless runs, with a suggested remedy for each (agy 1.1.27 and later).
- `--effort <low|medium|high>` on `task` and `rescue`.

### Changed

- CI now also runs on macOS.

### Fixed

- Long runs no longer stop at agy's 5-minute default timeout.
- `vision` works on macOS (symlinked temp directory).
- Job state is found consistently when a workspace is reached through a symlink.

### Security

- Prompt text starting with `/` is passed to agy as plain text, never run as an agy slash command.

## [1.2.0] — 2026-09-06

### Added

- `result --head <n>` and `--tail <n>`; `status` shows answer size.
- `--model` on `task` and `rescue`.
- `update` retries failed registry requests, within a 25-second budget.
- `CONTRIBUTING.md` and Cursor rule files.

### Changed

- Unknown flags exit 1 with guidance to put prompt text after `--`.
- `npm run lint` added, with `eslint` as the only dev dependency. The published package got smaller.
- Foreground runs now store their conversation id.
- Auth-required messages use the same wording everywhere.
- `status` reads only the end of long job logs.

### Removed

- Some unused internal exports and a few never-populated fields in `status <id>` and `result`.

### Security

- Safer handling of host bootstrap, `vision` image reads, malformed or oversized MCP requests, update commands, and tampered background-job requests.
- `review` skips untracked secret-shaped files (such as `.env` and key files) and marks diffs and file contents as untrusted data.
- Correct handling of non-ASCII and renamed file names.
- On POSIX, shared temp state that you do not own or that others can write is refused.

### Fixed

- Queued and running jobs are never dropped by history cleanup.
- A damaged job index is rebuilt instead of failing.
- Background workers report health; timed-out waits point to `status`.
- Runs stop after 30 minutes by default; change it with `ANTIGRAVITY_AGY_TIMEOUT_MS` (`0` disables).
- Ctrl+C stops agy and its child processes.
- Final output is no longer lost when agy exits.
- Background launch failures fail the job and the command.
- Quoted prompts and image paths keep their boundaries.
- `review` rejects unknown and option-like base references.
- A review that quotes a sign-in URL no longer reports `auth_required`.
- `status` table cells escape backslashes correctly.

## [1.1.3] — 2026-09-04

### Changed

- Same content as 1.1.2, republished because the 1.1.2 npm publish was lost to a registry incident. The runbook now checks the npm status page before tagging.

## [1.1.2] — 2026-09-03

### Added

- `docs/` and `CHANGELOG.md` now ship in the package, so README links work offline.
- Checks for stale version text in docs and for README links to files missing from the package.

### Changed

- `update --apply` refreshes the Claude Code marketplace first.
- `update --apply` reports a local Codex marketplace clone and never pulls it.
- README update instructions, commands reference, and Troubleshooting were extended.

## [1.1.1] — 2026-09-03

### Added

- GitHub Packages mirror of each release.
- Troubleshooting guide in the installation docs.
- Weekly Actions dependency checks and CodeQL scanning.
- Socket badge in the README.

### Changed

- Per-host quick starts in the README; clearer release runbook.

### Fixed

- The host wrapper now refuses a plugin root whose manifest is not this plugin.
- A missing `agy` or Git gives a clear message instead of a raw Node error.
- `vision` checks the file type and size before starting agy.
- `update --apply` passes Codex a fully qualified plugin name.
- `update --apply` always asks the registry for the latest version instead of using a cached one.

## [1.1.0] — 2026-09-03

### Added

- **`update`** in the standalone CLI: checks npm for a newer version and prints, or with `--apply` runs, the update commands for each host. The plugin does not update itself.
- npm provenance through trusted publishing.
- `--mode <plan|accept-edits>` on `rescue` and `task`.
- A fixed answer shape for `vision` (`Transcription`, `Observations`, `Answer`).
- `--add-dir <dir>` grants bounded, read-only access for one run.

### Fixed

- A headless run where agy denied a tool is now `failed` when the answer is empty, and names the tool and a remedy.
- `vision` rejects `--add-dir`, which it never supported.
- Large images work with agy 1.1.24.
- Failed agy runs include a reason, and a timeout says so.

## [1.0.1] — 2026-08-22

### Fixed

- Windows: images under 8.3 short paths are no longer refused.
- Windows: one workspace no longer uses two different state locks.
- Windows: clones no longer rewrite text files to CRLF.

## [1.0.0] — 2026-08-21

### Added

- `SECURITY.md` and a Permissions and privacy section in the README.
- A check that the README Status version matches `package.json`.

### Changed

- The 1.x contract is frozen.
- The npm package is `@southcarpet/antigravity-plugin`; the binary stays `antigravity-plugin`.
- Command wrappers no longer describe their own output, which stops models from imitating it.
- agy installs need uninstall-then-install; install docs match the live hosts.

### Removed

- Unused internal modules.

### Fixed

- agy `/antigravity:<verb>` now finds the plugin and no longer looks successful when it did not run. **Action:** re-run `agy plugin install <path>` after upgrading.
- Windows lock contention no longer aborts job operations.
- `review` accepts a tree with only untracked files.
- agy binary discovery prefers `agy.exe` and refuses `.cmd` and `.bat` shims with a clear message.
- All four hosts list the same verbs; docs match the code.

## [0.2.4] — 2026-08-19

### Fixed

- Compatible with agy 1.1.15, which changed its input format and broke every verb after an agy upgrade.

## [0.2.3] — 2026-08-19

### Fixed

- Windows paths with spaces in `$ARGUMENTS` are no longer mangled.
- Foreground progress shows readable text, not raw event data.
- Background jobs now save usage, duration, and conversation id.
- Test suite passes on native Windows.

## [0.2.2] — 2026-08-19

### Fixed

- Long prompts no longer fail on Windows; they are sent over stdin.
- Background jobs no longer stay `queued` forever on Windows.
- Job logs and `vision` progress show readable text, not raw event data.

### Changed

- A run counts as completed only when agy reports success, not on exit code 0 alone.

## [0.2.1] — 2026-08-16

### Fixed

- All Claude Code `/antigravity:*` verbs ran silently and exited 0 without output. They now run.

## [0.2.0] — 2026-08-10

### Added

- **`vision`**: ask agy about one or more image files (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, up to 10 MB each) through a local MCP server. If the images cannot be delivered, the answer is `VISION-UNAVAILABLE: <reason>`.
- `setup` registers the vision server after a successful sign-in probe (skip with `--skip-vision`).

### Fixed

- agy lookup on native Windows (`PATH` splitting, `.exe` and `.cmd`, home directory).

## [0.1.0] — 2026-05-22

Initial release. Replaces [`gemini-plugin-cc`](https://github.com/sakibsadmanshajib/gemini-plugin-cc) ahead of the June 18, 2026 Gemini CLI deprecation.

### Added

- Delegation to Google's Antigravity CLI (`agy`) for Claude Code, Codex CLI, agy, and a standalone CLI.
- `setup`, `review`, `rescue`, `task`, `status`, `result`, and `cancel`.

### Removed

- All ACP code, since agy does not support ACP, and live token streaming.

[Unreleased]: https://github.com/SouthCarpet/antigravity-plugin/compare/v3.0.1...HEAD
[3.0.1]: https://github.com/SouthCarpet/antigravity-plugin/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/SouthCarpet/antigravity-plugin/compare/v2.1.0...v3.0.0
[2.1.0]: https://github.com/SouthCarpet/antigravity-plugin/compare/v2.0.2...v2.1.0
[2.0.2]: https://github.com/SouthCarpet/antigravity-plugin/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/SouthCarpet/antigravity-plugin/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/SouthCarpet/antigravity-plugin/compare/v1.3.0...v2.0.0
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
