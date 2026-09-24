/**
 * Every host each agent has reached through the egress proxy, with when it was first and
 * last seen. The record a first-time-destination check reads: `isNewDestination` answers
 * it without a model, from what this machine has actually watched.
 */
import { join } from 'node:path';

import { MEMNOX_HOME } from '../config/config';
import { JsonRecordDir } from '../store/json-records';

const DESTINATIONS_DIR = 'destinations';

/** The most hosts kept per agent; the least recently seen fall off first. */
export const MOST_DESTINATIONS = 500;

export interface DestinationSeen {
  host: string;
  first: string;
  last: string;
  count: number;
}

export interface AgentDestinations {
  agent: string;
  hosts: DestinationSeen[];
}

/** True when this agent has never been seen reaching this host. */
export function isNewDestination(record: AgentDestinations, host: string): boolean {
  const wanted = host.toLowerCase();
  return !record.hosts.some((each) => each.host === wanted);
}

/** The record with one more visit in it, bounded, and whether the host was new. */
export function noteDestination(
  record: AgentDestinations,
  host: string,
  at: string,
): { record: AgentDestinations; first: boolean } {
  const wanted = host.toLowerCase();
  const known = record.hosts.find((each) => each.host === wanted);
  const seen: DestinationSeen =
    known === undefined
      ? { host: wanted, first: at, last: at, count: 1 }
      : { ...known, last: at, count: known.count + 1 };
  const others = record.hosts.filter((each) => each.host !== wanted);
  const hosts = [...others, seen]
    .sort((a, b) => b.last.localeCompare(a.last))
    .slice(0, MOST_DESTINATIONS);
  return { record: { agent: record.agent, hosts }, first: known === undefined };
}

/** One file per agent, so two agents never contend for one write. */
export class DestinationRecords {
  private readonly records: JsonRecordDir<AgentDestinations>;

  constructor(home: string) {
    this.records = new JsonRecordDir(join(home, MEMNOX_HOME, DESTINATIONS_DIR));
  }

  async read(agent: string): Promise<AgentDestinations> {
    return (await this.records.read(fileIdOf(agent))) ?? { agent, hosts: [] };
  }

  /** Records one visit. A lost race loses a count, never a host seen before. */
  async record(agent: string, host: string, at: string): Promise<{ first: boolean }> {
    const noted = noteDestination(await this.read(agent), host, at);
    await this.records.write(fileIdOf(agent), noted.record);
    return { first: noted.first };
  }
}

/** A name safe as a file name, since an agent name is whatever somebody called it. */
function fileIdOf(agent: string): string {
  return agent.toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
}
