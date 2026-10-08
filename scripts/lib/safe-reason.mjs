/** Allow-list filter for upstream text used in public failure messages. */

/** Longest reason, in characters, after redaction. */
export const MAX_SAFE_REASON_LENGTH = 300;

const REDACTED = "[redacted]";
const REDACTED_URL = "[redacted-url]";
const FORMAT_SENTINEL = "\uE000";
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
    .replace(/\u001b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[\s\S]/g, "=")
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, FORMAT_SENTINEL)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Zs}]/gu, " ")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * @param {string} token
 * @returns {string}
 */
function keywordName(token) {
  return token.toLowerCase().replace(/^["'()\[\],;:]+|["'()\[\],;:]+$/g, "");
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isKeyword(token) {
  return KEYWORDS.has(keywordName(token));
}

/**
 * @param {string} token
 * @param {boolean} [stripPunctuation]
 * @returns {boolean}
 */
function hasGluedKeyword(token, stripPunctuation = false) {
  const candidate = stripPunctuation ? keywordName(token) : token;
  const colon = candidate.indexOf(":");
  return colon > 0 && colon < candidate.length - 1
    && (stripPunctuation
      ? isKeyword(candidate.slice(0, colon))
      : KEYWORDS.has(candidate.slice(0, colon).toLowerCase()));
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function hasAllowedRuns(token) {
  return (token.match(/[A-Za-z0-9]+/g) ?? []).every((run) => {
    const hasLetter = /[A-Za-z]/.test(run);
    const hasDigit = /[0-9]/.test(run);
    if (hasLetter && hasDigit) return run.length < 12;
    return run.length <= (hasLetter ? 20 : 12);
  });
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
    && !/[A-Za-z]:[A-Za-z0-9]/.test(token)
    && hasAllowedRuns(token)
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
  for (const [index, rawToken] of tokens.entries()) {
    const hasSentinel = rawToken.includes(FORMAT_SENTINEL);
    const token = rawToken.replaceAll(FORMAT_SENTINEL, "");
    const gluedKeyword = hasGluedKeyword(token, hasSentinel);
    let safeToken;
    if (remaining > 0) {
      safeToken = replacement(token);
      remaining -= 1;
    } else if (hasSentinel && !isKeyword(token) && !gluedKeyword) {
      safeToken = replacement(token);
    } else if (gluedKeyword) {
      safeToken = replacement(token);
      remaining = 1;
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
  const reason = truncate(redact(text.split(" ")).join(" "));
  if (!/[A-Za-z]{3}/.test(reason.replace(/\[redacted(?:-url)?\]/g, ""))) return null;
  return reason;
}
