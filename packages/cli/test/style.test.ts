import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { ansiStyle, plainStyle, resolveStyle } from '../src/style';

describe('plainStyle', () => {
  it('is the identity, so piped output stays byte-identical', () => {
    expect(plainStyle.bold('x')).toBe('x');
    expect(plainStyle.dim('x')).toBe('x');
    expect(plainStyle.ok('x')).toBe('x');
    expect(plainStyle.warn('x')).toBe('x');
    expect(plainStyle.effect(DECISION_EFFECT.WITHHOLD, 'BLOCK')).toBe('BLOCK');
    expect(plainStyle.risk(RISK_LEVEL.CRITICAL, 'critical')).toBe('critical');
    expect(plainStyle.symbol(DECISION_EFFECT.ALLOW)).toBe('');
  });
});

describe('ansiStyle', () => {
  it('wraps a verdict in colour and leaves the text intact', () => {
    const styled = ansiStyle.effect(DECISION_EFFECT.WITHHOLD, 'BLOCK');

    expect(styled).toContain('BLOCK');
    expect(styled.startsWith('\u001b[')).toBe(true);
    expect(styled.endsWith('\u001b[0m')).toBe(true);
  });

  it('colours a run state without borrowing a verdict colour', () => {
    const ok = ansiStyle.ok('Enforcing');
    const warn = ansiStyle.warn('Observing only');

    expect(ok).toContain('Enforcing');
    expect(warn).toContain('Observing only');
    expect(ok).not.toBe(warn.replace('Observing only', 'Enforcing'));
    for (const styled of [ok, warn]) {
      expect(styled.startsWith('\u001b[')).toBe(true);
      expect(styled.endsWith('\u001b[0m')).toBe(true);
    }
  });

  it('gives each effect its own marker', () => {
    expect(ansiStyle.symbol(DECISION_EFFECT.ALLOW)).toBe('✓');
    expect(ansiStyle.symbol(DECISION_EFFECT.WITHHOLD)).toBe('✗');
    expect(ansiStyle.symbol(DECISION_EFFECT.ESCALATE)).toBe('●');
  });

  it('passes through an effect or risk it does not know', () => {
    expect(ansiStyle.effect('invented', 'text')).toBe('text');
    expect(ansiStyle.risk('invented', 'text')).toBe('text');
    expect(ansiStyle.symbol('invented')).toBe('');
  });
});

describe('resolveStyle', () => {
  it('honours NO_COLOR over everything else', () => {
    expect(resolveStyle({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(plainStyle);
  });

  it('honours FORCE_COLOR when nothing is attached to the stream', () => {
    expect(resolveStyle({ FORCE_COLOR: '1' }, false)).toBe(ansiStyle);
    expect(resolveStyle({ FORCE_COLOR: '0' }, false)).toBe(plainStyle);
  });

  it('falls back to whether a terminal is attached', () => {
    expect(resolveStyle({}, true)).toBe(ansiStyle);
    expect(resolveStyle({}, false)).toBe(plainStyle);
  });
});
