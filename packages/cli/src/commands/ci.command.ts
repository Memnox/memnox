import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import type { CliOutput } from '../cli-output';
import { isBlocking, scanDiff, type ShieldScanResult } from '@memnox/content-shield';
import { DIFF_BASE_HELP, gitDiff, type DiffSource } from '../git-diff';

const EXIT_BLOCKED = 1;

export function registerCiCommand(
  program: Command,
  context: CliContext,
  readDiff: DiffSource = gitDiff,
): void {
  program
    .command('ci')
    .description(
      'Scan the git diff for secrets and PII in CI — exits 1 on blocking findings',
    )
    .option('--base <ref>', DIFF_BASE_HELP)
    .option('--staged', 'scan staged changes instead of a ref diff')
    .option('--json', 'machine-readable output')
    .option('--no-fail', 'report findings but always exit 0')
    .action(
      (options: { base?: string; staged?: boolean; json?: boolean; fail: boolean }) => {
        const result = scanDiff(readDiff(options));
        if (options.json) {
          context.out.line(JSON.stringify(result, null, 2));
        } else {
          printResult(context.out, result);
        }
        if (options.fail && result.blocked) {
          process.exitCode = EXIT_BLOCKED;
        }
      },
    );
}

function printResult(out: CliOutput, result: ShieldScanResult): void {
  for (const finding of result.findings) {
    out.line(
      `${finding.file}:${finding.line} [${finding.severity}] ${finding.rule} — ${finding.message}`,
    );
    out.line(`  ${finding.excerpt}`);
    out.line(`  fix: ${finding.fix}`);
  }
  const blocking = result.findings.filter(isBlocking).length;
  const verdict = result.blocked ? `BLOCKED — ${blocking} blocking finding(s)` : 'CLEAN';
  out.line(
    `memnox ci: ${verdict} (${result.findings.length} finding(s) across ${result.scannedFiles} changed file(s), ruleset v${result.rulesetVersion})`,
  );
}
