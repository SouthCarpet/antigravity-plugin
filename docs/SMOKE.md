# Release smoke checklist

Manual end-to-end check of `@southcarpet/antigravity-plugin` on all four
hosts before tagging a release. Automated gates (the test suite, version
agreement, pack contents) are necessary but not sufficient: they do not
exercise live `agy`, OAuth, or host plugin loaders.

Run from a **fresh shell** (no leftover `AGY_BIN`, `CLAUDE_PLUGIN_DATA`,
`CODEX_PLUGIN_DATA`, or `AGY_PLUGIN_DATA`). Tick items as you go.

The expected CLI version is whatever `package.json` currently says (today
that is `0.2.4`). Do not treat an older number in a leftover note as the
target.

## Prerequisites (do once)

- [ ] `node --version` → ≥ 22.3.0
- [ ] `agy --version` → 1.1.15 or 1.1.17 (the tested matrix; other versions
      are not promised)
- [ ] Logged into a Google account that can use `agy` (run `agy --print 'hi'`
      once outside the plugin if the token cache is empty)
- [ ] No shell-rc overrides that would confuse host detection

## Automated preflight (must be green)

From the repository root:

```bash
node --test --experimental-test-module-mocks tests/*.test.mjs
node scripts/check-manifests.mjs
node scripts/bump-version.mjs --check
node scripts/check-pack.mjs
```

On a POSIX shell you can also run `bash scripts/smoke.sh`.

- [ ] Full suite green
- [ ] Manifests agree
- [ ] `bump-version --check` green (including README Status version)
- [ ] `check-pack` green; tarball name is
      `southcarpet-antigravity-plugin-<version>.tgz`

Do **not** run `npm publish` from this checklist.

## Host 1 — standalone

Preferred published form:

```bash
npx @southcarpet/antigravity-plugin --version
#   expect: the package.json version

npx @southcarpet/antigravity-plugin help review
#   expect: review flag summary
```

From a checkout (same dispatcher):

```bash
cd /tmp && rm -rf smoke-test && mkdir smoke-test && cd smoke-test
git init -q && echo "smoke" > README.md && git add -A && git commit -q -m init
# Windows: use %TEMP%\smoke-test equivalently.

node /path/to/antigravity-plugin/bin/antigravity.mjs setup
#   expect: agy probe; unless --skip-vision, ~/.gemini vision MCP +
#   mcp(vision/view_image) are registered. Undo later with setup --remove-vision.

node /path/to/antigravity-plugin/bin/antigravity.mjs review
#   expect: markdown review on stdout, exit 0 (or the no-changes line)

node /path/to/antigravity-plugin/bin/antigravity.mjs rescue "summarize this repository in one sentence"
#   expect: a completed answer, exit 0

node /path/to/antigravity-plugin/bin/antigravity.mjs task --foreground "say the word OK"
#   expect: completed foreground task

node /path/to/antigravity-plugin/bin/antigravity.mjs vision /path/to/small.png --prompt "what is in this image?"
#   expect: a visual description, not VISION-UNAVAILABLE; usage trailer on stderr

node /path/to/antigravity-plugin/bin/antigravity.mjs status
node /path/to/antigravity-plugin/bin/antigravity.mjs result
```

Optional background path:

```bash
node /path/to/antigravity-plugin/bin/antigravity.mjs task "sleep-less no-op: reply with OK"
#   expect: queued job id
node /path/to/antigravity-plugin/bin/antigravity.mjs status <job-id> --wait
node /path/to/antigravity-plugin/bin/antigravity.mjs result <job-id>
# start another, then:
node /path/to/antigravity-plugin/bin/antigravity.mjs cancel <job-id>
```

- [ ] `--version` matches `package.json`
- [ ] `help review` works
- [ ] `setup` (or already-valid credentials) succeeds
- [ ] `review` completes
- [ ] `rescue` completes
- [ ] `task` completes (foreground and/or background)
- [ ] `vision` sees a real image (not the unavailable sentinel)
- [ ] `status` / `result` show the jobs
- [ ] `cancel` works on an active job (if you queued one)

## Host 2 — Claude Code

```bash
claude plugin marketplace add /path/to/antigravity-plugin
claude plugin install antigravity@antigravity
```

Inside Claude Code:

```
/antigravity:setup
/antigravity:review
/antigravity:rescue investigate why the existing tests pass
/antigravity:vision ./screenshot.png
/antigravity:task --foreground say the word OK
/antigravity:status
/antigravity:result
```

- [ ] `/antigravity:setup` shows the OAuth URL or already-authenticated probe
- [ ] `/antigravity:review` produces review markdown
- [ ] `/antigravity:rescue` returns
- [ ] `/antigravity:vision` returns a visual answer (or a documented sentinel)
- [ ] `/antigravity:task` runs
- [ ] `/antigravity:status` and `/antigravity:result` list/fetch jobs
- [ ] No raw stack traces; no leftover `Gemini` / `gemini-companion` / `--acp`
      strings from the dropped transport

## Host 3 — Codex CLI

```bash
codex plugin marketplace add /path/to/antigravity-plugin
codex plugin marketplace list
#   expect: this marketplace appears
codex plugin add antigravity@antigravity
codex plugin list
#   expect: antigravity installed, enabled
```

Inside Codex CLI:

```
$antigravity setup
$antigravity review
$antigravity vision ./screenshot.png
$antigravity status
```

- [ ] Marketplace registers
- [ ] `codex plugin add antigravity@antigravity` installs and enables the plugin
- [ ] `$antigravity setup` succeeds
- [ ] `$antigravity review` completes
- [ ] `$antigravity vision` is reachable (same eight verbs as the other hosts)
- [ ] `$antigravity status` lists jobs

## Host 4 — agy native

```bash
agy plugin install /path/to/antigravity-plugin
#   from a clean clone: agy copies the whole working tree, including .git
#   and tests/, and does not honour package.json files.

agy plugin list
#   expect: antigravity appears (agents, commands)

agy plugin validate /path/to/antigravity-plugin
#   expect: commands: 8 processed (converted to skills)

npx @southcarpet/antigravity-plugin status
npx @southcarpet/antigravity-plugin review
```

- [ ] `agy plugin install <path-to-clone>` succeeds
- [ ] `agy plugin list` shows `antigravity`
- [ ] standalone CLI reaches the same runtime on that machine

## Reporting

Capture:

1. Which boxes were ticked.
2. Any host that failed, with the exact command and output.
3. Whether OAuth had to be re-done.
4. Wall-clock duration per host.

If any host fails, file an issue against `SouthCarpet/antigravity-plugin`
with that log. Do **not** tag the release until every host has at least one
green smoke run for the verbs you ship.
