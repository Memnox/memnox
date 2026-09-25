import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import type { Policy } from './policy';
import { TOOL_CLASS } from '../discovery/classify';
import {
  ACTION,
  CHANGING_HTTP_METHODS,
  HTTP_METHOD_ARGUMENT,
} from '../constants/action.constants';

/**
 * The six things somebody decides about when writing rules for the first time, walked
 * as questions that produce a file they can read afterwards.
 */
export const POLICY_DOMAIN = {
  FILESYSTEM: 'filesystem',
  SHELL: 'shell',
  GIT: 'git',
  MCP: 'mcp',
  NETWORK: 'network',
  CLI: 'cli',
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
  /** Narrows the rule to some calls of an action, as a request's method does. */
  arguments?: Record<string, string[]>;
  /** Narrows the rule to what the action does, so reads under the same name go through. */
  classes?: string[];
}

/** What changes something, as every classifier spells it. Reads are left out on purpose. */
const CHANGING_CLASSES: readonly string[] = [
  TOOL_CLASS.WRITE,
  TOOL_CLASS.DESTRUCTIVE,
  TOOL_CLASS.COMMUNICATION,
];

/**
 * CLIs whose writes land on somebody else's system. `npm`, `docker` and `playwright` are
 * not here whole, because their writes are mostly an install, a build or a test run.
 */
const REMOTE_CLIS: readonly string[] = [
  'aws',
  'gcloud',
  'az',
  'gh',
  'kubectl',
  'terraform',
  'vercel',
  'railway',
  'fly',
  'heroku',
  'netlify',
  'stripe',
  'psql',
  'mysql',
  'mongosh',
];

/** The verbs of the mostly local CLIs that publish something outward. */
const OUTWARD_VERBS: readonly string[] = ['docker.push', 'npm.publish', 'npm.unpublish'];

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
      'git.clean-f',
      'git.reset',
      'git.clean',
    ],
  },
  {
    domain: POLICY_DOMAIN.MCP,
    question: 'MCP tools that change something outside this machine',
    recommended: DECISION_EFFECT.ASK,
    because:
      'these are the calls whose consequences other people see, while a tool that only lists or reads is how an agent finds its way',
    actions: ['mcp.*'],
    // Unknown too: a tool nothing could classify might change anything.
    classes: [...CHANGING_CLASSES, TOOL_CLASS.UNKNOWN],
  },
  {
    domain: POLICY_DOMAIN.NETWORK,
    question: 'Requests that change something on a host no rule names',
    recommended: DECISION_EFFECT.ASK,
    because:
      'a POST, PUT, PATCH or DELETE changes somebody else’s state, while reading documentation or fetching a resource is ordinary work',
    actions: [ACTION.HTTP_REQUEST],
    arguments: { [HTTP_METHOD_ARGUMENT]: [...CHANGING_HTTP_METHODS] },
  },
  {
    domain: POLICY_DOMAIN.CLI,
    question: 'CLIs changing your cloud, repositories, deployments and databases',
    recommended: DECISION_EFFECT.ASK,
    because:
      'a deploy, a merge or a delete lands on somebody else’s system, while listing and reading are how an agent finds its way',
    actions: [...REMOTE_CLIS.map((cli) => `${cli}.*`), ...OUTWARD_VERBS],
    // Not unknown: a verb no table knows is allowed and counted rather than blocked.
    classes: [...CHANGING_CLASSES],
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
        ...(choice.arguments === undefined ? {} : { arguments: choice.arguments }),
        ...(choice.classes === undefined ? {} : { classes: choice.classes }),
      },
      decision: {
        effect,
        reason: `${REASONS[effect]}: ${choice.because}`,
        alternative: {
          // Every choice above names at least one action.
          action: choice.actions[0] as string,
          note: GENERATED_ALTERNATIVE_NOTE,
        },
      },
    });
  }
  return policies;
}

/** Written on every generated rule, which names no way forward particular to one command. */
export const GENERATED_ALTERNATIVE_NOTE =
  'Ask somebody, or change this rule if it is wrong for your work.';

/** What a run with no questions asked would write. */
export function recommendedAnswers(): Map<PolicyDomain, DecisionEffect> {
  return new Map(DOMAIN_CHOICES.map((choice) => [choice.domain, choice.recommended]));
}
