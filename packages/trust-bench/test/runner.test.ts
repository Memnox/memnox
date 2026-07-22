import { describe, expect, it } from 'vitest';
import { runBench } from '../src/runner';

describe('trust-bench', () => {
  it('the reference runtime scores 100/100', async () => {
    const report = await runBench();
    const failed = report.results.filter((result) => !result.passed);
    expect(failed.map((result) => result.scenario.id)).toEqual([]);
    expect(report.score).toBe(100);
  });
});
