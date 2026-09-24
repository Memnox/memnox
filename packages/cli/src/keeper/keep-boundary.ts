import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  desktopNotice,
  PROBATION_KIND,
  protectionStopped,
  watchablePaths,
  watchedRepositories,
} from '@memnox/core';
import { EDIT_HOOK_BINARY } from '@memnox/interceptors';
import { watchConfigPaths } from '../config-watch';
import type { ScanSeams } from '../machine-scan';
import { wrapEveryServer } from '../mcp/wrap-servers';
import { wireSessionTools, type SessionPlacement } from '../session-tools/session-entry';
import { EDIT_HOOK_TARGETS, type EditHookTarget } from '../protect/agent-hooks';
import { holdsPolicyHook } from '../protect/claude-hook';
import { describeResumed, endStopWhenDue } from '../protect/stop';
import { recordConfigChanges } from './config-events';
import { DRIFT_GROUP, driftNotices, type DriftItem } from './keep-drift';
import { dormantNotice } from './keep-dormant';
import { probationClause, startProbations, type Adopted } from './keep-probation';
import { keptRecords } from './keep-records';
import { watchOnce } from './keep-watch';
import { readKept, writeKept, type Kept } from './kept';

/**
 * The daemon's half of `setup`: an agent installed next week is hooked, a hook somebody's
 * editor dropped is put back, and a server added later goes through the proxy, so the
 * boundary setup drew stays drawn without anybody running setup again.
 */

/** The backstop between passes; a config change wakes it sooner. */
const KEEP_INTERVAL_MS = 5 * 60 * 1_000;

/** The least time between two looks for drift, so a burst of config writes is one scan. */
const LOOK_GAP_MS = 30 * 1_000;

export const KEPT_CHANGE = {
  /** An agent that was not here when setup ran, hooked now. */
  ADOPTED: 'adopted',
  /** A hook that was in place and is not any more, put back. */
  RESTORED: 'restored',
  /** A hook that only took leases, put back so it rules on every tool call too. */
  UPGRADED: 'upgraded',
  /** MCP servers added to a config since the last pass, now through the proxy. */
  WRAPPED: 'wrapped',
  /** The session tools put into an agent that was missing them. */
  SESSION: 'session-tools',
} as const;

export type KeptChange =
  | {
      kind:
        | typeof KEPT_CHANGE.ADOPTED
        | typeof KEPT_CHANGE.RESTORED
        | typeof KEPT_CHANGE.UPGRADED;
      agent: string;
      /** Set when this adoption started the agent's probation. */
      probation?: true;
    }
  | {
      kind: typeof KEPT_CHANGE.WRAPPED;
      servers: string[];
      files?: string[];
      /** The servers whose probation this wrapping started. */
      probation?: string[];
    }
  | { kind: typeof KEPT_CHANGE.SESSION; agents: string[]; files: string[] };

export interface KeepSeams {
  targets?: readonly EditHookTarget[];
  wrap?: (
    home: string,
    project: string,
  ) => Promise<{ names: string[]; files?: string[] }>;
  projects?: (home: string) => string[];
  /** The machine the drift look reads, so a test never scans the real one. */
  scan?: ScanSeams;
  /** When probation starts from, so a test states the clock. */
  now?: () => Date;
  /** Where the session tools are put back, so a test never needs the binary on PATH. */
  session?: (home: string) => Promise<SessionPlacement>;
}

/**
 * One pass. Hooks only what is missing, so a file whose owner reordered it is never
 * rewritten, and never touches an agent somebody took the hook out of on purpose.
 */
export async function keepOnce(
  home: string,
  seams: KeepSeams = {},
): Promise<KeptChange[]> {
  const kept = await readKept(home);
  if (kept === null) return [];
  // Stopped on purpose, so nothing is put back or adopted until somebody starts it again.
  if (await protectionStopped(home, (seams.now ?? (() => new Date()))())) return [];
  const changes: KeptChange[] = [];
  const hooked = new Set(kept.hooked);
  for (const target of seams.targets ?? EDIT_HOOK_TARGETS) {
    const change = await keepHook(home, kept, target);
    if (change !== null) changes.push(change);
    if ((await hookIn(join(home, target.file), [])) !== HOOK.NONE)
      hooked.add(target.name);
  }
  if (kept.mcp) {
    const { servers, files } = await wrapNew(home, seams);
    if (servers.length > 0) {
      changes.push({
        kind: KEPT_CHANGE.WRAPPED,
        servers,
        ...(files.length === 0 ? {} : { files }),
      });
    }
  }
  const session = await keepSession(home, kept, seams);
  if (session !== null) changes.push(session);
  if (hooked.size !== kept.hooked.length) {
    await writeKept(home, { ...kept, hooked: [...hooked] });
  }
  return onProbation(home, changes, (seams.now ?? (() => new Date()))());
}

