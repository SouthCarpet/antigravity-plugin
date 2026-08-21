# Antigravity plugin 1.x compatibility contract

This document defines the public contract for `antigravity-plugin` 1.0.0 and
later 1.x releases. The implementation at 0.2.4 is the baseline from which
the contract was frozen. A behavior is public only when this document or the
[commands reference](./COMMANDS.md) says it is promised.

## Supported matrix

| Surface | Supported in 1.x |
|---|---|
| Hosts | Claude Code (`/antigravity:<verb>`), Codex CLI (`$antigravity <verb>`), agy-native (`agy plugin run antigravity <verb>`), and the standalone CLI (`npx @southcarpet/antigravity-plugin <verb>`, `antigravity-plugin <verb>` after install, or `node bin/antigravity.mjs <verb>`) |
| Operating systems | Linux and Windows. Both run the full CI suite. macOS and other Node platforms are best-effort, not part of the compatibility promise. |
| Node.js | `>=22.3.0` |
| Google Antigravity CLI | `agy` 1.1.15. Other versions may work, but are not in the tested or promised matrix. |

The standalone package-binary spelling (`antigravity-plugin`) is the CLI
interface name after install. The published npm package is
`@southcarpet/antigravity-plugin`. The supported distributed path is
`npx @southcarpet/antigravity-plugin <verb>`; a clone may still run
`node bin/antigravity.mjs <verb>`.

The Node floor is 22.3.0 because Node 18 and 20 are EOL as of this contract,
and 22.3.0 is the first Node 22 release on which this repository's full test
suite can run (`mock.module()` and `--experimental-test-module-mocks`). The
runtime has no npm dependencies.

The agy version is intentionally narrow. Every delegated verb uses agy's
stream-JSON input and output. agy 1.1.15 rejected the input envelope accepted
by 1.1.14, breaking every delegated verb until this plugin changed its
transport. `setup` probes and displays the installed version but does not
enforce this matrix; that probe succeeding is not a promise that an unlisted
agy version is compatible.

Host installers and host-owned invocation wrappers can evolve independently.
The promise is that the four surfaces above invoke the same eight runtime
verbs and accept the documented arguments when the host can load this plugin.

## Public command surface

The public verbs are exactly:

`setup`, `review`, `rescue`, `task`, `vision`, `status`, `result`, and `cancel`.

Their positional arguments, flags, defaults, conflicts, and foreground versus
background behavior are defined in [COMMANDS.md](./COMMANDS.md). Verb names,
documented flag names, documented positional meanings, and documented defaults
are stable through 1.x subject to the deprecation and emergency rules below.

The standalone dispatcher's `help`, `-h`/`--help`, and `-v`/`--version` entry
points are also public. They are dispatcher conveniences, not ninth and tenth
runtime verbs. Per-command help interception is guaranteed only through the
standalone dispatcher.

The following are not promised command surface:

- unknown flags that the permissive parser happens to accept or ignore;
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

| Field | 1.x contract |
|---|---|
| `schemaVersion` | The integer `1`. An incompatible envelope change requires a new value. |
| `command` | One of `review`, `rescue`, `task`, `vision`, `status`, `result`, or `cancel`, matching the invoked verb. |
| `status` | A string describing the represented outcome or state. Foreground delegated success is `completed`; a successful background dispatch is `queued`; an empty review is `no_changes`. `status` and `result` expose the represented job's stored status when they address one job. A status list uses `ok`. Cancellation paths that emit output use `cancelled`, `cancel_failed`, or `state_busy`. |
| `jobId` | The tracked job id as a string when the output represents one job, otherwise `null`. Successful background dispatch always supplies it. Foreground `review`, `rescue`, `task`, and `vision` also supply their tracked job id. |
| `answer` | Opaque human-facing/model-generated text as a string when the command returns an answer, otherwise `null`. Its prose, Markdown, field-like conventions, and all other internal structure are explicitly unstable. Consumers may display or store it but must not parse it as a review/result schema. |
| `details` | An object containing command-specific metadata. Its field set and nested shapes are explicitly unstable in 1.x; consumers must tolerate additions, removals, and changes within it. |

