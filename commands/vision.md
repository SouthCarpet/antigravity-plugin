---
description: Ask Google Antigravity (agy) to look at one or more image files via the vision MCP channel
argument-hint: '<image-path> [<image-path>...] [--prompt "<question>"] [--model <id>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/vision.mjs" $ARGUMENTS`

Flags:
- `<image-path>` one or more image files (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`). At least one required.
- `--prompt "<question>"` what to ask about the image(s). Default: a generic concrete-detail description prompt.
- `--model <id>` agy model id. Default `gemini-3.6-flash-high`.
- `--json` emit structured JSON instead of the rendered markdown answer.

FOREGROUND ONLY: this verb has no `--background`/`--wait`. `agy --print` has no native image ingestion path — the answer depends on a live MCP tool call round-trip, so it always runs inline and blocks until agy responds.

Setup requirement:
- Run `/antigravity:setup` at least once so it can register the `vision` MCP server and the `read_file(*)`, `view_image(*)`, `mcp(*)` permissions agy needs to answer image questions unattended. Without that registration agy still runs, but it cannot see the images.

Auth note:
- If the output says "Antigravity is not authenticated", run `/antigravity:setup` to complete the OAuth flow and then re-try.

Health signal:
- If agy replies with a single line starting `VISION-UNAVAILABLE:`, the MCP image channel did not deliver visual content (missing setup, tool error, or unsupported file). Do not treat this as a real image description — surface it to the user and suggest re-running `/antigravity:setup`.

Output rules:
- Present the answer to the user exactly as returned.
- Do not paraphrase, summarize, or add your own commentary.
- If the output is `VISION-UNAVAILABLE: ...`, say so explicitly rather than inventing image content.
