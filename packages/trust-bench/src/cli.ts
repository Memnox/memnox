import { POLICY_PACKS } from '@memnox/policy-engine';
import { formatLatencyReport, measureDecisionLatency } from './latency';
import { runBench } from './runner';

const report = await runBench();
console.log(
  `trust-bench: ${report.passed}/${report.total} scenarios — score ${report.score}/100\n`,
);
for (const result of report.results) {
  const mark = result.passed ? 'PASS' : 'FAIL';
  console.log(
    `  [${mark}] ${result.scenario.id} (${result.scenario.category}) — expected ≥ ${result.scenario.expectedAtLeast}, got ${result.actual}`,
  );
}
// Measured against every shipped pack at once — the worst realistic rule count.
const allPackPolicies = POLICY_PACKS.flatMap((pack) => pack.policies);
console.log('\nDecision latency (policy evaluation only):');
console.log(
  formatLatencyReport(
    measureDecisionLatency(allPackPolicies, [
      { action: 'shell.execute', target: 'rm -rf /', environment: 'production' },
      { action: 'repository.read' },
      { action: 'llm.infer', model: 'gpt-4', provider: 'openai' },
    ]),
  ),
);

process.exit(report.passed === report.total ? 0 : 1);
