/**
 * `memnox scan`: what can act on this machine and what it can reach. It runs with no
 * account and no network, which is why anybody runs it on a laptop holding production keys.
 */

import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  failOnValues,
  inventoryOf,
  renderShareCard,
  shareCardFor,
  EXIT,
  type DiscoveryReport,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { readLocalCounts, type LocalCounts } from '../local-counts';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';
import { renderMachine } from '../scan/machine-report';
import { renderServerReview } from '../scan/server-review';
import { renderTools } from '../scan/tool-listing';
import { renderUsage } from '../scan/usage-report';
import { renderDrift, wantsDrift } from '../scan/drift-report';
import { describeUnknownCommand } from '../unknown-command';

/** What `scan` reads the machine through, injected so a test never reads the real one. */
interface ScanDeps {
  buildSeams: (cwd: string) => ScanSeams;
  cwd: () => string;
  counts: () => Promise<LocalCounts>;
}

/** Every flag `scan` takes, so the router and the action cannot drift apart. */
interface ScanOptions {
  json?: boolean;
  tools?: boolean;
  probe: boolean;
  mcp?: string;
  save?: boolean;
  usage?: string;
  share?: boolean;
  since?: string;
  from?: string;
  to?: string;
  failOn?: string;
}

interface ScanInput {
  unrecognized: readonly string[];
  options: ScanOptions;
}

interface ReportInput {
  report: DiscoveryReport;
  takenAt: string;
  options: ScanOptions;
}

export function registerScanCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<ScanDeps> = {},
): void {
  const deps: ScanDeps = {
    buildSeams: defaultScanSeams,
    cwd: () => process.cwd(),
    counts: () => readLocalCounts(homedir()),
    ...overrides,
  };
  program
    .command('scan', { isDefault: true })
    .description(
      'What can act on this machine, and what it can reach. No account, no network.',
    )
    // Bare `memnox` runs this, so an unknown word lands here and is named as unknown.
    .usage('[options]')
    .argument('[unrecognized...]')
    .option('--json', 'emit the report as JSON')
    .option('--tools', 'list every tool by what it does, server by server')
    .option('--mcp <server>', 'review one MCP server before you trust it')
    .option('--usage <window>', 'what was granted against what was used, e.g. 7d')
    .option('--save', 'keep this scan, so a later comparison has a baseline')
    .option('--share', 'a card of counts only, safe to paste anywhere')
    .option('--since <when>', 'what changed since the last scan at or before this time')
    .option('--from <when>', 'the earlier side of a comparison, as an ISO time')
    .option('--to <when>', 'the later side of a comparison, as an ISO time')
    .option(
      '--fail-on <gate>',
      `exit non-zero when something widened: ${failOnValues().join(' | ')}`,
    )
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(async (unrecognized: readonly string[], options: ScanOptions) =>
      runScan(program, context, deps, { unrecognized, options }),
    );
}

/** One scan, rendered as whichever narrower question the flags asked, on one rail. */
async function runScan(
  program: Command,
  context: CliContext,
  deps: ScanDeps,
  input: ScanInput,
): Promise<void> {
  const { unrecognized, options } = input;
  const first = unrecognized[0];
  if (first !== undefined) throw new Error(describeUnknownCommand(program, first));
  if (options.json !== true) context.flow.open('memnox scan');
  const seams = deps.buildSeams(deps.cwd());

  // Before the scan, because a comparison takes its own later side.
  if (wantsDrift(options)) {
    if (await renderDrift(context, seams, options)) process.exitCode = EXIT.FAILED;
    return;
  }

  // Kept only when asked: a scan every command runs would churn the history.
  const { report, snapshot } = await scanMachine(seams, {
    probe: options.probe,
    save: options.save === true,
  });
  return renderReport(context, deps, { report, takenAt: snapshot.takenAt, options });
}

/** The report, as the one view the flags picked. */
async function renderReport(
  context: CliContext,
  deps: ScanDeps,
  input: ReportInput,
): Promise<void> {
  const { report, takenAt, options } = input;
  const asJson = options.json === true;
  if (options.share === true) return renderShare(context, report, takenAt, asJson);
  if (options.usage !== undefined) {
    return renderUsage(context, report, options.usage, asJson);
  }
  if (options.mcp !== undefined) {
    return renderServerReview(context, report, options.mcp, asJson);
  }
  if (asJson) {
    // The inventory rather than the raw report: this is the shape that leaves the process.
    context.out.json(inventoryOf(report, takenAt));
    return;
  }
  if (options.tools === true) return renderTools(context, report);
  return renderMachine(context, report, await deps.counts());
}

/** The share card is meant to be pasted elsewhere, so nothing of ours is drawn through it. */
function renderShare(
  context: CliContext,
  report: DiscoveryReport,
  takenAt: string,
  asJson: boolean,
): void {
  const card = shareCardFor(inventoryOf(report, takenAt));
  if (asJson) {
    context.out.json(card);
    return;
  }
  context.out.line(renderShareCard(card));
}
