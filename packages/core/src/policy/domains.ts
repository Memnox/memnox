import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import type { Policy } from './policy';

/**
 * The five things somebody is deciding about when they write rules for the first time.
 * Walking these is faster than writing a file, and the file it produces is one they
 * can read afterwards — which a wizard that hid its output would not be.
 */
export const POLICY_DOMAIN = {
  FILESYSTEM: 'filesystem',
  SHELL: 'shell',
  GIT: 'git',
  MCP: 'mcp',
  NETWORK: 'network',
} as const;

export type PolicyDomain = (typeof POLICY_DOMAIN)[keyof typeof POLICY_DOMAIN];

export interface DomainChoice {
  domain: PolicyDomain;
  /** The question, in the words somebody would use about their own machine. */
  question: string;
  /** What most people should pick, and why it is not stricter. */
  recommended: DecisionEffect;
  because: string;
  actions: string[];
  targets?: string[];
}

export const DOMAIN_CHOICES: readonly DomainChoice[] = [
  {
    domain: POLICY_DOMAIN.FILESYSTEM,
    question: 'Reading your credentials — ~/.ssh, ~/.aws, .env files',
    recommended: DECISION_EFFECT.DENY,
    because:
      'almost no task needs the key itself, and a leaked one is somebody’s weekend',
    actions: ['filesystem.read'],
    /* Both the directory and what is inside it: a rule that only covered the contents
       answers "no rule matched" to somebody asking about `~/.aws`, which reads as
       permission. */
    targets: [
      '**/.ssh',
      '**/.ssh/**',
      '**/.aws',
      '**/.aws/**',
      '**/.gcloud',
      '**/.gcloud/**',
      '**/.kube',
      '**/.kube/**',
      '**/.env',
      '**/.env.*',
    ],
  },
  {
    domain: POLICY_DOMAIN.SHELL,
    question: 'Destructive shell commands — rm -rf, dd, truncate',
    recommended: DECISION_EFFECT.ASK,
    because: 'sometimes it really is the build directory, so a person should look',
    actions: ['filesystem.delete'],
  },
  {
    domain: POLICY_DOMAIN.GIT,
    question: 'Force-pushing, and hard resets',
    recommended: DECISION_EFFECT.DENY,
    because: 'it rewrites history somebody else may already have pulled',
    /* The names the verb table actually produces. This read `git.push` and so the
       baseline denied every ordinary push while permitting `git push --force` — the
       opposite of what the question above it asks, and invisible until something
       rendered the boundary action by action. `git.reset` and `git.clean` stay for
       the generic classifier's spelling of the same commands. */
    actions: [
      'git.push-force',
      'git.push-f',
      'git.reset-hard',
      'git.branch-d',
      'git.clean-fd',
      'git.reset',
      'git.clean',
    ],
  },
  {
    domain: POLICY_DOMAIN.MCP,
    question: 'MCP tools that change something outside this machine',
    recommended: DECISION_EFFECT.ASK,
    because: 'these are the calls whose consequences other people see',
    actions: ['mcp.*'],
  },
  {
    domain: POLICY_DOMAIN.NETWORK,
    question: 'Requests to hosts no rule names',
    recommended: DECISION_EFFECT.ASK,
    because:
      'denying every unknown host breaks ordinary work on the first package install',
    actions: ['http.request'],
  },
];

const REASONS: Readonly<Record<DecisionEffect, string>> = {
  [DECISION_EFFECT.ALLOW]: 'you chose to allow this',
  [DECISION_EFFECT.ASK]: 'you chose to be asked about this',
  [DECISION_EFFECT.DENY]: 'you chose to deny this',
};

/** One rule per domain the person did not leave on allow. */
export function policiesFrom(
  answers: ReadonlyMap<PolicyDomain, DecisionEffect>,
): Policy[] {
  const policies: Policy[] = [];
  for (const choice of DOMAIN_CHOICES) {
    const effect = answers.get(choice.domain);
    if (effect === undefined || effect === DECISION_EFFECT.ALLOW) continue;

    policies.push({
      name: `${choice.domain}-${effect}`,
      description: choice.question,
      match: {
        actions: choice.actions,
        ...(choice.targets === undefined ? {} : { targets: choice.targets }),
      },
      decision: {
        effect,
        reason: `${REASONS[effect]}: ${choice.because}`,
        alternative: {
          action: choice.actions[0] as string,
          note: 'Ask somebody, or change this rule if it is wrong for your work.',
        },
      },
    } as unknown as Policy);
  }
  return policies;
}

/** What a run with no questions asked would write. */
export function recommendedAnswers(): Map<PolicyDomain, DecisionEffect> {
  return new Map(DOMAIN_CHOICES.map((choice) => [choice.domain, choice.recommended]));
}
