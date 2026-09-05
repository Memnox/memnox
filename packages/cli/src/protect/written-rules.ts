import { homedir } from 'node:os';
import {
  DECISION_EFFECT,
  discover,
  findUnusedGrants,
  matchesPattern,
  NodeMachineReader,
  POLICY_FILE_EXTENSION,
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
