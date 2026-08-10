#!/usr/bin/env node
/**
 * vision-server — MCP stdio server that hands real image pixels to agy.
 *
 * Why this exists: `agy --print` (headless print mode, agy 1.1.11) has no
 * native image ingestion path. Its `read_file` tool feeds file bytes to the
 * model as text, `@file` prompt syntax does not create image parts, there is
 * no CLI attachment flag, and the internal send-message call goes out with
 * `media=0`. The one channel that DOES deliver real pixels in `--print` mode
 * is an MCP tool call whose result contains an MCP image content block
 * (`{ type: "image", data: <base64>, mimeType }`). This server exposes a
 * single `view_image` tool that reads an image file off disk and returns it
 * that way — verified live against agy 1.1.11 / gemini-3.6-flash-high.
 *
 * Protocol handling below mirrors the probe script that proved this out; do
 * not change the JSON-RPC shapes without re-verifying against a live agy run.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

/** Supported image extensions → MIME type. */
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Hard cap on source file size — protects the model context / IPC channel. */
const MAX_BYTES = 10 * 1024 * 1024;

const TOOLS = [
  {
    name: "view_image",
    description:
      "Load an image file from disk and return it as actual visual image content so the model can SEE the pixels.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function errorContent(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Load an image file and build the MCP tool result payload.
 *
 * @param {string} rawPath
 * @param {string} [cwd]
 * @returns {{ content: Array<any>, isError?: boolean }}
 */
export function loadImageResult(rawPath, cwd = process.cwd()) {
  const p = path.resolve(cwd, String(rawPath ?? ""));
  const ext = path.extname(p).toLowerCase();
  const mimeType = MIME[ext];
  if (!mimeType) {
    return errorContent(
      `ERROR: unsupported image extension "${ext || "(none)"}". Supported: ${Object.keys(MIME).join(", ")}`,
    );
  }

  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    return errorContent(`ERROR: file not found: ${p}`);
  }
  if (!stat.isFile()) {
    return errorContent(`ERROR: not a regular file: ${p}`);
  }
  if (stat.size > MAX_BYTES) {
    return errorContent(`ERROR: file too large (${stat.size} bytes > ${MAX_BYTES} byte cap): ${p}`);
  }

  try {
    const data = fs.readFileSync(p).toString("base64");
    return {
      content: [
        { type: "text", text: `Image loaded from ${p} (${mimeType}).` },
        { type: "image", data, mimeType },
      ],
    };
  } catch (err) {
    return errorContent(`ERROR: ${err.message}`);
  }
}

/* c8 ignore start — stdio wiring exercised via child-process tests, not unit coverage. */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vision-server", version: "0.2.0" },
      });
    } else if (method === "notifications/initialized" || method === "initialized") {
      // notification, no reply
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      if (params?.name !== "view_image") {
        replyError(id, -32602, `unknown tool: ${params?.name}`);
        return;
      }
      reply(id, loadImageResult(params?.arguments?.path));
    } else if (id !== undefined) {
      replyError(id, -32601, `method not found: ${method}`);
    }
  });
}
/* c8 ignore stop */
