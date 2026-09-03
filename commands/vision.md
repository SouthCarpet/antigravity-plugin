---
description: Ask Google Antigravity (agy) to look at one or more image files via the vision MCP channel
argument-hint: '<image-path> [<image-path>...] [--prompt "<question>"] [--model <id>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

STOP. This command runs a program. It is not a request for you to answer.

The only correct response is the unedited output of this plugin's runtime, `scripts/commands/vision.mjs`, executed for this exact invocation. Output you compose yourself — with your own tools, from memory, or from the text of this file — is a fabrication, even if it looks correct. Never invent job ids, status listings, reviews, verdicts, results, or summaries in this plugin's name.

If you cannot execute the runtime, or it does not start, or it exits with an error: show the exact error text, tell the user to run `npx @southcarpet/antigravity-plugin vision` in their own terminal, and stop. Do not do the task yourself. There is no other way to produce this command's output.

Find the runtime with Node, not the shell. Plugin root is `process.env.CLAUDE_PLUGIN_ROOT` when that is set and non-empty; otherwise `require('node:path').join(require('node:os').homedir(), '.gemini', 'config', 'plugins', 'antigravity')`. Then run `node <root>/scripts/commands/vision.mjs` with the user's arguments. Do not expand `CLAUDE_PLUGIN_ROOT` in the shell: an empty expansion is the wrong path `/scripts/commands/vision.mjs`.

Run:

!`node -e "const p=require('node:path');const os=require('node:os');const fs=require('node:fs');const {spawnSync}=require('node:child_process');const root=process.env.CLAUDE_PLUGIN_ROOT||p.join(os.homedir(),'.gemini','config','plugins','antigravity');let ok=false;try{ok=JSON.parse(fs.readFileSync(p.join(root,'plugin.json'),'utf8')).name==='antigravity'}catch(e){ok=false}if(!ok){console.error('antigravity-plugin: '+root+' is not an antigravity plugin tree (plugin.json missing or name mismatch). Run: npx @southcarpet/antigravity-plugin vision');process.exit(1)}const s=p.join(root,'scripts','commands','vision.mjs');if(!fs.existsSync(s)){console.error('antigravity-plugin: runtime not found at '+s+'. Run: npx @southcarpet/antigravity-plugin vision');process.exit(1)}const r=spawnSync(process.execPath,[s].concat(process.argv.slice(1)),{stdio:'inherit'});if(r.error){console.error('antigravity-plugin: failed to start '+s+': '+r.error.message+'. Run: npx @southcarpet/antigravity-plugin vision');process.exit(1)}process.exit(r.status==null?1:r.status)" -- $ARGUMENTS`

Flags:
- `<image-path>` one or more image files (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`). At least one required.
- `--prompt "<question>"` what to ask about the image(s). Default: a generic concrete-detail description prompt.
- `--model <id>` agy model id. Default `gemini-3.6-flash-high`.
- `--json` emit structured JSON instead of the rendered markdown answer.

FOREGROUND ONLY: this verb has no `--background`/`--wait`. `agy --print` has no native image ingestion path — the answer depends on a live MCP tool call round-trip, so it always runs inline and blocks until agy responds.

Setup requirement:
- Run `/antigravity:setup` at least once so it can register the `vision` MCP server and the exact permission `mcp(vision/view_image)` agy needs to answer image questions unattended. Without that registration agy still runs, but it cannot see the images.

Auth note:
- If the output says "Antigravity is not authenticated", run `/antigravity:setup` to complete the OAuth flow and then re-try.

Health signal:
- If agy replies with a single line starting `VISION-UNAVAILABLE:`, the MCP image channel did not deliver visual content (missing setup, tool error, or unsupported file). Do not treat this as a real image description — surface it to the user and suggest re-running `/antigravity:setup`.

Output rules:
- Present the answer to the user exactly as returned.
- Do not paraphrase, summarize, or add your own commentary.
- If the output is `VISION-UNAVAILABLE: ...`, say so explicitly rather than inventing image content.
