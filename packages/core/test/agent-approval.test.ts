import { describe, expect, it } from 'vitest';
import {
  AGENT_APPROVAL,
  applyConfigValue,
  approvalOf,
  DEFAULT_CONFIG,
  parseConfig,
  readConfigValue,
  renderConfig,
} from '../src/config/index';

describe('which agents somebody decided are allowed', () => {
  /* Three states, not two. A machine where nobody filled the list in must not have
     every agent flagged — that is noise, and noise is how a real one gets missed. */
  it('says undecided when nobody has decided, rather than flagging everything', () => {
    expect(approvalOf('claude-code', [])).toBe(AGENT_APPROVAL.UNDECIDED);
    expect(approvalOf('openclaw', [])).toBe(AGENT_APPROVAL.UNDECIDED);
  });

  it('flags an agent nobody approved, once somebody has decided', () => {
    const approved = ['claude-code', 'cursor'];
    expect(approvalOf('claude-code', approved)).toBe(AGENT_APPROVAL.APPROVED);
    expect(approvalOf('openclaw', approved)).toBe(AGENT_APPROVAL.UNREGISTERED);
  });

  it('starts empty, so nothing is approved by default either', () => {
    expect(DEFAULT_CONFIG.approvedAgents).toEqual([]);
  });
});

describe('the list in the config file', () => {
  it('round-trips through render and parse', () => {
    const config = { ...DEFAULT_CONFIG, approvedAgents: ['claude-code', 'cursor'] };
    expect(parseConfig(renderConfig(config)).approvedAgents).toEqual([
      'claude-code',
      'cursor',
    ]);
  });

  it('reads the shapes people write by hand', () => {
    expect(parseConfig('approvedAgents = "a, b"').approvedAgents).toEqual(['a', 'b']);
    expect(parseConfig('approvedAgents = a,b').approvedAgents).toEqual(['a', 'b']);
    expect(parseConfig('approvedAgents = ["a", "b"]').approvedAgents).toEqual(['a', 'b']);
    expect(parseConfig('approvedAgents = ""').approvedAgents).toEqual([]);
  });

  it('is settable from the command line', () => {
    const next = applyConfigValue(
      DEFAULT_CONFIG,
      'approvedAgents',
      'claude-code, cursor',
    );
    expect(next.approvedAgents).toEqual(['claude-code', 'cursor']);
    expect(readConfigValue(next, 'approvedAgents')).toBe('claude-code, cursor');
  });

  it('says in the file itself that empty means undecided', () => {
    expect(renderConfig(DEFAULT_CONFIG)).toContain('not that all are approved');
  });
});
