import { describe, expect, it } from 'vitest';
import {
  DECISION_EFFECT,
  LocalGate,
  policiesFrom,
  recommendedAnswers,
} from '@memnox/core';
import { LocalGateAuthorizer } from '../src/call-authorizer';

/* The baseline asked about every MCP call, reads included, so an agent could not list
   issues without a person. It asks about what changes something and nothing else. */
describe('the proxy under the baseline rules', () => {
  const gate = new LocalGate(policiesFrom(recommendedAnswers()), {
    agentName: 'claude-code',
  });
  const authorizer = new LocalGateAuthorizer(gate, 'github', 'ses_mcp');
  const effectOf = async (name: string): Promise<string> =>
    (await authorizer.authorize({ name, arguments: {} })).effect;

  it('lets a tool that lists or reads through', async () => {
    expect(await effectOf('list_issues')).toBe(DECISION_EFFECT.ALLOW);
    expect(await effectOf('get_pull_request')).toBe(DECISION_EFFECT.ALLOW);
  });

  it('asks about a tool that writes, deletes or sends', async () => {
    expect(await effectOf('create_issue')).toBe(DECISION_EFFECT.ASK);
    expect(await effectOf('delete_branch')).toBe(DECISION_EFFECT.ASK);
    expect(await effectOf('merge_pull_request')).toBe(DECISION_EFFECT.ASK);
  });

  it('asks about a tool its name does not explain', async () => {
    expect(await effectOf('frobnicate')).toBe(DECISION_EFFECT.ASK);
  });
});
