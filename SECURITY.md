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

### `doctor` (read-only)

`doctor` reads `process.version`, this package's own `package.json`, the
resolved `agy` binary's `--version` and `--help` output, the same two
`~/.gemini` config files `setup`'s vision step writes (read-only, never
the OAuth token store), and the job-state root. It never runs OAuth, never
calls a model, never writes a file anywhere, and never opens the network.
`tests/doctor.test.mjs` proves this with a byte-for-byte snapshot of an
isolated `HOME`/`USERPROFILE` before and after a full run.

### `vision` (per invocation)

`vision` sets `ANTIGRAVITY_VISION_ALLOWED_PATHS` to a JSON array of the
absolute paths named on that command, resolved to their realpath, then
starts agy. The MCP server:

- grants **no** image access when that value is missing or invalid;
- rejects every path not on the list, checked both as given and by its own
  realpath — an ancestor directory symlink (macOS's `os.tmpdir()` resolves
  through `/var` -> `/private/var`) is accepted when the resolved path is
  itself an authorized entry, never merely because it resolves to something;
- rejects the requested file itself being a symlink, unconditionally, even
  when its target is also an authorized entry;
- accepts only `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, ≤ 10 MiB each.

Reading through a checked file handle closes stat-then-read substitution and
bounds image allocation even if a file grows after the check.
These checks are not a proof against every parent-directory race.
Malformed MCP input receives a protocol error without killing the server
(notifications remain unanswered); input frames are capped at 64 KiB and
replies wait for stdout drain before the next request is processed.

Users should not set `ANTIGRAVITY_VISION_ALLOWED_PATHS` globally.

### `task --prompt-file` / stdin

`task --prompt-file <path>` reads exactly the one file named on the command
line, resolved against the invocation's own working directory, and nothing
else: no directory listing, no glob, no following the file to a different
location after it is opened. Reading is capped at 512 KiB; an oversized,
missing/unreadable, or empty/whitespace-only source is refused before agy is
ever probed or spawned. `--prompt-file -` reads stdin to EOF instead, under
the same cap, and only from the standalone CLI run directly by a person or
script. A host wrapper (Claude Code, Codex CLI, the agy TUI) refuses it,
because that host already owns stdio for its own protocol.

Neither the file's path nor the prompt's content ever appears in a stderr
diagnostic or in the job's stored `provenance`: a refusal names the byte cap
and the actual size, or a fixed reason, never the path or the content that
triggered it.

### `review` context sent to agy

An untracked file whose basename looks like a secret (`.env` and its
variants, `.pem`/`.key`/`.p12`/`.pfx`, or a default SSH private-key name) is
never read or sent; it is listed to agy only as skipped, with that reason.
Diffs, commit messages, and untracked file contents that are sent are wrapped
in a labeled data block that tells the model the content is untrusted
repository data, not instructions — this narrows, but does not eliminate,
prompt injection from repository content (see "Out of scope").

The optional `--focus <text>` is caller text only: it comes from the
invocation's own flag, never from the diff or any other repository content,
and the plugin never infers it. When given, it is
placed in its own "## Reviewer focus (caller instruction)" section, outside
every data block, so it is never mistaken for reviewed content and cannot be
used to smuggle instructions through the untrusted data blocks above.

`review --preview` shows exactly what a real run would send to agy: the same
included/skipped file lists, the same truncation state, and the SHA-256 hash
of the exact prompt string a real run would compute, all from the one
`buildReviewInput` selection function every path (`--preview`, foreground,
background) calls. It never calls agy itself. The hash lets a caller confirm,
after the fact, exactly which input a completed job actually sent, by
comparing the stored `request.inputHash` against a fresh `--preview` run on
the same tree. `review --require-complete` refuses to send an input that
left something out (a skipped file, a diff cut by the cap) instead of
sending it silently with a warning; the refusal happens before agy is ever
probed or spawned.

### Headless denial reporting

When a tool is auto-denied in headless mode (agy >= 1.1.20), the plugin only
reports it — on stderr, in `--json`, and in `status`/`result` — with a
remedy for the caller to apply on the next invocation. It never auto-grants
the denied action, never retries with `--dangerously-skip-permissions`, and
never writes a permission rule on the caller's behalf. Since agy 1.1.27 the
JSON `denied_actions` field is parsed as untrusted, agy-reported diagnostic
text: each `action`/`display_name` string is validated, length-capped, and
stripped of control characters before it is ever rendered or written to a
job record.

Since plan 086 T3, the target agy named for the denial (model-chosen
tool-parameter text, equally untrusted) is validated, length-capped, and
control-character-stripped the same way before display. It is shown to the
caller for context only; the plugin never assembles it into a
`permissions.allow` rule and never writes a wildcard rule on the caller's
behalf. agy's own headless-denial sentinel also ends with its own bypass
suggestion ("... re-run with `--dangerously-skip-permissions` ..."); the
plugin no longer prints that sentence to its own stderr (the stored result
and `result --json` still keep the complete upstream line).

### Slash and skill commands in prompts

Every print-mode `agy` invocation (`review`, `rescue`, `task`, `vision`)
forwards `--disable-slash-commands`. Without it, prompt text beginning with
`/` — including untrusted diff, review, rescue, or task content this plugin
sends as plain prompt text, not as instructions — would be parsed and
executed as an agy slash command or skill instead. This closes that
expansion path for every prompt this plugin builds; it is not an OS sandbox
around what agy itself may do once a run starts.

### Shared temporary directories (POSIX)

The job state root, the per-workspace directory created under it, the
`jobs` directory beneath that, the cross-process lock directory, and the
update-check cache directory each refuse to use a directory that already
exists with a different owner, that is writable by the directory's group or
by anyone else, or that is a symlink. Every level is checked, not only the
leaf that a call happens to create. This matters only on a shared
multi-user Linux host, where another local user could otherwise pre-create
or replace one of these paths under the OS temp directory before this
plugin runs. Windows and macOS are unaffected: `%TEMP%`/`$TMPDIR` are
already per-user there.

### The `node -e` host bootstrap snippet

Every `commands/*.md` wrapper's `node -e "..."` line (or, for `rescue`, the
embedded invocation the wrapper's own text tells the host model to run) does
four things, in this order: resolve the plugin root the same way
`resolvePluginRoot` does (`CLAUDE_PLUGIN_ROOT` when set and non-empty, else
the agy install copy under the home directory); read `<root>/plugin.json`
and refuse with one line — before requiring anything from that root — when
the manifest is missing or names a different plugin; check that the shipped
`scripts/lib/host-bootstrap.cjs` file exists and refuse with one line when it
does not; only then `require()` that module and call `run(root,
verb)`, which spawns `scripts/commands/<verb>.mjs` and passes its exit code
through. That module — a real, reviewable, tested file, not generated text —
carries its own copy of the same manifest check as a second layer, in case
it is ever reached by a caller other than this snippet. The root comes from
the environment at run time; no host input is interpolated into executed
source — the manifest field name and the verb are the only literals the
generated text carries, and both are constants this plugin controls.

### `update --apply`

On Windows, the update runner refuses a `.cmd`/`.bat` step before spawning
when its command path or any argument contains `&`, `|`, `<`, `>`, `^`, `%`,
`!`, `"`, or a carriage return/newline.

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
| `doctor` | Nothing to agy beyond `--version` and `--help` (no prompt, no OAuth) | Node version, agy version/flags, vision config presence, job-state root: all read-only, never written anywhere |

Assume anything you hand to `review`, `rescue`, `task`, or `vision` is
visible to agy. Secrets in a diff, an untracked file, a prompt, or a
screenshot are secrets you chose to give that process.

This plugin does not bill or estimate cost. Images are large. `review`,
`rescue`, `task`, and `vision` (on a successful run) and `result` (when usage
was stored) print `usage: total=<N> in=<N> out=<N>` on stderr from whatever
agy reported; this plugin does not estimate missing counts.

### Job provenance record

Not to be confused with the npm release provenance below: this is a
per-job record, `provenance`, stored on every job from creation
(`scripts/lib/job-helpers.mjs#createTrackedJob`).

Stored: the plugin's own running version, the `agy --version` string the
verb's own probe reported, the resolved `--model`/`--effort` values
(including the `agy-default` sentinel), the run mode (`print`, `continue`,
or `conversation`), the count of `--add-dir` values, and the ISO timestamp
the job was requested.

Excluded, always: the prompt text, the workspace path, image paths, the
content of `extraArgs`, and any tool list. `status <id>` and `result <id>`
render the stored record as a "## Provenance" section; a legacy job written
before this field existed renders and reports it as absent, never as an
error.

### Request fingerprint (`--request-id`)

A background `task` or `rescue` started with `--request-id <id>` stores the
id and a fingerprint on the job request (`request.requestId`,
`request.requestFingerprint`), and the pair in `state.json`'s `requestIds`
map. The fingerprint is a sha256 hash of the request, which includes the
prompt, the conversation id, the `--add-dir` paths, the model, the effort,
and the workspace root. The hash adds no new exposure: the prompt and those
fields are already stored in plain text on the same job record, in the same
private job state directory. The plugin compares fingerprints only to
decide whether a repeated id is the same request; it never retries a call
by itself.

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

### Installing into agy from the same artifact npm publishes

`agy plugin install <path>` copies whatever directory you point it at. A
plain clone also copies `.git`, `.github`, and `tests/`, none of which npm
ever publishes. `scripts/pack-for-agy.mjs` closes that gap: it uses the same
packing logic `npm publish` uses (`npm pack`), extracts the result, and
prints the integrity hash (sha512, the value npm itself verifies), the
shasum (sha1), and the exact `agy plugin install <dir>` command. The
installed copy is then the published artifact, not the whole working tree.
The script itself never runs `agy` and never writes under `~/.gemini`; it
only reads the checkout and writes to a temporary directory.

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
- The host wrapper reads `<plugin root>/plugin.json` and refuses to spawn
  anything unless that manifest names this plugin. An attacker who can set the
  host's environment already has code execution on that machine, so this check
  limits accidental misdirection, for example a stale or half-removed install
  copy in `CLAUDE_PLUGIN_ROOT`. It is not a defence against a hostile host.
