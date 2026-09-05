import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  DECISION_EFFECT,
  findUnusedGrants,
  inventoryOf,
  matchesPattern,
  renderFields,
  renderShareCard,
  shareCardFor,
  rollUpUsage,
  SqliteEventStore,
  reviewServers,
  SENSITIVITY,
  SURFACE_KIND,
  TOOL_EFFECT,
  type DiscoveryReport,
  type McpTool,
  type ServerReview,
  type ToolEffect,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { readLocalCounts, type LocalCounts } from '../local-counts';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';

/** How far apart two words may be before a suggestion is noise rather than help. */
const MAX_SUGGESTION_DISTANCE = 3;

/** Names the word the user actually typed, and the nearest command if there is one. */
function unknownCommand(program: Command, word: string): string {
  const names = program.commands.map((command) => command.name());
  const nearest = names
    .map((name) => ({ name, distance: distance(word, name) }))
    .filter((each) => each.distance <= MAX_SUGGESTION_DISTANCE)
    .sort((a, b) => a.distance - b.distance)[0];
  return (
    `unknown command "${word}"` +
    (nearest === undefined ? '' : ` — did you mean "${nearest.name}"?`) +
    '\nRun "memnox --help" for the full list.'
  );
}

/** Levenshtein, iterative: a typo is one or two edits away from what was meant. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

const LABEL_WIDTH = 24;
/** Padding is computed from the longest path, so a long one never eats its own count. */
const PATH_GUTTER = 2;

/**
 * Runs with no account, no key and no network. Nothing is transmitted, which is the
 * only reason a security engineer runs this on a laptop holding production credentials.
 */
export function registerScanCommand(
  program: Command,
  context: CliContext,
  buildSeams: (cwd: string) => ScanSeams = defaultScanSeams,
  cwd: () => string = () => process.cwd(),
  counts: () => Promise<LocalCounts> = () => readLocalCounts(homedir()),
): void {
  program
    .command('scan', { isDefault: true })
    // The word people reach for first. `memnox` alone runs it either way.
    .description(
      'What can act on this machine, and what it can reach. No account, no network.',
    )
    /* Bare `memnox` runs this, but `memnox audti` must not: with a default command
       commander hands an unknown word here as an argument. Refusing it as an excess
       argument blamed `discover` for a word the user never typed, so it is caught
       here instead and named for what it is. Hidden from the usage line. */
    .usage('[options]')
    .argument('[unrecognized...]')
    .option('--json', 'emit the report as JSON')
    .option('--tools', 'list every tool by what it does, server by server')
    .option('--mcp <server>', 'review one MCP server before you trust it')
    .option('--usage <window>', 'what was granted against what was used, e.g. 7d')
    .option('--save', 'keep this scan, so a later "memnox diff" has a baseline')
    .option('--share', 'a card of counts only, safe to paste anywhere')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(
      async (
        unrecognized: string[],
        options: {
          json?: boolean;
          tools?: boolean;
          probe: boolean;
          mcp?: string;
          save?: boolean;
          usage?: string;
          share?: boolean;
        },
      ) => {
        if (unrecognized.length > 0) {
          throw new Error(unknownCommand(program, unrecognized[0] as string));
        }
        // Kept only when asked: a scan every command runs would churn the history.
        const { report, snapshot } = await scanMachine(buildSeams(cwd()), {
          probe: options.probe,
          save: options.save === true,
        });
        if (options.share === true) {
          const card = shareCardFor(inventoryOf(report, snapshot.takenAt));
          context.out.line(
            options.json === true ? JSON.stringify(card, null, 2) : renderShareCard(card),
          );
          return;
        }
        if (options.usage !== undefined) {
          await renderUsage(context, report, options.usage, options.json === true);
          return;
        }
        if (options.mcp !== undefined) {
          renderServerReview(context, report, options.mcp, options.json === true);
          return;
        }
        if (options.json === true) {
          // The inventory, not the raw report: this is the shape that leaves the process.
          context.out.line(
            JSON.stringify(inventoryOf(report, snapshot.takenAt), null, 2),
          );
          return;
        }
        if (options.tools === true) {
          renderTools(context, report);
          return;
        }
        render(context, report, await counts());
      },
    );
}

