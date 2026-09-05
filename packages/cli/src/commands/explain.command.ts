import { cwd } from 'node:process';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import {
  actionForVerb,
  hasTag,
  VERB_TAG,
  verbTableFor,
  classifyActionClass,
  inventoryOf,
  LocalGate,
  parseQuestion,
  toolsMatching,
  traceCapability,
  type CapabilityInventory,
  type CapabilityTrace,
  type AuthenticatedCli,
  type DiscoveryReport,
  type ParsedQuestion,
  type VerbTable,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { row } from '../cli-output';
import { resolvePolicyFile } from '../policy-path';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';

/** Every field is read off a scan, so the chain is evidence rather than a guess. */
function renderTrace(context: CliContext, trace: CapabilityTrace): void {
  const { out, style } = context;
  out.line('');
  out.line(style.bold(trace.tool));
  out.line('');
  row(context.out, 'server', trace.server);
  row(context.out, 'declared', trace.grantedBy);
  row(context.out, 'class', `${trace.effect} — ${classifyActionClass(trace.tool).class}`);
  row(
    context.out,
    'reached by',
    trace.reachedBy.length === 0
      ? 'no agent here launches it'
      : trace.reachedBy.join(', '),
  );
  row(
    context.out,
    'first seen',
    trace.firstSeen ?? 'at least as long as the kept scans go back',
  );
  out.line('');
}

interface Answer {
  technically: string;
  runtime: string;
  policy: string;
}

/**
 * Three rows, each answered from something on this disk. The fourth row — what the
 * organization intended — needs somebody else's data and is the cloud's; it is left
 * out rather than filled with a guess.
 */
async function answerQuestion(
  question: ParsedQuestion,
  inventory: CapabilityInventory,
  policyFile: string,
): Promise<Answer> {
  const agent = inventory.agents.find((each) =>
    each.kind.toLowerCase().includes(question.agent.toLowerCase()),
  );
  if (agent === undefined) {
    const known = inventory.agents.map((each) => each.kind);
    throw new Error(
      known.length === 0
        ? `No agent on this machine, so there is nothing to answer about "${question.agent}".`
        : `No agent here matches "${question.agent}". Found: ${known.join(', ')}.`,
    );
  }

  const reachesShell = inventory.shell.includes(agent.id);
  const tools = inventory.tools.filter((tool) =>
    inventory.mcpServers.some(
      (server) => server.name === tool.server && server.reachedBy.includes(agent.id),
    ),
  );
  const matchingPath = inventory.filesystem.filter(
    (entry) =>
      entry.reachableBy.includes(agent.id) && entry.path.includes(question.resource),
  );

  const technically =
    matchingPath.length > 0
      ? `yes — ${matchingPath[0]?.path} is reachable by ${agent.kind}`
      : reachesShell
        ? `yes — ${agent.kind} holds a shell, which reaches anything you can`
        : tools.length > 0
          ? `unclear — ${tools.length} tool(s) reachable, none named for ${question.resource}`
          : `no — nothing ${agent.kind} holds here reaches ${question.resource}`;

  const runtime = reachesShell
    ? 'a shell is present, so the runtime restricts nothing by itself'
    : `${tools.length} tool(s) across ${inventory.mcpServers.length} server(s)`;

  const action = actionForVerb(question.verb);
  if (!existsSync(policyFile)) {
    return {
      technically,
      runtime,
      policy: `no rules at ${policyFile} — nothing here would stop it`,
    };
  }

  const gate = await LocalGate.fromFiles([policyFile], { agentName: agent.kind });
  const verdict = gate.evaluate({ action, target: question.resource });
  const rule = verdict.matchedPolicies[0];
  const named = rule === undefined ? 'no rule matched' : `rule ${rule.name}`;

  return {
    technically,
    runtime,
    policy: `${verdict.effect.toUpperCase()} — ${named}: ${verdict.reason}`,
  };
}

function renderAnswer(
  context: CliContext,
  question: ParsedQuestion,
  answer: Answer,
): void {
  const { out, style } = context;
  out.line('');
  out.line(style.bold(`can ${question.agent} ${question.verb} ${question.resource}?`));
  out.line('');
  row(context.out, 'Technically', answer.technically);
  row(context.out, 'Runtime', answer.runtime);
  row(context.out, 'Policy', answer.policy);
  out.line('');
  // The fourth row is the cloud's, and an empty row is better than an invented one.
  out.note(
    'What the organization intended is not on this disk, so it is not answered here.',
  );
}

export function registerExplainCommand(
  program: Command,
  context: CliContext,
  buildSeams: (dir: string) => ScanSeams = defaultScanSeams,
): void {
  program
    .command('explain <subject>')
    .description('Where a capability came from, or whether an agent could do a thing')
    .option('--json', 'machine-readable output')
    .option('-f, --file <path>', 'policy file (default: whichever exists)')
    .action(async (subject: string, options: { json?: boolean; file?: string }) => {
      const seams = buildSeams(cwd());
      const { report, snapshot } = await scanMachine(seams, { probe: false });

      // An authenticated CLI is the thing people ask about first, so it is checked
      // before the tool index: "vercel" means the CLI, not a tool named vercel.
      const cli = report.authenticated.find((each) => each.name === subject);
      if (cli !== undefined && !subject.includes(' ')) {
        renderCli(context, cli, report, options.json === true);
        return;
      }

      // A sentence is a question; a bare word is a capability. Nothing is inferred.
      if (subject.trim().includes(' ')) {
        const { question, error } = parseQuestion(subject);
        if (question === undefined) throw new Error(error);

        const answer = await answerQuestion(
          question,
          inventoryOf(report, snapshot.takenAt),
          resolvePolicyFile(options.file),
        );
        if (options.json === true) {
          context.out.json({ question, ...answer });
          return;
        }
        renderAnswer(context, question, answer);
        return;
      }

      const history = await seams.snapshots.history();
      const trace = traceCapability(subject, [...history, snapshot]);
      if (trace === null) {
        // Naming near misses beats a bare "not found" for a half-remembered tool.
        const near = toolsMatching(snapshot, subject);
        if (near.length === 0) {
          throw new Error(`Nothing here provides "${subject}". Run "memnox scan".`);
        }
        context.out.line(`No capability is named exactly "${subject}". Close matches:`);
        for (const each of near) context.out.line(`  ${each.server}.${each.tool}`);
        return;
      }

      if (options.json === true) {
        context.out.json(trace);
        return;
      }
      renderTrace(context, trace);
    });
}

/**
 * The verb table shown here is the one enforcement reads, so what this promises is
 * exactly what `protect` will gate. A screen that listed capabilities the gate did not
 * actually recognise would be worse than no screen.
 */
function renderCli(
  context: CliContext,
  cli: AuthenticatedCli,
  report: DiscoveryReport,
  asJson: boolean,
): void {
  const table = verbTableFor(cli.name) as VerbTable;
  if (asJson) {
    context.out.json({ cli, verbs: table.verbs });
    return;
  }

  const { out, style } = context;
  out.line('');
  out.line(`${style.bold(cli.name)}  ${style.dim('· authenticated CLI')}`);
  out.line('');

  const agents = report.agents.map((agent) => agent.kind);
  row(
    context.out,
    'Reachable by',
    agents.length === 0 ? 'no agent here' : agents.join(', '),
  );
  row(context.out, 'Credential', cli.via);
  if (cli.detail !== undefined) row(context.out, '', cli.detail);
  if (cli.productionLooking !== undefined) {
    // A guess from a name stays a guess all the way into the screen.
    row(
      context.out,
      '',
      style.warn(`"${cli.productionLooking}" is named like production`),
    );
  }
  out.line('');
  out.line('  Can');

  const width = Math.max(...table.verbs.map((verb) => verb.match.length)) + 2;
  for (const verb of table.verbs) {
    const tags = [
      verb.class,
      ...(hasTag(verb, VERB_TAG.PRODUCTION) ? ['production'] : []),
      ...(hasTag(verb, VERB_TAG.SECRETS) ? ['secrets'] : []),
    ].join(' · ');
    const marked = verb.class === 'destructive' ? style.warn(tags) : style.dim(tags);
    out.line(`    ${verb.match.padEnd(width)}${marked}`);
    if (verb.note !== undefined) {
      out.line(`    ${''.padEnd(width)}${style.dim(verb.note)}`);
    }
  }

  out.line('');
  out.line(
    `  ${style.dim(`memnox protect --for ${cli.name}`)}   put the dangerous ones behind ask or deny`,
  );
  out.line('');
}
