/** Allow-list filter for upstream text used in public failure messages. */

/** Longest reason, in characters, after redaction. */
export const MAX_SAFE_REASON_LENGTH = 300;

const REDACTED = "[redacted]";
const REDACTED_URL = "[redacted-url]";
const KEYWORDS = new Set([
  "bearer", "basic", "digest", "negotiate", "token", "authorization",
  "proxy-authorization", "cookie", "set-cookie", "password", "passwd",
  "pwd", "secret", "apikey", "api-key", "api_key", "x-api-key", "key",
  "credential", "credentials", "session", "sid", "jwt", "auth",
  "access_token", "refresh_token", "id_token", "client_secret", "code",
]);

/**
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return text
    .replace(/\u001b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b[\s\S]/g, "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}]/gu, " ")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isKeyword(token) {
  return KEYWORDS.has(token.toLowerCase().replace(/^["'()\[\],;:]+|["'()\[\],;:]+$/g, ""));
}

/** Preserve numeric status diagnostics such as the required `(code 503):`.
 * @param {string} token
 * @param {string | undefined} next
 * @returns {boolean}
 */
function isStatusCode(token, next) {
  return token.toLowerCase() === "(code" && /^\d{1,20}\):$/.test(next ?? "");
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function hasAllowedShape(token) {
  return token.length <= 32
    && /^[A-Za-z0-9.,:;!()\[\]'"_\-/]+$/.test(token)
    && !/[A-Za-z0-9]{21}/.test(token)
    && !token.includes("//");
}

/**
 * @param {string} token
 * @returns {string}
 */
function replacement(token) {
  return token.includes("://") ? REDACTED_URL : REDACTED;
}

/**
 * @param {string[]} tokens
 * @returns {string[]}
 */
function redact(tokens) {
  const output = [];
  let remaining = 0;
  for (const [index, token] of tokens.entries()) {
    let safeToken;
    if (remaining > 0) {
      safeToken = replacement(token);
      remaining -= 1;
    } else if (isKeyword(token) && !isStatusCode(token, tokens[index + 1])) {
      safeToken = token;
      remaining = 2;
    } else {
      safeToken = hasAllowedShape(token) ? token : replacement(token);
    }
    const marker = safeToken === REDACTED || safeToken === REDACTED_URL;
    if (!marker || output.at(-1) !== safeToken) output.push(safeToken);
  }
  return output;
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
  if (text.length <= MAX_SAFE_REASON_LENGTH) return text;
  const boundary = text.lastIndexOf(" ", MAX_SAFE_REASON_LENGTH);
  return text.slice(0, Math.max(0, boundary));
}

/**
 * Normalize and keep only allowed tokens, with two tokens masked after each
 * credential keyword. Return null when no three-letter ASCII word remains.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeFailureReason(value) {
  if (typeof value !== "string") return null;
  const text = normalize(value);
  if (!text) return null;
  const reason = redact(text.split(" ")).join(" ");
  if (!/[A-Za-z]{3}/.test(reason.replace(/\[redacted(?:-url)?\]/g, ""))) return null;
  return truncate(reason);
}
