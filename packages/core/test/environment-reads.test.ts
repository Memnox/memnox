import { describe, expect, it } from 'vitest';
import { LocalGate } from '../src/gate/local-gate';
import { resolveShellLine } from '../src/intercept/resolve';
import { DOMAIN_CHOICES } from '../src/policy/domains';

function printed(line: string): readonly string[] | undefined {
  return resolveShellLine(line).actions.find((each) => each.action === 'environment.read')
    ?.targets;
}

describe('a command that prints a variable', () => {
  it.each([
    ['env', ['all']],
    ['printenv', ['all']],
    ['export -p', ['all']],
    ['printenv STRIPE_API_KEY', ['STRIPE_API_KEY']],
    ['echo $STRIPE_SECRET', ['STRIPE_SECRET']],
    ['echo "${DATABASE_URL}"', ['DATABASE_URL']],
  ])('%s prints %j', (line, names) => {
    expect(printed(line)).toEqual(names);
  });

  it.each([
    'env NODE_ENV=test node app.js',
    '/usr/bin/env node x.js',
    'echo $HOME',
    'ls',
    'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com',
  ])('%s prints no credential', (line) => {
    expect(printed(line)).toBeUndefined();
  });
});

describe('the generated credential rule', () => {
  const choice = DOMAIN_CHOICES[0];
  const gate = new LocalGate(
    [
      {
        name: 'filesystem-deny',
        match: { actions: choice?.actions ?? [], targets: choice?.targets ?? [] },
        decision: { effect: 'deny', reason: 'keys stay here' },
      },
    ] as never,
    { agentName: 'agent' },
  );

  it('refuses a key printed from the environment, as it refuses the file', () => {
    expect(
      gate.evaluate({ action: 'environment.read', target: 'STRIPE_API_KEY' }).effect,
    ).toBe('deny');
    expect(gate.evaluate({ action: 'environment.read', target: 'all' }).effect).toBe(
      'deny',
    );
  });

  it('leaves a template of names readable', () => {
    const template = ['/r/', '.', 'env', '.example'].join('');
    const real = ['/r/', '.', 'env', '.production'].join('');
    expect(gate.evaluate({ action: 'filesystem.read', target: template }).effect).toBe(
      'allow',
    );
    expect(gate.evaluate({ action: 'filesystem.read', target: real }).effect).toBe(
      'deny',
    );
  });
});
