# antigravity-plugin

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

> **Pre-release (v0.2.2).** Active development. Expect breaking changes until
> v1.0.0. See [`CHANGELOG.md`](./CHANGELOG.md).

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
| Standalone       | `npx antigravity-plugin <command>` (upstream npm name; from this fork prefer `node bin/antigravity.mjs <command>`) |

## Requirements

- Node.js ≥ 18.18.0
- `agy` v1.0.1+ on `PATH` ([install from antigravity.google](https://antigravity.google/download))
- A Google account for `agy` OAuth (run `agy --print 'hi'` once or `/antigravity:setup`)

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
it before answering.

```bash
# one-time (also runs your normal OAuth setup)
/antigravity:setup

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
if you don't want it). If the MCP channel isn't available for any reason, agy
is instructed to reply with `VISION-UNAVAILABLE: <reason>` rather than guess
from the file name — treat that line as a health signal, not a real answer.

> **Known issue:** invoking the command with a SINGLE argument whose path
> contains a **space** (e.g. `/antigravity:vision "C:\Program Files\shot.png"`
> with nothing else) still mis-parses the path. Workaround until fixed: add
> any second token (`--prompt "..."` or a second image), or use a space-free
> path. Space-free single paths and all multi-argument invocations work.

## Documentation

- [Installation](./docs/INSTALL.md) — per-host setup recipes
- [Spike findings](./docs/SPIKE-findings.md) — why we dropped ACP
- [Commands reference](./docs/COMMANDS.md) (coming soon)

## License

MIT — see [`LICENSE`](./LICENSE).
