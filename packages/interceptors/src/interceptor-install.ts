import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { interceptedBinaries } from '@memnox/core';
import { interceptorDirFor } from './interceptor';

/**
 * A tiny shell script per binary rather than a symlink, because a symlink loses the
 * name it was invoked as on some platforms, and the name is how one binary serves ten
 * interceptors. Each script is two lines and states what it is.
 */
function scriptFor(binary: string, interceptBinary: string): string {
  return [
    '#!/bin/sh',
    `# Memnox interceptor for ${binary}. Remove this file, or run "memnox uninstall", to undo.`,
    `exec "${interceptBinary}" "${binary}" "$@"`,
    '',
  ].join('\n');
}

export interface InterceptorInstallReport {
  directory: string;
  installed: string[];
  /** What to add to PATH, printed rather than written into somebody's shell profile. */
  pathLine: string;
}

export async function installInterceptors(
  home: string,
  interceptBinary: string,
): Promise<InterceptorInstallReport> {
  const directory = interceptorDirFor(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const installed: string[] = [];
  for (const binary of interceptedBinaries()) {
    const path = join(directory, binary);
    await writeFile(path, scriptFor(binary, interceptBinary), {
      encoding: 'utf8',
      mode: 0o700,
    });
    await chmod(path, 0o700);
    installed.push(binary);
  }

  return {
    directory,
    installed,
    pathLine: `export PATH="${directory}:$PATH"`,
  };
}

/** Removes every interceptor and the directory, so a machine goes back exactly as it was. */
export async function removeInterceptors(home: string): Promise<string[]> {
  const directory = interceptorDirFor(home);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    // Never installed, which is not a failure to uninstall.
    return [];
  }
  for (const name of names) await rm(join(directory, name), { force: true });
  await rm(directory, { recursive: true, force: true });
  return names;
}
