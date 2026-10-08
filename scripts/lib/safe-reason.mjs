/**
 * A failure reason that is safe to show in `details.error.message`.
 *
 * agy puts a one-line reason on a failed run (`result.error`, or an
 * `error:` line on stderr). That text comes from outside the plugin, so it
 * can carry a bearer token, an OAuth callback URL or a multi-line dump. This
 * module turns it into one bounded line with the sensitive parts replaced, or
 * into `null` when nothing useful is left. A caller then keeps its own
 * generic text.
 */

/** Longest reason, in characters, after redaction. */
export const MAX_SAFE_REASON_LENGTH = 300;

const REDACTED = "[redacted]";
const REDACTED_URL = "[redacted-url]";

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]*/gi;
const URL_USERINFO_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

/** A URL is kept only when it has no query, no fragment and no credentials. */
function redactUrl(url) {
  return url.includes("?") || url.includes("#") || URL_USERINFO_RE.test(url) ? REDACTED_URL : url;
}

/** Each rule maps a pattern to its replacement. Order matters: URLs first. */
const VALUE_RULES = [
  [/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`],
  [
    /(["']?)\b(access_token|refresh_token|id_token|client_secret|api[_-]?key|token|secret|password|authorization)\b\1(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    `$1$2$1$3${REDACTED}`,
  ],
  [/\bcode=[^\s&,;"']+/gi, `code=${REDACTED}`],
  [/\bya29\.[\w-]+/g, REDACTED],
  [/\b1\/\/[\w-]{20,}/g, REDACTED],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, REDACTED],
  [/\b(?:sk|pk|gh[pousr]|AIza)[_-]?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, REDACTED],
];

/**
 * @param {string} text one line of text
 * @returns {string} the same text with URLs, tokens and credentials replaced
 */
function redact(text) {
  let out = text.replace(URL_RE, redactUrl);
  for (const [pattern, replacement] of VALUE_RULES) out = out.replace(pattern, replacement);
  return out;
}

/** True when text still says something once the redaction markers are removed. */
function hasReadableWords(text) {
  return /[A-Za-z]{3,}/.test(text.replace(/\[redacted(?:-url)?\]/g, ""));
}

/**
 * One safe, bounded line for a failure reason, or `null` when none can be
 * made. Control characters and line breaks become single spaces, tokens and
 * URLs with a query string, a fragment or credentials are replaced, and the
 * result is cut to {@link MAX_SAFE_REASON_LENGTH} characters after redaction.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeFailureReason(value) {
  if (typeof value !== "string") return null;
  const oneLine = value.replace(/[\x00-\x20\x7f]+/g, " ").trim();
  if (!oneLine) return null;
  const redacted = redact(oneLine);
  if (!hasReadableWords(redacted)) return null;
  return redacted.length > MAX_SAFE_REASON_LENGTH ? redacted.slice(0, MAX_SAFE_REASON_LENGTH) : redacted;
}
