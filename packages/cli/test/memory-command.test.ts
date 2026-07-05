import { describe, expect, it } from 'vitest';
import { DECISION_ENFORCEMENT, DECISION_STATUS } from '@memnox/memory';
import { FakeRuntime, runCli } from './cli-harness';

const DECISIONS_PATH = '/v1/memory/decisions';

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'dec_1',
  title: 'No direct production migrations',
  statement: 'Migrations run through the release pipeline.',
  owner: 'platform-team',
  actions: ['database.migrate'],
  enforcement: DECISION_ENFORCEMENT.REQUIRE_APPROVAL,
  decidedAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

describe('memnox memory add', () => {
  it('splits comma-separated patterns and trims the whitespace around them', async () => {
    const runtime = new FakeRuntime().on('POST', DECISIONS_PATH, record());

    await runCli(
      [
        'memory',
        'add',
        '--title',
        'No direct production migrations',
        '--statement',
        'Migrations run through the release pipeline.',
        '--owner',
        'platform-team',
        '--actions',
        'database.migrate, database.drop ,',
        '--envs',
        'production',
      ],
      runtime,
    );

    expect(runtime.requests[0]?.body).toMatchObject({
      actions: ['database.migrate', 'database.drop'],
      environments: ['production'],
    });
  });

  it('defaults enforcement to require_approval', async () => {
    const runtime = new FakeRuntime().on('POST', DECISIONS_PATH, record());

    const { out } = await runCli(
      [
        'memory',
        'add',
        '--title',
        'T',
        '--statement',
        'S',
        '--owner',
        'o',
        '--actions',
        'a',
      ],
      runtime,
    );

    expect(runtime.requests[0]?.body).toMatchObject({
      enforcement: DECISION_ENFORCEMENT.REQUIRE_APPROVAL,
    });
    expect(out.text).toContain('Decision recorded:');
  });
});

describe('memnox memory list', () => {
  it('shows status, enforcement, owner, and governed actions', async () => {
    const runtime = new FakeRuntime().on('GET', DECISIONS_PATH, [record()]);

    const { out } = await runCli(['memory', 'list'], runtime);

    expect(out.text).toContain(`dec_1  [${DECISION_STATUS.ACTIVE}]`);
    expect(out.text).toContain('(platform-team)');
    expect(out.text).toContain('actions: database.migrate');
  });

  it('marks a superseded decision with its replacement', async () => {
    const runtime = new FakeRuntime().on('GET', DECISIONS_PATH, [
      record({ status: DECISION_STATUS.SUPERSEDED, supersededById: 'dec_9' }),
    ]);

    const { out } = await runCli(['memory', 'list'], runtime);

    expect(out.text).toContain(`[${DECISION_STATUS.SUPERSEDED} → dec_9]`);
  });

  it('points a new user at the add command when the corpus is empty', async () => {
    const runtime = new FakeRuntime().on('GET', DECISIONS_PATH, []);

    const { out } = await runCli(['memory', 'list'], runtime);

    expect(out.text).toContain('memnox memory add');
  });
});

describe('memnox memory health', () => {
  it('summarises the corpus and flags each problem decision', async () => {
    const runtime = new FakeRuntime().on('GET', '/v1/memory/health', {
      score: 72,
      activeDecisions: 8,
      stale: 2,
      frequentlyViolated: 1,
      neverReferenced: 3,
      entries: [
        {
          id: 'dec_1',
          title: 'No direct production migrations',
          violations: 4,
          stale: true,
          neverReferenced: false,
          dueForReview: true,
        },
      ],
    });

    const { out } = await runCli(['memory', 'health'], runtime);

    expect(out.text).toContain('Health score      : 72/100');
    expect(out.text).toContain('Stale             : 2');
    expect(out.text).toContain('4 enforcement hit(s) [stale, review-due]');
  });
});

describe('memnox memory digest / retire / remove', () => {
  it('prints the digest verbatim so it can be piped into a prompt', async () => {
    const runtime = new FakeRuntime().on('GET', '/v1/memory/digest', {
      digest: 'Active constraints:\n- No direct production migrations',
    });

    const { out } = await runCli(['memory', 'digest'], runtime);

    expect(out.text).toBe('Active constraints:\n- No direct production migrations');
  });

  it('retires a decision without deleting it', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      `${DECISIONS_PATH}/dec_1/status`,
      record({ status: DECISION_STATUS.RETIRED }),
    );

    const { out } = await runCli(['memory', 'retire', 'dec_1'], runtime);

    expect(runtime.requests[0]?.body).toEqual({ status: DECISION_STATUS.RETIRED });
    expect(out.text).toContain(`is now ${DECISION_STATUS.RETIRED}`);
  });

  it('removes a decision by id', async () => {
    const runtime = new FakeRuntime().on('DELETE', `${DECISIONS_PATH}/dec_1`, {});

    const { out } = await runCli(['memory', 'remove', 'dec_1'], runtime);

    expect(runtime.requests[0]?.method).toBe('DELETE');
    expect(out.text).toBe('Decision dec_1 removed.');
  });
});
