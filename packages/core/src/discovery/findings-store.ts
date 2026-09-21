import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Finding } from './finding';

/**
 * What the last `memnox doctor` found, kept so the sync can send it. The last run only,
 * because a fleet counting a problem fixed last week is one nobody trusts.
 */
const FINDINGS_FILE = 'findings.json';
const OWNER_ONLY = 0o600;

export interface KeptFindings {
  /** `takenAt` of the scan these came from, so one scan is sent once. */
  takenAt: string;
  findings: Finding[];
}

export interface FindingsStore {
  latest(): Promise<KeptFindings | null>;
  keep(kept: KeptFindings): Promise<void>;
}

export function findingsPathFor(root: string): string {
  return join(root, FINDINGS_FILE);
}

export class NodeFindingsStore implements FindingsStore {
  constructor(private readonly root: string) {}

  async latest(): Promise<KeptFindings | null> {
    try {
      const raw = await readFile(findingsPathFor(this.root), 'utf8');
      // Partial until both fields are checked just below.
      const parsed = JSON.parse(raw) as Partial<KeptFindings>;
      if (typeof parsed.takenAt !== 'string' || !Array.isArray(parsed.findings)) {
        // Written by an older build, or truncated. A scan replaces it.
        return null;
      }
      return { takenAt: parsed.takenAt, findings: parsed.findings };
    } catch {
      // No scan has been kept yet, which is the ordinary state before the first.
      return null;
    }
  }

  /** Whole or not at all, and owner-only, because half a file reads as a truncated estate. */
  async keep(kept: KeptFindings): Promise<void> {
    const path = findingsPathFor(this.root);
    const staging = `${path}.incoming`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(staging, JSON.stringify(kept, null, 2), {
      encoding: 'utf8',
      mode: OWNER_ONLY,
    });
    await rename(staging, path);
  }
}
