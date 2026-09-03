# Security policy

This plugin is a one-maintainer fork. Security reports are handled on a
**best-effort** basis. There is no dedicated security team, no SLA, and no
CVE assignment process beyond what GitHub provides.

## How to report

Use **GitHub private vulnerability reporting** on
[SouthCarpet/antigravity-plugin](https://github.com/SouthCarpet/antigravity-plugin/security/advisories/new).

[Code scanning](https://github.com/SouthCarpet/antigravity-plugin/security/code-scanning) with CodeQL and Dependabot are the repository's automated checks, and [Socket](https://socket.dev/npm/package/@southcarpet/antigravity-plugin) scores the published package.

Do **not** open a public issue with exploit details, payloads, or a
proof-of-concept that would help someone else reproduce a local-file or
credential leak.

If the private-reporting form is not available, open a public issue that
says only that you need a private contact path (no technical details), or
wait until reporting is enabled. Do not email unsolicited exploit files.

Please include:

- the plugin version (`npx @southcarpet/antigravity-plugin --version`);
- the host (Claude Code, Codex CLI, agy-native, or standalone);
- OS and Node version;
- what you expected vs what happened;
- a minimal reproduction that does **not** require publishing private
  repository contents.

## In scope

Issues in **this repository's shipped code** that let a caller, a prompt,
or a local process do something the plugin claims it will not do:

- bypass of the vision MCP path allowlist (reading a file that was not
  named on that `vision` invocation, following a symlink/junction to a
  different file, or serving image bytes when no allowlist is present);
- `setup` overwriting a foreign `mcpServers.vision` entry, deleting
  unrelated `~/.gemini` settings, or writing a permission other than the
  documented `mcp(vision/view_image)` rule;
- command injection or unexpected process spawn when resolving `agy` or
  the bundled vision server;
- leakage of Google OAuth tokens or other credentials that this plugin
  itself stores or prints (agy's own credential store is **out of scope**
  unless this plugin copies or logs it);
- a documented undo path (`setup --remove-vision`) that leaves plugin-owned
  vision configuration in place while claiming success.

## Out of scope

- Google Antigravity CLI (`agy`), Gemini models, and Google's cloud
  processing of prompts, diffs, and images;
- Claude Code, Codex CLI, and other hosts that load this plugin;
- issues that require an already-compromised machine, a malicious `agy`
  binary on `PATH`, or a caller who already has write access to
  `~/.gemini`;
- prompt injection that only changes **model text**, as long as the
  plugin still does not read extra files or escalate local permissions;
- denial of service against Google APIs, quota exhaustion, or token spend;
- the original upstream plugin, except code that this fork still ships.

## What this plugin actually does on the machine

### `setup` (persistent, user-wide)

Successful `setup` without `--skip-vision` writes under `~/.gemini`:

- `config/mcp_config.json` — registers `mcpServers.vision` as this Node
  executable plus the bundled `scripts/mcp/vision-server.mjs`;
- `antigravity-cli/settings.json` — adds the exact allow rule
  `mcp(vision/view_image)`;
- `antigravity-plugin-vision.json` — an ownership receipt used for undo;
- `antigravity-plugin-vision.lock` — a transient lock file.

That permission is **user-wide**. Any later `agy --print` session can
*attempt* the `vision/view_image` tool. The bundled server still denies
every path unless that process was given this invocation's allowlist
(see below). `setup` does not upload files. It does spawn agy so the user
can complete Google's OAuth in that CLI. This plugin does not write OAuth
tokens; whatever agy stores afterwards is agy's own behaviour.

Undo with `setup --remove-vision`. Removal is limited to plugin-owned
vision entries described in the
[compatibility contract](./docs/COMPATIBILITY.md#vision-configuration).
It does not revoke Google OAuth, delete job state, or touch unrelated MCP
servers.

### `vision` (per invocation)

`vision` sets `ANTIGRAVITY_VISION_ALLOWED_PATHS` to a JSON array of the
absolute paths named on that command, then starts agy. The MCP server:

- grants **no** image access when that value is missing or invalid;
- rejects every path not on the list;
- rejects symlink/junction resolution to a different file;
- accepts only `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, ≤ 10 MiB each.

Users should not set `ANTIGRAVITY_VISION_ALLOWED_PATHS` globally.

### What this plugin passes to agy, and when

This plugin does not talk to Google itself. Delegated verbs spawn `agy` and
pass it prompts, collected context, and (for vision) image bytes the local
MCP server read. What agy transmits, stores, or bills after that spawn is
agy's and Google's behaviour, not this plugin's.

| Verb | Passed to agy | Stays local to this plugin |
|---|---|---|
| `setup` | The OAuth probe process (browser / agy credential flow) | `~/.gemini` vision config, ownership receipt |
| `review` | Git metadata, the review prompt, and the collected diff / untracked snippets | Plugin job state under the host data directory (or the temp fallback) |
| `rescue` / `task` | The user prompt; agy may also read workspace files with its own tools, including `--add-dir` extra roots | Plugin job state |
| `vision` | The text prompt and the image bytes of allowlisted files (base64 MCP image content via agy) | The image files themselves; MCP reads them only for that invocation |
| `status` / `result` / `cancel` | Nothing via this plugin | Job JSON/logs; `cancel` only signals local processes |

Assume anything you hand to `review`, `rescue`, `task`, or `vision` is
visible to agy. Secrets in a diff, an untracked file, a prompt, or a
screenshot are secrets you chose to give that process.

This plugin does not bill or estimate cost. Images are large. Successful
`vision` and `result` (when usage was stored) print
`usage: total=<N> in=<N> out=<N>` on stderr from whatever agy reported;
this plugin does not estimate missing counts.

## Provenance

From 1.1.0, `.github/workflows/release.yml` publishes releases through npm
trusted publishing. npm attaches a provenance attestation. It binds the
tarball to this public repository, the tagged commit, and the workflow run.
No npm token is stored. The job holds only `id-token: write` and
`contents: read`.

Verify a version with
`npm view @southcarpet/antigravity-plugin@X.Y.Z dist.attestations` and, in a
fresh install, `npm audit signatures`. The full steps, and how the signed
release tag ties in, are in [docs/RELEASING.md](./docs/RELEASING.md).

A valid attestation identifies where a tarball came from. It does not review
the code. It does not cover `agy` or the hosts that load this plugin.

## Threat boundaries this plugin does **not** close

- agy is a general tool-using agent. `rescue` and `task` can change the
  workspace if agy chooses to. `review` is prompted to be read-only; that
  is a prompt, not an OS sandbox.
- The vision MCP allowlist is per Node process, not a global mandatory
  access control system. A modified server binary, a replaced
  `mcpServers.vision` command, or a hand-started server with a forged
  allowlist is outside this plugin's guarantee.
- Job logs under the state root can contain model output and prompts.
  Protect that directory as you would other local project metadata.