/** Order matters: what can destroy is read before what can only read. */
const EFFECT_ORDER: readonly { effect: ToolEffect; label: string; mark: string }[] = [
  { effect: TOOL_EFFECT.DESTRUCTIVE, label: 'DESTRUCTIVE', mark: '✕' },
  { effect: TOOL_EFFECT.WRITE, label: 'WRITE', mark: '⚠' },
  { effect: TOOL_EFFECT.UNKNOWN, label: 'UNKNOWN', mark: '?' },
  { effect: TOOL_EFFECT.READ, label: 'READ', mark: '✓' },
];

const EFFECT_COLUMN = 34;

/**
 * "Thirty one tools" becomes "eight of them change external state", which is the only
 * version of that sentence anybody can act on. Nobody wants to read thirty
 * descriptions, and no client anywhere shows which of them change something.
 */
function renderTools(context: CliContext, report: DiscoveryReport): void {
  const { out, style } = context;
  const servers = new Map<string, McpTool[]>();
  for (const surface of report.surfaces) {
    for (const tool of surface.tools ?? []) {
      servers.set(tool.server, [...(servers.get(tool.server) ?? []), tool]);
    }
  }
  const credentials = credentialsByServer(report);

  if (servers.size === 0) {
    // Honest when empty: without a probe the servers are named and hold no tools.
    out.line('No MCP tools found.');
    out.line(style.dim('Run without --no-probe to ask each server what it holds.'));
    return;
  }

  let external = 0;
  let unknown = 0;
  let total = 0;
  for (const [server, tools] of [...servers].sort()) {
    out.line('');
    out.line(
      style.bold(`${server}  «mcp»`.padEnd(EFFECT_COLUMN)) +
        `${tools.length} tool${tools.length === 1 ? '' : 's'}`,
    );
    total += tools.length;

    // What the config hands it, before anything asks whether it should have it. Names
    // only: the value stays in the file it was written in.
    const handed = credentials.get(server) ?? [];
    if (handed.length > 0) {
      out.line(`${'credentials'.padEnd(EFFECT_COLUMN)}${style.warn(handed.join(', '))}`);
    }

    for (const { effect, label, mark } of EFFECT_ORDER) {
      const matching = tools.filter((tool) => tool.effect === effect);
      if (matching.length === 0) continue;
      // Unknown is not counted as external: an inferred blank is not evidence of harm.
      if (effect === TOOL_EFFECT.UNKNOWN) unknown += matching.length;
      else if (effect !== TOOL_EFFECT.READ) external += matching.length;
      out.line('');
      out.line(style.bold(label.padEnd(EFFECT_COLUMN)) + String(matching.length));
      for (const tool of matching.sort((a, b) => a.name.localeCompare(b.name))) {
        const painted = effect === TOOL_EFFECT.READ ? mark : style.warn(mark);
        // How it was decided rides along, so a wrong call is arguable rather than final.
        out.line(
          `  ${painted}  ${tool.name.padEnd(EFFECT_COLUMN - 5)}${style.dim(tool.inferredFrom)}`,
        );
      }
    }
  }

  out.line('');
  out.line(
    external === 0
      ? 'Nothing here is known to change external state.'
      : style.warn(`→ ${external} of ${total} change external state`),
  );
  if (unknown > 0) {
    out.line(
      style.dim(`  ${unknown} could not be classified, so they are counted as neither`),
    );
  }
}

/**
 * A server is installed by pasting a line, and nothing between the paste and the first
 * tool call asks what it wants. This is what it asked for, read off the config.
 */
function credentialsByServer(report: DiscoveryReport): Map<string, string[]> {
  const byServer = new Map<string, string[]>();
  for (const surface of report.surfaces) {
    for (const launch of surface.servers ?? []) {
      const env = launch.env;
      if (env === undefined || env.length === 0) continue;
      byServer.set(launch.name, [
        ...new Set([...(byServer.get(launch.name) ?? []), ...env]),
      ]);
    }
  }
  return byServer;
}

