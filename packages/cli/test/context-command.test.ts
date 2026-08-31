import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { FakeRuntime, runCli } from './cli-harness';

const CONTEXT_PATH = '/v1/context';

const response = () => ({
  briefing: {
    action: 'code.modify',
    target: 'payment/checkout.ts',
    riskLevel: RISK_LEVEL.MEDIUM,
    wouldBe: DECISION_EFFECT.ESCALATE,
    constraints: [
      {
        source: 'policy',
        name: 'payment-code-approval',
        effect: DECISION_EFFECT.ESCALATE,
        statement: 'Payment logic changes need security review.',
      },
    ],
  },
  text: 'Memnox constraints for "code.modify payment/checkout.ts"',
});

describe('memnox context', () => {
  it('prints the text, so it can be piped into a prompt', async () => {
    const runtime = new FakeRuntime().on('POST', CONTEXT_PATH, response());

    const { out } = await runCli(
      ['context', 'code.modify', 'payment/checkout.ts', '--token', 'mnx_t'],
      runtime,
    );

    expect(out.text).toContain('Memnox constraints for');
    expect(runtime.requests[0]?.body).toMatchObject({
      action: 'code.modify',
      target: 'payment/checkout.ts',
    });
  });

  it('emits the structured briefing with --json', async () => {
    const runtime = new FakeRuntime().on('POST', CONTEXT_PATH, response());

    const { out } = await runCli(
      ['context', 'code.modify', 'payment/checkout.ts', '--json', '--token', 'mnx_t'],
      runtime,
    );

    expect(JSON.parse(out.text)).toMatchObject({
      wouldBe: DECISION_EFFECT.ESCALATE,
    });
  });

  it('passes the environment through', async () => {
    const runtime = new FakeRuntime().on('POST', CONTEXT_PATH, response());

    await runCli(
      ['context', 'deploy.service', '--env', 'production', '--token', 'mnx_t'],
      runtime,
    );

    expect(runtime.requests[0]?.body).toMatchObject({ environment: 'production' });
  });

  it('says how to get a token instead of asking unauthenticated', async () => {
    const runtime = new FakeRuntime().on('POST', CONTEXT_PATH, response());

    await expect(runCli(['context', 'file.read'], runtime)).rejects.toThrow(
      /memnox setup/,
    );
    expect(runtime.requests).toHaveLength(0);
  });
});
