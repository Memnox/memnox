import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import type { Policy } from '@memnox/policy-engine';
import { formatLatencyReport, measureDecisionLatency, percentile } from '../src/latency';

const POLICIES: Policy[] = [
  {
    name: 'block-prod-delete',
    match: { actions: ['database.delete'], environments: ['production'] },
    decision: { effect: DECISION_EFFECT.BLOCK },
  },
];

const REQUESTS = [
  { action: 'database.delete', environment: 'production' },
  { action: 'repository.read' },
];

describe('percentile', () => {
  it('uses nearest-rank on a sorted array', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
    expect(percentile(sorted, 0.99)).toBe(10);
  });

  it('handles a single sample and an empty one', () => {
    expect(percentile([7], 0.99)).toBe(7);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('measureDecisionLatency', () => {
  // A fake clock keeps the assertion about the maths, not the machine.
  const steppingClock = (stepNs: bigint): (() => bigint) => {
    let current = 0n;
    return () => {
      const value = current;
      current += stepNs;
      return value;
    };
  };

  it('reports percentiles from measured samples', () => {
    const report = measureDecisionLatency(POLICIES, REQUESTS, {
      iterations: 100,
      // Each measurement spans one step: 500_000ns = 0.5ms.
      now: steppingClock(500_000n),
    });

    expect(report.iterations).toBe(100);
    expect(report.policyCount).toBe(1);
    expect(report.p50Ms).toBeCloseTo(0.5, 5);
    expect(report.p99Ms).toBeCloseTo(0.5, 5);
  });

  it('refuses to measure with no requests', () => {
    expect(() => measureDecisionLatency(POLICIES, [], {})).toThrow(
      /at least one request/,
    );
  });

  it('produces a real decision path measurement', () => {
    const report = measureDecisionLatency(POLICIES, REQUESTS, { iterations: 5_000 });

    expect(report.p99Ms).toBeGreaterThan(0);
    // Not an SLA — a sanity bound that would catch an accidental I/O call.
    expect(report.p99Ms).toBeLessThan(5);
    expect(report.maxMs).toBeGreaterThanOrEqual(report.p99Ms);
  });

  it('formats a readable report', () => {
    const text = formatLatencyReport({
      iterations: 10,
      policyCount: 2,
      p50Ms: 0.001,
      p95Ms: 0.002,
      p99Ms: 0.003,
      maxMs: 0.01,
    });

    expect(text).toContain('p99        : 0.0030 ms');
    expect(text).toContain('policies   : 2');
  });
});
