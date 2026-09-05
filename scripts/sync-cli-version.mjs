/**
 * Writes the CLI package's version into the constant the CLI reports.
 *
 * `memnox --version` reads a constant rather than its own package.json, because the
 * published bundle is one file and reaching back up to a manifest at runtime is a
 * resolution problem in every packaging shape. The cost is that two places hold the
 * version, and 0.6.0 once shipped reporting 0.5.2 because only one of them moved.
 *
 * A test asserts they agree, which turns that into a red release PR rather than a
 * wrong number in the wild. This runs inside `pnpm version` so there is nothing to
 * go red about: changesets writes the manifest, and this follows it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const packageDir = join(import.meta.dirname, '..', 'packages', 'cli');
const constantFile = join(packageDir, 'src', 'defaults.ts');

const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const source = await readFile(constantFile, 'utf8');
const updated = source.replace(
  /export const CLI_VERSION = '[^']*';/,
  `export const CLI_VERSION = '${manifest.version}';`,
);

if (updated === source) {
  // Either it already matches, or the constant was renamed and this quietly did nothing.
  if (!source.includes(`CLI_VERSION = '${manifest.version}'`)) {
    console.error(`sync-cli-version: no CLI_VERSION assignment found in ${constantFile}`);
    process.exit(1);
  }
  process.exit(0);
}

await writeFile(constantFile, updated, 'utf8');
console.log(`sync-cli-version: CLI_VERSION -> ${manifest.version}`);
