import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import type { Policy } from './policy';
import { ACTION } from '../constants/action.constants';

/**
 * The five things somebody decides about when writing rules for the first time, walked
 * as questions that produce a file they can read afterwards.
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
    question: 'Reading your credentials: ~/.ssh, ~/.aws, .env files',
    recommended: DECISION_EFFECT.DENY,
    because:
      'almost no task needs the key itself, and a leaked one is somebody’s weekend',
    actions: [ACTION.FILESYSTEM_READ],
    // The directory too, or asking about `~/.aws` itself answers "no rule matched".
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
    question: 'Destructive shell commands: rm -rf, dd, truncate',
    recommended: DECISION_EFFECT.ASK,
    because: 'sometimes it really is the build directory, so a person should look',
    actions: [ACTION.FILESYSTEM_DELETE],
  },
  {
    domain: POLICY_DOMAIN.GIT,
    question: 'Force-pushing, and hard resets',
    recommended: DECISION_EFFECT.DENY,
    because: 'it rewrites history somebody else may already have pulled',
    // The names the verb table produces, so an ordinary push stays allowed; `git.reset`
    // and `git.clean` are the generic classifier's spelling of the same commands.
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
          // Every choice above names at least one action.
          action: choice.actions[0] as string,
          note: 'Ask somebody, or change this rule if it is wrong for your work.',
        },
      },
    });
  }
  return policies;
}

/** What a run with no questions asked would write. */
export function recommendedAnswers(): Map<PolicyDomain, DecisionEffect> {
  return new Map(DOMAIN_CHOICES.map((choice) => [choice.domain, choice.recommended]));
}