function render(context: CliContext, report: DiscoveryReport, counts: LocalCounts): void {
  const { out, style } = context;

  if (report.agents.length === 0) {
    // With no fixtures there is no pretty default, so an empty machine reads as an answer.
    out.line('No AI agents found on this machine.');
    out.line(style.dim('Nothing was transmitted. Install an agent and run this again.'));
    return;
  }

  out.line(
    style.bold('AI AGENTS'.padEnd(LABEL_WIDTH)) +
      report.agents.map((agent) => agent.kind).join(', '),
  );

  const servers = report.surfaces.filter((surface) => surface.kind === SURFACE_KIND.MCP);
  if (servers.length > 0) {
    const tools = servers.reduce(
      (total, surface) => total + (surface.tools ?? []).length,
      0,
    );
    out.line(
      style.bold('MCP CLIENTS'.padEnd(LABEL_WIDTH)) +
        servers.map((surface) => surface.agentId.replace('agt_', '')).join(', ') +
        (tools === 0 ? '' : style.dim(`  ${tools} tools`)),
    );

    const named = [
      ...new Set(
        servers.flatMap((surface) => (surface.servers ?? []).map((each) => each.name)),
      ),
    ];
    if (named.length > 0) {
      out.line(style.bold('MCP SERVERS'.padEnd(LABEL_WIDTH)) + named.join(', '));
    }

    // The line that lands: a count of destructive tools nothing is checking.
    const destructive = servers
      .flatMap((surface) => surface.tools ?? [])
      .filter((tool) => tool.effect === TOOL_EFFECT.DESTRUCTIVE);
    if (destructive.length > 0) {
      out.line(
        ''.padEnd(LABEL_WIDTH) +
          style.warn(
            `${destructive.length} of them destructive, and nothing is checking any of them`,
          ),
      );
    }
  }

  // Everything an agent with a shell reaches through one of these, whether or not
  // Memnox can see the call.
  if (report.tools.length > 0) {
    out.line(
      style.bold('TOOLS'.padEnd(LABEL_WIDTH)) +
        report.tools.map((tool) => tool.name).join(', '),
    );
  }

  const reachable = report.resources.filter(
    (resource) =>
      resource.sensitivity !== SENSITIVITY.ORDINARY && resource.reachableBy.length > 0,
  );
  if (reachable.length > 0) {
    out.line('');
    out.line(style.bold('REACHABLE FROM AN AGENT RIGHT NOW'));
    out.line('');
    const paths = reachable.map((resource) => resource.path ?? resource.id);
    const width =
      Math.max(LABEL_WIDTH, ...paths.map((path) => path.length)) + PATH_GUTTER;
    reachable.forEach((resource, index) => {
      const count = resource.reachableBy.length;
      const agents = `${count} agent${count === 1 ? '' : 's'}`;
      out.line(`  ${style.warn('!')}  ${(paths[index] ?? '').padEnd(width)}${agents}`);
      // A database or the network is not a file, so what named it is said plainly.
      if (resource.declaredIn !== undefined) {
        out.line(`     ${style.dim(resource.declaredIn)}`);
      }
    });
  }

  const surfaces = report.surfaces.filter((surface) => surface.kind !== SURFACE_KIND.MCP);
  out.line('');
  out.line(`${surfaces.length} execution surfaces.`);
  // Both are zero on a machine nobody has governed, which is the honest opening.
  out.line(
    `${counts.policies} ${counts.policies === 1 ? 'policy' : 'policies'}.  ${counts.records} record${counts.records === 1 ? '' : 's'}.`,
  );
  out.line('');
  // Padded on the plain text, so colour codes never throw the column off.
  const NEXT_WIDTH = 16;
  for (const [command, what] of [
    ['memnox doctor', 'what is risky and why'],
    ['memnox protect', 'fix it, reversibly'],
  ] as const) {
    out.line(`  ${style.dim(command)}${' '.repeat(NEXT_WIDTH - command.length)}${what}`);
  }
}

