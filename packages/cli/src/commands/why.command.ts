import { homedir } from 'node:os';
import type { Command } from 'commander';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  codeownersFor,
  DECISION_EFFECT,
  describeEvidence,
  readProtection,
  readPullRequest,
  type MemnoxEvent,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { row } from '../cli-output';
import { withEvents } from '../event-store';

/**
 * Read back from the row, never recomputed. Re-evaluating today's rules against
 * yesterday's action would answer a different question from the one asked, and answer
 * it confidently.
 */
function render(context: CliContext, event: MemnoxEvent): void {
  const { out, style } = context;
  out.line('');
  out.line(
    `${style.effect(event.effect, event.effect.toUpperCase())}  ${event.operation}${
      event.target === undefined ? '' : ` ${event.target}`
    }`,
  );
  out.line('');
  row(context.out, 'when', event.at);
  /* The actor type only when it says something the name has not: an unnamed actor
     recorded as "an agent" rendered as "an agent (agent)". */
  const named = event.agent.toLowerCase().includes(event.actorType.toLowerCase());
  row(context.out, 'agent', named ? event.agent : `${event.agent} (${event.actorType})`);
  row(context.out, 'surface', event.surface);
  row(context.out, 'class', event.class);
  row(context.out, 'reason', event.reason);

  const rule = event.rule;
  if (rule === undefined) {
    row(context.out, 'rule', 'none matched — the default for this mode applied');
  } else {
    const at = rule.line === undefined ? rule.file : `${rule.file}:${rule.line}`;
    row(context.out, 'rule', `${rule.name}  (${rule.layer} layer)`);
    row(context.out, 'declared in', at);
  }

  if (event.policyHash !== undefined) {
    row(context.out, 'ruleset', `${event.policyHash} — the rules in force at the time`);
  }
  if (event.mode !== 'enforce' && event.shadowEffect !== undefined) {
    row(
      context.out,
      'would have',
      `${event.shadowEffect.toUpperCase()} in enforce; the mode was ${event.mode}`,
    );
  }
  if (event.authorizedBy !== undefined) {
    row(context.out, 'released by', event.authorizedBy);
  }

  const alternative = event.alternative;
  if (alternative !== undefined) {
    const instead =
      alternative.resource === undefined
        ? alternative.action
        : `${alternative.action} ${alternative.resource}`;
    out.line('');
    out.line(`  Instead:  ${instead}`);
    if (alternative.note !== '') out.line(`            ${style.dim(alternative.note)}`);
  }
  out.line('');
}

function renderEvidence(context: CliContext, event: MemnoxEvent): void {
  const { out } = context;
  out.line('  Evidence');
  row(context.out, '  event', event.id);
  if (event.argsDigest !== undefined) {
    // The digest, never the arguments: this is the line that keeps the ledger dull.
    row(
      context.out,
      '  arguments',
      `${event.argsDigest} (a hash; the payload never left)`,
    );
  }
  if (event.exitCode !== undefined)
    row(context.out, '  exit code', String(event.exitCode));
  if (event.durationMs !== undefined) row(context.out, '  took', `${event.durationMs}ms`);
  if (event.execution !== undefined) row(context.out, '  execution', event.execution);
  out.line('');
}

export function registerWhyCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  program
    .command('why [id]')
    .description('Why the last thing that did not simply proceed was decided that way')
    .option('--allowed', 'explain the last allow instead')
    .option('--evidence', 'show the digests and the outcome behind it')
    .option('--json', 'machine-readable output')
    .action(
      async (
        id: string | undefined,
        options: { allowed?: boolean; evidence?: boolean; json?: boolean },
      ) => {
        await withEvents(home(), async (store) => {
          const effects =
            options.allowed === true
              ? [DECISION_EFFECT.ALLOW]
              : [DECISION_EFFECT.DENY, DECISION_EFFECT.ASK];
          const rows = await store.query(
            id === undefined ? { effects, limit: 1 } : { limit: 500 },
          );
          const event =
            id === undefined
              ? rows[rows.length - 1]
              : rows.find((each) => each.id === id);

          if (event === undefined) {
            context.out.line(
              id === undefined
                ? 'Nothing has been decided on this machine yet. Run an agent through "memnox mcp wrap" first.'
                : `No event with id "${id}".`,
            );
            return;
          }

          if (options.json === true) {
            context.out.json(event);
            return;
          }
          render(context, event);
          if (options.evidence === true) {
            renderEvidence(context, event);
            await renderRepoEvidence(context, event);
          }
        });
      },
    );
}

const run = promisify(execFile);

/**
 * What the repository already says, read through a CLI the reader is logged into. It
 * is a fact somebody else set, so it stands beside the rule rather than behind it —
 * and it is read-only: `gh api` with no `-X`, and a file off the disk.
 */
async function renderRepoEvidence(
  context: CliContext,
  event: MemnoxEvent,
): Promise<void> {
  if (!event.operation.startsWith('git') && !event.operation.startsWith('gh')) return;

  const lines: string[] = [];
  const at = new Date().toISOString();

  try {
    const { stdout } = await run(
      'gh',
      ['api', 'repos/{owner}/{repo}/branches/main/protection'],
      {
        timeout: 3000,
      },
    );
    const evidence = readProtection(stdout, 'gh api, just now', at);
    if (evidence !== null) lines.push(...describeEvidence(evidence));
  } catch {
    // Not logged in, no remote, or the branch is unprotected. Silence, not a guess.
  }

  try {
    /* The same read-only path as the protection call: `gh pr view` with no mutation,
       for the branch the reader is standing on. No PR is the ordinary case. */
    const { stdout } = await run(
      'gh',
      ['pr', 'view', '--json', 'number,reviewDecision,statusCheckRollup'],
      { timeout: 3000 },
    );
    const evidence = readPullRequest(stdout, 'gh pr view, just now', at);
    if (evidence !== null) lines.push(...describeEvidence(evidence));
  } catch {
    // No pull request for this branch, or not logged in. Silence, not a guess.
  }

  const target = event.target;
  if (target !== undefined) {
    try {
      const owners = codeownersFor(await readFile('.github/CODEOWNERS', 'utf8'), target);
      if (owners !== null) lines.push(`CODEOWNERS: ${owners}`);
    } catch {
      // No CODEOWNERS file, which is the ordinary case.
    }
  }

  if (lines.length === 0) return;
  context.out.line('  Evidence from this repository');
  for (const line of lines) context.out.line(`    ${line}`);
  context.out.line('');
}
