import { describe, expect, it } from 'vitest';
import {
  classifyBinary,
  COMMAND_CLASS,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  HOLD_ANSWER,
  HoldService,
  LocalGate,
  type DecisionEffect,
  type EnforcementMode,
} from '@memnox/core';
import { ruleOnCommand } from '../src/interceptor';

/**
 * One matrix over every surface this package gates, every class a command can be, and
 * every mode the config allows. A gap here is a surface somebody can walk through, so
 * the table is exhaustive rather than illustrative.
 */

const COMMANDS: Readonly<Record<string, string[]>> = {
  [COMMAND_CLASS.DESTRUCTIVE]: ['rm', '-rf', 'build'],
  [COMMAND_CLASS.NETWORK]: ['curl', 'https://example.com'],
  [COMMAND_CLASS.PACKAGE_INSTALL]: ['npm', 'install', 'left-pad'],
  [COMMAND_CLASS.NORMAL]: ['git', 'status'],
};

function ruleFor(action: string, effect: DecisionEffect, mode: EnforcementMode) {
  return {
    name: `rule-${action}`,
    match: { actions: [action] },
    mode,
    decision: {
      effect,
      reason: `${action} is ${effect}`,
      alternative: { action, note: 'ask somebody first' },
    },
  } as never;
}

function gateFor(
  action: string,
  effect: DecisionEffect,
  mode: EnforcementMode,
): LocalGate {
  return new LocalGate([ruleFor(action, effect, mode)], { agentName: 'claude-code' });
}

const CLASSES = Object.keys(COMMANDS);
const EFFECTS: DecisionEffect[] = [
  DECISION_EFFECT.ALLOW,
  DECISION_EFFECT.ASK,
  DECISION_EFFECT.DENY,
];

describe('the conformance matrix', () => {
  it('covers every command class the classifier can produce', () => {
    for (const argv of Object.values(COMMANDS)) {
      const [binary, ...args] = argv;
      expect(classifyBinary(binary as string, args)).not.toBeNull();
    }
    expect(CLASSES.sort()).toEqual([...Object.values(COMMAND_CLASS)].sort());
  });

  for (const commandClass of CLASSES) {
    for (const effect of EFFECTS) {
      it(`${commandClass} × ${effect} in enforce`, async () => {
        const argv = COMMANDS[commandClass] as string[];
        const [binary, ...args] = argv;
        const action = classifyBinary(binary as string, args)?.action as string;

        const outcome = await ruleOnCommand(binary as string, args, {
          gate: gateFor(action, effect, ENFORCEMENT_MODE.ENFORCE),
          // A person is present and says yes, so ASK resolves to allowed.
          hold: new HoldService({ ask: async () => HOLD_ANSWER.ONCE }),
          log: () => {},
        });

        expect(outcome.allowed).toBe(effect !== DECISION_EFFECT.DENY);
        if (!outcome.allowed) expect(outcome.message).toContain('Instead');
      });
    }
  }

  it('denies an ASK on every class when nobody is at the keyboard', async () => {
    for (const commandClass of CLASSES) {
      const argv = COMMANDS[commandClass] as string[];
      const [binary, ...args] = argv;
      const action = classifyBinary(binary as string, args)?.action as string;

      const outcome = await ruleOnCommand(binary as string, args, {
        gate: gateFor(action, DECISION_EFFECT.ASK, ENFORCEMENT_MODE.ENFORCE),
        log: () => {},
      });
      expect(outcome.allowed).toBe(false);
    }
  });

  it('lets everything through when no rules are configured at all', async () => {
    for (const argv of Object.values(COMMANDS)) {
      const [binary, ...args] = argv;
      const outcome = await ruleOnCommand(binary as string, args, { log: () => {} });
      expect(outcome.allowed).toBe(true);
    }
  });

  it('gives every class a namespaced action a rule can be written about', () => {
    for (const argv of Object.values(COMMANDS)) {
      const [binary, ...args] = argv;
      expect(classifyBinary(binary as string, args)?.action).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});
