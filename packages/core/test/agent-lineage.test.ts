import { describe, expect, it } from 'vitest';
import { LocalGate } from '../src/gate/local-gate';
import { lineageFor, parentAgentsOf } from '../src/session/agent-lineage';

describe('which agents started this one', () => {
  it('reads the parent off its marker, and never counts an agent as its own parent', () => {
    expect(parentAgentsOf({ CLAUDECODE: '1' }, 'codex-cli')).toEqual(['claude-code']);
    expect(parentAgentsOf({ CLAUDECODE: '1' }, 'claude-code')).toEqual([]);
    expect(parentAgentsOf({}, 'codex-cli')).toEqual([]);
  });

  it('keeps the whole chain a run wrote down, outermost first', () => {
    const env = { MEMNOX_PARENT_AGENTS: 'claude-code', CODEX_SANDBOX: '1' };
    expect(parentAgentsOf(env, 'hermes')).toEqual(['claude-code', 'codex-cli']);
    expect(lineageFor(env, 'hermes')).toBe('claude-code,codex-cli,hermes');
  });
});

describe('a child agent', () => {
  const RULES = [
    {
      name: 'claude-reads-only',
      match: { actions: ['mcp.*'], agents: ['claude-code'], classes: ['write'] },
      decision: { effect: 'deny', reason: 'claude-code only reads' },
    },
  ];

  it('never does what the agent that started it may not', () => {
    const child = new LocalGate(RULES as never, {
      agentName: 'codex-cli',
      parents: ['claude-code'],
    });
    const verdict = child.evaluate({
      action: 'mcp.github.create_issue',
      toolClass: 'write',
    });
    expect(verdict.effect).toBe('deny');
    expect(verdict.reason).toContain('claude-code, which started this agent, may not');
  });

  it('is its own agent where nobody started it', () => {
    const alone = new LocalGate(RULES as never, { agentName: 'codex-cli' });
    expect(
      alone.evaluate({ action: 'mcp.github.create_issue', toolClass: 'write' }).effect,
    ).toBe('allow');
  });
});
