import { DECISION_EFFECT, TOOL_EFFECT, type Policy } from '@memnox/core';
import { describe, expect, it } from 'vitest';
import { withVerdicts, type ExplainedServer } from '../src/commands/explain/server';

const SERVER: ExplainedServer = {
  name: 'railway',
  agents: ['claude-code'],
  detectedFrom: ['~/.claude.json'],
  env: [],
  probed: true,
  tools: [
    { name: 'list_deployments', server: 'railway', effect: TOOL_EFFECT.READ },
    { name: 'get_logs', server: 'railway', effect: TOOL_EFFECT.READ },
    { name: 'redeploy', server: 'railway', effect: TOOL_EFFECT.UNKNOWN },
    { name: 'delete_service', server: 'railway', effect: TOOL_EFFECT.DESTRUCTIVE },
  ] as never,
};

const CHANGES_REFUSED: Policy[] = [
  {
    name: 'mcp-changes',
    match: { actions: ['mcp.*'], classes: ['write', 'destructive', 'communication'] },
    decision: { effect: DECISION_EFFECT.DENY, reason: 'read only' },
  } as never,
];

describe('each MCP tool under the rules in force', () => {
  it('says what a call to each would meet', () => {
    const verdicts = withVerdicts(SERVER, CHANGES_REFUSED).verdicts ?? {};
    expect(verdicts['list_deployments']).toEqual({ effect: DECISION_EFFECT.ALLOW });
    expect(verdicts['get_logs']?.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(verdicts['redeploy']).toEqual({
      effect: DECISION_EFFECT.DENY,
      rule: 'mcp-changes',
    });
    expect(verdicts['delete_service']?.effect).toBe(DECISION_EFFECT.DENY);
  });

  it('matches a rule written with the server in the name, as a native rule is', () => {
    const verdicts =
      withVerdicts(SERVER, [
        {
          name: 'railway-logs',
          match: { actions: ['mcp.railway.get_logs'] },
          decision: { effect: DECISION_EFFECT.ASK, reason: 'logs hold customer data' },
        } as never,
      ]).verdicts ?? {};
    expect(verdicts['get_logs']).toEqual({
      effect: DECISION_EFFECT.ASK,
      rule: 'railway-logs',
    });
  });

  it('leaves "no rule" apart from allowed', () => {
    const verdicts = withVerdicts(SERVER, []).verdicts ?? {};
    expect(verdicts['redeploy']?.rule).toBeUndefined();
  });
});
