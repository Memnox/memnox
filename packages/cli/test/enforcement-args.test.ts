import { describe, expect, it } from 'vitest';
import { ENFORCEMENT_MODE } from '@memnox/core';
import { parseEnforcement } from '../src/enforcement-args';

describe('parseEnforcement', () => {
  it('reads a bare mode as the default', () => {
    expect(parseEnforcement('observe')).toEqual({ default: ENFORCEMENT_MODE.OBSERVE });
  });

  it('reads per-environment pairs', () => {
    expect(parseEnforcement('default=observe,production=enforce')).toEqual({
      default: ENFORCEMENT_MODE.OBSERVE,
      environments: { production: ENFORCEMENT_MODE.ENFORCE },
    });
  });

  it('reads environments without a default', () => {
    expect(parseEnforcement('staging=off')).toEqual({
      environments: { staging: ENFORCEMENT_MODE.OFF },
    });
  });

  it('tolerates surrounding and inner whitespace', () => {
    expect(parseEnforcement('  default = observe , prod = enforce ')).toEqual({
      default: ENFORCEMENT_MODE.OBSERVE,
      environments: { prod: ENFORCEMENT_MODE.ENFORCE },
    });
  });

  it('ignores empty entries from a trailing comma', () => {
    expect(parseEnforcement('prod=enforce,')).toEqual({
      environments: { prod: ENFORCEMENT_MODE.ENFORCE },
    });
  });

  it('rejects an unknown mode', () => {
    expect(() => parseEnforcement('prod=block')).toThrow(/must be one of/);
  });

  it('rejects a pair with no mode', () => {
    expect(() => parseEnforcement('prod')).toThrow(/<environment>=<mode>/);
  });

  it('rejects a missing environment name', () => {
    expect(() => parseEnforcement('=enforce')).toThrow(/missing an environment/);
  });

  it('rejects an empty value', () => {
    expect(() => parseEnforcement('   ')).toThrow(/needs a value/);
  });

  // Silently keeping one of two would enforce something the operator did not mean.
  it('rejects a repeated environment rather than picking one', () => {
    expect(() => parseEnforcement('prod=enforce,prod=observe')).toThrow(/twice/);
  });
});
