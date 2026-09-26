/**
 * A scope a person allowed for a while: "Claude may change staging payments-api for thirty
 * minutes". It turns an ask inside the scope into an allow, never a refusal, and it ends
 * on its own, so debugging access never quietly becomes standing authority.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MEMNOX_HOME } from '../config/config';
import type { ActionRequest } from '../domain/action-event';
import { matchesAny } from '../policy/pattern-matcher';
import { readJsonArray, writeJsonFile } from '../store/json-records';

const ALLOWANCES_FILE = 'allowances.json';

/** The longest an allowance may stand, so one somebody forgot still ends the same day. */
export const MOST_ALLOWANCE_MINUTES = 8 * 60;

export interface Allowance {
  id: string;
  /** Action patterns, as a rule's `actions` are written. */
  actions: string[];
  environments?: string[];
  targets?: string[];
  agents?: string[];
  /** Who allowed it and why, carried into every decision it made. */
  by: string;
  reason?: string;
  since: string;
  until: string;
  revokedAt?: string;
}

export function inForceAt(allowance: Allowance, now: string): boolean {
  return (
    allowance.revokedAt === undefined && allowance.until > now && allowance.since <= now
  );
}

/** The allowance covering this request, if any. Every field it names must match. */
export function allowanceFor(
  allowances: readonly Allowance[],
  request: ActionRequest,
  context: { agentName: string; now: string },
): Allowance | null {
  return (
    allowances.find(
      (each) =>
        inForceAt(each, context.now) &&
        matchesAny(each.actions, request.action) &&
        matchesAny(each.environments, request.environment) &&
        matchesAny(each.targets, request.target) &&
        matchesAny(each.agents, context.agentName),
    ) ?? null
  );
}

/** How a decision an allowance made reads, so `why` names who allowed it and until when. */
export function describeAllowance(allowance: Allowance): string {
  const why = allowance.reason === undefined ? '' : ` (${allowance.reason})`;
  return `${allowance.by} allowed this until ${allowance.until}${why}, allowance ${allowance.id}`;
}

export class FileAllowances {
  constructor(private readonly home: string) {}

  all(): Promise<Allowance[]> {
    return readJsonArray<Allowance>(this.path());
  }

  async inForce(now: string): Promise<Allowance[]> {
    return (await this.all()).filter((each) => inForceAt(each, now));
  }

  /** Ended ones are kept a day for the record, then dropped, so the file stays small. */
  async add(allowance: Allowance): Promise<void> {
    const dayAgo = new Date(
      Date.parse(allowance.since) - 24 * 60 * 60 * 1_000,
    ).toISOString();
    const kept = (await this.all()).filter((each) => each.until > dayAgo);
    await writeJsonFile(this.path(), [...kept, allowance]);
  }

  /** Null when there was no such allowance. */
  async revoke(id: string, now: string): Promise<Allowance | null> {
    const all = await this.all();
    const found = all.find((each) => each.id === id);
    if (found === undefined) return null;
    const revoked = { ...found, revokedAt: found.revokedAt ?? now };
    await writeJsonFile(
      this.path(),
      all.map((each) => (each === found ? revoked : each)),
    );
    return revoked;
  }

  /** For a gate that decides synchronously; a file that will not read is no allowance. */
  inForceNow(now: string): Allowance[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path(), 'utf8'));
      if (!Array.isArray(parsed)) return [];
      // Written by `add` above, so each entry is an allowance.
      return (parsed as Allowance[]).filter((each) => inForceAt(each, now));
    } catch {
      return [];
    }
  }

  private path(): string {
    return join(this.home, MEMNOX_HOME, ALLOWANCES_FILE);
  }
}
