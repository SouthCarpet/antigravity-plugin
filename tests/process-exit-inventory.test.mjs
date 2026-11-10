// Oracle: runtime exits use the flush helper. Comments and strings are data.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = new Map([
  ['scripts/lib/process-exit.cjs', 'the helper calls the injected runtime.exit after both barriers'],
  ['scripts/lib/plugin-root.mjs', 'generated wrapper exits in its stderr callback; behavior tested separately'],
]);
// Limits: dataflow aliases such as const p = process and dynamic property names are not resolved.
// Literal computed access, destructuring and references such as const end = process.exit ARE rejected.
function exits(source) {
  const linter = new Linter();
  return linter.verify(source, [{ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { inventory: { rules: { exit: { create(context) {
      return {
        MemberExpression(node) {
          if (node.object.name !== 'process') return;
          const name = node.computed ? node.property.value : node.property.name;
          if (['exit', 'reallyExit'].includes(name)) context.report({ node, message: 'direct process ending reference' });
        },
        VariableDeclarator(node) {
          if (node.init?.name !== 'process' || node.id.type !== 'ObjectPattern') return;
          if (node.id.properties.some(p => ['exit', 'reallyExit'].includes(p.key?.name ?? p.key?.value))) {
            context.report({ node, message: 'process ending alias' });
          }
        },
      };
    } } } } }, rules: { 'inventory/exit': 'error' } }]);
}
function walk(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(file) : /\.(?:mjs|cjs|js)$/.test(file) ? [file] : [];
  });
}
it('runtime files have no unapproved direct ending references', () => {
  // Development scripts (check-pack, check-manifests, generators) are outside these runtime roots.
  for (const file of ['bin', 'scripts/commands', 'scripts/lib'].flatMap(walk)) {
    // The two allowed sites use runtime.exit or generated string text, never a direct process reference.
    assert.deepEqual(exits(fs.readFileSync(path.join(root, file), 'utf8')), [], `${file}: ${allowed.get(file) ?? 'no exception'}`);
  }
});
for (const source of ['process.exit(1)', 'process.reallyExit(1)', "process['exit'](1)",
  'const { exit } = process; exit(1)', 'const end = process.exit; end(1)']) {
  it(`scanner rejects ${source}`, () => assert.ok(exits(source).length > 0));
}
it('scanner ignores ending text in comments and strings', () => {
  assert.deepEqual(exits('// process.exit(1)\n/* process.reallyExit(1) */\nconst s = "process.exit(1)";'), []);
});
