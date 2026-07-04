import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { renderComplianceReportMarkdown, type ComplianceReport } from '@memnox/runtime';
import { DEFAULT_BASE_URL } from '../defaults';

const FORMAT_MARKDOWN = 'md';
const FORMAT_JSON = 'json';

export function registerReportCommand(program: Command, context: CliContext): void {
  program
    .command('report')
    .description('Generate an AI governance report from the audit trail')
    .option('--from <iso-date>', 'period start (ISO 8601)')
    .option('--to <iso-date>', 'period end (ISO 8601)')
    .option('--format <format>', `${FORMAT_MARKDOWN}|${FORMAT_JSON}`, FORMAT_MARKDOWN)
    .option('--url <url>', 'runtime base URL', DEFAULT_BASE_URL)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: {
        from?: string;
        to?: string;
        format: string;
        url: string;
        adminToken?: string;
      }) => {
        const client = context.client(options);
        const report: ComplianceReport = await client.complianceReport({
          from: options.from,
          to: options.to,
        });
        context.out.line(
          options.format === FORMAT_JSON
            ? JSON.stringify(report, null, 2)
            : renderComplianceReportMarkdown(report),
        );
      },
    );
}
