import { describe, expect, it } from 'vitest';
import { LocalGate } from '../src/gate/local-gate';
import { matchesAny, withWorkspace } from '../src/policy/pattern-matcher';

const EXAMPLE = '/r/.env.example';
const PRODUCTION = '/r/.env.production';

describe('a pattern that takes matches back out', () => {
  it('excludes what a ! pattern names', () => {
    expect(matchesAny(['*', '!api.stripe.com'], 'api.stripe.com')).toBe(false);
    expect(matchesAny(['*', '!api.stripe.com'], 'evil.example')).toBe(true);
    expect(matchesAny(['!api.stripe.com'], 'evil.example')).toBe(true);
    expect(matchesAny(['**/.env*', '!**/.env.example'], EXAMPLE)).toBe(false);
    expect(matchesAny(['**/.env*', '!**/.env.example'], PRODUCTION)).toBe(true);
  });

  it('still applies the rule when nothing was reported to exclude', () => {
    expect(matchesAny(['!api.stripe.com'], undefined)).toBe(true);
    expect(matchesAny(['api.*'], undefined)).toBe(false);
  });

  it('puts the working directory where {workspace} stands', () => {
    expect(withWorkspace(['!{workspace}/**'], '/home/dev/app/')).toEqual([
      '!/home/dev/app/**',
    ]);
    const unplaced = withWorkspace(['!{workspace}/**'], undefined) ?? [];
    expect(matchesAny(unplaced, '/home/dev/app/src/x.ts')).toBe(true);
  });
});

describe('the rules the exclusions make possible', () => {
  it('lets an agent write inside its workspace and refuses anywhere else', () => {
    const gate = new LocalGate(
      [
        {
          name: 'write-only-here',
          match: {
            actions: ['filesystem.write', 'filesystem.delete'],
            targets: ['!{workspace}/**'],
          },
          decision: {
            effect: 'deny',
            reason: 'this agent writes inside its workspace only',
          },
        },
      ] as never,
      { agentName: 'agent' },
    );
    const inside = gate.evaluate({
      action: 'filesystem.write',
      target: '/home/dev/app/src/x.ts',
      workingDirectory: '/home/dev/app',
    });
    const outside = gate.evaluate({
      action: 'filesystem.write',
      target: '/home/dev/.zshrc',
      workingDirectory: '/home/dev/app',
    });
    expect(inside.effect).toBe('allow');
    expect(outside.effect).toBe('deny');
  });

  it('asks about every host but the ones named', () => {
    const gate = new LocalGate(
      [
        {
          name: 'known-hosts',
          match: {
            actions: ['http.request'],
            targets: ['*', '!api.stripe.com', '!api.github.com'],
          },
          decision: { effect: 'ask', reason: 'a host nobody named' },
        },
      ] as never,
      { agentName: 'agent' },
    );
    expect(
      gate.evaluate({ action: 'http.request', target: 'api.stripe.com' }).effect,
    ).toBe('allow');
    expect(
      gate.evaluate({ action: 'http.request', target: 'paste.example' }).effect,
    ).toBe('ask');
  });
});
