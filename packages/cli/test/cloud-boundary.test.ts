import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

/** The modules that speak to a control plane. Nothing governing may import them. */
const CLOUD_MODULES = ['cloud-client', 'cloud-connection'];

/** A machine that never signs in must be governed exactly as well as one that did. */
const LOCAL_GOVERNANCE = [
  'commands/check.command.ts',
  'commands/rules.command.ts',
  'commands/serve.command.ts',
  'commands/setup.command.ts',
  // The first four phases run with no account, so none of them may reach the cloud.
  'commands/discover.command.ts',
  'commands/doctor.command.ts',
  'commands/harden.command.ts',
  'commands/why.command.ts',
];

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

function importsCloud(source: string): boolean {
  return CLOUD_MODULES.some((module) =>
    new RegExp(`from '\\.{1,2}/(commands/)?${module}'`).test(source),
  );
}

describe('the control plane stays optional', () => {
  it('no local governance path imports a control-plane module', async () => {
    const offenders: string[] = [];
    for (const relative of LOCAL_GOVERNANCE) {
      const source = await readFile(join(SRC, relative), 'utf8');
      if (importsCloud(source)) offenders.push(relative);
    }

    // Solo means zero infrastructure: no account, no network, no control plane.
    // The moment a deciding path imports one, that promise is gone.
    expect(offenders).toEqual([]);
  });

  it('only the commands that exist to reach a control plane import one', async () => {
    const importers: string[] = [];
    for (const path of await sourceFiles(SRC)) {
      if (path.includes('cloud-client') || path.includes('cloud-connection')) continue;
      if (importsCloud(await readFile(path, 'utf8'))) {
        importers.push(path.slice(SRC.length + 1));
      }
    }

    // Adding to this list is a deliberate act: it says a new command exists to
    // reach a control plane, not that one crept into a path that governs.
    expect(importers.sort()).toEqual([
      'agent-config.ts',
      'commands/cloud.command.ts',
      'commands/login.command.ts',
      'commands/pull.command.ts',
    ]);
  });
});
