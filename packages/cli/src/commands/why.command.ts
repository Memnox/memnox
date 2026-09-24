/**
 * `memnox why`: why one decision went the way it did, read back from the row and never
 * recomputed, because today's rules against yesterday's action answer a different question.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import {
  codeownersFor,
  DECISION_EFFECT,
  describeEvidence,
  ENFORCEMENT_MODE,
  LEDGER_LATEST_ONLY,
  LEDGER_RECENT_LIMIT,
  readProtection,
  readPullRequest,
  type SqliteEventStore,
  type MemnoxEvent,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { withEvents } from '../event-store';
import type { FlowRow } from '../flow';

/** How long `gh` is given to answer, because `why` is read while somebody waits. */
const FORGE_TIMEOUT_MS = 3_000;

const execFileAsync = promisify(execFile);

export function registerWhyCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
): void {
  program
    .command('why [id]')
    .description('Why the last thing that did not simply proceed was decided that way')
    .option('--allowed', 'explain the last allow instead')
    .option('--evidence', 'show the digests and the outcome behind it')
    .option('--json', 'machine-readable output')
    .action(async (id: string | undefined, options: WhyOptions) =>
      runWhy(context, { home, now }, id, options),
    );
}

interface WhyOptions {
  allowed?: boolean;
  evidence?: boolean;
  json?: boolean;
}

interface WhyDeps {
  home: () => string;
  now: () => Date;
}

/** Why one decision went the way it did: the rule, the file line, and the evidence. */
async function runWhy(
  context: CliContext,
  deps: WhyDeps,
  id: string | undefined,
  options: WhyOptions,
): Promise<void> {
  await withEvents(deps.home(), async (store) => {
    const event = await findEvent(store, id, options.allowed === true);
    if (options.json === true) {
      if (event !== undefined) context.out.json(event);
      return;
    }
    context.flow.open('memnox why');
    if (event === undefined) {
      renderNothingFound(context, id);
      return;
    }
    await renderAnswer(context, event, options.evidence === true, deps.now());
  });
}

/** The named event, or else the latest one that did not simply proceed. */
async function findEvent(
  store: SqliteEventStore,
  id: string | undefined,
  allowed: boolean,
): Promise<MemnoxEvent | undefined> {
  if (id !== undefined) {
    const rows = await store.query({ limit: LEDGER_RECENT_LIMIT, withConfig: true });
    return rows.find((each) => each.id === id);
  }
  const effects = allowed
    ? [DECISION_EFFECT.ALLOW]
    : [DECISION_EFFECT.DENY, DECISION_EFFECT.ASK];
  const rows = await store.query({ effects, limit: LEDGER_LATEST_ONLY });
  return rows[rows.length - 1];
}

function renderNothingFound(context: CliContext, id: string | undefined): void {
  if (id !== undefined) {
    context.flow.close(`No event with id "${id}".`);
    return;
  }
  context.flow.close('Nothing has been decided on this machine yet.');
  context.flow.hint('Run an agent through "memnox mcp wrap" first.');
}

async function renderAnswer(
  context: CliContext,
  event: MemnoxEvent,
  withEvidence: boolean,
  now: Date,
): Promise<void> {
  const { flow, style } = context;
  renderDecision(context, event);
  if (withEvidence) {
    renderEvidence(context, event);
    await renderRepoEvidence(context, event, now);
  }
  flow.close(
    style.effect(event.effect, `${event.effect.toUpperCase()}  ${event.operation}`),
  );
  if (!withEvidence) {
    flow.hint('Add --evidence for the digests and the outcome behind it.');
  }
}

function renderDecision(context: CliContext, event: MemnoxEvent): void {
  const { flow, style } = context;
  const target = event.target === undefined ? '' : ` ${event.target}`;
  flow.rows(
    `${style.effect(event.effect, event.effect.toUpperCase())}  ${event.operation}${target}`,
    decisionRows(event),
  );
  const alternative = event.alternative;
  if (alternative !== undefined) {
    const instead =
      alternative.resource === undefined
        ? alternative.action
        : `${alternative.action} ${alternative.resource}`;
    flow.step(
      'Instead',
      alternative.note === '' ? instead : `${instead}  ${alternative.note}`,
    );
  }
}

