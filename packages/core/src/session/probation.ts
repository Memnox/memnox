/**
 * Something new on the machine earns its allowances rather than inheriting them: an agent
 * the daemon adopted, or an MCP server it wrapped, asks before it writes or reaches out
 * until the period ends or a person trusts it. Local state, read by every seam.
 */
import { join } from 'node:path';

import { MEMNOX_HOME } from '../config/config';
import { DAY_MS } from '../domain/time';
import { readJsonArray, writeJsonFile } from '../store/json-records';

/** How long something new stays on probation unless a person ends it sooner. */
export const PROBATION_DAYS = 7;

export const PROBATION_KIND = {
  AGENT: 'agent',
  MCP_SERVER: 'mcp-server',
} as const;

export type ProbationKind = (typeof PROBATION_KIND)[keyof typeof PROBATION_KIND];

const PROBATION_FILE = 'probation.json';

export interface ProbationEntry {
  kind: ProbationKind;
  /** The name the seams know it by: `claude-code`, or the server name the proxy is given. */
  name: string;
  /** What a screen prints, where that differs from the name. */
  label?: string;
  since: string;
  until: string;
  /** Set when a person ended it early. */
  trustedAt?: string;
}

/** The command that ends one entry now, quoted wherever probation is explained. */
export function trustCommandFor(kind: ProbationKind, name: string): string {
  return kind === PROBATION_KIND.AGENT
    ? `memnox agents trust ${name}`
    : `memnox mcp trust ${name}`;
}

/** The entry in force for this name, or null when it was trusted, served, or never started. */
export function probationOf(
  entries: readonly ProbationEntry[],
  kind: ProbationKind,
  name: string,
  now: Date,
): ProbationEntry | null {
  const entry = entries.find((each) => each.kind === kind && namedBy(each, name));
  if (entry === undefined || entry.trustedAt !== undefined) return null;
  return Date.parse(entry.until) > now.getTime() ? entry : null;
}

/** Everything on probation right now, soonest to end first. */
export function probationsInForce(
  entries: readonly ProbationEntry[],
  now: Date,
): ProbationEntry[] {
  return entries
    .filter((each) => probationOf([each], each.kind, each.name, now) !== null)
    .sort((a, b) => a.until.localeCompare(b.until));
}

/** Case and punctuation aside, so `Claude Code` and `claude-code` are one agent. */
function namedBy(entry: ProbationEntry, name: string): boolean {
  const wanted = normalized(name);
  return (
    normalized(entry.name) === wanted ||
    (entry.label !== undefined && normalized(entry.label) === wanted)
  );
}

function normalized(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface ProbationStart {
  kind: ProbationKind;
  name: string;
  label?: string;
}

/** The register under the Memnox home. One file, because it holds a handful of names. */
export class ProbationRegister {
  constructor(private readonly home: string) {}

  all(): Promise<ProbationEntry[]> {
    return readJsonArray<ProbationEntry>(this.path());
  }

  /**
   * Starts one, or returns null for something already known: a probation served or
   * ended by a person is never started again because a config was rewritten.
   */
  async start(
    start: ProbationStart,
    now: Date,
    days: number = PROBATION_DAYS,
  ): Promise<ProbationEntry | null> {
    const entries = await this.all();
    if (entries.some((each) => each.kind === start.kind && namedBy(each, start.name))) {
      return null;
    }
    const entry: ProbationEntry = {
      kind: start.kind,
      name: start.name,
      ...(start.label === undefined ? {} : { label: start.label }),
      since: now.toISOString(),
      until: new Date(now.getTime() + days * DAY_MS).toISOString(),
    };
    await writeJsonFile(this.path(), [...entries, entry]);
    return entry;
  }

  /** Ends it now, on the record. Null when nothing by that name was ever on probation. */
  async trust(
    kind: ProbationKind,
    name: string,
    now: Date,
  ): Promise<ProbationEntry | null> {
    const entries = await this.all();
    const found = entries.find((each) => each.kind === kind && namedBy(each, name));
    if (found === undefined) return null;
    const trusted = { ...found, trustedAt: found.trustedAt ?? now.toISOString() };
    await writeJsonFile(
      this.path(),
      entries.map((each) => (each === found ? trusted : each)),
    );
    return trusted;
  }

  private path(): string {
    return join(this.home, MEMNOX_HOME, PROBATION_FILE);
  }
}
