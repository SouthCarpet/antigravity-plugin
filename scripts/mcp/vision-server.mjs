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
 * Access is capability-scoped, not prompt-scoped. The parent vision command
 * passes the exact user-named absolute paths in a per-process environment
 * value. This server denies all access when that value is absent or invalid,
 * rejects every path not in it, and rejects symlink/junction resolution so a
 * permitted-looking name cannot resolve to a different file.
 *
 * Protocol handling below mirrors the probe script that proved this out; do
 * not change the JSON-RPC shapes without re-verifying against a live agy run.
 */
import fs from "node:fs";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

import { canonicalComparePath, pathModuleFor } from "../lib/paths.mjs";
import {
  decodeVisionAllowlist,
  VISION_ALLOWLIST_ENV,
  VISION_MAX_BYTES,
  VISION_MIME,
} from "../lib/vision-capability.mjs";

// Shared with the vision command, which applies the same two limits before it
// starts agy. One definition, two checks.
const MIME = VISION_MIME;
const MAX_BYTES = VISION_MAX_BYTES;
const IDENTITY_CHANGED = "ERROR: image identity changed; refusing access";
// MCP requests contain paths, not image bytes. Limit each UTF-8 input frame
// to 64 KiB before decoding; discard an oversized frame through its newline.
export const MAX_FRAME_BYTES = 64 * 1024;

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

function protocolError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function errorContent(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Load an image file and build the MCP tool result payload.
 *
 * The `seam` argument (`platform`, `fs`) defaults to the real host and is
 * supplied by tests for file races and 8.3 short-name fixture volumes;
 * see scripts/lib/paths.mjs.
 *
 * @param {string} rawPath
 * @param {string} [cwd]
 * @param {string[]} [allowedPaths]
 * @param {{ platform?: string, fs?: typeof fs }} [seam]
 * @returns {{ content: Array<any>, isError?: boolean }}
 */
export function loadImageResult(
  rawPath,
  cwd = process.cwd(),
  allowedPaths = decodeVisionAllowlist(process.env[VISION_ALLOWLIST_ENV]),
  { platform = process.platform, fs: fsImpl = fs } = {},
) {
  const seam = { platform, fs: fsImpl };
  const pathApi = pathModuleFor(platform);
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return errorContent("ERROR: path must be a non-empty string");
  }
  const p = pathApi.resolve(cwd, rawPath);
  // Canonicalise 8.3 short names and `\\?\` prefixes on both sides without
  // following junctions. path.resolve("C:\\Users\\RUNNER~1\\…") and
  // realpathSync.native of the same file otherwise compare unequal and a
  // legitimate image is refused as a symlink escape.
  const allowed = new Set(
    allowedPaths.map((allowedPath) => canonicalComparePath(pathApi.resolve(cwd, allowedPath), seam)),
  );
  if (!allowed.has(canonicalComparePath(p, seam))) {
    return errorContent("ERROR: path is not authorized for this vision invocation");
  }

  let realPath;
  try {
    realPath = fsImpl.realpathSync.native(p);
  } catch {
    return errorContent("ERROR: file not found");
  }
  // Compare after realpath: a symlink/junction may look allowed lexically but
  // resolve elsewhere. Requiring equality rejects that escape before reading.
  const canonicalPath = canonicalComparePath(realPath, seam);
  if (canonicalPath !== canonicalComparePath(p, seam)) {
    return errorContent("ERROR: authorized path resolves through a symlink or junction; refusing access");
  }

  const ext = pathApi.extname(p).toLowerCase();
  const mimeType = MIME[ext];
  if (!mimeType) {
    return errorContent(
      `ERROR: unsupported image extension. Supported: ${Object.keys(MIME).join(", ")}`,
    );
  }

  return readCheckedImage(p, realPath, canonicalPath, mimeType, seam);
}

function readCheckedImage(p, realPath, canonicalPath, mimeType, seam) {
  const { fs: fsImpl } = seam;
  let stat;
  try {
    stat = fsImpl.statSync(realPath, { bigint: true });
  } catch {
    return errorContent("ERROR: file not found");
  }
  if (!stat.isFile()) {
    return errorContent("ERROR: not a regular file");
  }
  if (stat.size > MAX_BYTES) {
    return errorContent(`ERROR: file too large (${stat.size} bytes > ${MAX_BYTES} byte cap)`);
  }

  let fd;
  try {
    // Pin the read to the checked identity and bound allocation even if the
    // file grows. This closes stat-then-read substitution, but is not a proof
    // against every parent-directory race.
    fd = fsImpl.openSync(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fsImpl.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      return errorContent(IDENTITY_CHANGED);
    }
    let currentPath;
    try {
      currentPath = canonicalComparePath(fsImpl.realpathSync.native(p), seam);
    } catch {
      return errorContent(IDENTITY_CHANGED);
    }
    if (currentPath !== canonicalPath) {
      return errorContent(IDENTITY_CHANGED);
    }

    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fsImpl.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_BYTES) {
      return errorContent(`ERROR: file too large (exceeds ${MAX_BYTES} byte cap)`);
    }
    const data = buffer.subarray(0, bytesRead).toString("base64");
    return {
      content: [
        { type: "text", text: `Image loaded from ${p} (${mimeType}).` },
        { type: "image", data, mimeType },
      ],
    };
  } catch (err) {
    return errorContent(err.code === "ELOOP"
      ? IDENTITY_CHANGED
      : "ERROR: unable to read image");
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
}

