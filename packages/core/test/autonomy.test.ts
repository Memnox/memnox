import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  TOOL_CLASS,
  type MemnoxEvent,
} from '../src/index';
import {
  AUTONOMY,
  PROMOTION_THRESHOLD,
  delegations,
  describeLevel,
  interruptions,
  promotable,
  MINIMUM_EVIDENCE,
  standingOf,
} from '../src/session/autonomy';

const NOW = '2026-09-05T10:00:00.000Z';
const ago = (days: number): string =>
  new Date(Date.parse(NOW) - days * 24 * 60 * 60_000).toISOString();

const event = (over: Partial<MemnoxEvent> = {}): MemnoxEvent => ({
  id: `evt_${Math.random().toString(36).slice(2, 10)}`,
  schemaVersion: EVENT_SCHEMA_VERSION,
  at: NOW,
  sessionId: 'ses_1',
  agent: 'claude-code',
  actorType: ACTOR_TYPE.AGENT,
  surface: EVENT_SURFACE.SHELL,
  operation: 'vercel.deploy-preview',
  class: TOOL_CLASS.WRITE,
  effect: DECISION_EFFECT.ASK,
  mode: ENFORCEMENT_MODE.ENFORCE,
  reason: 'held',
  ...over,
});

const approved = (n: number, over: Partial<MemnoxEvent> = {}): MemnoxEvent[] =>
  Array.from({ length: n }, () => event({ authorizedBy: 'tresor', ...over }));

describe('what a person has already decided', () => {
  it('recommends handing over what they keep saying yes to', () => {
    const [found] = delegations(approved(PROMOTION_THRESHOLD));
    expect(found?.recommendation).toBe(AUTONOMY.AUTONOMOUS);
    expect(found?.approvals).toBe(PROMOTION_THRESHOLD);
  });

  it('keeps asking about something approved only a couple of times', () => {
    const [found] = delegations(approved(2));
    expect(found?.recommendation).toBe(AUTONOMY.ASSIST);
    expect(found?.because).toContain('fewer than');
  });

  /* One no is enough. A thing somebody refused is a thing they want to be asked
     about, and a pile of earlier yeses does not overrule that. */
  it('stops recommending the moment somebody has said no once', () => {
    const mixed = [...approved(20), event({ effect: DECISION_EFFECT.DENY })];
    const [found] = delegations(mixed);
    expect(found?.recommendation).toBe(AUTONOMY.ASSIST);
    expect(found?.because).toContain('refused');
    expect(promotable(delegations(mixed))).toEqual([]);
  });

  it('never lets a destructive action past supervised, however routine it became', () => {
    const [found] = delegations(approved(40, { class: TOOL_CLASS.DESTRUCTIVE }));
    expect(found?.recommendation).toBe(AUTONOMY.SUPERVISED);
    expect(found?.because).toContain('destructive');
  });

  it('holds outward communication at supervised too', () => {
    const [found] = delegations(approved(40, { class: TOOL_CLASS.COMMUNICATION }));
    expect(found?.recommendation).toBe(AUTONOMY.SUPERVISED);
  });

  it('lets a read reach trusted', () => {
    const [found] = delegations(approved(40, { class: TOOL_CLASS.READ }));
    expect(found?.recommendation).toBe(AUTONOMY.TRUSTED);
  });

  /* An allow is a rule already deciding, not a person. Counting it would recommend
     promoting things nobody was ever being asked about. */
  it('reads nothing into actions a rule already allowed', () => {
    expect(delegations(approved(20, { effect: DECISION_EFFECT.ALLOW }))).toEqual([]);
  });

  it('does not count a hold nobody ever answered', () => {
    const [found] = delegations(Array.from({ length: 10 }, () => event()));
    expect(found?.approvals).toBe(0);
    expect(found?.recommendation).toBe(AUTONOMY.ASSIST);
  });

  it('puts the most-approved first, so the screen leads with the best candidate', () => {
    const found = delegations([
      ...approved(6, { operation: 'a.thing' }),
      ...approved(12, { operation: 'b.thing' }),
    ]);
    expect(found.map((each) => each.action)).toEqual(['b.thing', 'a.thing']);
  });
});

