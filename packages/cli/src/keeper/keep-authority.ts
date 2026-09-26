/**
 * What each agent may do, pass to pass, so authority that grew is said the pass it grew:
 * an agent that could only read gh and can now change it on its own, a CLI newly logged
 * in, or a credential that now names something like production.
 */
import {
  productionLooking,
  type DiscoveryReport,
  type EnvironmentSnapshot,
  type Policy,
} from '@memnox/core';

import { authorityFor } from '../commands/explain/authority-view';
import { DRIFT_GROUP, type DriftItem } from './keep-drift';

/** The part of one agent's reach into one system a person would want to hear moved. */
interface SystemStanding {
  /** Changes it can make with nobody asked. The number that matters. */
  changesAllowed: number;
  readsAllowed: number;
}

export interface AuthorityRecord {
  /** Agent kind to system to standing. */
  agents: Record<string, Record<string, SystemStanding>>;
  /** CLI name to the production-looking names its credential carries. */
  production: Record<string, string[]>;
}

/** This look's authority, under the rules in force now. */
export function authorityRecordOf(
  look: { report: DiscoveryReport; snapshot: EnvironmentSnapshot },
  policies: readonly Policy[],
): AuthorityRecord {
  const agents: AuthorityRecord['agents'] = {};
  for (const agent of look.report.agents) {
    const systems: Record<string, SystemStanding> = {};
    const authority = authorityFor({
      agentKind: agent.kind,
      agentId: agent.id,
      report: look.report,
      last: look.snapshot,
      policies,
    });
    for (const each of authority) {
      systems[each.system] = {
        changesAllowed: each.changes.allow,
        readsAllowed: each.reads.allow,
      };
    }
    agents[agent.kind] = systems;
  }
  const production: AuthorityRecord['production'] = {};
  for (const cli of look.report.authenticated) {
    production[cli.name] = productionNamesIn(cli.detail);
  }
  return { agents, production };
}

/** Every production-looking name in a credential's structural detail. A guess, and said as one. */
function productionNamesIn(detail: string | undefined): string[] {
  if (detail === undefined) return [];
  return [
    ...new Set(
      detail
        .split(/[,\s]+/)
        .filter((word) => word !== '' && productionLooking(word) !== undefined),
    ),
  ];
}

/** What grew since the last pass. The first pass only sets the record, and says nothing. */
export function authorityItems(
  before: AuthorityRecord | null,
  after: AuthorityRecord,
): DriftItem[] {
  if (before === null) return [];
  return [
    ...grownReach(before, after),
    ...newClis(before, after),
    ...newProduction(before, after),
  ];
}

function grownReach(before: AuthorityRecord, after: AuthorityRecord): DriftItem[] {
  const items: DriftItem[] = [];
  for (const [agent, systems] of Object.entries(after.agents)) {
    const was = before.agents[agent];
    // A new agent is the daemon's other notice; this one is about authority that grew.
    if (was === undefined) continue;
    for (const [system, now] of Object.entries(systems)) {
      const then = was[system]?.changesAllowed ?? 0;
      if (now.changesAllowed <= then) continue;
      items.push({
        group: DRIFT_GROUP.AUTHORITY,
        name: agent,
        agent,
        summary: `${agent} can now change ${system} with nobody asked. before: ${then} change(s); after: ${now.changesAllowed}`,
      });
    }
  }
  return items;
}

function newClis(before: AuthorityRecord, after: AuthorityRecord): DriftItem[] {
  return Object.keys(after.production)
    .filter((cli) => before.production[cli] === undefined)
    .map((cli) => ({
      group: DRIFT_GROUP.AUTHORITY,
      name: cli,
      summary: `${cli} is logged in on this machine, so an agent with a shell can use it. before: absent; after: present`,
    }));
}

function newProduction(before: AuthorityRecord, after: AuthorityRecord): DriftItem[] {
  const items: DriftItem[] = [];
  for (const [cli, names] of Object.entries(after.production)) {
    const known = before.production[cli];
    if (known === undefined) continue;
    const added = names.filter((name) => !known.includes(name));
    if (added.length === 0) continue;
    items.push({
      group: DRIFT_GROUP.AUTHORITY,
      name: cli,
      summary: `${cli}'s credential now names ${added.join(', ')}, which is named like production. before: ${known.length === 0 ? 'none' : known.join(', ')}; after: ${names.join(', ')}`,
    });
  }
  return items;
}
