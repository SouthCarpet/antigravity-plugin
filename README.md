# antigravity-plugin

[![Latest release](https://img.shields.io/github/v/release/SouthCarpet/antigravity-plugin?label=release)](https://github.com/SouthCarpet/antigravity-plugin/releases)
[![Known issues](https://img.shields.io/github/issues/SouthCarpet/antigravity-plugin/known%20issue?label=known%20issues&color=D93F0B)](https://github.com/SouthCarpet/antigravity-plugin/issues?q=is%3Aissue+is%3Aopen+label%3A%22known+issue%22)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

Multi-host plugin for delegating tasks and code reviews to
[Google Antigravity CLI (`agy`)](https://antigravity.google).

> **This is a maintained fork** of
> [sakibsadmanshajib/antigravity-plugin](https://github.com/sakibsadmanshajib/antigravity-plugin)
> (credit to the original author for the plugin architecture). The fork is
> currently **functional against Antigravity CLI 1.1.x — including image
> analysis**: it adds a working vision channel (`/antigravity:vision`, MCP
> image server), headless permission setup for agy's auto-deny print mode,
> and Windows binary-resolution fixes. See [`CHANGELOG.md`](./CHANGELOG.md)
> for the full delta.

Replaces [`gemini-plugin-cc`](https://github.com/sakibsadmanshajib/gemini-plugin-cc),
which is archived because Google [retires Gemini CLI on June 18, 2026](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
for free / personal users.

## Status

> **Pre-release (v0.2.4).** Active development. Expect breaking changes until
> v1.0.0. See [`CHANGELOG.md`](./CHANGELOG.md).

## CI

Every pull request targeting `main`, and every push to `main`, runs the full
matrix on **Ubuntu and Windows**.

**Full suite** — Node **22.3.x** (the `engines.node` floor and the first Node
22 release that supports `mock.module()` and
`--experimental-test-module-mocks`) and Node **24** (current Active LTS).
This is the job that must be green:

1. Runs the full test suite (`node --test --experimental-test-module-mocks tests/*.test.mjs`).
2. Checks that the seven host version scalars agree (`node scripts/check-manifests.mjs`).
3. Dry-runs `npm pack` and asserts the tarball still contains what Claude Code, Codex CLI, agy, and the standalone CLI need (`node scripts/check-pack.mjs`).

There is no `npm ci` step: this package has no dependencies and no lockfile.
`claude plugin validate` is not run in CI (the Claude Code CLI is not a clean
unattended install). `check-pack` fails if any required host file, including
the Codex discovery files `SKILL.md` and `.agents/plugins/marketplace.json`,
drops out of the tarball.

## Release notes

Full notes per release live on the
[**Releases page**](https://github.com/SouthCarpet/antigravity-plugin/releases);
the complete history is in [`CHANGELOG.md`](./CHANGELOG.md).

| Version | Date | Highlights |
|---|---|---|
| [v0.2.4](https://github.com/SouthCarpet/antigravity-plugin/releases/tag/v0.2.4) | 2026-08-19 | stdin envelope updated for agy 1.1.15 (`event: user`) - agy calls broken after the agy upgrade work again |
| [v0.2.3](https://github.com/SouthCarpet/antigravity-plugin/releases/tag/v0.2.3) | 2026-08-19 | All four tracked known issues fixed (space-bearing Windows paths, `rescue`/`review`/`task` progress mirrors, background-job usage persistence, POSIX-only tests); first fully green test suite on Windows |
| [v0.2.2](https://github.com/SouthCarpet/antigravity-plugin/releases/tag/v0.2.2) | 2026-08-19 | Prompt travels over **stdin (stream-json)** — no more ~32 K Windows argv crash on long briefs; background jobs un-broken on Windows (`fileURLToPath` worker path); readable progress via `onText`; token usage always captured |
| [v0.2.1](https://github.com/SouthCarpet/antigravity-plugin/releases/tag/v0.2.1) | 2026-08-16 | All `/antigravity:*` verbs actually execute when invoked from Claude Code (main-guard `runIfMain`; they used to exit 0 silently) |
| [v0.2.0](https://github.com/SouthCarpet/antigravity-plugin/releases/tag/v0.2.0) | 2026-08-10 | **Vision channel** for headless agy (`/antigravity:vision`, bundled MCP `view_image` server, permission auto-setup); Windows binary-resolution fixes |

## What it does

Spawns `agy --print` (or `--continue` / `--conversation <id>`) from inside your
preferred AI host so you can:

- Get a code review of your uncommitted changes or a branch diff.
- Ask agy to look at an image (screenshot, chart, diagram) via a local MCP
  vision channel — see [Vision](#vision) below.
- Delegate a fix, investigation, or refactor without leaving your current host.
- Run multiple delegations in parallel with background job tracking.

## Where it runs

| Host             | Install command                                                    |
|------------------|--------------------------------------------------------------------|
| Claude Code      | `claude plugin marketplace add SouthCarpet/antigravity-plugin` then `claude plugin install antigravity@antigravity` |
| Codex CLI        | `codex plugin marketplace add <path-to-clone>` then `$antigravity setup` (see [docs/INSTALL.md](./docs/INSTALL.md)) |
| Antigravity (agy)| `agy plugin install` from a local clone of this fork               |
| Standalone       | Clone this fork, then run `node bin/antigravity.mjs <command>`; this package is not currently published to npm |

## Requirements

- Node.js ≥ 22.3.0
- `agy` v1.1.15 on `PATH` ([install from antigravity.google](https://antigravity.google/download)); other versions are not part of the tested compatibility matrix
- A Google account for `agy` OAuth (run `agy --print 'hi'` once or `/antigravity:setup`)

### Job state location

Tracked jobs use the first non-empty host data variable in this compatibility
order: `CLAUDE_PLUGIN_DATA`, `CODEX_PLUGIN_DATA`, then `AGY_PLUGIN_DATA`.
Standalone runs with none of those variables set use
`<os-temporary-directory>/antigravity`. Codex and agy installations upgraded
from a version that ignored their host variable continue to read and write an
existing workspace state directory at that legacy temporary location; new
workspaces use their host-owned data directory.

## Quick start (Claude Code)

```bash
# 1. add the marketplace (this fork)
claude plugin marketplace add SouthCarpet/antigravity-plugin

# 2. install
claude plugin install antigravity@antigravity

# 3. one-time auth
/antigravity:setup

# 4. use
/antigravity:review
/antigravity:rescue investigate why the tests started failing
```

## Vision

`agy --print` (headless print mode) has **no native image ingestion path**: its
`read_file` tool feeds file bytes to the model as text, `@file` prompt syntax
does not create image parts, there is no CLI attachment flag, and the internal
send-message call goes out with `media=0`. Ask it to "look at" a screenshot
and it will politely tell you it cannot see images.

The one channel that DOES deliver real pixels in `--print` mode is an MCP
tool call whose result contains an MCP image content block
(`{ type: "image", data: <base64>, mimeType }`). `/antigravity:setup`
registers a small local MCP server (`scripts/mcp/vision-server.mjs`) that
exposes a `view_image` tool for exactly this, and `/antigravity:vision`
builds a prompt that instructs agy to call that tool for each image you give
it before answering. Setup persists only the exact headless permission
`mcp(vision/view_image)`. Each invocation separately passes an allowlist of
the user-named image paths; the server denies every other path and denies all
access when no invocation allowlist is present.

```bash
# one-time (also runs your normal OAuth setup)
/antigravity:setup

# remove only the persistent MCP entry and permission setup added
/antigravity:setup --remove-vision

# describe a screenshot
/antigravity:vision ./screenshot.png

# ask a specific question
/antigravity:vision ./chart.png --prompt "does this chart render the values 3, 5, 8?"

# compare two images
/antigravity:vision before.png after.png --prompt "what changed between these two?"
```

Supported formats: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, up to 10 MB each.
`/antigravity:vision` is foreground-only (no `--background`) and requires
`/antigravity:setup` to have run at least once (skip with `setup --skip-vision`
if you don't want it; undo with `setup --remove-vision`). If the MCP channel
isn't available for any reason, agy
is instructed to reply with `VISION-UNAVAILABLE: <reason>` rather than guess
from the file name — treat that line as a health signal, not a real answer.

## Known issues

All four issues tracked before v0.2.3 are fixed in v0.2.3. Open ones live
under the
[`known issue` label](https://github.com/SouthCarpet/antigravity-plugin/issues?q=is%3Aissue+is%3Aopen+label%3A%22known+issue%22):

| # | Issue | Workaround |
|---|---|---|
| [#5](https://github.com/SouthCarpet/antigravity-plugin/issues/5) | Latent: if `agy` resolves to a **`.cmd` shim** on Windows, spawning it fails with `EINVAL` on Node ≥ 20.12.2 (untraveled with a normal `agy.exe` install) | Point `AGY_BIN` at the real `agy.exe` |

## Documentation

- [Installation](./docs/INSTALL.md) — per-host setup recipes
- [1.x compatibility contract](./docs/COMPATIBILITY.md) — supported matrix, outputs, state, and versioning promises
- [Commands reference](./docs/COMMANDS.md) — all eight verbs, flags, defaults, and exit behavior
- [Spike findings](./docs/SPIKE-findings.md) — why we dropped ACP

## License

MIT — see [`LICENSE`](./LICENSE).
