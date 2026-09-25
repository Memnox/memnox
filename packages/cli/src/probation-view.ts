/**
 * Probation as people meet it: `memnox agents trust` and `memnox mcp trust` end one on the
 * record, and `memnox status` names what is still on it and until when.
 */
import {
  PROBATION_KIND,
  ProbationRegister,
  type ProbationEntry,
  type ProbationKind,
} from '@memnox/core';
import type { CliContext } from './cli-context';

interface TrustInput {
  context: CliContext;
  home: string;
  kind: ProbationKind;
  name: string;
  now: Date;
}

/** Ends one probation now. Says so plainly when there was nothing to end. */
const WHAT_IS_TRUSTED: Readonly<Record<ProbationKind, string>> = {
  [PROBATION_KIND.AGENT]: 'agent',
  [PROBATION_KIND.MCP_SERVER]: 'MCP server',
  [PROBATION_KIND.REPOSITORY]: 'repository',
};

const TRUST_COMMAND: Readonly<Record<ProbationKind, string>> = {
  [PROBATION_KIND.AGENT]: 'memnox agents trust',
  [PROBATION_KIND.MCP_SERVER]: 'memnox mcp trust',
  [PROBATION_KIND.REPOSITORY]: 'memnox repo trust',
};

export async function runTrust(input: TrustInput): Promise<void> {
  const { context, kind, name } = input;
  const what = WHAT_IS_TRUSTED[kind];
  context.flow.open(TRUST_COMMAND[kind]);
  const trusted = await new ProbationRegister(input.home).trust(kind, name, input.now);
  if (trusted === null) {
    context.flow.close(
      `No ${what} called ${name} was ever on probation, so there is nothing to end.`,
    );
    context.flow.hint('"memnox status" lists what is on probation.');
    return;
  }
  context.flow.rows('Trusted', [
    { label: what, value: trusted.label ?? trusted.name },
    { label: 'since', value: trusted.since.slice(0, 10) },
    { label: 'would have ended', value: trusted.until.slice(0, 10) },
  ]);
  context.flow.close(
    context.style.ok(
      `${trusted.label ?? trusted.name} is trusted: only your rules decide what it does now.`,
    ),
  );
}

/** One line per entry for the status screen: what it is and when it ends on its own. */
export function describeProbations(entries: readonly ProbationEntry[]): string {
  return entries
    .map((entry) => `${entry.label ?? entry.name} until ${entry.until.slice(0, 10)}`)
    .join(', ');
}
