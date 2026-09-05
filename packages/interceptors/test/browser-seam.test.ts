import { describe, expect, it, vi } from 'vitest';
import {
  BrowserHosts,
  DECISION_EFFECT,
  HOLD_ANSWER,
  HoldService,
  LocalGate,
  type HoldAnswer,
} from '@memnox/core';
import { BROWSER_ACTION, BrowserSeam } from '../src/browser-seam';

function gate(effect: string): LocalGate {
  return new LocalGate(
    [
      {
        name: 'browser',
        match: { actions: [BROWSER_ACTION] },
        decision: { effect: effect as never, reason: 'it acts as you on that site' },
      } as never,
    ],
    { agentName: 'claude-code' },
  );
}

const answering = (answer: HoldAnswer | null): HoldService =>
  new HoldService({ ask: async () => answer });

describe('driving a browser', () => {
  it('says nothing about your own dev server', async () => {
    const seam = new BrowserSeam({ gate: gate(DECISION_EFFECT.DENY) });
    const outcome = await seam.navigate('http://localhost:3000/admin');

    expect(outcome.allowed).toBe(true);
    expect(outcome.host).toBeNull();
  });

  it('rules on the host, not the page', async () => {
    const seam = new BrowserSeam({ gate: gate(DECISION_EFFECT.DENY) });
    const outcome = await seam.navigate('https://admin.acme.com/users/1');

    expect(outcome.allowed).toBe(false);
    expect(outcome.host).toBe('admin.acme.com');
    expect(outcome.message).toContain('acts as you');
  });

  it('asks once per host, then lets the rest of the session through', async () => {
    const ask = vi.fn(async () => HOLD_ANSWER.ONCE);
    const seam = new BrowserSeam({
      gate: gate(DECISION_EFFECT.ASK),
      hold: new HoldService({ ask }),
    });

    expect((await seam.navigate('https://acme.com/a')).allowed).toBe(true);
    const second = await seam.navigate('https://acme.com/b');

    expect(second.allowed).toBe(true);
    expect(second.remembered).toBe(true);
    // Asking on every page trains somebody to hold the key down.
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('still asks about a different host', async () => {
    const ask = vi.fn(async () => HOLD_ANSWER.ONCE);
    const seam = new BrowserSeam({
      gate: gate(DECISION_EFFECT.ASK),
      hold: new HoldService({ ask }),
    });

    await seam.navigate('https://a.example/x');
    await seam.navigate('https://b.example/x');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('denies when nobody can be asked, and says how to fix that', async () => {
    const seam = new BrowserSeam({ gate: gate(DECISION_EFFECT.ASK) });
    const outcome = await seam.navigate('https://acme.com');

    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain('memnox run');
  });

  it('remembers nothing when a person said no', async () => {
    const hosts = new BrowserHosts();
    const seam = new BrowserSeam({
      gate: gate(DECISION_EFFECT.ASK),
      hold: answering(HOLD_ANSWER.DENY),
      hosts,
    });

    expect((await seam.navigate('https://acme.com')).allowed).toBe(false);
    expect(hosts.seen('ses_local', 'acme.com')).toBe(false);
  });

  it('allows everything when no rules are configured', async () => {
    const seam = new BrowserSeam();
    expect((await seam.navigate('https://acme.com')).allowed).toBe(true);
  });
});
