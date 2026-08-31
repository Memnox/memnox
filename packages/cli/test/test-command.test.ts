import { afterEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { EXIT_UNSAFE, registerTestCommand } from '../src/commands/test.command';
import { SAFETY_CASES } from '../src/safety-cases';
import { plainStyle } from '../src/style';
import { FakeRuntime } from './cli-harness';

const RISK_PATH = '/v1/evaluate-risk';
const CHECK_PATH = '/v1/actions/check';

interface StubOptions {
  effect?: string;
  policy?: string;
}

/** Answers per request, because the suite sends one per case down one route. */
const answering = (decide: (action: unknown) => StubOptions): FakeRuntime =>
  new FakeRuntime().handle('POST', RISK_PATH, (body) => {
    const stub = decide(body);
    return {
      body: {
        effect: stub.effect ?? DECISION_EFFECT.WITHHOLD,
        riskLevel: RISK_LEVEL.HIGH,
        reason: 'a rule your organization wrote covers this',
        matchedPolicies:
          stub.policy === undefined
            ? []
            : [{ name: stub.policy, effect: stub.effect ?? DECISION_EFFECT.WITHHOLD }],
        advisories: [],
        trustScore: 80,
      },
    };
  });

const request = (body: unknown): { action: string; target?: string } =>
  body as { action: string; target?: string };

/** Stops everything except the control case, which the suite expects to pass. */
const wellGoverned = (): FakeRuntime =>
  answering((body) =>
    request(body).action === 'file.write' && request(body).target === 'src/index.ts'
      ? { effect: DECISION_EFFECT.ALLOW }
      : { effect: DECISION_EFFECT.WITHHOLD, policy: 'terminal-safety' },
  );

async function run(args: string[], runtime: FakeRuntime): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerTestCommand(
    program,
    new CliContext(out, runtime.transport, plainStyle, async () => ({}), {}),
    () => '/nowhere',
    () => 'safety-fixed',
  );
  await program.parseAsync(args, { from: 'user' });
  return out;
}

afterEach(() => {
  process.exitCode = 0;
});

describe('memnox test', () => {
  it('sends every safety case through the read-only evaluation route', async () => {
    const runtime = wellGoverned();

    await run(['test', '--token', 'mnx_test'], runtime);

    expect(runtime.requests).toHaveLength(SAFETY_CASES.length);
    expect(runtime.requests.every((sent) => sent.path === RISK_PATH)).toBe(true);
  });

  it('passes a case the gate stops and exits zero when nothing got through', async () => {
    const out = await run(['test', '--token', 'mnx_test'], wellGoverned());

    expect(out.text).toContain('PASS  WITHHELD  Wipe a directory tree with rm -rf');
    expect(out.text).toContain('Every dangerous capability tested was stopped.');
    expect(process.exitCode).toBe(0);
  });

  it('reports an unstopped dangerous action as a gap and exits non-zero', async () => {
    const runtime = answering((body) =>
      request(body).action === 'repository.force_push'
        ? { effect: DECISION_EFFECT.ALLOW }
        : { effect: DECISION_EFFECT.WITHHOLD, policy: 'terminal-safety' },
    );

    const out = await run(['test', '--token', 'mnx_test'], runtime);

    expect(out.text).toContain('GAP   ALLOWED   Force-push over shared git history');
    expect(out.text).toContain('your agent can do right now, unattended');
    expect(process.exitCode).toBe(EXIT_UNSAFE);
  });

  it('names an uncovered case rather than implying a rule decided it', async () => {
    const runtime = answering(() => ({ effect: DECISION_EFFECT.ALLOW }));

    const out = await run(['test', '--token', 'mnx_test'], runtime);

    expect(out.text).toContain('no rule your organization wrote covers this');
  });

  it('counts a held action as stopped, not as a gap', async () => {
    const runtime = answering((body) =>
      request(body).target === 'src/index.ts'
        ? { effect: DECISION_EFFECT.ALLOW }
        : { effect: DECISION_EFFECT.ESCALATE, policy: 'human-approval' },
    );

    const out = await run(['test', '--token', 'mnx_test'], runtime);

    expect(out.text).toContain('PASS  HELD');
    expect(process.exitCode).toBe(0);
  });

  it('records the run under one session when --record is given', async () => {
    const runtime = new FakeRuntime().handle('POST', CHECK_PATH, () => ({
      body: {
        eventId: 'evt_1',
        effect: DECISION_EFFECT.WITHHOLD,
        riskLevel: RISK_LEVEL.HIGH,
        reason: 'withheld',
        matchedPolicies: [],
        advisories: [],
      },
    }));

    const out = await run(['test', '--token', 'mnx_test', '--record'], runtime);

    expect(runtime.requests.every((sent) => sent.path === CHECK_PATH)).toBe(true);
    expect(runtime.requests[0]?.body).toMatchObject({ sessionId: 'safety-fixed' });
    expect(out.text).toContain('recorded as session safety-fixed');
    expect(out.notes.join('\n')).toContain('memnox replay safety-fixed');
  });

  it('says nothing was recorded when the run only evaluated', async () => {
    const out = await run(['test', '--token', 'mnx_test'], wellGoverned());

    expect(out.text).toContain('nothing was recorded and no action was taken');
  });

  it('emits every verdict as JSON when asked', async () => {
    const out = await run(['test', '--token', 'mnx_test', '--json'], wellGoverned());

    const parsed = JSON.parse(out.text) as { results: unknown[] };
    expect(parsed.results).toHaveLength(SAFETY_CASES.length);
  });

  it('says how to get a token rather than sending an unauthenticated request', async () => {
    const runtime = wellGoverned();
    const out = new RecordedOutput();
    const program = new Command();
    registerTestCommand(
      program,
      new CliContext(out, runtime.transport, plainStyle, async () => ({}), {}),
    );

    await expect(program.parseAsync(['test'], { from: 'user' })).rejects.toThrow(
      /memnox setup/,
    );
    expect(runtime.requests).toHaveLength(0);
  });
});
