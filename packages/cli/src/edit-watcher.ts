import { execFile } from 'node:child_process';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { hostname } from 'node:os';
import { join, sep } from 'node:path';
import {
  CloudLeases,
  conflicts,
  desktopNotice,
  GitRegionReader,
  LeaseRegistry,
  SHARED_OUTCOME,
  shortMachine,
  watchedRepositories,
  type SharedTake,
  type WrittenRegion,
  MINUTE_MS,
  minutesToMs,
  secondsToMs,
} from '@memnox/core';

/**
 * Edits nothing hooked, claimed from the files themselves a moment after they are saved.
 * It cannot stop a save, but it holds those lines against every other machine from then on.
 */

/** Folders whose changes are never somebody editing code. */
const IGNORED = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.memnox'];

/** Milliseconds a file is left alone after it changes, so a burst of saves is one claim. */
const SETTLE_MS = secondsToMs(1.5);

/** The most claims one minute makes, whatever is being rewritten. */
const MOST_CLAIMS_PER_MINUTE = 60;

/** How often the list of repositories is read again, to watch new ones. */
const RESCAN_MS = MINUTE_MS;

/** Minutes a watcher's hold lasts without another change: the editor's own window. */
const WATCH_MINUTES = 5;

/** A desktop notice about one file at most this often. */
const NOTICE_EVERY_MS = minutesToMs(5);

/** Milliseconds git is given for the questions asked here. */
const GIT_TIMEOUT_MS = secondsToMs(2);

/** What the watcher asks of the world, injected so a test states it. */
export interface WatcherSeams {
  /** Whether the file is there at all. */
  exists: (root: string, path: string) => boolean;
  /** Whether something on this machine already holds this path. */
  heldHere: (root: string, path: string) => Promise<boolean>;
  /** What changed in this file against the last commit, or null where nothing did. */
  changed: (root: string, path: string) => Promise<WrittenRegion | null>;
  take: (path: string, region: WrittenRegion) => Promise<SharedTake>;
  notify: (message: string) => void;
  now: () => number;
}

/** What happened to one saved file. */
export const WATCH_OUTCOME = {
  CLAIMED: 'claimed',
  /** Another machine's agent had these lines first. */
  COLLIDED: 'collided',
  /** A hooked agent here already holds it, or nothing changed against the commit. */
  SKIPPED: 'skipped',
  /** Over this minute's cap. */
  DEFERRED: 'deferred',
} as const;

type WatchOutcome = (typeof WATCH_OUTCOME)[keyof typeof WATCH_OUTCOME];

/**
 * Scratch names editors leave while saving (vim swap files and its `4913` probe, Emacs
 * locks, `~` backups, `.!pid!`), since a claim on one holds a file nobody is writing.
 */
const SCRATCH = /(^\.#|^#.*#$|~$|\.sw[a-p]$|\.tmp$|^4913$|^\.!\d+!)/;

/** Whether a changed path is somebody's source rather than something generated. */
export function worthWatching(path: string): boolean {
  if (path === '') return false;
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => IGNORED.includes(part))) return false;
  const name = parts[parts.length - 1] ?? '';
  return !SCRATCH.test(name);
}

