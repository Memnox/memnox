import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BREAKER_SIGNAL,
  CircuitBreaker,
  DEFAULT_THRESHOLDS,
  breachIn,
  type ActionOutcome,
} from '../src/session/breaker';
import { SessionPauses, describePause } from '../src/session/pause';

const NOW = '2026-09-05T10:00:00.000Z';

const outcome = (over: Partial<ActionOutcome> = {}): ActionOutcome => ({
  sessionId: 'ses_1',
  fingerprint: 'npm.test:',
  action: 'npm.test',
  at: NOW,
  failed: false,
  ...over,
});

const failing = (over: Partial<ActionOutcome> = {}): ActionOutcome =>
  outcome({ failed: true, failureKind: '1', ...over });

const run = (breaker: CircuitBreaker, times: number, make: () => ActionOutcome) => {
  let last = null;
  for (let i = 0; i < times; i += 1) last = breaker.observe(make());
  return last;
};

describe('the same failure, over and over', () => {
  it('trips once the same command has failed the same way five times', () => {
    const breaker = new CircuitBreaker();
    expect(run(breaker, 4, failing)).toBeNull();
    const breach = breaker.observe(failing());
    expect(breach?.signal).toBe(BREAKER_SIGNAL.ERROR_LOOP);
    // The number is the evidence: "why did you stop my agent" is answered with a count.
    expect(breach?.reason).toContain('5 times');
  });

  it('does not trip on the same command failing differently each time', () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 4; i += 1) {
      expect(breaker.observe(failing({ failureKind: String(i) }))).toBeNull();
    }
  });

  it('does not trip on a command that keeps working', () => {
    expect(run(new CircuitBreaker(), 50, outcome)).toBeNull();
  });
});

describe('nothing is moving', () => {
  it('trips after a run of failures with nothing succeeding between them', () => {
    const breaker = new CircuitBreaker({ ...DEFAULT_THRESHOLDS, errorLoop: 99 });
    expect(
      run(breaker, 7, () => failing({ fingerprint: `cmd-${Math.random()}` })),
    ).toBeNull();
    const breach = breaker.observe(failing({ fingerprint: 'cmd-last' }));
    expect(breach?.signal).toBe(BREAKER_SIGNAL.NO_PROGRESS);
  });

  it('treats anything that worked as progress, and starts the run again', () => {
    const breaker = new CircuitBreaker({ ...DEFAULT_THRESHOLDS, errorLoop: 99 });
    run(breaker, 7, () => failing({ fingerprint: `a-${Math.random()}` }));
    breaker.observe(outcome());
    expect(
      run(breaker, 7, () => failing({ fingerprint: `b-${Math.random()}` })),
    ).toBeNull();
  });
});

describe('far more than anybody expected', () => {
  it('trips past a multiple of the estimate the task declared', () => {
    const breaker = new CircuitBreaker();
    breaker.expect('ses_1', 10);
    expect(run(breaker, 50, outcome)).toBeNull();
    const breach = breaker.observe(outcome());
    expect(breach?.signal).toBe(BREAKER_SIGNAL.ACTION_EXPLOSION);
    expect(breach?.reason).toContain('about 10 actions');
  });

  /* Without a declared estimate there is no such thing as too many actions, and
     inventing a number would pause every honest long session. */
  it('never trips when the task declared no estimate', () => {
    expect(run(new CircuitBreaker(), 500, outcome)).toBeNull();
  });
});

describe('working somewhere it was not asked to work', () => {
  it('trips after five actions outside the declared task', () => {
    const breaker = new CircuitBreaker();
    expect(run(breaker, 4, () => outcome({ outOfScope: true }))).toBeNull();
    expect(breaker.observe(outcome({ outOfScope: true }))?.signal).toBe(
      BREAKER_SIGNAL.SCOPE_DRIFT,
    );
  });

  it('never trips when nothing reported being out of scope', () => {
    expect(run(new CircuitBreaker(), 100, outcome)).toBeNull();
  });
});

describe('spend', () => {
  it('trips past a ceiling somebody set, counting only reported cost', () => {
    const breaker = new CircuitBreaker({ ...DEFAULT_THRESHOLDS, spendCeilingUsd: 10 });
    expect(run(breaker, 9, () => outcome({ costUsd: 1 }))).toBeNull();
    const breach = breaker.observe(outcome({ costUsd: 2 }));
    expect(breach?.signal).toBe(BREAKER_SIGNAL.SPEND);
    expect(breach?.reason).toContain('$11.00');
  });

  it('watches nothing when no ceiling was set, which is the default', () => {
    expect(run(new CircuitBreaker(), 100, () => outcome({ costUsd: 50 }))).toBeNull();
  });
});

describe('one rule, two callers', () => {
  it('reaches the same verdict from history as it does live', () => {
    const history = Array.from({ length: 5 }, () => failing());
    expect(breachIn(history)?.signal).toBe(BREAKER_SIGNAL.ERROR_LOOP);
    expect(breachIn(Array.from({ length: 4 }, () => failing()))).toBeNull();
  });

  it('counts an explosion from history when the estimate is handed in', () => {
    const history = Array.from({ length: 60 }, () => outcome());
    expect(breachIn(history, DEFAULT_THRESHOLDS, 10)?.signal).toBe(
      BREAKER_SIGNAL.ACTION_EXPLOSION,
    );
  });

  it('keeps sessions apart, so one loop never pauses another session', () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 4; i += 1) breaker.observe(failing());
    expect(breaker.observe(failing({ sessionId: 'ses_other' }))).toBeNull();
  });
});

describe('a pause is a held session, not a denial', () => {
  it('survives the process that noticed, because the seams are other processes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-pause-'));
    const pauses = new SessionPauses(home);
    await pauses.pause({
      sessionId: 'ses_1',
      signal: BREAKER_SIGNAL.ERROR_LOOP,
      reason: 'npm.test has failed the same way 5 times',
      reached: 5,
      ceiling: 5,
      pausedAt: NOW,
    });

    const held = await pauses.inForce('ses_1');
    expect(held?.reason).toContain('5 times');
    expect(describePause(held!)).toContain('memnox resume ses_1');
  });

  it('keeps the first reason when something else trips while somebody is reading', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-pause-first-'));
    const pauses = new SessionPauses(home);
    const base = {
      sessionId: 'ses_1',
      reached: 5,
      ceiling: 5,
      pausedAt: NOW,
    };
    await pauses.pause({ ...base, signal: BREAKER_SIGNAL.ERROR_LOOP, reason: 'first' });
    await pauses.pause({ ...base, signal: BREAKER_SIGNAL.SCOPE_DRIFT, reason: 'second' });
    expect((await pauses.inForce('ses_1'))?.reason).toBe('first');
  });

  it('can be lifted, and who lifted it stays in the record', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-pause-resume-'));
    const pauses = new SessionPauses(home);
    await pauses.pause({
      sessionId: 'ses_1',
      signal: BREAKER_SIGNAL.NO_PROGRESS,
      reason: 'nothing has succeeded',
      reached: 8,
      ceiling: 8,
      pausedAt: NOW,
    });

    expect(await pauses.resume('ses_1', 'tresor', NOW)).not.toBeNull();
    expect(await pauses.inForce('ses_1')).toBeNull();
    expect((await pauses.read('ses_1'))?.resumedBy).toBe('tresor');
    // Lifting one that is not held is an answer, not a failure.
    expect(await pauses.resume('ses_1', 'tresor', NOW)).toBeNull();
  });
});
