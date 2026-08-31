import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '../src/constants/decision.constants';
import { ENFORCEMENT_MODE } from '../src/constants/enforcement.constants';
import {
  applyEnforcementMode,
  isEnforcementMode,
  resolveEnforcementMode,
} from '../src/domain/enforcement';

describe('resolveEnforcementMode', () => {
  // Fail-closed: an upgrade must never silently stop enforcing.
  it('enforces an environment nobody configured', () => {
    expect(resolveEnforcementMode({}, 'production')).toBe(ENFORCEMENT_MODE.ENFORCE);
  });

  it('falls back to the configured default', () => {
    expect(resolveEnforcementMode({ default: ENFORCEMENT_MODE.ENFORCE }, 'staging')).toBe(
      ENFORCEMENT_MODE.ENFORCE,
    );
  });

  it('prefers the named environment over the default', () => {
    const modes = {
      default: ENFORCEMENT_MODE.OBSERVE,
      environments: { production: ENFORCEMENT_MODE.ENFORCE },
    };
    expect(resolveEnforcementMode(modes, 'production')).toBe(ENFORCEMENT_MODE.ENFORCE);
    expect(resolveEnforcementMode(modes, 'staging')).toBe(ENFORCEMENT_MODE.OBSERVE);
  });

  it('matches environment names case-insensitively', () => {
    const modes = {
      default: ENFORCEMENT_MODE.OBSERVE,
      environments: { production: ENFORCEMENT_MODE.ENFORCE },
    };
    expect(resolveEnforcementMode(modes, 'PROD')).toBe(ENFORCEMENT_MODE.OBSERVE);
    expect(resolveEnforcementMode(modes, 'Production')).toBe(ENFORCEMENT_MODE.ENFORCE);
  });

  it('uses the default when the request names no environment', () => {
    expect(
      resolveEnforcementMode(
        {
          default: ENFORCEMENT_MODE.OFF,
          environments: { prod: ENFORCEMENT_MODE.ENFORCE },
        },
        undefined,
      ),
    ).toBe(ENFORCEMENT_MODE.OFF);
  });
});

describe('applyEnforcementMode', () => {
  it('applies the verdict when enforcing', () => {
    expect(
      applyEnforcementMode(DECISION_EFFECT.WITHHOLD, ENFORCEMENT_MODE.ENFORCE),
    ).toEqual({
      effect: DECISION_EFFECT.WITHHOLD,
    });
  });

  // The whole point of monitor mode: the verdict is preserved, not applied.
  it('withholds a block in monitor mode and reports what it would have done', () => {
    expect(
      applyEnforcementMode(DECISION_EFFECT.WITHHOLD, ENFORCEMENT_MODE.OBSERVE),
    ).toEqual({
      effect: DECISION_EFFECT.ALLOW,
      shadowEffect: DECISION_EFFECT.WITHHOLD,
    });
  });

  it('withholds an approval requirement in monitor mode', () => {
    expect(
      applyEnforcementMode(DECISION_EFFECT.ESCALATE, ENFORCEMENT_MODE.OBSERVE),
    ).toEqual({
      effect: DECISION_EFFECT.ALLOW,
      shadowEffect: DECISION_EFFECT.ESCALATE,
    });
  });

  it('reports nothing withheld when the verdict was already allow', () => {
    expect(applyEnforcementMode(DECISION_EFFECT.ALLOW, ENFORCEMENT_MODE.OBSERVE)).toEqual(
      {
        effect: DECISION_EFFECT.ALLOW,
      },
    );
  });

  it('never escalates — no mode turns an allow into a block', () => {
    for (const mode of Object.values(ENFORCEMENT_MODE)) {
      expect(applyEnforcementMode(DECISION_EFFECT.ALLOW, mode).effect).toBe(
        DECISION_EFFECT.ALLOW,
      );
    }
  });
});

describe('isEnforcementMode', () => {
  it('accepts the three modes and rejects anything else', () => {
    expect(isEnforcementMode('enforce')).toBe(true);
    expect(isEnforcementMode('observe')).toBe(true);
    expect(isEnforcementMode('off')).toBe(true);
    expect(isEnforcementMode('withhold')).toBe(false);
    expect(isEnforcementMode(undefined)).toBe(false);
  });
});
