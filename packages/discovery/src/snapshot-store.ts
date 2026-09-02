import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SNAPSHOT_HISTORY_LIMIT } from './discovery.constants';
import type { EnvironmentSnapshot } from './snapshot';

/** Owner-only: a snapshot names every path an agent on this machine can reach. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SNAPSHOT_DIR = 'snapshots';
const SNAPSHOT_SUFFIX = '.json';

/**
 * Where a scan is kept so the next one has something to compare against. A port,
 * because a test that had to write a developer's home directory would not be run.
 */
export interface SnapshotStore {
  /**
   * The most recent snapshot taken at or before `at`, or the latest one when `at` is
   * absent. Null on a first run, which is the honest answer rather than an error.
   */
  latest(at?: string): Promise<EnvironmentSnapshot | null>;
  /** Every kept scan, oldest first. What makes "it was already here" answerable. */
  history(): Promise<EnvironmentSnapshot[]>;
  save(snapshot: EnvironmentSnapshot): Promise<void>;
}

/** Files under the Memnox root, one per scan, named by the moment they were taken. */
export class NodeSnapshotStore implements SnapshotStore {
  private readonly dir: string;

  constructor(
    root: string,
    private readonly limit: number = SNAPSHOT_HISTORY_LIMIT,
  ) {
    this.dir = join(root, SNAPSHOT_DIR);
  }

  async latest(at?: string): Promise<EnvironmentSnapshot | null> {
    const names = await this.names();
    const wanted =
      at === undefined
        ? names[names.length - 1]
        : [...names].reverse().find((name) => stampOf(name) <= at);
    if (wanted === undefined) return null;

    return this.readOne(wanted);
  }

  async history(): Promise<EnvironmentSnapshot[]> {
    const kept: EnvironmentSnapshot[] = [];
    for (const name of await this.names()) {
      const snapshot = await this.readOne(name);
      if (snapshot !== null) kept.push(snapshot);
    }
    return kept;
  }

  private async readOne(name: string): Promise<EnvironmentSnapshot | null> {
    try {
      return JSON.parse(
        await readFile(join(this.dir, name), 'utf8'),
      ) as EnvironmentSnapshot;
    } catch {
      // A half-written file from a killed run is not a baseline; treat it as none.
      return null;
    }
  }

  async save(snapshot: EnvironmentSnapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    await writeFile(
      join(this.dir, `${fileStamp(snapshot.takenAt)}${SNAPSHOT_SUFFIX}`),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { encoding: 'utf8', mode: FILE_MODE },
    );
    await this.prune();
  }

  /** Sorted oldest first: the name carries the timestamp, so the sort is the order. */
  private async names(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      return entries.filter((name) => name.endsWith(SNAPSHOT_SUFFIX)).sort();
    } catch {
      // No directory yet is the ordinary first run.
      return [];
    }
  }

  private async prune(): Promise<void> {
    const names = await this.names();
    for (const name of names.slice(0, Math.max(0, names.length - this.limit))) {
      await rm(join(this.dir, name), { force: true });
    }
  }
}

/** Only the colons move: a filename keeps sorting in the order the scans happened. */
function fileStamp(takenAt: string): string {
  return takenAt.replace(/:/g, '-');
}

function stampOf(fileName: string): string {
  const stem = fileName.slice(0, -SNAPSHOT_SUFFIX.length);
  const separator = stem.indexOf('T');
  if (separator === -1) return stem;
  return stem.slice(0, separator) + stem.slice(separator).replace(/-/g, ':');
}
