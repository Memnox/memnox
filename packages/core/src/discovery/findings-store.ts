import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Finding } from './finding';

/**
 * What the last `memnox doctor` found, kept so something else can send it.
 *
 * Findings were printed and dropped. The control plane has a projection and a
 * table for them and a deliberate hole in its ingest guard so a machine may
 * report them, and all of it stayed empty because nothing here outlived the
 * terminal that ran the scan.
 *
 * The last run only, not a history: this exists to answer "what is wrong with
 * this machine now", and a fleet counting a problem somebody fixed last week is
 * a fleet nobody trusts. The snapshot store next door keeps a history because
 * `diff` asks what *changed*; nothing asks that of a finding.
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

  /**
   * Whole or not at all, and owner-only.
   *
   * Written to a temporary file and moved into place, the same way the bundle
   * is: a sync reading a half-written file would report a truncated estate as
   * the whole of it, and these name paths on somebody's machine.
   */
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