/** What one server declares, asks for and can reach — read before it is trusted. */
function renderServerReview(
  context: CliContext,
  report: DiscoveryReport,
  wanted: string,
  asJson: boolean,
): void {
  const reviews = reviewServers(report);
  const match = reviews.find((review) => review.server === wanted);
  if (match === undefined) {
    const names = reviews.map((review) => review.server);
    throw new Error(
      names.length === 0
        ? `No MCP server is configured on this machine, so there is no "${wanted}" to review.`
        : `No MCP server named "${wanted}". Configured here: ${names.join(', ')}.`,
    );
  }
  if (asJson) {
    context.out.line(JSON.stringify(match, null, 2));
    return;
  }
  context.out.line('');
  context.out.line(context.style.bold(match.server));
  context.out.line('');
  context.out.line(renderFields(fieldsFor(match)));
  context.out.line('');
  // Zero tools on a server nobody started means unknown, never harmless.
  if (match.unprobed) {
    context.out.note(
      'This server was never started, so its tools are unknown, not absent.',
    );
    context.out.note('Run without --no-probe to ask it.');
  }
}

function fieldsFor(review: ServerReview): { label: string; value: string }[] {
  return [
    { label: 'declared in', value: review.declaredIn },
    { label: 'command', value: review.command },
    { label: 'risk', value: review.risk },
    { label: 'tools', value: String(review.tools) },
    { label: 'read', value: String(review.read) },
    { label: 'write', value: String(review.write) },
    { label: 'destructive', value: String(review.destructive) },
    {
      label: 'credentials',
      value: review.credentials.length === 0 ? 'none' : review.credentials.join(', '),
    },
    { label: 'filesystem', value: review.filesystem ? 'reaches it' : 'no' },
    { label: 'network', value: review.network ? 'reaches it' : 'no' },
  ];
}

const DAY_MS = 86_400_000;

function windowDays(raw: string): number {
  const match = /^(\d+)d$/.exec(raw.trim());
  const days = match === null ? Number(raw) : Number(match[1]);
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`--usage takes a number of days, like 7d. Got "${raw}".`);
  }
  return days;
}

/**
 * Granted against used. The sentence nobody else can produce about a machine: this
 * agent can reach twenty things and touched three, and here are the seventeen.
 */
async function renderUsage(
  context: CliContext,
  report: DiscoveryReport,
  window: string,
  asJson: boolean,
): Promise<void> {
  const days = windowDays(window);
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const store = SqliteEventStore.forHome(homedir());

  try {
    const events = await store.query({ since });
    const usage = rollUpUsage(
      events.map((event) => ({
        agentId: event.agent,
        action: event.operation,
        resourceKind: event.surface,
        resourceId: event.target ?? event.operation,
        at: event.at,
        effect: event.effect,
      })),
    );

    // Every tool an agent here can reach is a grant, whether or not a rule names it.
    const granted = report.surfaces.flatMap((surface) =>
      (surface.tools ?? []).map((tool) => ({
        agentId: surface.agentId,
        action: `${tool.server}.${tool.name}`,
        grantedVia: surface.detectedFrom,
      })),
    );
    const unused = findUnusedGrants(granted, usage, days, matchesPattern);

    if (asJson) {
      context.out.line(JSON.stringify({ window: `${days}d`, usage, unused }, null, 2));
      return;
    }

    const { out, style } = context;
    out.line('');
    out.line(style.bold(`GRANTED AGAINST USED — last ${days} days`));
    out.line('');
    if (events.length === 0) {
      out.line('  Nothing was recorded in that window, so nothing can be called unused.');
      out.note('Wrap an agent with "memnox mcp wrap" and use it for a few days first.');
      return;
    }

    out.line(
      `  ${granted.length} granted    ${usage.length} used    ${unused.length} never touched`,
    );
    if (unused.length === 0) return;

    out.line('');
    const external = unused.filter((grant) =>
      report.surfaces.some((surface) =>
        (surface.tools ?? []).some(
          (tool) =>
            `${tool.server}.${tool.name}` === grant.action &&
            tool.effect !== TOOL_EFFECT.READ,
        ),
      ),
    );
    if (external.length > 0) {
      out.line(
        `  ${style.warn('!')} ${external.length} unused tool(s) can change external state:`,
      );
      for (const grant of external.slice(0, 10)) {
        out.line(`      ${grant.action}  (${grant.grantedVia})`);
      }
    }
    out.line('');
    out.line(
      `  ${style.dim('memnox protect')}  propose rules for what is not being used`,
    );
  } finally {
    store.close();
  }
}
