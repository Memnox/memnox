/** `memnox explain`: an agent, a CLI, a server, a tool or a whole sentence, answered on one rail. */

import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  inventoryOf,
  parseQuestion,
  toolsMatching,
  traceCapability,
  verbTableFor,
  type DiscoveryReport,
  type EnvironmentSnapshot,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import {
  policySetInForce,
  resolvePolicyFile,
  renderWhatDidNotLoad,
} from '../policy-path';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';
import { renderTrace } from './explain/capability';
import { answerQuestion, renderAnswer } from './explain/question';
import { renderCli, type ExplainedCli } from './explain/cli';
import { readDormantHere } from '../keeper/keep-dormant';
import { readCoverageFacts, readLastProbedScan, renderAgent } from './explain/agent';
import { renderServer, serverNamed, withVerdicts } from './explain/server';
import { authorityFor } from './explain/authority-view';

/** What `explain` reads the machine through, injected so a test never reads the real one. */
interface ExplainDeps {
  buildSeams: (dir: string) => ScanSeams;
  cwd: () => string;
  home: () => string;
  env: NodeJS.ProcessEnv;
}

interface ExplainOptions {
  json?: boolean;
  file?: string;
}

/** What `explain` was asked, and everything a resolver needs to answer it. */
interface ExplainQuery {
  context: CliContext;
  seams: ScanSeams;
  report: DiscoveryReport;
  snapshot: EnvironmentSnapshot;
  subject: string;
  asJson: boolean;
  dir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  file?: string;
}

/** Answered it, or did not recognise the subject and left it to the next resolver. */
type Resolver = (query: ExplainQuery) => Promise<boolean>;

/**
 * Tried in order: a product name wins over a tool named after it, a CLI over the tool
 * index, a sentence is a question, and whatever nobody claims falls to the capability trace.
 */
const RESOLVERS: readonly Resolver[] = [
  resolveAgent,
  resolveCli,
  resolveQuestion,
  resolveServer,
  resolveCapability,
];

export function registerExplainCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<ExplainDeps> = {},
): void {
  const deps: ExplainDeps = {
    buildSeams: defaultScanSeams,
    cwd: () => process.cwd(),
    home: homedir,
    env: process.env,
    ...overrides,
  };
  program
    .command('explain <subject>')
    .description('Where a capability came from, or whether an agent could do a thing')
    .option('--json', 'machine-readable output')
    .option('-f, --file <path>', 'policy file (default: whichever exists)')
    .action(async (subject: string, options: ExplainOptions) =>
      runExplain(context, deps, subject, options),
    );
}

/** Scans once, then hands the subject down the resolver chain until one answers. */
async function runExplain(
  context: CliContext,
  deps: ExplainDeps,
  subject: string,
  options: ExplainOptions,
): Promise<void> {
  const asJson = options.json === true;
  if (!asJson) context.flow.open('memnox explain');

  const dir = deps.cwd();
  const seams = deps.buildSeams(dir);
  const { report, snapshot } = await scanMachine(seams, { probe: false });
  const query: ExplainQuery = {
    context,
    seams,
    report,
    snapshot,
    subject,
    asJson,
    dir,
    home: deps.home(),
    env: deps.env,
    file: options.file,
  };

  for (const resolve of RESOLVERS) {
    if (await resolve(query)) return;
  }
}

/** The product itself, first, because "cursor" is the agent rather than a tool named after it. */
async function resolveAgent(query: ExplainQuery): Promise<boolean> {
  const agent = query.report.agents.find((each) => each.kind === query.subject);
  if (agent === undefined) return false;

  // Explain never starts an MCP server, so the tools come from the last scan that did.
  const last = await readLastProbedScan(query.seams);
  const rules = await policySetInForce(query.home, query.file);
  renderAgent(query.context, {
    agent,
    report: query.report,
    last,
    authority: authorityFor({
      agentKind: agent.kind,
      agentId: agent.id,
      report: query.report,
      last,
      policies: rules.policies,
    }),
    facts: await readCoverageFacts({
      dir: query.dir,
      home: query.home,
      env: query.env,
      agent: agent.kind,
    }),
    dormant: (await readDormantHere(query.home, query.seams.snapshots, new Date())).find(
      (each) => each.agentId === agent.id,
    ),
    asJson: query.asJson,
  });
  return true;
}

/**
 * An authenticated CLI, or an installed one the verb tables know, checked before the
 * tool index because "vercel" means the CLI.
 */
async function resolveCli(query: ExplainQuery): Promise<boolean> {
  const { report, subject } = query;
  if (subject.includes(' ')) return false;

  const cli =
    report.authenticated.find((each) => each.name === subject) ?? installedCli(query);
  if (cli === null) return false;
  renderCli(query.context, cli, report, query.asJson);
  return true;
}

/** Installed counts too, because the verb table is worth reading with or without a credential. */
function installedCli(query: ExplainQuery): ExplainedCli | null {
  const installed = query.report.tools.find((each) => each.name === query.subject);
  if (installed === undefined || verbTableFor(query.subject) === null) return null;
  return { name: query.subject, detectedFrom: installed.detectedFrom };
}

/** A sentence is a question; a bare word is not, and nothing in between is inferred. */
async function resolveQuestion(query: ExplainQuery): Promise<boolean> {
  const { context, subject, asJson, home } = query;
  if (!subject.trim().includes(' ')) return false;

  const { question, error } = parseQuestion(subject, home);
  if (question === undefined) throw new Error(error);

  const rules = await policySetInForce(home, query.file);
  const answer = await answerQuestion(
    question,
    inventoryOf(query.report, query.snapshot.takenAt),
    rules,
    resolvePolicyFile(query.file),
  );
  // A file that would not load is not an absent rule, and is never silent here.
  renderWhatDidNotLoad(context, rules);
  if (asJson) {
    context.out.json({ question, ...answer });
    return true;
  }
  renderAnswer(context, question, answer);
  return true;
}

/** An MCP server the scan named, because denying one the scan just listed breaks trust in both. */
async function resolveServer(query: ExplainQuery): Promise<boolean> {
  if (query.subject.includes(' ')) return false;
  const server = serverNamed(query.report, query.subject);
  if (server === null) return false;

  const rules = await policySetInForce(query.home, query.file);
  renderWhatDidNotLoad(query.context, rules);
  renderServer(query.context, withVerdicts(server, rules.policies), query.asJson);
  return true;
}

/** Where a capability came from; always answers, with the trace, near misses, or a throw. */
async function resolveCapability(query: ExplainQuery): Promise<boolean> {
  const { context, seams, snapshot, subject, asJson } = query;
  const history = await seams.snapshots.history();
  const trace = traceCapability(subject, [...history, snapshot]);

  if (trace === null) {
    renderNearMisses(query);
    return true;
  }
  if (asJson) {
    context.out.json(trace);
    return true;
  }
  renderTrace(context, trace);
  return true;
}

/** Naming near misses beats a bare not found for a half-remembered tool. */
function renderNearMisses(query: ExplainQuery): void {
  const { context, snapshot, subject } = query;
  const near = toolsMatching(snapshot, subject);
  if (near.length === 0) {
    throw new Error(`Nothing here provides "${subject}". Run "memnox scan".`);
  }
  context.flow.list(
    `Nothing is named exactly "${subject}". Close matches`,
    near.map((each) => ({ tone: TONE.DIM, text: `${each.server}.${each.tool}` })),
  );
  context.flow.close(`${near.length} close match(es).`);
}