async function* inputFrames(input) {
  const frame = Buffer.alloc(MAX_FRAME_BYTES);
  let length = 0;
  let dropping = false;
  for await (const chunk of input) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      if (!dropping) {
        const size = end - offset;
        if (length + size > MAX_FRAME_BYTES) {
          length = 0;
          dropping = true;
          yield null;
        } else {
          chunk.copy(frame, length, offset, end);
          length += size;
        }
      }
      if (newline !== -1) {
        if (!dropping) yield frame.toString("utf8", 0, length);
        length = 0;
        dropping = false;
      }
      offset = end + 1;
    }
  }
  if (length > 0 && !dropping) yield frame.toString("utf8", 0, length);
}

function usableId(msg) {
  if (msg === null || typeof msg !== "object" || !Object.hasOwn(msg, "id")) return null;
  if (typeof msg.id === "string") return msg.id;
  if (typeof msg.id === "number" && Number.isFinite(msg.id)) return msg.id;
  return null;
}

function handleRequest(msg, allowedPaths, loadImage) {
  const isObject = msg !== null && typeof msg === "object" && !Array.isArray(msg);
  const hasId = isObject && Object.hasOwn(msg, "id");
  const id = usableId(msg);
  // Non-object JSON is invalid, not a notification. Objects without an id
  // are never answered, including malformed notifications.
  if (isObject && !hasId) return;
  if (!isObject || msg.jsonrpc !== "2.0" || typeof msg.method !== "string"
    || (id === null && msg.id !== null)) {
    return protocolError(id, -32600, "invalid request");
  }
  try {
    const { method, params } = msg;
    let result;
    if (method === "initialize") {
      result = {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vision-server", version: "0.2.0" },
      };
    } else if (method === "notifications/initialized" || method === "initialized") {
      return;
    } else if (method === "ping") {
      result = {};
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      const imagePath = params?.arguments?.path;
      if (typeof imagePath !== "string" || imagePath.length === 0) {
        return protocolError(id, -32602, "path must be a non-empty string");
      }
      if (params?.name !== "view_image") {
        return protocolError(id, -32602, "unknown tool");
      }
      result = loadImage(imagePath, process.cwd(), allowedPaths);
    } else {
      return protocolError(id, -32601, "method not found");
    }
    return { jsonrpc: "2.0", id, result };
  } catch {
    return protocolError(id, -32603, "internal error");
  }
}

// Streams and the image loader are injectable for deterministic transport and
// handler-failure tests. Production uses the same serial processing loop.
export async function serveVision(input, output, allowedPaths, loadImage = loadImageResult) {
  // No application request/reply queue: retain one input frame (64 KiB) plus
  // the current stream chunk and one reply (at most one 10 MiB base64 image
  // plus frame-sized metadata). Await drain before consuming another frame;
  // stdin's own high-water mark then applies backpressure to the client.
  for await (const frame of inputFrames(input)) {
    let response;
    if (frame === null) {
      response = protocolError(null, -32600, "request frame exceeds byte cap");
    } else {
      if (!frame.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(frame);
      } catch {
        response = protocolError(null, -32700, "parse error");
      }
      if (!response) response = handleRequest(msg, allowedPaths, loadImage);
    }
    if (!response) continue;
    let encoded;
    try {
      encoded = JSON.stringify(response) + "\n";
    } catch {
      // A serialization failure must not terminate the server or expose the
      // exception to the client.
      encoded = JSON.stringify(protocolError(response.id, -32603, "internal error")) + "\n";
    }
    if (!output.write(encoded)) {
      await once(output, "drain");
    }
  }
}

/* c8 ignore start — stdio wiring exercised via child-process tests, not unit coverage. */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await serveVision(process.stdin, process.stdout,
    decodeVisionAllowlist(process.env[VISION_ALLOWLIST_ENV]));
}
/* c8 ignore stop */