describe('how often somebody is interrupted', () => {
  it('counts holds inside the window and ignores older ones', () => {
    const asked = interruptions(
      [...Array.from({ length: 3 }, () => event()), event({ at: ago(30) })],
      ago(7),
    );
    expect(asked.total).toBe(3);
    expect(asked.byAction[0]?.count).toBe(3);
  });

  it('counts nothing when nothing was held', () => {
    expect(
      interruptions(approved(5, { effect: DECISION_EFFECT.ALLOW }), ago(7)).total,
    ).toBe(0);
  });
});

describe('where this machine actually sits', () => {
  /* Read off facts rather than declared: an install that calls itself autonomous while
     asking about everything is telling somebody a story about themselves. */
  it('is observing when nothing is enforced', () => {
    expect(
      standingOf({ enforcing: false, rules: 40, asksInWindow: 0, actionsInWindow: 100 }),
    ).toBe(AUTONOMY.OBSERVE);
  });

  it('is observing when there are no rules, whatever the mode says', () => {
    expect(
      standingOf({ enforcing: true, rules: 0, asksInWindow: 0, actionsInWindow: 100 }),
    ).toBe(AUTONOMY.OBSERVE);
  });

  it('is assisting when it asks about most things', () => {
    expect(
      standingOf({ enforcing: true, rules: 10, asksInWindow: 40, actionsInWindow: 100 }),
    ).toBe(AUTONOMY.ASSIST);
  });

  it('is supervised when it asks occasionally', () => {
    expect(
      standingOf({ enforcing: true, rules: 10, asksInWindow: 5, actionsInWindow: 100 }),
    ).toBe(AUTONOMY.SUPERVISED);
  });

  it('is autonomous when it hardly ever asks', () => {
    expect(
      standingOf({ enforcing: true, rules: 10, asksInWindow: 1, actionsInWindow: 1000 }),
    ).toBe(AUTONOMY.AUTONOMOUS);
  });

  it('is trusted only once the boundary has caught nothing at all', () => {
    expect(
      standingOf({ enforcing: true, rules: 10, asksInWindow: 0, actionsInWindow: 1000 }),
    ).toBe(AUTONOMY.TRUSTED);
  });

  it('says what each rung means in words somebody would use', () => {
    expect(describeLevel(AUTONOMY.TRUSTED)).toContain('caught nothing');
  });
});

describe('what the ladder will not claim without evidence', () => {
  const clean = { enforcing: true, rules: 4, asksInWindow: 0, actionsInWindow: 3 };

  /* An afternoon of three commands and no interruptions is not a tested boundary.
     Reading as `trusted` there would be the reassurance that makes the rest suspect. */
  it('will not call a quiet afternoon trusted', () => {
    expect(standingOf(clean)).toBe(AUTONOMY.SUPERVISED);
  });

  it('reaches the top rungs once there is work behind them', () => {
    expect(standingOf({ ...clean, actionsInWindow: MINIMUM_EVIDENCE })).toBe(
      AUTONOMY.TRUSTED,
    );
    expect(
      standingOf({ ...clean, actionsInWindow: MINIMUM_EVIDENCE, asksInWindow: 1 }),
    ).toBe(AUTONOMY.AUTONOMOUS);
  });

  /* The floor only ever holds a level down. A noisy machine is still assist, however
     much work it has done, or the floor would become a promotion. */
  it('never lifts a level, only holds one back', () => {
    expect(
      standingOf({ enforcing: true, rules: 4, asksInWindow: 90, actionsInWindow: 100 }),
    ).toBe(AUTONOMY.ASSIST);
    expect(standingOf({ ...clean, enforcing: false })).toBe(AUTONOMY.OBSERVE);
  });
});
