import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  ACTION,
  DECISION_EFFECT,
  LEDGER_SCAN_LIMIT,
  NodeMachineReader,
  TOOL_CLASS,
  TOOL_EFFECT,
  delegations,
  discover,
  findUnusedGrants,
  handOverVerdict,
  matchesPattern,
  readPolicyDocumentFile,
  rollUpUsage,
  usageFrom,
  verbAction,
  verbTableFor,
  verbTableNames,
  writePolicyDocumentFile,
  type DecisionEffect,
  type Delegation,
  type MemnoxEvent,
  type Policy,
  type VerbTable,
  type Verb,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DAY_MS, windowDays } from '../duration';
import { withEvents } from '../event-store';
import { TONE, type FlowItem } from '../flow';
import { resolvePolicyFile } from '../policy-path';
import { registerPolicyFile } from '../policy-registry';
import { mergeRules, WRITTEN_POLICY_FILE } from './merge-rules';
import { recordLocalDecisions } from '../sync/local-decisions';

/**
 * The rules `protect` drafts from evidence rather than a questionnaire: one CLI's verb
 * table, what went unused, and what has been approved often enough to hand over.
 */

/** A glob segment matching any depth of directories. */
const ANY_DEPTH = '**';

/** Enough to make the point without the block becoming the screen. */
const UNUSED_SHOWN = 12;

/**
 * One CLI, from its own verb table. Denying the credential *file* while allowing the
 * CLI is what makes this adoptable: the tool keeps working, and the key stays unread.
 */
export async function runForCli(context: CliContext, name: string): Promise<void> {
  const table = verbTableFor(name);
  if (table === null) {
    throw new Error(
      `No verb table for "${name}". Known: ${verbTableNames().join(', ')}.`,
    );
  }
  const rules = rulesForCli(name, table);
  await mergeRules(WRITTEN_POLICY_FILE, rules);

  const { flow } = context;
  flow.table(
    `Written to ${WRITTEN_POLICY_FILE}`,
    ['Effect', 'Rule'],
    rules.map((rule) => [rule.decision.effect, rule.name]),
  );
  flow.close(`Wrote ${rules.length} rule(s) for ${name}.`);
  flow.hint(`${name} keeps working: only reading its credential file is denied.`);
}

function rulesForCli(name: string, table: VerbTable): Policy[] {
  const rules: Policy[] = [];
  const destructive = table.verbs.filter((verb) => verb.class === TOOL_CLASS.DESTRUCTIVE);
  const external = table.verbs.filter((verb) => verb.class === TOOL_CLASS.WRITE);
  if (destructive.length > 0) {
    rules.push(
      ruleFor(name, DECISION_EFFECT.DENY, destructive, 'these do not come back'),
    );
  }
  if (external.length > 0) {
    rules.push(
      ruleFor(name, DECISION_EFFECT.ASK, external, 'somebody else sees the result'),
    );
  }
  const paths = table.credential.filter((source) => source.startsWith('~'));
  if (paths.length > 0) rules.push(credentialRule(name, paths));
  return rules;
}

function credentialRule(name: string, paths: readonly string[]): Policy {
  return {
    name: `${name}-credential-deny`,
    description: `${name} keeps working; the agent just cannot read the key.`,
    match: {
      actions: [ACTION.FILESYSTEM_READ],
      targets: paths.flatMap((path) => {
        const anywhere = path.replace('~', ANY_DEPTH);
        return [anywhere, `${anywhere}/${ANY_DEPTH}`];
      }),
    },
    decision: {
      effect: DECISION_EFFECT.DENY,
      reason: `reading ${name}'s credential is not needed to use ${name}`,
      alternative: { action: name, note: `run ${name} instead of reading its key` },
    },
  };
}

/** One rule covering every verb of a CLI that shares an effect. */
function ruleFor(
  cli: string,
  effect: DecisionEffect,
  verbs: readonly Verb[],
  because: string,
): Policy {
  const first = verbs[0];
  return {
    name: `${cli}-${effect}`,
    match: {
      actions: verbs.map((verb) => verbAction(cli, verb)),
    },
    decision: {
      effect,
      reason: `${cli}: ${because}`,
      alternative: {
        action: cli,
        note: first?.alternative ?? 'ask somebody, or change this rule',
      },
    },
  };
}

