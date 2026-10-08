/**
 * How Claude Code reads a slash command's `allowed-tools` and matches a Bash
 * prefix rule, modelled on Claude Code 2.1.294 (read from its shipped
 * bundle on 2026-10-08; not a public API, so re-check after a host update):
 *
 * - the list is split at a comma or a space, except while the last
 *   parenthesis seen was an opening one (a flag, not a depth counter);
 * - a rule is `Tool(content)`: the tool is the text before the first
 *   unescaped `(`, the content runs to the last unescaped `)`, which must
 *   end the rule; `\(`, `\)` and `\\` are unescaped in the content;
 * - content ending in `:*` is a prefix rule. A command matches when, after
 *   runs of spaces and tabs collapse to one space, it equals the prefix or
 *   starts with the prefix plus a space. Other content must match exactly.
 */

/**
 * @param {string} value the `allowed-tools` value after YAML decoding
 * @returns {string[]}
 */
export function splitAllowedTools(value) {
  const entries = [];
  let current = '';
  let open = false;
  const push = () => {
    if (current.trim()) entries.push(current.trim());
    current = '';
  };
  for (const ch of value) {
    if (ch === '(') open = true;
    if (ch === ')') open = false;
    if ((ch === ',' || ch === ' ') && !open) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return entries;
}

function unescapedIndex(text, ch, fromEnd) {
  const order = Array.from({ length: text.length }, (_, i) => i);
  if (fromEnd) order.reverse();
  for (const i of order) {
    if (text[i] !== ch) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

/**
 * @param {string} rule
 * @returns {{ tool: string, content: string | null } | null} null when malformed
 */
export function parseRule(rule) {
  const open = unescapedIndex(rule, '(', false);
  const close = unescapedIndex(rule, ')', true);
  if (open === -1 && close === -1) return { tool: rule, content: null };
  if (open === -1 || close <= open || close !== rule.length - 1) return null;
  const tool = rule.slice(0, open);
  if (/[()]/.test(tool)) return null;
  const content = rule
    .slice(open + 1, close)
    .replaceAll('\\(', '(')
    .replaceAll('\\)', ')')
    .replaceAll('\\\\', '\\');
  return { tool, content };
}

const collapse = (text) => text.replace(/[ \t]+/g, ' ');

/**
 * @param {string} rule
 * @param {string} command
 * @returns {boolean}
 */
export function bashRuleMatches(rule, command) {
  const parsed = parseRule(rule);
  if (!parsed || parsed.tool !== 'Bash' || parsed.content === null) return false;
  const cmd = collapse(command.trim());
  if (!parsed.content.endsWith(':*')) return cmd === parsed.content;
  const prefix = collapse(parsed.content.slice(0, -2));
  return cmd === prefix || cmd.startsWith(`${prefix} `);
}

/**
 * The `allowed-tools` value of a command file, decoded the way YAML reads
 * the two forms the wrappers use: a double-quoted scalar (JSON string
 * syntax) or a plain scalar.
 *
 * @param {string} source the whole command file
 * @returns {string | null}
 */
export function allowedToolsValue(source) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!frontmatter) return null;
  const line = frontmatter[1].split(/\r?\n/).find((l) => l.startsWith('allowed-tools:'));
  if (!line) return null;
  const raw = line.slice('allowed-tools:'.length).trim();
  return raw.startsWith('"') ? JSON.parse(raw) : raw;
}
