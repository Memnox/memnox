import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { PolicyEngine } from '../src/policy/policy-engine';
import { conditionsForMachine, orgOverlaysFrom } from '../src/policy/overlay-store';
import { stateLabelsOf } from '../src/policy/overlay';
import type { Policy } from '../src/policy/policy';

const allowEverything: Policy = {
  name: 'allow-everything',
  match: { actions: ['*'] },
  decision: { effect: DECISION_EFFECT.ALLOW },
};

const NOW = '2026-09-24T10:00:00.000Z';

// The bundle's own shape: a workspace freeze scoped to one agent, as the cloud declares it.
function stateFrom(subject: string): string[] {
  const overlays = orgOverlaysFrom({
    syncedAt: Date.parse(NOW),
    conditions: [
      {
        id: 'fact-1:agent:claude-code',
        kind: 'freeze',
        subject,
        fromAt: Date.parse(NOW) - 60_000,
        untilAt: Date.parse(NOW) + 60 * 60_000,
      },
    ],
  });
  return stateLabelsOf(overlays, NOW);
}

describe('a freeze scoped to one agent', () => {
  const engine = new PolicyEngine([allowEverything]);

  it('refuses every action of that agent, whatever the rules allow', () => {
    const result = engine.evaluate(
      { action: 'git.push' },
      { agentName: 'claude-code', state: stateFrom('agent:claude-code') },
    );
    expect(result.effect).toBe(DECISION_EFFECT.DENY);
    expect(result.reason).toMatch(/frozen across the workspace/);
    expect(result.matchedPolicies).toEqual([]);
  });

  /* The console freezes an agent by its fleet id, and a seam runs as the agent's name,
     so a freeze pressed on the agent's page stopped nothing on its own laptop. */
  it('refuses the agent when the freeze names it by its fleet id', () => {
    const result = engine.evaluate(
      { action: 'git.push' },
      { agentName: 'claude-code', state: stateFrom('agent:agt_claude-code') },
    );
    expect(result.effect).toBe(DECISION_EFFECT.DENY);
  });

  it('leaves every other agent to the rules', () => {
    const result = engine.evaluate(
      { action: 'git.push' },
      { agentName: 'codex', state: stateFrom('agent:claude-code') },
    );
    expect(result.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('does not read a freeze on a service as a freeze on an agent of the same name', () => {
    const result = engine.evaluate(
      { action: 'git.push' },
      { agentName: 'claude-code', state: stateFrom('claude-code') },
    );
    expect(result.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('stops refusing once the freeze is out of force', () => {
    const later = new Date(Date.parse(NOW) + 2 * 60 * 60_000).toISOString();
    const overlays = orgOverlaysFrom({
      syncedAt: Date.parse(NOW),
      conditions: [
        {
          id: 'fact-1:agent:claude-code',
          kind: 'freeze',
          subject: 'agent:claude-code',
          fromAt: Date.parse(NOW) - 60_000,
          untilAt: Date.parse(NOW) + 60 * 60_000,
        },
      ],
    });
    const result = engine.evaluate(
      { action: 'git.push' },
      { agentName: 'claude-code', state: stateLabelsOf(overlays, later) },
    );
    expect(result.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

/* The console's Freeze button sits on one agent's page, so it names the laptop that
   agent runs on, and a teammate's Claude Code on another laptop carries on. */
describe('a freeze of one agent on one machine', () => {
  const condition = (subject: string) => ({
    id: `fact-1:${subject}`,
    kind: 'freeze',
    subject,
    fromAt: Date.parse(NOW) - 60_000,
  });

  it('applies on the machine it names, as a freeze of that agent', () => {
    const kept = conditionsForMachine(
      [condition('agent:agt_claude-code@m-laptop')],
      'm-laptop',
    );
    expect(kept.map((each) => each.subject)).toEqual(['agent:agt_claude-code']);
  });

  it('is nothing on any other machine', () => {
    expect(
      conditionsForMachine([condition('agent:agt_claude-code@m-laptop')], 'm-other'),
    ).toEqual([]);
  });

  it('leaves a freeze naming no machine to every machine, as before', () => {
    const everywhere = [condition('agent:claude-code'), condition('payments')];
    expect(conditionsForMachine(everywhere, 'm-other')).toEqual(everywhere);
  });
});