/**
 * Least privilege from what actually happened: everything reachable that nothing touched
 * in the window becomes an ask, never a deny, since unused is not never needed.
 */
export async function runFromUsage(
  context: CliContext,
  window: string,
  cwd: () => string,
): Promise<void> {
  const days = windowDays(window, '--from-usage');
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const { flow } = context;

  await withEvents(homedir(), async (store) => {
    const events = await store.query({ since });
    if (events.length === 0) {
      flow.close(`Nothing was recorded in the last ${days} days.`);
      flow.hint('Nothing can be called unused until something has been used.');
      return;
    }
    const actions = await unusedActions(events, days, cwd());
    if (actions.length === 0) {
      flow.close(`Everything reachable was used in the last ${days} days.`);
      return;
    }
    await mergeRules(WRITTEN_POLICY_FILE, [unusedRule(actions, days)]);
    renderUnused(context, actions);
  });
}

/** Every write-capable MCP tool reachable here that the ledger never saw used. */
async function unusedActions(
  events: readonly MemnoxEvent[],
  days: number,
  cwd: string,
): Promise<string[]> {
  const report = await discover(new NodeMachineReader(homedir()), {
    now: new Date().toISOString(),
    projectDirs: [cwd],
  });
  const usage = rollUpUsage(usageFrom(events));
  const granted = report.surfaces.flatMap((surface) =>
    (surface.tools ?? [])
      .filter((tool) => tool.effect !== TOOL_EFFECT.READ)
      .map((tool) => ({
        agentId: surface.agentId,
        action: `mcp.${tool.name}`,
        grantedVia: surface.detectedFrom,
      })),
  );
  const unused = findUnusedGrants(granted, usage, days, matchesPattern);
  return [...new Set(unused.map((grant) => grant.action))];
}

function unusedRule(actions: readonly string[], days: number): Policy {
  return {
    name: `unused-${days}d`,
    description: `Reachable and untouched for ${days} days. Ask before the first use.`,
    match: { actions: [...actions] },
    decision: {
      effect: DECISION_EFFECT.ASK,
      reason: `nothing used this in ${days} days, so the first use is worth seeing`,
      alternative: {
        // Only called with at least one unused action.
        action: actions[0] as string,
        note: 'approve it once, or delete this rule if it is wrong',
      },
    },
  };
}

function renderUnused(context: CliContext, actions: readonly string[]): void {
  const { flow } = context;
  const shown: FlowItem[] = actions
    .slice(0, UNUSED_SHOWN)
    .map((action) => ({ tone: TONE.WARN, text: action }));
  if (actions.length > UNUSED_SHOWN) {
    shown.push({ tone: TONE.DIM, text: `… and ${actions.length - UNUSED_SHOWN} more` });
  }
  flow.list(`${actions.length} capability(ies) were reachable and never used`, shown);
  flow.close(`Wrote one ask rule to ${WRITTEN_POLICY_FILE}.`);
  flow.hint('They are set to ask, not deny: the first real use will simply pause.');
}

/**
 * Stop being asked about something already approved enough times. The ledger decides
 * rather than the argument, through the same `handOverVerdict` that `memnox next` uses.
 */
export async function runAllow(
  context: CliContext,
  actions: readonly string[],
  exists: (path: string) => boolean = existsSync,
): Promise<void> {
  const { flow } = context;
  const events = await withEvents(homedir(), (store) =>
    store.query({ limit: LEDGER_SCAN_LIMIT }),
  );
  const found = delegations(events);
  const verdicts = actions.map((action) => handOverVerdict(action, found));

  const skipped = verdicts.filter((verdict) => !verdict.ready);
  if (skipped.length > 0) {
    flow.list(
      'Not handed over',
      skipped.map((verdict) => ({
        tone: TONE.DIM,
        text: verdict.action,
        detail: [verdict.because],
      })),
    );
  }

  const handing = verdicts
    .filter((verdict) => verdict.ready)
    .map((verdict) => verdict.delegation);
  if (handing.length === 0) {
    flow.close('Nothing was handed over.');
    flow.hint('Run "memnox next" to see what has been approved often enough.');
    return;
  }
  await writeAllowRules(context, resolvePolicyFile(undefined, exists), handing);
}

