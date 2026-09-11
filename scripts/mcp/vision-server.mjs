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
      // agy 1.2.1 "preserves open object schemas ... instead of rejecting
      // undeclared arguments on schemas that allow them" — an object schema
      // with no additionalProperties is open by JSON Schema default, so an
      // invented argument would reach the server again (plan 086 T2 D5).
      additionalProperties: false,
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

  let realPath = null;
  try {
    realPath = fsImpl.realpathSync.native(p);
  } catch {
    // Leave realPath null. A request that never matches the allowlist below
    // (lexically or via its realpath) is refused as unauthorized without
    // depending on this failure; one that does match is a real missing file.
  }
  const canonicalRealPath = realPath === null ? null : canonicalComparePath(realPath, seam);
  // An ancestor directory symlink (macOS's os.tmpdir() resolves through
  // /var -> /private/var) makes the request's own lexical form differ from
  // an allowlist entry that scripts/commands/vision.mjs already recorded in
  // its resolved form. Accept that divergence only when the request's own
  // realpath is itself an authorized entry — never merely because the path
  // resolves to *something*.
  const authorized =
    allowed.has(canonicalComparePath(p, seam)) || (canonicalRealPath !== null && allowed.has(canonicalRealPath));
  if (!authorized) {
    return errorContent("ERROR: path is not authorized for this vision invocation");
  }
  if (realPath === null) {
    return errorContent("ERROR: file not found");
  }

  // The final path component itself must never be a symlink: an authorized
  // NAME must always read the file that name itself is, not whatever it
  // currently points at. Reconstruct the request from its own ancestor's
  // realpath plus the given (literal, unresolved) basename; if that matches
  // the full realpath above, every difference between `p` and its realpath
  // came from an ancestor (an ancestor symlink is accepted below, via the
  // allowlist membership check). If it does not match, the final component
  // itself is a symlink — refused unconditionally, even to another
  // authorized entry. (`lstatSync` on `p` cannot answer this directly on
  // every platform: a junction-bearing ancestor makes a literal lstat on
  // the full path fail rather than report on the terminal entry.)
  let finalIsSymlink;
  try {
    const ancestorResolvedPath = pathApi.join(
      fsImpl.realpathSync.native(pathApi.dirname(p)),
      pathApi.basename(p),
    );
    finalIsSymlink = canonicalComparePath(ancestorResolvedPath, seam) !== canonicalRealPath;
  } catch {
    finalIsSymlink = true; // Cannot prove the final component is not a symlink; fail closed.
  }
  // A symlinked ancestor whose resolved target is NOT itself an authorized
  // entry (a permitted-looking name that actually escapes elsewhere) is
  // refused here even though the lexical/ancestor check above let it through.
  if (finalIsSymlink || !allowed.has(canonicalRealPath)) {
    return errorContent("ERROR: authorized path resolves through a symlink or junction; refusing access");
  }

  const ext = pathApi.extname(p).toLowerCase();
  const mimeType = MIME[ext];
  if (!mimeType) {
    return errorContent(
      `ERROR: unsupported image extension. Supported: ${Object.keys(MIME).join(", ")}`,
    );
  }

  return readCheckedImage(p, realPath, canonicalRealPath, mimeType, seam);
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

/**
 * Classify a raw JSON-RPC message before dispatch: `ignore` when it is an
 * object without an id (a malformed notification — never answered), else
 * `invalid` when it fails the JSON-RPC 2.0 request shape.
 *
 * @param {unknown} msg
 * @returns {{ id: string | number | null, ignore: boolean, invalid: boolean }}
 */
function validateEnvelope(msg) {
  const isObject = msg !== null && typeof msg === "object" && !Array.isArray(msg);
  const hasId = isObject && Object.hasOwn(msg, "id");
  const id = usableId(msg);
  // Non-object JSON is invalid, not a notification. Objects without an id
  // are never answered, including malformed notifications.
  const ignore = isObject && !hasId;
  const invalid = !ignore && (!isObject || msg.jsonrpc !== "2.0" || typeof msg.method !== "string"
    || (id === null && msg.id !== null));
  return { id, ignore, invalid };
}

/**
 * @param {unknown} params
 * @param {string[]} allowedPaths
 * @param {typeof loadImageResult} loadImage
 * @returns {{ result?: any, error?: { code: number, message: string } }}
 */
function dispatchToolsCall(params, allowedPaths, loadImage) {
  const imagePath = params?.arguments?.path;
  if (typeof imagePath !== "string" || imagePath.length === 0) {
    return { error: { code: -32602, message: "path must be a non-empty string" } };
  }
  if (params?.name !== "view_image") {
    return { error: { code: -32602, message: "unknown tool" } };
  }
  return { result: loadImage(imagePath, process.cwd(), allowedPaths) };
}

/**
 * @param {string} method
 * @param {unknown} params
 * @param {string[]} allowedPaths
 * @param {typeof loadImageResult} loadImage
 * @returns {{ result?: any, error?: { code: number, message: string }, ignore?: boolean }}
 */
function dispatchMethod(method, params, allowedPaths, loadImage) {
  if (method === "initialize") {
    return {
      result: {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vision-server", version: "0.2.0" },
      },
    };
  }
  if (method === "notifications/initialized" || method === "initialized") return { ignore: true };
  if (method === "ping") return { result: {} };
  if (method === "tools/list") return { result: { tools: TOOLS } };
  if (method === "tools/call") return dispatchToolsCall(params, allowedPaths, loadImage);
  return { error: { code: -32601, message: "method not found" } };
}

function handleRequest(msg, allowedPaths, loadImage) {
  const envelope = validateEnvelope(msg);
  if (envelope.ignore) return;
  if (envelope.invalid) return protocolError(envelope.id, -32600, "invalid request");
  const { id } = envelope;
  try {
    const { method, params } = msg;
    const outcome = dispatchMethod(method, params, allowedPaths, loadImage);
    if (outcome.ignore) return;
    if (outcome.error) return protocolError(id, outcome.error.code, outcome.error.message);
    return { jsonrpc: "2.0", id, result: outcome.result };
  } catch {
    return protocolError(id, -32603, "internal error");
  }
}

/**
 * Streams and the image loader are injectable for deterministic transport and
 * handler-failure tests. Production uses the same serial processing loop.
 *
 * @param {NodeJS.ReadableStream} input
 * @param {NodeJS.WritableStream} output
 * @param {string[]} allowedPaths
 * @param {typeof loadImageResult} [loadImage]
 * @returns {Promise<void>}
 */
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