/** The session tools, put back into any installed agent missing them, unless taken out on purpose. */
async function keepSession(
  home: string,
  kept: Kept,
  seams: KeepSeams,
): Promise<KeptChange | null> {
  if (kept.session === false) return null;
  const placed = await (seams.session ?? wireSessionTools)(home);
  if (placed.written.length === 0) return null;
  return { kind: KEPT_CHANGE.SESSION, agents: placed.written, files: placed.files };
}

/** Starts probation for what this pass adopted or wrapped, and marks the changes that did. */
async function onProbation(
  home: string,
  changes: KeptChange[],
  now: Date,
): Promise<KeptChange[]> {
  const adopted: Adopted[] = changes.flatMap((change): Adopted[] => {
    if (change.kind === KEPT_CHANGE.ADOPTED)
      return [{ kind: PROBATION_KIND.AGENT, agent: change.agent }];
    if (change.kind === KEPT_CHANGE.WRAPPED)
      return [{ kind: PROBATION_KIND.MCP_SERVER, servers: change.servers }];
    return [];
  });
  if (adopted.length === 0) return changes;
  const started = await startProbations(home, adopted, now);
  return changes.map((change): KeptChange => {
    if (change.kind === KEPT_CHANGE.WRAPPED) {
      const servers = change.servers.filter((server) => started.has(server));
      return servers.length === 0 ? change : { ...change, probation: servers };
    }
    return change.kind === KEPT_CHANGE.ADOPTED && started.has(change.agent)
      ? { ...change, probation: true }
      : change;
  });
}

async function keepHook(
  home: string,
  kept: Kept,
  target: EditHookTarget,
): Promise<KeptChange | null> {
  const path = join(home, target.file);
  // No directory is an agent that is not installed, and creating one would invent it.
  if (!existsSync(dirname(path))) return null;
  if (kept.declined.includes(target.name)) return null;
  const found = await hookIn(path, target.currentEvents ?? [], target.agent);
  if (found === HOOK.CURRENT) return null;
  if (!(await target.install(home))) return null;
  if (found === HOOK.OUTDATED) return { kind: KEPT_CHANGE.UPGRADED, agent: target.name };
  return {
    kind: kept.hooked.includes(target.name) ? KEPT_CHANGE.RESTORED : KEPT_CHANGE.ADOPTED,
    agent: target.name,
  };
}

/** What a hooks file holds of ours: nothing, what an older setup wrote, or all of it. */
const HOOK = { NONE: 'none', OUTDATED: 'outdated', CURRENT: 'current' } as const;

type HookFound = (typeof HOOK)[keyof typeof HOOK];

/** Any entry running the hook counts, because rewriting to reorder would fight the owner. */
async function hookIn(
  path: string,
  events: readonly string[],
  agent?: string,
): Promise<HookFound> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // No file yet: the agent is installed and has never been hooked.
    return HOOK.NONE;
  }
  if (
    holdsPolicyHook(text, agent) &&
    events.every((event) => text.includes(`"${event}"`))
  ) {
    return HOOK.CURRENT;
  }
  // Ours but older: the lease half alone, or from before an event or the agent flag was added.
  return text.includes(EDIT_HOOK_BINARY) ? HOOK.OUTDATED : HOOK.NONE;
}

/** Every repository the seams have seen, plus the home directory for user-level configs. */
async function wrapNew(
  home: string,
  seams: KeepSeams,
): Promise<{ servers: string[]; files: string[] }> {
  const wrap = seams.wrap ?? wrapEveryServer;
  const projects = [home, ...(seams.projects ?? watchedRepositories)(home)];
  const names: string[] = [];
  const files: string[] = [];
  for (const project of projects) {
    const wrapped = await wrap(home, project);
    names.push(...wrapped.names);
    files.push(...(wrapped.files ?? []));
  }
  return { servers: [...new Set(names)], files: [...new Set(files)] };
}

