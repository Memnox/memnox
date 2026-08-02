import { describe, expect, it } from 'vitest';
import {
  CONTROL_MAPPINGS,
  CONTROL_STATUS,
  FRAMEWORK,
  controlsFor,
  readinessFor,
  type Framework,
} from '../src/domain/control-mapping';

const FRAMEWORKS: Framework[] = Object.values(FRAMEWORK);

/** Wording that would turn a self-assessment into a claim of certification. */
const FORBIDDEN_CLAIMS = [
  /\bcertified\b/i,
  /\bcompliant\b/i,
  /\bfully compliant\b/i,
  /\baudited\b/i,
  /\battested\b/i,
];

describe('control mapping is honest', () => {
  it('never claims certification anywhere in its text', () => {
    for (const control of CONTROL_MAPPINGS) {
      const text = `${control.requirement} ${control.gap ?? ''}`;
      for (const forbidden of FORBIDDEN_CLAIMS) {
        expect(text).not.toMatch(forbidden);
      }
    }
  });

  it('backs every implemented or partial control with evidence', () => {
    for (const control of CONTROL_MAPPINGS) {
      const claimed =
        control.status === CONTROL_STATUS.IMPLEMENTED ||
        control.status === CONTROL_STATUS.PARTIAL;
      if (!claimed) continue;
      expect(control.evidence.length).toBeGreaterThan(0);
    }
  });

  it('states the gap on everything not fully implemented', () => {
    for (const control of CONTROL_MAPPINGS) {
      if (control.status === CONTROL_STATUS.IMPLEMENTED) continue;
      expect(control.gap).toBeDefined();
      expect(control.gap).not.toBe('');
    }
  });

  it('never records a gap on something it calls implemented', () => {
    for (const control of CONTROL_MAPPINGS) {
      if (control.status !== CONTROL_STATUS.IMPLEMENTED) continue;
      expect(control.gap).toBeUndefined();
    }
  });

  it('names each control once per framework', () => {
    for (const framework of FRAMEWORKS) {
      const references = controlsFor(framework).map((control) => control.reference);
      expect(new Set(references).size).toBe(references.length);
    }
  });

  it('covers every framework it names', () => {
    for (const framework of FRAMEWORKS) {
      expect(controlsFor(framework).length).toBeGreaterThan(0);
    }
  });
});

describe('readiness summary', () => {
  it('accounts for every control exactly once', () => {
    for (const framework of FRAMEWORKS) {
      const summary = readinessFor(framework);
      const total =
        summary.implemented + summary.partial + summary.planned + summary.organizational;
      expect(total).toBe(controlsFor(framework).length);
    }
  });

  it('reports HIPAA as gated on an agreement no code can satisfy', () => {
    const baa = controlsFor(FRAMEWORK.HIPAA).find(
      (control) => control.reference === 'BAA',
    );

    expect(baa).toBeDefined();
    expect(baa === undefined ? '' : baa.status).toBe(CONTROL_STATUS.ORGANIZATIONAL);
  });

  it('does not report any framework as fully implemented', () => {
    // If this ever passes, the mapping is lying: certification is not a code state.
    for (const framework of FRAMEWORKS) {
      const summary = readinessFor(framework);
      expect(summary.partial + summary.planned + summary.organizational).toBeGreaterThan(
        0,
      );
    }
  });
});
