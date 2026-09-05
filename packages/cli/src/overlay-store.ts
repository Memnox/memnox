import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME, type Overlay } from '@memnox/core';

const OVERLAY_FILE = 'overlays.json';

function overlayPathFor(home: string): string {
  return join(home, MEMNOX_HOME, OVERLAY_FILE);
}

/** Lifted overlays stay in the file: what was frozen and when is part of the record. */
export async function readOverlays(home: string): Promise<Overlay[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(overlayPathFor(home), 'utf8'));
    return Array.isArray(parsed) ? (parsed as Overlay[]) : [];
  } catch {
    // Nothing has ever been frozen here, which is the ordinary case.
    return [];
  }
}

export async function writeOverlays(home: string, overlays: Overlay[]): Promise<void> {
  const path = overlayPathFor(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(overlays, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
