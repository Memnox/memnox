import { cwd } from 'node:process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  actionForVerb,
  hasTag,
  VERB_TAG,
  verbTableFor,
  classifyActionClass,
  combinedCapabilities,
  coverageFor,
  coverageSummary,
  SEAM_STATE,
  describeCombined,
  inventoryOf,
  LocalGate,
  parseQuestion,
  toolsMatching,
  traceCapability,
  type CapabilityInventory,
  type CapabilityTrace,
  type AuthenticatedCli,
  type McpTool,
  type CombinedCapability,
  type CoverageFacts,
  type DiscoveredAgent,
  type DiscoveryReport,
  type EnvironmentSnapshot,
  type ParsedQuestion,
  type VerbTable,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { row } from '../cli-output';
import { resolvePolicyFile } from '../policy-path';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';
import { gatherHealth } from '../health-probe';
import { guardProfilePath } from '../memnox-paths';
import { loginPathConfigured } from '../protect/shell-profile';

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

      /* An agent kind is checked first: "cursor" is the product, not a tool that
         happens to be named after it. Every kind answers here, harness or not —
         one of them answering and the rest erroring is the asymmetry a reader hits
         the moment they try the second name they can see in a scan. */
      const agent = report.agents.find((each) => each.kind === subject);
      if (agent !== undefined) {
        /* Explain never starts anybody's MCP servers, so the tools come from the last
           scan that did. An unprobed snapshot holds no tools and would read as an
           agent with no chain, which is a different claim from "not asked yet". */
        const probed = await lastProbedScan(seams);
        renderAgent(
          context,
          agent,
          report,
          probed,
          await coverageFacts(cwd()),
          options.json === true,
        );
        return;
      }

      // An authenticated CLI is the thing people ask about first, so it is checked
      // before the tool index: "vercel" means the CLI, not a tool named vercel.
      const cli = report.authenticated.find((each) => each.name === subject);
      /* And one that is merely installed, which the scan also names. Answering only
         for the authenticated ones meant `scan` listed eight tools and `explain`
         denied every one of them existed — the same asymmetry the agent branch above
         is careful to avoid, one field over. The verb table is the half worth reading
         and it does not need a credential. */
      const installed = report.tools.find((each) => each.name === subject);
      const subjectCli: ExplainedCli | null =
        cli ??
        (installed !== undefined && verbTableFor(subject) !== null
          ? { name: subject, detectedFrom: installed.detectedFrom }
          : null);

      if (subjectCli !== null && !subject.includes(' ')) {
        renderCli(context, subjectCli, report, options.json === true);
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

      /* An MCP server the scan named. Same reason as the CLI branch above: a reader
         types the second name they can see on the scan, and a server that answers
         "nothing here provides that" about a server the scan just listed is the one
         wrong answer that makes somebody stop trusting both screens. */
      const server = serverNamed(report, subject);
      if (server !== null && !subject.includes(' ')) {
        renderServer(context, server, options.json === true);
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
type ExplainedCli =
  | AuthenticatedCli
  | {
      name: string;
      /** The path that proved it is here. An installed CLI has this and no credential. */
      detectedFrom: string;
      via?: undefined;
      detail?: undefined;
      productionLooking?: undefined;
    };

function renderCli(
  context: CliContext,
  cli: ExplainedCli,
  report: DiscoveryReport,
  asJson: boolean,
): void {
  const table = verbTableFor(cli.name) as VerbTable;
  if (asJson) {
    context.out.json({ cli, verbs: table.verbs });
    return;
  }

  const { out, style } = context;
  const authenticated = cli.via !== undefined;
  out.line('');
  out.line(
    `${style.bold(cli.name)}  ${style.dim(authenticated ? '· authenticated CLI' : '· installed CLI')}`,
  );
  out.line('');

  const agents = report.agents.map((agent) => agent.kind);
  row(
    context.out,
    'Reachable by',
    agents.length === 0 ? 'no agent here' : agents.join(', '),
  );
  /* "Nothing here is logged in" is a different claim from "this cannot reach
     anything", and the verbs below are true either way — a credential can arrive
     tomorrow without the table changing. */
  row(
    context.out,
    'Credential',
    cli.via ?? 'none found here — the table below is what it could do with one',
  );
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

/**
 * What a harness runs, rather than what it is. Every line is read off the disk it
 * scaffolded, because the interesting number about an orchestrator is how many
 * principals it puts behind one row on the roster.
 */
function renderAgent(
  context: CliContext,
  agent: DiscoveredAgent,
  report: DiscoveryReport,
  last: EnvironmentSnapshot | null,
  facts: CoverageFacts,
  asJson: boolean,
): void {
  const harness = report.harnesses.find((each) => each.agentId === agent.id) ?? null;
  const combined = chainsFor(agent.id, last);
  if (asJson) {
    context.out.json({
      agent,
      harness,
      combined,
      coverage: coverageFor(agent.kind, agent.id, report.surfaces, facts),
    });
    return;
  }

  const { out, style } = context;
  const what = harness === null ? 'agent' : 'harness, runs other agents';
  out.line('');
  out.line(`${style.bold(agent.kind)}  ${style.dim(`· ${what}`)}`);
  out.line('');

  // Only a harness has these three, and printing them empty for Cursor would imply
  // Cursor might have had them.
  if (harness !== null) {
    row(
      context.out,
      'Runs',
      harness.runtimes.length === 0
        ? 'nothing this scan could name'
        : harness.runtimes.join(', '),
    );
    row(
      context.out,
      'Roles',
      harness.roles.length === 0
        ? 'none defined on this disk'
        : `${harness.roles.length} — ${harness.roles.join(', ')}`,
    );
    row(
      context.out,
      'Hooks',
      harness.hooks.length === 0
        ? 'none installed into another product'
        : harness.hooks.join(', '),
    );
    if (harness.federated) {
      row(
        context.out,
        'Federated',
        style.warn('works with agents on machines this scan cannot see'),
      );
    }
  }

  const coverage = coverageFor(agent.kind, agent.id, report.surfaces, facts);
  const own = report.surfaces.filter((surface) => surface.agentId === agent.id);
  row(context.out, 'Declared in', agent.configPaths.join(', '));
  row(context.out, 'Surfaces', [...new Set(own.map((each) => each.kind))].join(', '));

  const servers = [
    ...new Set(own.flatMap((surface) => (surface.servers ?? []).map((s) => s.name))),
  ];
  row(
    context.out,
    'MCP servers',
    servers.length === 0 ? 'none declared in its config' : servers.join(', '),
  );
  // The shell is why a tool list understates a coding agent, so it is said out loud.
  const viaShell = report.reachability.find(
    (each) => each.agentId === agent.id,
  )?.viaShell;
  if (viaShell === true) {
    row(context.out, 'Shell', 'holds one, which reaches everything you can');
  }

  if (combined.length > 0) {
    out.line('');
    out.line('  Combined capability');
    for (const capability of combined) {
      out.line(`    ${style.warn(capability.consequence)}`);
      out.line(`    ${style.dim(describeCombined(capability))}`);
    }
  } else if (last === null) {
    out.line('');
    out.note(
      'No scan here has asked the servers, so no chain is shown. Run "memnox scan --save".',
    );
  }

  /* The question somebody actually has: what is in front of this one right now, and
     what would close the rest. Per agent, because a wrapped Claude Code and an
     unwrapped Cursor average out to a number nobody can act on. */
  const { held, total } = coverageSummary(coverage);
  out.line('');
  out.line(
    `  Governed by  ${held === total ? style.ok(`all ${total} seam(s)`) : style.warn(`${held} of ${total} seam(s)`)}`,
  );
  const width = Math.max(...coverage.map((each) => each.surface.length)) + 2;
  for (const seam of coverage) {
    if (seam.state === SEAM_STATE.NOT_HELD) continue;
    const mark = seam.state === SEAM_STATE.HELD ? style.ok('✓') : style.warn('!');
    out.line(`    ${mark}  ${seam.surface.padEnd(width)}${seam.detail}`);
    if (seam.next !== undefined) {
      out.line(`       ${''.padEnd(width)}${style.dim(`→ ${seam.next}`)}`);
    }
  }

  out.line('');
  /* A harness already filters its own tools and is right to. What it cannot see is
     the other harness on the same disk, the credentials underneath, and the shell
     they share. Said only for a harness: it is not true of Cursor. */
  if (harness !== null) {
    out.note(
      `${agent.kind} enforces its own tool policy. Memnox governs what it reaches underneath.`,
    );
  }
  out.line('');
}

/** The tools this agent reached in the last probed scan, and what they add up to. */
function chainsFor(
  agentId: string,
  last: EnvironmentSnapshot | null,
): CombinedCapability[] {
  if (last === null) return [];
  return combinedCapabilities(
    last.servers
      .filter((server) => server.agentIds.includes(agentId))
      .flatMap((server) =>
        server.tools.map((tool) => ({
          server: server.name,
          name: tool.name,
          effect: tool.effect,
          inferredFrom: 'name' as const,
        })),
      ),
  );
}

/**
 * The most recent snapshot that actually enumerated tools. Every command that reads the
 * machine also records what it saw, so the newest snapshot is usually this run's own
 * unprobed one — and reading that would report every harness as holding no tools.
 */
async function lastProbedScan(seams: ScanSeams): Promise<EnvironmentSnapshot | null> {
  const history = await seams.snapshots.history();
  for (let at = history.length - 1; at >= 0; at -= 1) {
    const snapshot = history[at] as EnvironmentSnapshot;
    if (snapshot.servers.some((server) => server.tools.length > 0)) return snapshot;
  }
  return null;
}

/**
 * The facts coverage is decided from, read once. Every one of them is about this
 * machine as it stands right now, so the answer changes when somebody wires
 * something up — which is the point of asking.
 */
async function coverageFacts(dir: string): Promise<CoverageFacts> {
  const health = await gatherHealth(homedir(), dir);
  return {
    interceptorsInstalled: health.interceptorsInstalled.length > 0,
    interceptorsFirstOnPath: health.interceptorDirFirstOnPath,
    gitHooksInstalled: existsSync(join(dir, '.git', 'hooks', 'pre-push')),
    osGuardWritten: existsSync(guardProfilePath(homedir())),
    egressProxySet: PROXY_VARS.some((name) => (process.env[name] ?? '') !== ''),
    loginPathConfigured: await loginPathConfigured(
      process.env['SHELL'] ?? 'zsh',
      homedir(),
    ),
    rulesRegistered: health.registeredFiles.length > 0,
  };
}

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy'];

interface ExplainedServer {
  name: string;
  /** Agents whose config declares it. */
  agents: string[];
  /** The config files that proved it. */
  detectedFrom: string[];
  /** Credential names the config hands it. Names only, never a value. */
  env: string[];
  /** Tools from the last scan that actually asked. Absent is "not asked", not "none". */
  tools: McpTool[];
  probed: boolean;
}

/** What the scan knows about one server, gathered from every agent that declares it. */
function serverNamed(report: DiscoveryReport, name: string): ExplainedServer | null {
  const agents = new Set<string>();
  const detectedFrom = new Set<string>();
  const env = new Set<string>();
  const tools: McpTool[] = [];
  let declared = false;

  for (const surface of report.surfaces) {
    for (const launch of surface.servers ?? []) {
      if (launch.name !== name) continue;
      declared = true;
      detectedFrom.add(surface.detectedFrom);
      for (const variable of launch.env ?? []) env.add(variable);
      const agent = report.agents.find((each) => each.id === surface.agentId);
      if (agent !== undefined) agents.add(agent.kind);
    }
    for (const tool of surface.tools ?? []) {
      if (tool.server === name) tools.push(tool);
    }
  }

  if (!declared) return null;
  return {
    name,
    agents: [...agents].sort(),
    detectedFrom: [...detectedFrom].sort(),
    env: [...env].sort(),
    tools,
    probed: tools.length > 0,
  };
}

function renderServer(
  context: CliContext,
  server: ExplainedServer,
  asJson: boolean,
): void {
  if (asJson) {
    context.out.json(server);
    return;
  }

  const { out, style } = context;
  out.line('');
  out.line(`${style.bold(server.name)}  ${style.dim('· MCP server')}`);
  out.line('');
  row(
    out,
    'Declared by',
    server.agents.length === 0 ? 'no agent here' : server.agents.join(', '),
  );
  for (const path of server.detectedFrom) row(out, 'From', path);
  if (server.env.length > 0) {
    // Names only: what a config hands a server, never the value behind it.
    row(out, 'Credentials', server.env.join(', '));
  }

  out.line('');
  if (!server.probed) {
    /* "Not asked yet" is a different claim from "holds nothing", and explain never
       starts anybody's server to find out. */
    out.line('  No tools recorded — nothing has asked this server what it holds.');
    out.note('"memnox scan" starts it and asks; this command never does.');
    return;
  }

  out.line('  Holds');
  const width = Math.max(...server.tools.map((tool) => tool.name.length)) + 2;
  for (const tool of server.tools) {
    const marked =
      tool.effect === 'destructive' ? style.warn(tool.effect) : style.dim(tool.effect);
    out.line(`    ${tool.name.padEnd(width)}${marked}`);
  }
  out.line('');
  out.line(
    `  ${style.dim(`memnox protect --for ${server.name}`)}   put the dangerous ones behind ask or deny`,
  );
  out.line('');
}
