import { DECISION_EFFECT, GENERATED_ALTERNATIVE_NOTE, LocalGate } from '@memnox/core';
import { describe, expect, it } from 'vitest';
import { HookAuthorizer } from '../src/hook-authorizer';
import { ShellSeam } from '../src/shell-seam';

function seamWith(policies: unknown[], env: NodeJS.ProcessEnv = {}): ShellSeam {
  const gate = new LocalGate(policies as never, { agentName: 'agent' });
  return new ShellSeam({ authorizer: new HookAuthorizer({ gate }), env });
}

const PRODUCTION_WRITES = {
  name: 'production-read-only',
  match: {
    actions: ['railway.*', 'kubectl.*', 'vercel.*', 'stripe.*'],
    environments: ['prod*', 'production'],
    classes: ['write', 'destructive', 'communication'],
  },
  decision: {
    effect: DECISION_EFFECT.DENY,
    reason: 'this agent may read production and change nothing there',
  },
};

describe('a rule about an environment, at the shell', () => {
  it('refuses a change in the environment the command named', async () => {
    const outcome = await seamWith([PRODUCTION_WRITES]).gate([
      'railway redeploy --environment production',
    ]);
    expect(outcome.run).toBeUndefined();
    expect(outcome.decision.environment).toBe('production');
    expect(outcome.message).toContain('Environment: production.');
  });

  it('lets the same change through in another environment', async () => {
    const outcome = await seamWith([PRODUCTION_WRITES]).gate([
      'railway redeploy --environment staging',
    ]);
    expect(outcome.run).toBeDefined();
  });

  it('lets a read of production through', async () => {
    const outcome = await seamWith([PRODUCTION_WRITES]).gate([
      'railway logs --environment production',
    ]);
    expect(outcome.run).toBeDefined();
  });

  it('reads the environment from a flag before the verb and from a variable', async () => {
    expect(
      (
        await seamWith([PRODUCTION_WRITES]).gate([
          'kubectl --context prod-eu-1 delete pod x',
        ])
      ).decision.environment,
    ).toBe('prod-eu-1');
    const fromVariable = await seamWith([PRODUCTION_WRITES], {
      RAILWAY_ENVIRONMENT: 'production',
    }).gate(['railway up']);
    expect(fromVariable.run).toBeUndefined();
  });

  it('takes --prod and --live as production, which the CLI says outright', async () => {
    expect((await seamWith([PRODUCTION_WRITES]).gate(['vercel deploy --prod'])).run).toBe(
      undefined,
    );
    expect(
      (await seamWith([PRODUCTION_WRITES]).gate(['stripe refunds create --live'])).run,
    ).toBeUndefined();
    expect(
      (await seamWith([PRODUCTION_WRITES]).gate(['stripe refunds create'])).run,
    ).toBeDefined();
  });

  it('never matches an environment rule when the command named none', async () => {
    const outcome = await seamWith([PRODUCTION_WRITES]).gate(['railway redeploy']);
    expect(outcome.run).toBeDefined();
  });
});

describe('the way forward a refusal names', () => {
  const GENERATED = {
    name: 'cli-deny',
    match: { actions: ['railway.*'] },
    decision: {
      effect: DECISION_EFFECT.DENY,
      reason: 'you chose to deny this',
      alternative: { action: 'railway.*', note: GENERATED_ALTERNATIVE_NOTE },
    },
  };

  it('is the verb table’s when the rule only said to ask somebody', async () => {
    const outcome = await seamWith([GENERATED]).gate(['railway redeploy']);
    expect(outcome.message).toContain(
      'railway logs, and let the deploy pipeline redeploy',
    );
    expect(outcome.decision.alternative?.action).toBe('railway.redeploy');
  });

  it('is the rule’s own when the rule wrote one for this', async () => {
    const specific = {
      ...GENERATED,
      decision: {
        ...GENERATED.decision,
        alternative: { action: 'railway.logs', note: 'Read the logs and tell me.' },
      },
    };
    const outcome = await seamWith([specific]).gate(['railway redeploy']);
    expect(outcome.message).toContain('Read the logs and tell me.');
  });
});
