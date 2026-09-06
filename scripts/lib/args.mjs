/**
 * Lightweight argument parser for the antigravity-plugin CLI.
 * Mirrors the Codex plugin's args.mjs.
 */

/**
 * @typedef {{
 *   valueOptions?: string[],
 *   booleanOptions?: string[],
 *   repeatableOptions?: string[],
 *   valueChoices?: Record<string, string[]>,
 *   conflicts?: string[][],
 * }} ArgSchema
 *
 * Repeatable-option contract:
 *   An option listed in `repeatableOptions` always yields an array when
 *   present, including a single occurrence (`['only']`, never `'only'`).
 *   Absent repeatable options stay unset (`undefined`), not `[]`.
 *   Scalar `valueOptions` keep last-wins string behaviour.
 *
 * `valueChoices` restricts a scalar value option to the listed strings; any
 * other value throws {@link ArgsError} naming the flag and the choices.
 *
 * @typedef {{ options: Record<string, string | boolean | string[]>, positionals: string[] }} ParsedArgs
 */

export class ArgsError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "ArgsError";
  }
}

/**
 * @param {ArgSchema} schema
 * @returns {{ valueSet: Set<string>, booleanSet: Set<string>, repeatableSet: Set<string> }}
 */
function buildOptionSets(schema) {
  const valueSet = new Set(schema.valueOptions ?? []);
  const booleanSet = new Set(schema.booleanOptions ?? []);
  const repeatableSet = new Set(schema.repeatableOptions ?? []);
  for (const key of repeatableSet) valueSet.add(key);
  return { valueSet, booleanSet, repeatableSet };
}

/**
 * Consume one `--<key>` flag (and its value, if it takes one) starting at
 * `argv[i]`, mutating `options` in place.
 *
 * @param {string[]} argv
 * @param {number} i index of the `--<key>` token itself
 * @param {string} key the flag name, without the leading `--`
 * @param {{ valueSet: Set<string>, booleanSet: Set<string>, repeatableSet: Set<string> }} sets
 * @param {Record<string, string | boolean | string[]>} options mutated in place
 * @returns {number} the index of the last argv token this flag consumed
 */
function consumeFlag(argv, i, key, { valueSet, booleanSet, repeatableSet }, options) {
  if (valueSet.has(key)) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new ArgsError(`missing value for --${key}`);
    }
    if (repeatableSet.has(key)) {
      if (!Array.isArray(options[key])) options[key] = [];
      options[key].push(next);
    } else {
      options[key] = next;
    }
    return i + 1;
  }
  if (booleanSet.has(key)) {
    options[key] = true;
    return i;
  }
  throw new ArgsError(`unknown flag --${key}; put prompt text after --`);
}

/**
 * Walk `argv` once, splitting it into `options` (via {@link consumeFlag}) and
 * positional tokens; `--` ends flag parsing and the rest are positionals.
 *
 * @param {string[]} argv
 * @param {{ valueSet: Set<string>, booleanSet: Set<string>, repeatableSet: Set<string> }} sets
 * @returns {ParsedArgs}
 */
function collectOptionsAndPositionals(argv, sets) {
  /** @type {Record<string, string | boolean | string[]>} */
  const options = {};
  /** @type {string[]} */
  const positionals = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      i = consumeFlag(argv, i, arg.slice(2), sets, options);
    } else {
      positionals.push(arg);
    }
    i += 1;
  }

  return { options, positionals };
}

/**
 * Throw {@link ArgsError} naming both flags in the first present conflicting
 * pair.
 *
 * @param {Record<string, string | boolean | string[]>} options
 * @param {string[][]} conflicts
 * @returns {void}
 */
function applyConflicts(options, conflicts) {
  for (const [a, b] of conflicts) {
    if (options[a] && options[b]) {
      throw new ArgsError(`cannot combine --${a} and --${b}`);
    }
  }
}

/**
 * Throw {@link ArgsError} naming the flag and its choices when a scalar
 * value option's value isn't one of them.
 *
 * @param {Record<string, string | boolean | string[]>} options
 * @param {Record<string, string[]>} valueChoices
 * @returns {void}
 */
function applyValueChoices(options, valueChoices) {
  for (const [key, choices] of Object.entries(valueChoices)) {
    const value = options[key];
    if (value !== undefined && !choices.includes(String(value))) {
      throw new ArgsError(`invalid value for --${key}: "${value}" (expected ${choices.join("|")})`);
    }
  }
}

/**
 * Parse argv-style arguments into options and positionals.
 *
 * Declared value options with no following argument (or whose next token
 * is another `--flag`) throw {@link ArgsError} naming the flag. Pairs in
 * `schema.conflicts` throw {@link ArgsError} naming both flags when both
 * are present.
 *
 * @param {string[]} argv
 * @param {ArgSchema} schema
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, schema = {}) {
  const sets = buildOptionSets(schema);
  const { options, positionals } = collectOptionsAndPositionals(argv, sets);
  applyConflicts(options, schema.conflicts ?? []);
  applyValueChoices(options, schema.valueChoices ?? {});
  return { options, positionals };
}

/**
 * Parse tokenized command argv without reinterpreting argument boundaries.
 *
 * @param {string[]} argv
 * @param {ArgSchema} [schema]
 * @returns {ParsedArgs}
 */
export function parseCommandInput(argv, schema = {}) {
  return parseArgs(argv, schema);
}

/**
 * Parse command argv. On {@link ArgsError}, write the message to stderr
 * (prefixed with `antigravity:<command> — ` when `command` is set) and
 * return null so the caller can `return 1`.
 *
 * @param {string[]} argv
 * @param {ArgSchema} schema
 * @param {string} [command]
 * @returns {ParsedArgs | null}
 */
export function readCommandInput(argv, schema = {}, command = "") {
  try {
    return parseCommandInput(argv, schema);
  } catch (err) {
    if (err instanceof ArgsError) {
      const prefix = command ? `antigravity:${command} — ` : "";
      process.stderr.write(`${prefix}${err.message}\n`);
      return null;
    }
    throw err;
  }
}

/**
 * Resolve a verb's working directory: an explicit `--cwd` flag wins, else
 * the test-injected `ctx.cwd`, else the process cwd. The one `cwd`
 * resolution every verb command repeats.
 *
 * @param {Record<string, string | boolean | string[]>} options parsed CLI options
 * @param {{ cwd?: string }} [ctx] dependency overrides for tests
 * @returns {string}
 */
export function resolveCliCwd(options, ctx = {}) {
  if (options.cwd) return String(options.cwd);
  return ctx.cwd ?? process.cwd();
}
