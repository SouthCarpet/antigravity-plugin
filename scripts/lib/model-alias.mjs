/** Model aliases select only ids listed by the current account. */
export const MODEL_ALIAS_FAMILIES = Object.freeze(Object.fromEntries(
  ["flash", "argon", "pro", "sonnet", "opus", "gpt-oss"].map((name) => [name, [name]]),
));

export function parseModelsListing(text) {
  const rows = new Map();
  for (const line of String(text).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length !== 2 || fields.some((field) => !field.trim() || /[\x00-\x1f]/.test(field))) {
      return { ok: false, reason: "unparsable listing" };
    }
    const [id, name] = fields.map((field) => field.trim());
    if (!rows.has(id)) rows.set(id, { id, name });
  }
  return rows.size ? { ok: true, rows: [...rows.values()] } : { ok: false, reason: "empty listing" };
}

function versionOf(id) {
  // A family's version is the first numeric run, including dot/hyphen components.
  return (id.match(/\d+(?:[.-]\d+)*/)?.[0] ?? "0").split(/[.-]/).map(Number);
}

export function compareModelVersions(a, b) {
  const left = versionOf(a), right = versionOf(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

export function selectAliasModel(rows, alias, effort, families = MODEL_ALIAS_FAMILIES) {
  const tokens = Object.hasOwn(families, alias) ? families[alias] : null;
  if (!tokens) return { ok: false, reason: `unknown model alias ${JSON.stringify(alias)}` };
  const matched = rows.filter(({ id }) => tokens.some((token) => id.toLowerCase().includes(token)));
  if (!matched.length) {
    return { ok: false, reason: `model alias "${alias}" family absent (${tokens.join(", ")}).\n` +
      rows.map(({ id, name }) => `${id}\t${name}`).join("\n") };
  }
  if (tokens.filter((token) => matched.some(({ id }) => id.toLowerCase().includes(token))).length > 1) {
    return { ok: false, reason: `model alias "${alias}" matches multiple families` };
  }
  matched.sort((a, b) => compareModelVersions(b.id, a.id) || a.id.localeCompare(b.id));
  const newest = matched.filter(({ id }) => compareModelVersions(id, matched[0].id) === 0);
  const requested = effort && effort !== "agy-default" ? effort : null;
  const picked = requested ? newest.find(({ id }) => id.toLowerCase().endsWith(`-${requested}`)) :
    newest.find(({ id }) => id.toLowerCase().endsWith("-medium")) ?? (newest.length === 1 ? newest[0] : null);
  if (!picked) return { ok: false, reason: `model alias "${alias}" effort mismatch (${requested ?? "medium"})` };
  return { ok: true, model: picked.id };
}
