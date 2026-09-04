import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION } from '../src/defaults';

/** 0.6.0 shipped reporting 0.5.2: the manifest moved and this constant did not. */
describe('CLI_VERSION', () => {
  it('matches the version this package is published under', async () => {
    const manifest = JSON.parse(
      await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };

    expect(CLI_VERSION).toBe(manifest.version);
  });
});