/** One allow rule per thing handed over, skipping any a rule of that name already covers. */
function newAllowRules(
  existing: readonly { name: string }[],
  handing: readonly Delegation[],
): {
  name: string;
  description: string;
  match: { actions: string[] };
  decision: { effect: typeof DECISION_EFFECT.ALLOW; reason: string };
}[] {
  const taken = new Set(existing.map((rule) => rule.name));
  return handing
    .filter((each) => !taken.has(allowRuleName(each.action)))
    .map((each) => ({
      name: allowRuleName(each.action),
      description: `Handed over after ${each.approvals} approvals and no refusal.`,
      match: { actions: [each.action] },
      decision: { effect: DECISION_EFFECT.ALLOW, reason: each.because },
    }));
}

/** Appended rather than written over, so handing a second thing over keeps the first. */
async function writeAllowRules(
  context: CliContext,
  path: string,
  handing: readonly Delegation[],
): Promise<void> {
  const { flow } = context;
  const document = await readPolicyDocumentFile(path);
  const existing = document?.policies ?? [];
  const added = newAllowRules(existing, handing);
  if (added.length === 0) {
    flow.close('Every one of those is already allowed here.');
    return;
  }
  await writePolicyDocumentFile(path, {
    ...(document ?? { version: 1 }),
    policies: [...existing, ...added],
  });
  await registerPolicyFile(homedir(), path);

  flow.list(
    `Written to ${path}`,
    added.map((rule) => ({ tone: TONE.OK, text: `allow  ${rule.match.actions[0]}` })),
  );
  flow.close(`Wrote ${added.length} allow rule(s).`);
  // Said out loud, because an allow rule is the one change that widens what may happen.
  flow.hint('These now run without asking. Delete the rule to be asked again.');
  await offerToTeam(
    context,
    handing.map((each) => each.action),
    DECISION_EFFECT.ALLOW,
    homedir(),
  );
}

/**
 * `protect --ask` and `--deny`: a rule a person decides here, written at once and, on an
 * enrolled machine, offered to the team as a proposal a second admin approves.
 */
export async function runDecide(
  context: CliContext,
  effect: typeof DECISION_EFFECT.ASK | typeof DECISION_EFFECT.DENY,
  actions: readonly string[],
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): Promise<void> {
  const wanted = [...new Set(actions.filter((action) => action.trim() !== ''))];
  if (wanted.length === 0) throw new Error(`--${effect} needs at least one action.`);
  const path = resolvePolicyFile(undefined, exists);
  await mergeRules(
    path,
    wanted.map((action) => decidedRule(effect, action)),
    home,
  );

  const { flow } = context;
  flow.list(
    `Written to ${path}`,
    wanted.map((action) => ({ tone: TONE.OK, text: `${effect}  ${action}` })),
  );
  flow.close(`Wrote ${wanted.length} ${effect} rule(s).`);
  await offerToTeam(context, wanted, effect, home);
}

function decidedRule(effect: DecisionEffect, action: string): Policy {
  return {
    name: `${effect}-${action.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
    description: 'Decided on this machine with memnox protect.',
    match: { actions: [action] },
    decision: {
      effect,
      reason:
        effect === DECISION_EFFECT.DENY
          ? 'somebody on this machine decided this is never run'
          : 'somebody on this machine decided a person looks at this first',
    },
  };
}

/** Recorded for the next sync only on an enrolled machine; said so, since it reaches others. */
async function offerToTeam(
  context: CliContext,
  actions: readonly string[],
  effect: DecisionEffect,
  home: string,
): Promise<void> {
  const decidedAt = new Date().toISOString();
  const offered = await recordLocalDecisions(
    home,
    actions.map((operation) => ({ operation, effect, decidedAt })),
  );
  if (offered === 0) return;
  context.flow.hint(
    'Offered to your team on the next sync. A second admin decides whether it becomes a team rule.',
  );
}

/** Stable across runs, so handing the same thing over twice adds one rule, not two. */
function allowRuleName(action: string): string {
  return `allow-${action.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}
