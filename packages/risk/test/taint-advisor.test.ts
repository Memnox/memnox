import { describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  CLEAN_SESSION_TAINT,
  DECISION_EFFECT,
  EMPTY_AGENT_STATS,
  InMemorySessionTaintStore,
  UNAVAILABLE_SESSION_TAINT,
} from '@memnox/core';
import type {
  AgentIdentity,
  SessionTaintState,
  SessionTaintStore,
  TaintAssessment,
} from '@memnox/core';
import { TaintAdvisor } from '../src/taint-advisor';

const AGENT: AgentIdentity = {
  id: 'agent-1',
  name: 'claude-code',
  kind: AGENT_KIND.CLAUDE_CODE,
  status: AGENT_STATUS.ACTIVE,
  tokenHash: 'hash',
  createdAt: new Date().toISOString(),
  stats: { ...EMPTY_AGENT_STATS },
};

const EMAIL_TAINT: TaintAssessment = {
  tainted: true,
  sources: [{ sourceType: 'email_message', reason: 'third-party email in context' }],
};

/** Stands in for a Redis outage: reads answer "unknown", writes are dropped. */
class UnavailableTaintStore implements SessionTaintStore {
  async read(): Promise<SessionTaintState> {
    return UNAVAILABLE_SESSION_TAINT;
  }
  async merge(): Promise<void> {}
}

class ThrowingTaintStore implements SessionTaintStore {
  async read(): Promise<SessionTaintState> {
    return CLEAN_SESSION_TAINT;
  }
  async merge(): Promise<void> {
    throw new Error('write failed');
  }
}

describe('TaintAdvisor', () => {
  it('requires approval for privileged actions when the request reports taint', async () => {
    const advisor = new TaintAdvisor(new InMemorySessionTaintStore());
    const advisories = await advisor.advise(
      { action: 'file.write', target: 'payment/checkout.ts', taint: EMAIL_TAINT },
      { agent: AGENT },
    );
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(advisories[0]?.signals).toContain('taint:email_message');
    expect(advisories[0]?.nonOverridable).toBeUndefined();
  });

  it('taint sticks to the session: later actions are gated without re-reporting', async () => {
    const advisor = new TaintAdvisor(new InMemorySessionTaintStore());
    await advisor.advise(
      { action: 'repository.read', sessionId: 'sess-1', taint: EMAIL_TAINT },
      { agent: AGENT },
    );
    const later = await advisor.advise(
      { action: 'shell.execute', target: 'git push', sessionId: 'sess-1' },
      { agent: AGENT },
    );
    expect(later[0]?.escalateTo).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
  });

  it('leaves unprivileged actions and clean sessions alone', async () => {
    const advisor = new TaintAdvisor(new InMemorySessionTaintStore());
    expect(
      await advisor.advise(
        { action: 'repository.read', sessionId: 'sess-1', taint: EMAIL_TAINT },
        { agent: AGENT },
      ),
    ).toHaveLength(0);
    expect(
      await advisor.advise(
        { action: 'file.write', sessionId: 'sess-clean' },
        { agent: AGENT },
      ),
    ).toHaveLength(0);
  });

  it('blocks non-overridable actions instead of asking for an approval', async () => {
    const advisor = new TaintAdvisor(new InMemorySessionTaintStore());
    const advisories = await advisor.advise(
      { action: 'project.delete', target: 'acme', taint: EMAIL_TAINT },
      { agent: AGENT },
    );
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.BLOCK);
    expect(advisories[0]?.nonOverridable).toBe(true);
  });

  it('fails closed when session provenance cannot be read', async () => {
    const advisor = new TaintAdvisor(new UnavailableTaintStore());
    const advisories = await advisor.advise(
      { action: 'file.write', sessionId: 'sess-1' },
      { agent: AGENT },
    );
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(advisories[0]?.signals).toContain('taint:unreadable_state');
  });

  it('still escalates when persisting the session taint fails', async () => {
    const advisor = new TaintAdvisor(new ThrowingTaintStore());
    const advisories = await advisor.advise(
      { action: 'file.write', sessionId: 'sess-1', taint: EMAIL_TAINT },
      { agent: AGENT },
    );
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
  });
});
