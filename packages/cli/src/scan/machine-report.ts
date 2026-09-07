import {
  AGENT_APPROVAL,
  agentRefOf,
  agentsReachingPath,
  approvalOf,
  DEFINITION_KIND,
  describeBrowser,
  describeCombined,
  describeHarness,
  distinctTools,
  gapLines,
  GRANT,
  measureGap,
  principalCount,
  SENSITIVITY,
  SURFACE_KIND,
  TOOL_EFFECT,
  type DiscoveryReport,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import type { LocalCounts } from '../local-counts';

const LABEL_WIDTH = 24;
/** Padding is computed from the longest path, so a long one never eats its own count. */
const PATH_GUTTER = 2;

export function renderMachine(
  context: CliContext,
  report: DiscoveryReport,
  counts: LocalCounts,
): void {
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

  /* Nobody approved it, and until now nothing noticed. Only said when somebody has
     actually decided: an empty list means undecided, not that everything is approved. */
  const unregistered = report.agents
    .map((agent) => agent.kind)
    .filter(
      (kind) => approvalOf(kind, counts.approvedAgents) === AGENT_APPROVAL.UNREGISTERED,
    );
  if (unregistered.length > 0) {
    out.line(
      ''.padEnd(LABEL_WIDTH) +
        style.warn(
          `${unregistered.join(', ')} — nobody approved ${unregistered.length === 1 ? 'this' : 'these'}`,
        ),
    );
  }

  renderHarnesses(context, report);
  renderDefinitions(context, report);

  const servers = report.surfaces.filter((surface) => surface.kind === SURFACE_KIND.MCP);
  if (servers.length > 0) {
    // Distinct: the same server in five editors is one server's worth of tools.
    const tools = distinctTools(servers).length;
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

    /* A host that filters its own tools was right to, and the smaller number needs a
       reason beside it or it reads as a scan that missed something. */
    const filtered = servers.reduce(
      (total, surface) => total + (surface.filteredOut ?? 0),
      0,
    );
    if (filtered > 0) {
      out.line(
        ''.padEnd(LABEL_WIDTH) +
          style.dim(
            `${filtered} more hidden by the host's own filter, so ${filtered === 1 ? 'it is' : 'they are'} not counted here`,
          ),
      );
    }

    // The line that lands: a count of destructive tools nothing is checking.
    const destructive = distinctTools(servers).filter(
      (tool) => tool.effect === TOOL_EFFECT.DESTRUCTIVE,
    );
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

  renderCredentials(context, report);
  renderAuthenticatedClis(context, report);
  renderBrowsers(context, report);
  renderCombined(context, report);

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
  if (counts.approvedAgents.length === 0 && report.agents.length > 0) {
    out.note(
      'No agent has been approved or refused here. Decide with ' +
        `"memnox config set approvedAgents ${report.agents.map((agent) => agent.kind).join(',')}".`,
    );
  }
  out.line('');
  /* The gap, and the reason anybody keeps reading: what can reach outside this laptop
     against how much of it anything is checking. Both are counts, never a score. */
  const gap = measureGap(report, counts.policies);
  for (const line of gapLines(gap)) {
    out.line(gap.governed === 0 ? style.warn(line) : line);
  }
  /* An unreadable file is never reported as no rules, and never as the whole rule set
     either: the other repositories on this disk are still in force. Each broken file is
     named with a count, and the command that prints what is wrong with it. */
  for (const broken of counts.unreadable) {
    const problems = broken.issues.length;
    out.note(
      `${broken.file} would not load — ${problems} problem${problems === 1 ? '' : 's'}, so its rules are not in force.`,
    );
    out.note(`  see them with "memnox policy check ${broken.file}"`);
  }
  out.line('');
  // Padded on the plain text, so colour codes never throw the column off.
  const NEXT_WIDTH = 24;
  for (const [command, what] of [
    ['memnox explain <name>', 'where any of these comes from'],
    ['memnox protect', 'put the dangerous ones behind ask or deny'],
  ] as const) {
    out.line(
      `  ${style.dim(command)}${' '.repeat(Math.max(2, NEXT_WIDTH - command.length + 2))}${what}`,
    );
  }
}

/**
 * The headline. A credential file is a fact; how many agents can read it is the line
 * people screenshot. Values never appear — only the path, the structure and a count.
 */
function renderCredentials(context: CliContext, report: DiscoveryReport): void {
  const { out, style } = context;
  if (report.credentials.length === 0) return;

  const refs = report.agents.map(agentRefOf);
  /* Counted per path off the same table the reachable block reads. Standing in the
     agent total here meant one screen said `5 agents` and `4 agents` about one file. */
  const reach = (path: string): string => {
    const count = agentsReachingPath(path, refs, report.surfaces).length;
    return `${count} agent${count === 1 ? '' : 's'}`;
  };
  out.line('');
  out.line(style.bold('CREDENTIALS THESE AGENTS CAN READ'));
  out.line('');

  // Every path in this block sets the column, or the shortest list wins and the rest run on.
  const width =
    Math.max(
      ...report.credentials.map((each) => each.path.length),
      ...report.envFiles.map((each) => each.path.length),
    ) + PATH_GUTTER;
  for (const credential of report.credentials) {
    out.line(
      `  ${style.warn('!')}  ${credential.path.padEnd(width)}${reach(credential.path)}`,
    );
    if (credential.detail !== undefined) {
      out.line(`     ${style.dim(credential.detail)}`);
    }
  }

  // Counted, never read out: the variable names decide, and the values stay put.
  for (const env of report.envFiles) {
    const keys =
      env.keyLike === 0
        ? ''
        : env.keyLike === 1
          ? ', 1 looks like a credential'
          : `, ${env.keyLike} look like credentials`;
    out.line(`  ${style.warn('!')}  ${env.path.padEnd(width)}${reach(env.path)}`);
    out.line(`     ${style.dim(`${env.variables} variables${keys}`)}`);
  }
}

/**
 * The section that makes the CLI surface land: it turns a file into a verb. Everything
 * here comes from the same verb tables enforcement reads, so what this promises is
 * exactly what `protect` will gate.
 */
function renderAuthenticatedClis(context: CliContext, report: DiscoveryReport): void {
  const { out, style } = context;
  if (report.authenticated.length === 0) return;

  out.line('');
  out.line(style.bold('WHAT THEY CAN DO WITH THEM') + style.dim('  (via shell)'));
  out.line('');

  const width = Math.max(...report.authenticated.map((each) => each.name.length)) + 2;
  for (const cli of report.authenticated) {
    const destructive =
      cli.destructiveVerbs === 0
        ? ''
        : style.dim(` · ${cli.destructiveVerbs} destructive`);
    out.line(`  ${cli.name.padEnd(width)}${cli.headline}${destructive}`);
    if (cli.detail !== undefined)
      out.line(`  ${''.padEnd(width)}${style.dim(cli.detail)}`);
    // A guess from a name is printed as a guess, never asserted as a fact.
    if (cli.productionLooking !== undefined) {
      out.line(
        `  ${''.padEnd(width)}${style.warn(`"${cli.productionLooking}" is named like production`)}`,
      );
    }
  }
}

/**
 * The quietest credential on the machine. No file called `credentials`, no token in an
 * env var — just every site somebody is still signed into, reachable by anything that
 * can drive the browser.
 */
function renderBrowsers(context: CliContext, report: DiscoveryReport): void {
  const { out, style } = context;
  const carrying = report.browsers.filter((each) => each.persistentProfile !== undefined);
  if (report.browsers.length === 0) return;

  out.line('');
  out.line(style.bold('BROWSER AUTOMATION'));
  out.line('');
  for (const browser of report.browsers) {
    const mark = browser.persistentProfile === undefined ? ' ' : style.warn('!');
    out.line(`  ${mark}  ${describeBrowser(browser)}`);
    out.line(`     ${style.dim(browser.detectedFrom)}`);
  }
  if (carrying.length > 0) {
    out.note('A saved profile carries your logins; nothing here opened it.');
  }
}

/**
 * A harness is one row that launches several principals, so the roster says so. Nothing
 * here replaces what Hermes, OpenClaw or Ruflo already enforce — each filters its own
 * tools and each is right to. What none of them can see is the other two, the
 * credentials on the disk underneath, and the shell all three share.
 */
/**
 * Personas installed into an agent's own directory, counted by what they grant.
 *
 * Not folded into the gap below it, and that is deliberate: the gap counts actions a
 * rule could be written about, and a definition is not an action — it is how wide the
 * session running those actions is. Counting them together would make one number out
 * of two different claims.
 */
function renderDefinitions(context: CliContext, report: DiscoveryReport): void {
  const { out, style } = context;
  const installed = report.definitions.filter(
    (each) => each.kind === DEFINITION_KIND.AGENT,
  );
  if (installed.length === 0) return;

  const agents = [...new Set(installed.map((each) => each.agent))].join(', ');
  out.line(
    style.bold('AGENT DEFINITIONS'.padEnd(LABEL_WIDTH)) +
      `${installed.length} installed into ${agents}`,
  );

  /* The line that lands. A definition file reads as documentation — the largest public
     roster's own security policy calls these non-executable prompt definitions — and on
     these harnesses one that names no tools runs with the shell and every server. */
  const inheriting = installed.filter((each) => each.grant.kind === GRANT.INHERITS);
  if (inheriting.length > 0) {
    out.line(
      ''.padEnd(LABEL_WIDTH) +
        style.warn(
          `${inheriting.length} of them declare no tools, so each inherits every tool in the session`,
        ),
    );
  }
  const declared = installed.filter((each) => each.grant.kind === GRANT.DECLARED);
  if (declared.length > 0) {
    out.line(
      ''.padEnd(LABEL_WIDTH) +
        style.dim(`${declared.length} name the tools they may use`),
    );
  }
}

function renderHarnesses(context: CliContext, report: DiscoveryReport): void {
  const { out, style } = context;
  if (report.harnesses.length === 0) return;

  const principals = report.harnesses.reduce(
    (total, harness) => total + principalCount(harness),
    0,
  );
  out.line(
    style.bold('HARNESSES'.padEnd(LABEL_WIDTH)) +
      report.harnesses.map((harness) => harness.kind).join(', ') +
      style.dim(`  ${principals} principal${principals === 1 ? '' : 's'}`),
  );
  for (const harness of report.harnesses) {
    out.line(`  ${style.dim(`${harness.kind}: ${describeHarness(harness)}`)}`);
  }
  // The far side of a federated link is another organization's machine, and no local
  // scan can see it. Said plainly rather than left as an absence.
  if (report.harnesses.some((harness) => harness.federated)) {
    out.note(
      'One of these works with agents on other machines; this scan sees only here.',
    );
  }
}

/**
 * The section a per-call allow-list cannot produce. Every tool in a chain is ordinary,
 * every one of them passes review on its own, and holding all of them is the path.
 */
function renderCombined(context: CliContext, report: DiscoveryReport): void {
  const { out, style } = context;
  const chains = report.combined.filter((each) =>
    each.capabilities.some((capability) => capability.individuallyHarmless),
  );
  if (chains.length === 0) return;

  out.line('');
  out.line(style.bold('COMBINED CAPABILITY') + style.dim('  (no single tool does this)'));
  out.line('');
  for (const { agentId, capabilities } of chains) {
    const agent = agentId.replace('agt_', '');
    for (const capability of capabilities) {
      if (!capability.individuallyHarmless) continue;
      out.line(`  ${style.warn('!')}  ${agent}: ${capability.consequence}`);
      out.line(`     ${style.dim(describeCombined(capability))}`);
    }
  }
  out.note('Each of these tools is ordinary. Holding all of them is the path.');
}
