/**
 * Two ways of working, each a handful of ordinary rules that `why` explains like any other:
 * investigate reads and changes nothing outside; autonomous stops only at the irreversible.
 */
import { LOCAL_NAMESPACES } from '../constants/action-class.constants';
import { DECISION_EFFECT } from '../constants/decision.constants';
import {
  CHANGING_HTTP_METHODS,
  HTTP_METHOD_ARGUMENT,
} from '../constants/action.constants';
import { CAPABILITY } from '../domain/capability';
import { TOOL_CLASS } from '../discovery/classify';
import type { Policy } from './policy';

export const WORK_MODE = {
  INVESTIGATE: 'investigate',
  AUTONOMOUS: 'autonomous',
} as const;

export type WorkMode = (typeof WORK_MODE)[keyof typeof WORK_MODE];

/** The prefix every rule of a mode carries, which is how a file says which mode it is. */
export const MODE_RULE_PREFIX = 'mode-';

/** Everything that reaches outside this machine, spelled as every action but the local ones. */
const OUTSIDE: string[] = [
  '*',
  ...[...LOCAL_NAMESPACES, 'package'].map((each) => `!${each}.*`),
];

const CHANGES = [TOOL_CLASS.WRITE, TOOL_CLASS.DESTRUCTIVE, TOOL_CLASS.COMMUNICATION];

// Joined, since a slash and two stars written out read to the style check as a comment.
const OUTSIDE_WORKSPACE = ['!{workspace}', '**'].join('/');

/** Names a real environment would be called in production; a guess, and printed as one. */
const PRODUCTION_NAMES = ['prod*', 'production', 'live'];

function rule(mode: WorkMode, suffix: string, body: Omit<Policy, 'name'>): Policy {
  return { name: `${MODE_RULE_PREFIX}${mode}-${suffix}`, ...body };
}

const INVESTIGATE_REASON =
  'investigation mode: read anything, change nothing outside this machine';

const INVESTIGATE_ALTERNATIVE = {
  action: 'report',
  note: 'Say what you found and what you would change; a person makes the change.',
};

function refusedInInvestigation(
  suffix: string,
  description: string,
  match: Policy['match'],
): Policy {
  return rule(WORK_MODE.INVESTIGATE, suffix, {
    description,
    match,
    decision: {
      effect: DECISION_EFFECT.DENY,
      reason: INVESTIGATE_REASON,
      alternative: INVESTIGATE_ALTERNATIVE,
    },
  });
}

function investigate(): Policy[] {
  return [
    refusedInInvestigation('outside', 'Any change outside this machine', {
      actions: OUTSIDE,
      classes: CHANGES,
    }),
    refusedInInvestigation('web', 'A web request that changes something', {
      actions: ['http.request'],
      arguments: { [HTTP_METHOD_ARGUMENT]: [...CHANGING_HTTP_METHODS] },
    }),
    refusedInInvestigation('push', 'Pushing to a remote', { actions: ['git.push*'] }),
    refusedInInvestigation('elsewhere', 'A write outside the workspace', {
      actions: ['filesystem.write', 'filesystem.delete'],
      targets: [OUTSIDE_WORKSPACE],
    }),
    rule(WORK_MODE.INVESTIGATE, 'unclassified', {
      description: 'Something outside this machine nothing could classify',
      match: { actions: OUTSIDE, classes: [TOOL_CLASS.UNKNOWN] },
      decision: {
        effect: DECISION_EFFECT.ASK,
        reason:
          'investigation mode: this could change something, and nothing here could say',
      },
    }),
  ];
}

const AUTONOMOUS_ALTERNATIVE = {
  action: 'report',
  note: 'Finish what you can and leave this step for a person.',
};

function refusedWhenAutonomous(
  suffix: string,
  said: { description: string; reason: string },
  match: Policy['match'],
): Policy {
  return rule(WORK_MODE.AUTONOMOUS, suffix, {
    description: said.description,
    match,
    decision: {
      effect: DECISION_EFFECT.DENY,
      reason: `autonomous mode: ${said.reason}`,
      alternative: AUTONOMOUS_ALTERNATIVE,
    },
  });
}

function autonomous(): Policy[] {
  return [
    refusedWhenAutonomous(
      'consequential',
      {
        description: 'Moving money, deploying, or handing out authority',
        reason: 'money, deploys and authority stay with a person',
      },
      {
        actions: OUTSIDE,
        capabilities: [CAPABILITY.TRANSFER, CAPABILITY.DEPLOY, CAPABILITY.ADMIN],
      },
    ),
    refusedWhenAutonomous(
      'irreversible',
      {
        description: 'Deleting something outside this machine',
        reason: 'nothing outside this machine is deleted without a person',
      },
      { actions: OUTSIDE, classes: [TOOL_CLASS.DESTRUCTIVE] },
    ),
    refusedWhenAutonomous(
      'production',
      {
        description: 'Any change in an environment named like production',
        reason: 'production is read, never changed',
      },
      { actions: OUTSIDE, environments: PRODUCTION_NAMES, classes: CHANGES },
    ),
    refusedWhenAutonomous(
      'elsewhere',
      {
        description: 'Deleting a file outside the workspace',
        reason: 'the workspace is where the work is',
      },
      { actions: ['filesystem.delete'], targets: [OUTSIDE_WORKSPACE] },
    ),
  ];
}

/** The rules a mode is. */
export function modePolicies(mode: WorkMode): Policy[] {
  return mode === WORK_MODE.INVESTIGATE ? investigate() : autonomous();
}

/** Which mode a set of rules is, read off their names; null for none. */
export function modeOf(policies: readonly Policy[]): WorkMode | null {
  for (const mode of Object.values(WORK_MODE)) {
    if (policies.some((each) => each.name.startsWith(`${MODE_RULE_PREFIX}${mode}-`))) {
      return mode;
    }
  }
  return null;
}

export function isWorkMode(value: string): value is WorkMode {
  return (Object.values(WORK_MODE) as readonly string[]).includes(value);
}
