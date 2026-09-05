import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FREEZE_MINUTES,
  describeOverlay,
  freezeFor,
  inForce,
  OVERLAY_KIND,
  stateLabelsOf,
  stateVersionOf,
  validateOverlay,
  type Overlay,
} from '../src/policy/overlay';

const NOW = '2026-09-05T10:00:00.000Z';
const at = (minutes: number): string =>
  new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

const freeze = (over: Partial<Overlay> = {}): Overlay => ({
  ...freezeFor('payments', 'auth regression', 120, NOW, 'tresor'),
  ...over,
});

describe('an overlay must end', () => {
  it('refuses one with no expiry, because the next freeze gets ignored', () => {
    const problems = validateOverlay({ subject: 'payments', reason: 'incident' });
    expect(problems.join(' ')).toContain('when it ends');
  });

  it('refuses one that says nothing about why', () => {
    expect(validateOverlay({ subject: 'x', validUntil: at(60) }).join(' ')).toContain(
      'why',
    );
  });

  it('refuses one that names nothing', () => {
    expect(validateOverlay({ reason: 'x', validUntil: at(60) }).join(' ')).toContain(
      'what it is about',
    );
  });

  it('accepts one that says what, why and until when', () => {
    expect(validateOverlay(freeze())).toEqual([]);
  });

  it('defaults to two hours, which is a real incident and a survivable mistake', () => {
    expect(DEFAULT_FREEZE_MINUTES).toBe(120);
  });
});

describe('what is in force, at a moment', () => {
  it('is in force during its window and not before or after', () => {
    const overlays = [freeze()];
    expect(inForce(overlays, at(30))).toHaveLength(1);
    expect(inForce(overlays, at(-1))).toHaveLength(0);
    // The freeze lapses on its own; nobody has to remember to lift it.
    expect(inForce(overlays, at(121))).toHaveLength(0);
  });

  it('stops the moment somebody lifts it, and stays in the record', () => {
    const lifted = [freeze({ liftedAt: at(10) })];
    expect(inForce(lifted, at(5))).toHaveLength(1);
    expect(inForce(lifted, at(20))).toHaveLength(0);
    expect(lifted[0]?.liftedAt).toBe(at(10));
  });

  it('never reads a clock, so a replay a month later answers the same', () => {
    expect(inForce([freeze()], at(30))).toEqual(inForce([freeze()], at(30)));
  });
});

describe('the labels a rule matches on', () => {
  it('names the kind and the subject, so a rule needs no incident vocabulary', () => {
    expect(stateLabelsOf([freeze()], at(10))).toEqual(['freeze:payments']);
    expect(freeze().kind).toBe(OVERLAY_KIND.FREEZE);
  });

  it('is empty when nothing is in force, which is how a lapsed freeze stops biting', () => {
    expect(stateLabelsOf([freeze()], at(200))).toEqual([]);
    expect(stateVersionOf([freeze()], at(200))).toBe('none');
  });

  it('stamps a version, so a freeze that never propagated is visible afterwards', () => {
    expect(stateVersionOf([freeze()], at(10))).toBe('freeze:payments');
    const two = [freeze(), freeze({ subject: 'checkout', id: 'ovl_2' })];
    expect(stateVersionOf(two, at(10))).toBe('freeze:checkout,freeze:payments');
  });

  it('says how long is left, so a person can decide whether to extend it', () => {
    expect(describeOverlay(freeze(), at(0))).toContain('2h left');
    expect(describeOverlay(freeze(), at(90))).toContain('30 min left');
    expect(describeOverlay(freeze(), at(200))).toContain('expired');
  });
});
