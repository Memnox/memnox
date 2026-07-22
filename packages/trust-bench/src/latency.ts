import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import type { ActionRequest } from '@memnox/core';

/** Discarded before measuring so JIT warm-up does not land in the numbers. */
const WARMUP_ITERATIONS = 2_000;
const DEFAULT_ITERATIONS = 50_000;
const NS_PER_MS = 1e6;

export interface LatencyReport {
  iterations: number;
  policyCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface LatencyOptions {
  iterations?: number;
  /** Injected so a benchmark run is reproducible rather than wall-clock bound. */
  now?: () => bigint;
}

/**
 * Measures the deterministic decision path only — policy evaluation, no I/O,
 * no advisors, no audit append. Those are separate costs and averaging them in
 * would report a number nobody can act on.
 */
export function measureDecisionLatency(
  policies: Policy[],
  requests: readonly ActionRequest[],
  options: LatencyOptions = {},
): LatencyReport {
  if (requests.length === 0) throw new Error('latency bench needs at least one request');
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const now = options.now ?? process.hrtime.bigint;
  const engine = new PolicyEngine(policies);
  const context = { agentName: 'bench', now: new Date(0) };

  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    engine.evaluate(requests[index % requests.length] as ActionRequest, context);
  }

  const samples = new Float64Array(iterations);
  for (let index = 0; index < iterations; index += 1) {
    const request = requests[index % requests.length] as ActionRequest;
    const started = now();
    engine.evaluate(request, context);
    samples[index] = Number(now() - started) / NS_PER_MS;
  }

  const sorted = Array.from(samples).sort((left, right) => left - right);
  return {
    iterations,
    policyCount: policies.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/** Nearest-rank on a sorted ascending array. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}

export function formatLatencyReport(report: LatencyReport): string {
  const round = (value: number): string => value.toFixed(4);
  return [
    `iterations : ${report.iterations}`,
    `policies   : ${report.policyCount}`,
    `p50        : ${round(report.p50Ms)} ms`,
    `p95        : ${round(report.p95Ms)} ms`,
    `p99        : ${round(report.p99Ms)} ms`,
    `max        : ${round(report.maxMs)} ms`,
  ].join('\n');
}
