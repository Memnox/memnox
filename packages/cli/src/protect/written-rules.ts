import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  DECISION_EFFECT,
  delegations,
  discover,
  findUnusedGrants,
  matchesPattern,
  handOverVerdict,
  NodeMachineReader,
  POLICY_FILE_EXTENSION,
  readPolicyDocumentFile,
  rollUpUsage,
  TOOL_CLASS,
  TOOL_EFFECT,
  verbAction,
  verbTableFor,
  verbTableNames,
  writePolicyDocumentFile,
  type Policy,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DAY_MS, windowDays } from '../duration';
import { withEvents } from '../event-store';
import { resolvePolicyFile } from '../policy-path';
import { registerPolicyFile } from '../policy-registry';

/**
 * One CLI, from its own verb table. Denying the credential *file* while allowing the
 * CLI is the distinction that makes this adoptable: the tool keeps working, and the
 * agent cannot read the key out from under it.
 */
export async function runForCli(context: CliContext, name: string): Promise<void> {
  const table = verbTableFor(name);
  if (table === null) {
    throw new Error(
      `No verb table for "${name}". Known: ${verbTableNames().join(', ')}.`,
    );
  }

  const rules: Policy[] = [];
  const destructive = table.verbs.filter((verb) => verb.class === TOOL_CLASS.DESTRUCTIVE);
  const external = table.verbs.filter((verb) => verb.class === TOOL_CLASS.WRITE);

  if (destructive.length > 0) {
    rules.push(ruleFor(name, 'deny', destructive, 'these do not come back'));
  }
  if (external.length > 0) {
    rules.push(ruleFor(name, 'ask', external, 'somebody else sees the result'));
  }

  const paths = table.credential.filter((source) => source.startsWith('~'));
  if (paths.length > 0) {
    rules.push({
      name: `${name}-credential-deny`,
      description: `${name} keeps working; the agent just cannot read the key.`,
      match: {
        actions: ['filesystem.read'],
        targets: paths.flatMap((path) => [
          path.replace('~', '**'),
          `${path.replace('~', '**')}/**`,
        ]),
      },
      decision: {
        effect: DECISION_EFFECT.DENY,
        reason: `reading ${name}'s credential is not needed to use ${name}`,
        alternative: { action: name, note: `run ${name} instead of reading its key` },
      },
    } as unknown as Policy);
  }

  const path = `memnox.policies${POLICY_FILE_EXTENSION}`;
  await writePolicyDocumentFile(path, { version: 1, policies: rules });
  await registerPolicyFile(homedir(), path);

  const { out, style } = context;
  out.line('');
  for (const rule of rules) out.line(`  ${rule.decision.effect.padEnd(6)}${rule.name}`);
  out.line('');
  out.line(`Wrote ${rules.length} rule(s) for ${name} to ${path}.`);
  out.note(
    `${style.bold(name)} keeps working — only reading its credential file is denied.`,
  );
}

function ruleFor(
  cli: string,
  effect: string,
  verbs: readonly { match: string; alternative?: string }[],
  because: string,
): Policy {
  const first = verbs[0];
  return {
    name: `${cli}-${effect}`,
    match: {
      actions: verbs.map((verb) => verbAction(cli, verb as never)),
    },
    decision: {
      effect,
      reason: `${cli}: ${because}`,
      alternative: {
        action: cli,
        note: first?.alternative ?? 'ask somebody, or change this rule',
      },
    },
  } as unknown as Policy;
}

/**
 * Least privilege from what actually happened, not from a questionnaire. Everything
 * reachable that nothing touched in the window becomes an ask — never a deny, because
 * "unused for thirty days" is not the same as "never needed", and a rule that broke
 * somebody's quarterly job would be the last rule they let this write.
 */
