import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { interceptableBinaries } from '@memnox/core';
import { interceptorDirFor, realPath, resolveReal } from './interceptor';

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
  /** Known to the rules, absent from this machine. Named so the list is never a mystery. */
  absent: string[];
  /** What to add to PATH, printed rather than written into somebody's shell profile. */
  pathLine: string;
}

export interface InstallSeams {
  path?: string;
  exists?: (candidate: string) => boolean;
}

/**
 * Only binaries this machine actually has. A shim for an absent `aws` would answer
 * `command -v aws` and make every script that checks for it take the wrong branch —
 * a governance tool that breaks a build is a governance tool somebody removes.
 */
export async function installInterceptors(
  home: string,
  interceptBinary: string,
  seams: InstallSeams = {},
): Promise<InterceptorInstallReport> {
  const directory = interceptorDirFor(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Our own directory removed, or a re-install would see its own shims and call the
  // binary present when the machine never had it.
  const path = realPath(seams.path ?? process.env['PATH'] ?? '', home);
  const exists = seams.exists ?? existsSync;

  const installed: string[] = [];
  const absent: string[] = [];
  for (const binary of interceptableBinaries()) {
    if (resolveReal(binary, path, exists) === null) {
      absent.push(binary);
      continue;
    }
    const scriptPath = join(directory, binary);
    await writeFile(scriptPath, scriptFor(binary, interceptBinary), {
      encoding: 'utf8',
      mode: 0o700,
    });
    await chmod(scriptPath, 0o700);
    installed.push(binary);
  }

  return {
    directory,
    installed,
    absent,
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