export class EditWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly noticed = new Map<string, number>();
  private claims: number[] = [];
  private rescan: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly home: string,
    private readonly seams: WatcherSeams = defaultSeams(home),
  ) {}

  /** Watches every repository on the list, and any added to it later. */
  start(): void {
    this.watchListed();
    this.rescan = setInterval(() => this.watchListed(), RESCAN_MS);
    this.rescan.unref();
  }

  stop(): void {
    if (this.rescan !== undefined) clearInterval(this.rescan);
    for (const each of this.watchers.values()) each.close();
    for (const timer of this.settling.values()) clearTimeout(timer);
    this.watchers.clear();
    this.settling.clear();
  }

  /**
   * One saved file, once it has settled: claim what changed in it, or say why not.
   * Public so a test can hand it a change without a file system to watch.
   */
  async handle(root: string, path: string): Promise<WatchOutcome> {
    if (!worthWatching(path)) return WATCH_OUTCOME.SKIPPED;
    // Gone by the time it settled, so an editor wrote and removed it while saving.
    if (!this.seams.exists(root, path)) return WATCH_OUTCOME.SKIPPED;
    if (await this.seams.heldHere(root, path)) return WATCH_OUTCOME.SKIPPED;
    const region = await this.seams.changed(root, path);
    if (region === null) return WATCH_OUTCOME.SKIPPED;

    const now = this.seams.now();
    this.claims = this.claims.filter((at) => now - at < MINUTE_MS);
    if (this.claims.length >= MOST_CLAIMS_PER_MINUTE) return WATCH_OUTCOME.DEFERRED;
    this.claims.push(now);

    const taken = await this.seams.take(path, region);
    if (taken.outcome !== SHARED_OUTCOME.HELD_BY_ANOTHER) return WATCH_OUTCOME.CLAIMED;
    this.noticeCollision(path, taken, now);
    return WATCH_OUTCOME.COLLIDED;
  }

  /** At most one desktop notice per file per window, so a busy file is not a stream of them. */
  private noticeCollision(
    path: string,
    taken: Extract<SharedTake, { outcome: typeof SHARED_OUTCOME.HELD_BY_ANOTHER }>,
    now: number,
  ): void {
    const last = this.noticed.get(path);
    if (last !== undefined && now - last < NOTICE_EVERY_MS) return;
    this.noticed.set(path, now);
    const where = taken.machine === undefined ? '' : ` on ${shortMachine(taken.machine)}`;
    this.seams.notify(
      `${taken.holder}${where} was already editing ${path}, and a change saved here overlaps it. Agree who keeps it before either of you pushes.`,
    );
  }

  private watchListed(): void {
    for (const root of watchedRepositories(this.home)) {
      if (this.watchers.has(root)) continue;
      try {
        const watcher = watch(root, { recursive: true }, (_event, name) => {
          if (typeof name !== 'string') return;
          this.settle(root, name.split(sep).join('/'));
        });
        // A folder that went away takes its watch with it rather than the daemon.
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(root);
        });
        this.watchers.set(root, watcher);
      } catch {
        // A platform or a folder this cannot watch: the hooks still cover what they cover.
      }
    }
  }

  private settle(root: string, path: string): void {
    if (!worthWatching(path)) return;
    const key = `${root}\u0000${path}`;
    const waiting = this.settling.get(key);
    if (waiting !== undefined) clearTimeout(waiting);
    const timer = setTimeout(() => {
      this.settling.delete(key);
      void this.handle(root, path).catch(() => undefined);
    }, SETTLE_MS);
    timer.unref();
    this.settling.set(key, timer);
  }
}

/** Git's exit status for a question, which is its answer: 0 for yes. -1 where it could not run. */
function runGitQuestion(args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error) => {
        if (error === null) return resolve(0);
        // An exec error carries the exit status as `code` when the process ran at all.
        const status: unknown = (error as { code?: unknown }).code;
        resolve(typeof status === 'number' ? status : -1);
      },
    );
  });
}

function defaultSeams(home: string): WatcherSeams {
  const leases = new CloudLeases(home);
  const holder = { agent: 'someone', sessionId: `watch:${hostname()}`, pid: process.pid };
  return {
    exists: (root, path) => existsSync(join(root, path)),
    heldHere: async (_root, path) => {
      const held = await new LeaseRegistry(home).held(new Date().toISOString());
      return held.some((lease) => conflicts(lease.path, path));
    },
    changed: async (root, path) => {
      // Ignored by git is never somebody's source.
      if ((await runGitQuestion(['check-ignore', '-q', '--', path], root)) === 0)
        return null;
      const tracked =
        (await runGitQuestion(['ls-files', '--error-unmatch', '--', path], root)) === 0;
      // A new file is all of it; a tracked one matching the last commit holds nothing.
      if (!tracked) return { lines: [], symbols: [] };
      if ((await runGitQuestion(['diff', '--quiet', 'HEAD', '--', path], root)) === 0)
        return null;
      return new GitRegionReader(root).read(path);
    },
    take: (path, region) => leases.take(path, holder, WATCH_MINUTES, region),
    notify: (message) => desktopNotice(message),
    now: () => Date.now(),
  };
}
