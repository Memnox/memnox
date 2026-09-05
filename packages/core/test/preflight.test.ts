import { describe, expect, it } from 'vitest';
import { INTENT_KIND, preflightFor } from '../src/recovery/preflight';
import { LocalGate } from '../src/gate/local-gate';
import { DECISION_EFFECT } from '../src/constants/decision.constants';
import type { Policy } from '../src/policy/index';

describe('reading an intent before anything runs', () => {
  it('resolves a command line exactly, because it is exactly what would run', () => {
    const preflight = preflightFor('gh pr merge 12 && vercel deploy --prod');

    expect(preflight.kind).toBe(INTENT_KIND.COMMAND);
    expect(preflight.actions.map((action) => action.action)).toEqual([
      'gh.pr-merge',
      'vercel.deploy-prod',
    ]);
  });

  /* "deploy payments" is railway, vercel and kubectl until somebody says which.
     Answering about only the first would be a guess dressed as an answer. */
  it('resolves a phrase to every action it could mean', () => {
    const actions = preflightFor('deploy the payments service').actions.map(
      (action) => action.action,
    );

    expect(actions).toContain('vercel.deploy-prod');
    expect(actions).toContain('railway.up');
    expect(actions.length).toBeGreaterThan(3);
  });

  /* `gh release delete` holds a word from two verbs. Listing it under "deploy" would put
     a destructive action in front of somebody who asked about shipping. */
  it('never lists a delete under a deploy', () => {
    const actions = preflightFor('deploy payments').actions.map(
      (action) => action.action,
    );

    expect(actions).not.toContain('gh.release-delete');
    expect(preflightFor('delete the database').actions.map((a) => a.action)).toContain(
      'gh.release-delete',
    );
  });

  it('says what it read the phrase as, so a wrong reading is visible', () => {
    const preflight = preflightFor('merge the payments pull request');

    expect(preflight.verb).toBe('merge');
    expect(preflight.subject).toBe('payments');
  });

  // A word absent from the table is never guessed at.
  it('refuses a phrase with no verb in it, and says what it wanted', () => {
    expect(preflightFor('do the thing').unrecognized).toContain('deploy');
  });
});

describe('what the pre-flight is put through', () => {
  const frozen: Policy[] = [
    {
      name: 'no-deploys-while-frozen',
      match: { actions: ['vercel.deploy-prod'], state: ['freeze:payments'] },
      decision: { effect: DECISION_EFFECT.DENY, reason: 'payments is frozen' },
    },
  ];

  /* The whole point of an overlay: the same rule, the same action, decided differently
     because something is true right now that was not true this morning. */
  it('is the same gate, and it sees the freeze', () => {
    const request = { action: 'vercel.deploy-prod' };

    const during = new LocalGate(frozen, {
      agentName: 'agent',
      stateFacts: ['freeze:payments'],
    }).evaluate(request);
    const after = new LocalGate(frozen, { agentName: 'agent' }).evaluate(request);

    expect(during.effect).toBe(DECISION_EFFECT.DENY);
    expect(after.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});
