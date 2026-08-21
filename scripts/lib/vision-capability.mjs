/** Per-invocation image capability shared by the vision command and MCP server. */
export const VISION_ALLOWLIST_ENV = "ANTIGRAVITY_VISION_ALLOWED_PATHS";

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
