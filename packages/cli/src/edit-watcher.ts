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
} from '@memnox/core';

/**
 * Edits nothing hooked, claimed from the files themselves as they are saved.
 *
 * Claude Code, Codex, Cursor, Gemini CLI and Windsurf each run a hook before they
 * write, and are stopped before an edit that collides. OpenClaw, Hermes, an agent
 * nobody has written a hook for, and a person in their own editor run nothing, so
 * the lines they change were invisible to an agent on another computer about to
 * change the same ones. The daemon watches the repositories agents here work in,
 * and when a file changes it claims the lines that changed, the same way a hook
 * would, a moment after rather than before.
 *
 * **It cannot stop a save, and says so.** The edit is on disk by the time this sees
 * it. What it can do is hold those lines against every other machine from then on,
 * and, where another machine already had them, tell the person here and let the
 * workspace tell both sides.
 *
 * **Never in the way on its own machine.** A change a hooked agent here already
 * claimed is skipped, and the workspace never holds a watcher's claim against an
 * agent on the same machine: a person editing and asking their own agent to edit
 * the same lines is one person working.
 *
 * **Bounded.** Changes to one file are gathered for a moment, generated folders are
 * ignored, and claims are capped per minute, so a build that rewrites a thousand
 * files costs a handful of requests rather than a thousand.
 */

/** Folders whose changes are never somebody editing code. */
const IGNORED = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.memnox'];

/** Milliseconds a file is left alone after it changes, so a burst of saves is one claim. */
const SETTLE_MS = 1_500;

/** The most claims one minute makes, whatever is being rewritten. */
const MOST_CLAIMS_PER_MINUTE = 60;

/** How often the list of repositories is read again, to watch new ones. */
const RESCAN_MS = 60_000;

/** Minutes a watcher's hold lasts without another change: the editor's own window. */
const WATCH_MINUTES = 5;

/** A desktop notice about one file at most this often. */
const NOTICE_EVERY_MS = 5 * 60_000;

/** Milliseconds git is given for the questions asked here. */
const GIT_TIMEOUT_MS = 2_000;

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
 * Names editors and tools give their scratch files while saving: vim's swap files
 * and its `4913` probe, Emacs's `.#` locks and `#` autosaves, backups ending in `~`,
 * and the `.!pid!` files an in-place rewrite leaves for an instant. A claim on one
 * is a claim on a file nobody is writing.
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
    /* Gone by the time it settled: a file an editor wrote and removed while
       saving, which nobody is writing. */
    if (!this.seams.exists(root, path)) return WATCH_OUTCOME.SKIPPED;
    if (await this.seams.heldHere(root, path)) return WATCH_OUTCOME.SKIPPED;
    const region = await this.seams.changed(root, path);
    if (region === null) return WATCH_OUTCOME.SKIPPED;

    const now = this.seams.now();
    this.claims = this.claims.filter((at) => now - at < 60_000);
    if (this.claims.length >= MOST_CLAIMS_PER_MINUTE) return WATCH_OUTCOME.DEFERRED;
    this.claims.push(now);

    const taken = await this.seams.take(path, region);
    if (taken.outcome !== SHARED_OUTCOME.HELD_BY_ANOTHER) return WATCH_OUTCOME.CLAIMED;

    const last = this.noticed.get(path);
    if (last === undefined || now - last >= NOTICE_EVERY_MS) {
      this.noticed.set(path, now);
      const where =
        taken.machine === undefined ? '' : ` on ${shortMachine(taken.machine)}`;
      this.seams.notify(
        `${taken.holder}${where} was already editing ${path}, and a change saved here overlaps it. Agree who keeps it before either of you pushes.`,
      );
    }
    return WATCH_OUTCOME.COLLIDED;
  }

  private watchListed(): void {
    for (const root of watchedRepositories(this.home)) {
      if (this.watchers.has(root)) continue;
      try {
        const watcher = watch(root, { recursive: true }, (_event, name) => {
          if (typeof name !== 'string') return;
          this.settle(root, name.split(sep).join('/'));
        });
        /* A folder that went away takes its watch with it rather than the daemon. */
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
function gitAnswers(args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error) => {
        if (error === null) return resolve(0);
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
      /* Ignored by git is never somebody's source. */
      if ((await gitAnswers(['check-ignore', '-q', '--', path], root)) === 0) return null;
      const tracked =
        (await gitAnswers(['ls-files', '--error-unmatch', '--', path], root)) === 0;
      /* A new file is all of it; a tracked one with no difference from the last
         commit is one that was saved back, or committed, and holds nothing. */
      if (!tracked) return { lines: [], symbols: [] };
      if ((await gitAnswers(['diff', '--quiet', 'HEAD', '--', path], root)) === 0)
        return null;
      return new GitRegionReader(root).read(path);
    },
    take: (path, region) => leases.take(path, holder, WATCH_MINUTES, region),
    notify: (message) => desktopNotice(message),
    now: () => Date.now(),
  };
}