export async function runFromUsage(
  context: CliContext,
  window: string,
  cwd: () => string,
): Promise<void> {
  const days = windowDays(window, '--from-usage');
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const { out, style } = context;

  await withEvents(homedir(), async (store) => {
    const events = await store.query({ since });
    if (events.length === 0) {
      out.line(`Nothing was recorded in the last ${days} days.`);
      out.note('Nothing can be called unused until something has been used.');
      return;
    }

    const report = await discover(new NodeMachineReader(homedir()), {
      now: new Date().toISOString(),
      projectDirs: [cwd()],
    });
    const usage = rollUpUsage(
      events.map((event) => ({
        agentId: event.agent,
        action: event.operation,
        resourceKind: event.surface,
        resourceId: event.target ?? event.operation,
        at: event.at,
        effect: event.effect,
      })),
    );
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
    if (unused.length === 0) {
      out.line(`Everything reachable was used in the last ${days} days.`);
      return;
    }

    const actions = [...new Set(unused.map((grant) => grant.action))];
    const rule = {
      name: `unused-${days}d`,
      description: `Reachable and untouched for ${days} days. Ask before the first use.`,
      match: { actions },
      decision: {
        effect: DECISION_EFFECT.ASK,
        reason: `nothing used this in ${days} days, so the first use is worth seeing`,
        alternative: {
          action: actions[0] as string,
          note: 'approve it once, or delete this rule if it is wrong',
        },
      },
    } as unknown as Policy;

    const path = `memnox.policies${POLICY_FILE_EXTENSION}`;
    await writePolicyDocumentFile(path, { version: 1, policies: [rule] });
    await registerPolicyFile(homedir(), path);

    out.line('');
    out.line(`${actions.length} capability(ies) were reachable and never used:`);
    for (const action of actions.slice(0, 12)) out.line(`  ${action}`);
    if (actions.length > 12)
      out.line(`  ${style.dim(`… and ${actions.length - 12} more`)}`);
    out.line('');
    out.line(`Wrote one ask rule to ${path}.`);
    // Ask, never deny: unused for a month is not the same as never needed.
    out.note('They are set to ask, not deny — the first real use will simply pause.');
  });
}

/**
 * Stop being asked about something you have already said yes to enough times.
 *
 * This is the command `memnox next` names under every row it recommends, and until now
 * it did not exist: the flagship screen ended on a line that exits with "unknown
 * option". A recommendation nobody can act on is a report, and this product is not one.
 *
 * The ledger decides, not the argument. What a person types is the action; whether it
 * may be handed over is `handOverVerdict`, the same three tests the screen applied when
 * it recommended the row, so the flag cannot be used to talk the tool into something
 * the screen would refuse to suggest.
 */
export async function runAllow(
  context: CliContext,
  actions: readonly string[],
  exists: (path: string) => boolean = existsSync,
): Promise<void> {
  const { out, style } = context;
  const events = await withEvents(homedir(), (store) => store.query({ limit: 20_000 }));
  const found = delegations(events);
  const verdicts = actions.map((action) => handOverVerdict(action, found));

  for (const verdict of verdicts) {
    if (verdict.ready) continue;
    out.line(`  ${style.dim('skipped')}  ${verdict.action}`);
    out.line(`           ${style.dim(verdict.because)}`);
  }

  const handing = verdicts.filter((verdict) => verdict.ready).map((v) => v.delegation);
  if (handing.length === 0) {
    out.line('');
    out.line('Nothing was handed over.');
    out.note('Run "memnox next" to see what has been approved often enough.');
    return;
  }

  /* Appended to what is already there rather than written over it. Handing one thing
     over a week is the normal shape of this, and a write that replaced the file would
     make the second one take back the first. */
  const path = resolvePolicyFile(undefined, exists);
  const document = await readPolicyDocumentFile(path);
  const existing = document?.policies ?? [];
  const taken = new Set(existing.map((rule) => rule.name));

  const added = handing
    .filter((each) => !taken.has(allowRuleName(each.action)))
    .map(
      (each) =>
        ({
          name: allowRuleName(each.action),
          description: `Handed over after ${each.approvals} approvals and no refusal.`,
          match: { actions: [each.action] },
          decision: { effect: DECISION_EFFECT.ALLOW, reason: each.because },
        }) as unknown as Policy,
    );

  if (added.length === 0) {
    out.line('');
    out.line('Every one of those is already allowed here.');
    return;
  }

  await writePolicyDocumentFile(path, {
    ...(document ?? { version: 1 }),
    policies: [...existing, ...added],
  });
  await registerPolicyFile(homedir(), path);

  out.line('');
  for (const rule of added) out.line(`  ${style.ok('allow')}  ${rule.match.actions[0]}`);
  out.line('');
  out.line(`Wrote ${added.length} allow rule(s) to ${path}.`);
  // Said out loud, because an allow rule is the one change that widens what may happen.
  out.note('These now run without asking. Delete the rule to be asked again.');
}

/** Stable across runs, so handing the same thing over twice adds one rule, not two. */
function allowRuleName(action: string): string {
  return `allow-${action.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}