Consumers must tolerate additive top-level fields. `vision` additionally
promises top-level `model` (string) and `imagePaths` (an array of absolute path
strings), because these are resolved invocation inputs rather than model
output. No other command-specific top-level field is promised.

When `--wait` is combined with a background dispatch, `review`, `rescue`, and
`task` deliberately retain the dispatch envelope with `status: "queued"` and
its `jobId`, then report the final outcome by exit status. In particular,
background-default `task --wait --json` never appends completed model text to
stdout; callers fetch that text with `result <jobId> --json`. Likewise,
`review --json` with no tracked diff emits an envelope with
`status: "no_changes"`, `jobId: null`, and `answer: null`. These make both
previously exceptional stdout streams valid single JSON documents.

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

## Environment variables

These variables have direct semantics in the shipped code:

| Variable | Contract |
|---|---|
| `AGY_BIN` | Optional exact path to the agy executable. It wins over binary discovery when the file exists. The standalone dispatcher returns 127 when an explicitly configured path is missing; direct command-module invocation can fall back to normal discovery. |
| `PATH` / `Path` | Searched for `agy`; Windows accepts its conventional `Path` casing when `PATH` is absent. |
| `HOME` / `USERPROFILE` | Used, in that order, for the fallback `<home>/.local/bin/agy` search. Node's platform home directory also determines the `~/.gemini` paths used by vision setup. |
| `CLAUDE_PLUGIN_ROOT` | Supplied by Claude Code and used by the shipped slash-command wrappers to locate `scripts/commands/*.mjs`. |
| `CLAUDE_PLUGIN_DATA` | First-priority host state root; state lives below `<value>/state`. |
| `CODEX_PLUGIN_DATA` | Second-priority host state root; state lives below `<value>/state`, subject to the legacy fallback described below. |
| `AGY_PLUGIN_DATA` | Third-priority host state root; state lives below `<value>/state`, subject to the legacy fallback described below. |
| `ANTIGRAVITY_PLUGIN_SESSION_ID` | Associates new jobs with a host session and filters no-argument status/result selection to that session. If absent, jobs are not session-filtered. |
| `ANTIGRAVITY_VISION_ALLOWED_PATHS` | Internal per-process JSON array of absolute image paths. `vision` sets it for the MCP server. Missing or invalid data grants no image access. Users should not set it globally. |

The host-detection helper also recognizes `CLAUDE_ENV_FILE`, `CODEX_HOME`,
`CODEX_SESSION_ID`, `AGY_HOME`, and `AGY_SESSION_ID`, along with the data
variables above. That helper is shipped but is not currently on the eight
command handlers' execution path; these detection hints do not override the
state-root priority.

`ANTIGRAVITY_SCRIPT_ROOT` redirects the standalone dispatcher to a different
command-module directory. It exists for tests and is explicitly not a public
1.x integration point.

All other inherited environment variables are passed to child processes in
the normal Node fashion but have no plugin-specific compatibility promise.

## Job state and configuration locations

The workspace is the Git repository root when one can be resolved, otherwise
the command's working directory. Each workspace gets a leaf named from a
sanitized directory basename plus a 12-character hash of the resolved path:

```text
<state-root>/<workspace-slug>-<path-hash>/
  state.json
  jobs/
    <job-id>.json
    <job-id>.log
```

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

If a 1.x release moves or changes persistent state, it must preserve access to
existing 1.x jobs through automatic migration or a compatibility read path.
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

## Deprecation and compatibility changes

A documented public 1.x surface will be marked deprecated in release notes
and documentation and retained through at least one subsequent 1.x minor
release. Ordinary removal or another backward-incompatible change then waits
for 2.0.0. Additive commands, flags, fields, and behavior may ship in a 1.x
minor release.

There are two exceptions:

- An urgent security or privacy fix may disable or remove unsafe behavior in a
  1.x patch without the normal deprecation period. The release notes must name
  the affected surface, risk, and replacement or mitigation.
- An upstream agy change that breaks agy's own interface may force an
  immediate transport, flag, output-parsing, or supported-version change.
  The plugin may make that smallest necessary change in a 1.x patch and must
  document the upstream break and resulting compatibility boundary.

Neither exception authorizes unrelated breaking changes. Explicitly unstable
surfaces may change in 1.x without deprecation, but the change must still be
called out when it affects observable output.
