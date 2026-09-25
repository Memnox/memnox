import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DECISION_EFFECT,
  DOMAIN_CHOICES,
  policiesFrom,
  recommendedAnswers,
  writePolicyDocumentFile,
  type DecisionEffect,
  type PolicyDomain,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { registerPolicyFile } from '../policy-registry';
import { WRITTEN_POLICY_FILE } from './merge-rules';

/** The five-domain questionnaire behind `protect --interactive` and `--yes`. */

/** The question, asked wherever the caller says. Injected, so tests need no terminal. */
export type DomainAsker = (
  question: string,
  because: string,
  recommended: DecisionEffect,
) => Promise<DecisionEffect>;

const KEYS: Readonly<Record<string, DecisionEffect>> = {
  a: DECISION_EFFECT.ALLOW,
  k: DECISION_EFFECT.ASK,
  d: DECISION_EFFECT.DENY,
};

export async function promptOnTerminal(
  question: string,
  because: string,
  recommended: DecisionEffect,
): Promise<DecisionEffect> {
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `\n  ${question}\n  ${because}\n  [a]llow  as[k]  [d]eny  (enter = ${recommended})  > `,
    );
    const key = answer.trim().toLowerCase().charAt(0);
    // Enter takes the recommendation, because that is what most people mean by it.
    return key === '' ? recommended : (KEYS[key] ?? recommended);
  } finally {
    prompt.close();
  }
}

/**
 * Six questions, then a file they can read. The output is the point: a wizard whose
 * result you cannot open and edit is one you have to run again to change your mind.
 */
export async function runInteractive(
  context: CliContext,
  takeRecommended: boolean,
  ask: DomainAsker,
): Promise<void> {
  const { flow } = context;
  const answers = takeRecommended
    ? recommendedAnswers()
    : new Map<PolicyDomain, DecisionEffect>();

  if (!takeRecommended) {
    flow.step('What should the agents on this machine be allowed to do?');
    for (const choice of DOMAIN_CHOICES) {
      answers.set(
        choice.domain,
        await ask(choice.question, choice.because, choice.recommended),
      );
    }
  }

  const policies = policiesFrom(answers);
  // The answers are about this machine, so one file holds them wherever setup is run:
  // a copy per folder put the same rule in force once for every folder it was run from.
  const home = homedir();
  const path = join(home, WRITTEN_POLICY_FILE);
  await writePolicyDocumentFile(path, { version: 1, policies });
  await registerPolicyFile(home, path);

  flow.table(
    `Written to ${path}`,
    ['Domain', 'Effect'],
    [...answers].map(([domain, effect]) => [domain, effect]),
  );
  flow.close(`Wrote ${policies.length} rule(s) to ${path}.`);
  flow.hint('Open it: it is yours to edit. Test one with "memnox policy test".');
}
