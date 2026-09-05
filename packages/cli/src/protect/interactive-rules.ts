import { homedir } from 'node:os';
import {
  DECISION_EFFECT,
  DOMAIN_CHOICES,
  policiesFrom,
  POLICY_FILE_EXTENSION,
  recommendedAnswers,
  writePolicyDocumentFile,
  type DecisionEffect,
  type PolicyDomain,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { registerPolicyFile } from '../policy-registry';

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

export const promptOnTerminal: DomainAsker = async (question, because, recommended) => {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\n  ${question}\n  ${because}\n  [a]llow  as[k]  [d]eny  (enter = ${recommended})  > `,
    );
    const key = answer.trim().toLowerCase().charAt(0);
    // Enter takes the recommendation, because that is what most people mean by it.
    return key === '' ? recommended : (KEYS[key] ?? recommended);
  } finally {
    rl.close();
  }
};

/**
 * Five questions, then a file they can read. The output is the point: a wizard whose
 * result you cannot open and edit is one you have to run again to change your mind.
 */
export async function runInteractive(
  context: CliContext,
  takeRecommended: boolean,
  ask: DomainAsker,
): Promise<void> {
  const { out, style } = context;
  const answers = takeRecommended
    ? recommendedAnswers()
    : new Map<PolicyDomain, DecisionEffect>();

  if (!takeRecommended) {
    out.line(style.bold('What should the agents on this machine be allowed to do?'));
    for (const choice of DOMAIN_CHOICES) {
      answers.set(
        choice.domain,
        await ask(choice.question, choice.because, choice.recommended),
      );
    }
  }

  const policies = policiesFrom(answers);
  const path = `memnox.policies${POLICY_FILE_EXTENSION}`;
  await writePolicyDocumentFile(path, { version: 1, policies });
  await registerPolicyFile(homedir(), path);

  out.line('');
  for (const [domain, effect] of answers) {
    out.line(`  ${domain.padEnd(12)}${effect}`);
  }
  out.line('');
  out.line(`Wrote ${policies.length} rule(s) to ${path}.`);
  out.note('Open it — it is yours to edit. Test one with "memnox policy test".');
}
