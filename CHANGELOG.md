# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
    or installable via `agy plugin install antigravity@sakibsadmanshajib`).
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

[Unreleased]: https://github.com/sakibsadmanshajib/antigravity-plugin/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sakibsadmanshajib/antigravity-plugin/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sakibsadmanshajib/antigravity-plugin/releases/tag/v0.1.0
