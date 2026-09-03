/** Per-invocation image capability shared by the vision command and MCP server. */
export const VISION_ALLOWLIST_ENV = "ANTIGRAVITY_VISION_ALLOWED_PATHS";

/**
 * Image formats the MCP server can return, extension to MIME type. The vision
 * command checks the same table before it starts agy, so one list serves both
 * the pre-flight check and the server.
 */
export const VISION_MIME = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
});

/** Supported extensions, in the order the messages list them. */
export const VISION_EXTENSIONS = Object.freeze(Object.keys(VISION_MIME));

/** Hard cap on a source image file. Protects the model context and the IPC channel. */
export const VISION_MAX_BYTES = 10 * 1024 * 1024;

export function encodeVisionAllowlist(imagePaths) {
  if (!Array.isArray(imagePaths) || imagePaths.some((value) => typeof value !== "string")) {
    throw new TypeError("imagePaths must be an array of strings");
  }
  return JSON.stringify(imagePaths);
}

export function decodeVisionAllowlist(value) {
  if (typeof value !== "string" || !value.length) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}
