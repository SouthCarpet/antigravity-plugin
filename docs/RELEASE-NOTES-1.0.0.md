# antigravity-plugin 1.0.0

A multi-host plugin that delegates work to
[Google Antigravity CLI (`agy`)](https://antigravity.google) from Claude Code,
Codex CLI, an agy TUI, or a standalone shell.

1.0.0 freezes the public surface for 1.x: the eight verbs (`setup`, `review`,
`rescue`, `task`, `vision`, `status`, `result`, `cancel`), their flags, exit
codes, the `--json` envelope, the job-state locations, and the supported hosts.
Breaking that contract needs 2.0.0. The contract is in
[`docs/COMPATIBILITY.md`](./COMPATIBILITY.md). That is not "finished"; it is
the surface stopping under you.

## If you are on 0.2.x

What you will actually notice:

- **agy TUI commands run the plugin, or they refuse.** Wrappers resolve the
  copied runtime in Node instead of depending on `CLAUDE_PLUGIN_ROOT` (agy
  does not set it). If that run cannot start, they tell the model to print the
  error and stop. They no longer describe their own output columns, so a host
  that only shows the markdown as instructions has nothing left to imitate.
- **Claude Code now ships `setup`; Codex now ships `vision`.** All four hosts
  enumerate the same eight verbs. `review` and `rescue` are foreground unless
  you pass `--background` — they were documented as background-by-default in
  some host files.
- **Standalone invocation is `npx @southcarpet/antigravity-plugin <verb>`.**
  The installed binary name remains `antigravity-plugin`.
- **`review` accepts an untracked-only working tree.** Only a genuinely empty
  tree reports no changes.
- **Windows:** lock contention (`EPERM` / `EACCES` / `EBUSY`) waits instead of
  aborting; `agy.exe` is preferred on `PATH`, and a `.cmd` / `.bat` shim is
  refused with an actionable message.
- **`SECURITY.md` is in the tree.** The README has a permissions/privacy
  section.

The full list is in [`CHANGELOG.md`](../CHANGELOG.md).

## Install

Requires Node.js ≥ 22.3.0 and `agy` 1.1.15 or 1.1.17 on `PATH`. Details:
[`docs/INSTALL.md`](./INSTALL.md).

**Claude Code**

```bash
claude plugin marketplace add SouthCarpet/antigravity-plugin
claude plugin install antigravity@antigravity
```

Then `/antigravity:setup`.

**Codex CLI**

```bash
codex plugin marketplace add <path-to-clone>
codex plugin add antigravity@antigravity
```

Then `$antigravity setup`.

**agy**

Install from a clean clone. agy copies the whole tree and ignores
`package.json` `files`. A plain reinstall merges into
`~/.gemini/config/plugins/antigravity/` instead of replacing it, so an upgrade
needs uninstall first:

```bash
agy plugin uninstall antigravity
agy plugin install <path-to-clean-clone>
```

In an interactive TUI, `/antigravity:<verb>` runs the copied runtime. If that
invocation cannot run, use the standalone CLI.

**Standalone**

```bash
npx @southcarpet/antigravity-plugin <verb>
```

## Limits

1. **agy versions.** Tested against agy **1.1.15 and 1.1.17** only. That is
   not a blanket `1.1.x`. Other versions may work; they are not in the matrix.
2. **Host-run, not model-run.** In hosts that surface the commands as
   instructions rather than running them, a model can still answer without
   invoking the plugin. Every wrapper now refuses and points at the standalone
   CLI, but that guarantee is the host's, not ours. A real run always writes a
   job record; that is how you can check.
3. **`check-pack`.** The pack gate sees static and literal-specifier imports
   only, not computed ones. That is deliberate, and it will be revisited in a
   later minor release.

The suite at this release is 357 tests, 0 failing, 0 skipped, on Linux and
Windows across Node 22.3 and 24.