function decisionRows(event: MemnoxEvent): FlowRow[] {
  const rows: FlowRow[] = [
    { label: 'when', value: event.at },
    { label: 'agent', value: describeActor(event) },
    { label: 'surface', value: event.surface },
    { label: 'class', value: event.class },
    { label: 'reason', value: event.reason },
    { label: 'rule', value: describeRule(event) },
  ];
  const declaredIn = declaredInOf(event);
  if (declaredIn !== undefined) rows.push({ label: 'declared in', value: declaredIn });
  if (event.policyHash !== undefined) {
    rows.push({
      label: 'ruleset',
      value: `${event.policyHash}, the rules in force at the time`,
    });
  }
  if (event.mode !== ENFORCEMENT_MODE.ENFORCE && event.shadowEffect !== undefined) {
    rows.push({
      label: 'would have',
      value: `${event.shadowEffect.toUpperCase()} in enforce; the mode was ${event.mode}`,
    });
  }
  if (event.authorizedBy !== undefined) {
    rows.push({ label: 'released by', value: event.authorizedBy });
  }
  return rows;
}

// The actor type only when the name does not already say it, or "an agent (agent)".
function describeActor(event: MemnoxEvent): string {
  const named = event.agent.toLowerCase().includes(event.actorType.toLowerCase());
  return named ? event.agent : `${event.agent} (${event.actorType})`;
}

function describeRule(event: MemnoxEvent): string {
  const rule = event.rule;
  if (rule === undefined) return 'none matched, so the default for this mode applied';
  return `${rule.name}  (${rule.layer} layer)`;
}

function declaredInOf(event: MemnoxEvent): string | undefined {
  const rule = event.rule;
  if (rule === undefined) return undefined;
  if (rule.line === undefined) return rule.file;
  return `${rule.file}:${rule.line}`;
}

function renderEvidence(context: CliContext, event: MemnoxEvent): void {
  const rows: FlowRow[] = [{ label: 'event', value: event.id }];
  // The digest, never the arguments: this is the line that keeps the ledger dull.
  if (event.argsDigest !== undefined) {
    rows.push({
      label: 'arguments',
      value: `${event.argsDigest} (a hash; the payload never left)`,
    });
  }
  if (event.exitCode !== undefined) {
    rows.push({ label: 'exit code', value: String(event.exitCode) });
  }
  if (event.durationMs !== undefined) {
    rows.push({ label: 'took', value: `${event.durationMs}ms` });
  }
  if (event.execution !== undefined) {
    rows.push({ label: 'execution', value: event.execution });
  }
  context.flow.rows('Evidence', rows);
}

/**
 * What the repository already says, read-only through a CLI the reader is logged into:
 * `gh api` with no `-X`, and a file off the disk. It stands beside the rule, not behind it.
 */
async function renderRepoEvidence(
  context: CliContext,
  event: MemnoxEvent,
  now: Date,
): Promise<void> {
  if (!event.operation.startsWith('git') && !event.operation.startsWith('gh')) return;
  const at = now.toISOString();
  const lines = [
    ...(await readBranchProtection(at)),
    ...(await readPullRequestEvidence(at)),
    ...(await readCodeowners(event.target)),
  ];
  if (lines.length === 0) return;
  context.flow.box('Evidence from this repository', lines);
}

async function readBranchProtection(at: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', 'repos/{owner}/{repo}/branches/main/protection'],
      { timeout: FORGE_TIMEOUT_MS },
    );
    const evidence = readProtection(stdout, 'gh api, just now', at);
    return evidence === null ? [] : describeEvidence(evidence);
  } catch {
    // Not logged in, no remote, or the branch is unprotected. Silence, not a guess.
    return [];
  }
}

async function readPullRequestEvidence(at: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', '--json', 'number,reviewDecision,statusCheckRollup'],
      { timeout: FORGE_TIMEOUT_MS },
    );
    const evidence = readPullRequest(stdout, 'gh pr view, just now', at);
    return evidence === null ? [] : describeEvidence(evidence);
  } catch {
    // No pull request for this branch, or not logged in. Silence, not a guess.
    return [];
  }
}

async function readCodeowners(target: string | undefined): Promise<string[]> {
  if (target === undefined) return [];
  try {
    const owners = codeownersFor(await readFile('.github/CODEOWNERS', 'utf8'), target);
    return owners === null ? [] : [`CODEOWNERS: ${owners}`];
  } catch {
    // No CODEOWNERS file, which is the ordinary case.
    return [];
  }
}
