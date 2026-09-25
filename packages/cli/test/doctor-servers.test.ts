import { describe, expect, it } from 'vitest';
import { serverHealthOf } from '../src/commands/doctor/servers';

describe('whether each configured server answers', () => {
  it('counts a server once, with every agent that declares it and what it listed', () => {
    const report = {
      agents: [
        { id: 'agt_a', kind: 'claude-code' },
        { id: 'agt_b', kind: 'cursor' },
      ],
      surfaces: [
        {
          agentId: 'agt_a',
          servers: [{ name: 'railway' }, { name: 'sentry' }],
          tools: [
            { name: 'list_deployments', server: 'railway' },
            { name: 'get_logs', server: 'railway' },
          ],
        },
        { agentId: 'agt_b', servers: [{ name: 'railway' }], tools: [] },
      ],
    } as never;
    expect(serverHealthOf(report)).toEqual([
      { name: 'railway', tools: 2, agents: ['claude-code', 'cursor'] },
      { name: 'sentry', tools: 0, agents: ['claude-code'] },
    ]);
  });
});
