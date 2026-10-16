#!/usr/bin/env node
import { prepareAgyInstallCopy } from './lib/agy-install-copy.mjs';

try {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-for-agy.mjs <extracted-package-directory>');
  const dir = prepareAgyInstallCopy(process.argv[2]);
  console.log(`agy plugin install "${dir}"`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