/** What a person sees for one change, in a desktop notice and in the daemon's log. */
export function describeKept(change: KeptChange): string {
  if (change.kind === KEPT_CHANGE.WRAPPED) {
    const which = change.servers.join(', ');
    const said =
      change.servers.length === 1
        ? `New MCP server ${which} now goes through Memnox, so your rules apply to it.`
        : `New MCP servers ${which} now go through Memnox, so your rules apply to them.`;
    const probation = change.probation ?? [];
    return probation.length === 0
      ? said
      : `${said} ${probation.join(', ')}: ${probationClause()}.`;
  }
  if (change.kind === KEPT_CHANGE.SESSION) {
    return `${change.agents.join(', ')} can ask Memnox from inside a session again. "memnox mcp session off" takes it out for good.`;
  }
  if (change.kind === KEPT_CHANGE.UPGRADED) {
    return `The Memnox hook in ${change.agent} now checks your rules on every tool call, not only on writes.`;
  }
  if (change.kind === KEPT_CHANGE.ADOPTED) {
    const probation = change.probation === true ? ` It is ${probationClause()}.` : '';
    return `${change.agent} is new on this machine, so Memnox hooked it.${probation} Nothing needed running.`;
  }
  return `The Memnox hook was taken out of ${change.agent}, so it was put back. "memnox status" shows what is kept.`;
}

interface KeeperOptions {
  log: (message: string) => void;
  notify?: (message: string) => void;
  seams?: KeepSeams;
  intervalMs?: number;
  now?: () => Date;
  /** What wakes a pass early. The agents' config directories, unless a test says otherwise. */
  watcher?: () => ReturnType<typeof watchConfigPaths>;
}

/**
 * Runs a pass when an agent's config changes, and every few minutes regardless. A pass
 * that throws is logged and the next one runs, because the daemon must outlive a bad file.
 */
export class BoundaryKeeper {
  private running = false;
  private closeWatch: (() => void) | null = null;
  private lastLook: number | null = null;
  // A look skipped for coming too soon is owed, so the next wait is the gap and not five minutes.
  private owed = false;
  // Servers this keeper just wrapped, already announced, so drift does not announce them again.
  private readonly announced = new Set<string>();

  constructor(
    private readonly home: string,
    private readonly options: KeeperOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const watcher =
      this.options.watcher === undefined
        ? watchConfigPaths(watchablePaths(this.home))
        : this.options.watcher();
    this.closeWatch = () => watcher.close();
    void this.loop((ms) => watcher.next(ms));
  }

  stop(): void {
    this.running = false;
    this.closeWatch?.();
    this.closeWatch = null;
  }

  private async loop(next: (ms: number) => Promise<boolean>): Promise<void> {
    while (this.running) {
      await this.pass();
      await next(this.owed ? LOOK_GAP_MS : (this.options.intervalMs ?? KEEP_INTERVAL_MS));
    }
  }

  private async pass(): Promise<void> {
    const now = this.options.now === undefined ? new Date() : this.options.now();
    try {
      // The one way protection comes back without a person: the time they gave ran out.
      const resumed = await endStopWhenDue(this.home, now);
      if (resumed !== null) this.say(describeResumed(resumed));
      const changes = await keepOnce(this.home, this.options.seams);
      for (const change of changes) {
        this.say(describeKept(change));
        if (change.kind === KEPT_CHANGE.WRAPPED) {
          for (const server of change.servers) this.announced.add(server);
        }
      }
      const targets = this.options.seams?.targets ?? EDIT_HOOK_TARGETS;
      await recordConfigChanges(this.home, keptRecords(this.home, changes, targets), now);
    } catch (err) {
      this.options.log(`Keeping the boundary failed this pass: ${String(err)}`);
    }
    if (this.lookDue(now)) await this.look(now);
  }

  /** At most one look per gap, so the writes of one save, or of this keeper, are one scan. */
  private lookDue(now: Date): boolean {
    const last = this.lastLook;
    if (last !== null && now.getTime() - last < LOOK_GAP_MS) {
      this.owed = true;
      return false;
    }
    this.lastLook = now.getTime();
    this.owed = false;
    return true;
  }

  private async look(now: Date): Promise<void> {
    try {
      const { items, dormant } = await watchOnce(
        this.home,
        now,
        this.options.seams?.scan,
      );
      const fresh = items.filter((item) => !this.wasAnnounced(item));
      this.announced.clear();
      for (const said of driftNotices(fresh)) this.say(said);
      for (const agent of dormant) this.say(dormantNotice(agent));
    } catch (err) {
      this.options.log(`Looking for drift failed this pass: ${String(err)}`);
    }
  }

  private wasAnnounced(item: DriftItem): boolean {
    return item.group === DRIFT_GROUP.NEW_SERVER && this.announced.has(item.name);
  }

  private say(message: string): void {
    this.options.log(message);
    (this.options.notify ?? desktopNotice)(message);
  }
}
