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
import { TONE, type FlowRow } from '../flow';
import type { LocalCounts } from '../local-counts';

/**
 * What is on this machine, as one card and then the things that are wrong.
 *
 * The card is what a person reads first and it is all counts: which agents,
 * which harnesses, how many servers, how many tools. Everything after it is a
 * list of specific things somebody could act on, because a count nobody can
 * point at is a count nobody does anything about.
 */
export function renderMachine(
  context: CliContext,
  report: DiscoveryReport,
  counts: LocalCounts,
): void {
  const { flow, style } = context;

  if (report.agents.length === 0) {
    // With no fixtures there is no pretty default, so an empty machine reads as an answer.
    flow.close('No AI agents found on this machine.');
    flow.hint('Nothing was transmitted. Install an agent and run this again.');
    return;
  }

  flow.rows('On this machine', [
    { label: 'agents', value: report.agents.map((agent) => agent.kind).join(', ') },
    ...unregisteredRow(context, report, counts),
    ...harnessRows(context, report),
    ...definitionRows(context, report),
    ...serverRows(context, report),
    // Everything an agent with a shell reaches through one of these, whether or
    // not Memnox can see the call.
    ...(report.tools.length === 0
      ? []
      : [
          {
            label: 'tools',
            value: report.tools.map((tool) => tool.name).join(', '),
          },
        ]),
  ]);

  renderCredentials(context, report);
  renderAuthenticatedClis(context, report);
  renderBrowsers(context, report);
  renderCombined(context, report);
  renderReachable(context, report);

  /* An unreadable file is never reported as no rules, and never as the whole rule set
     either: the other repositories on this disk are still in force. Each broken file is
     named with a count, and the command that prints what is wrong with it. */
  if (counts.unreadable.length > 0) {
    flow.list(
      'Not in force',
      counts.unreadable.map((broken) => ({
        tone: TONE.WARN,
        text: `${broken.file} would not load, so its rules are not in force`,
        detail: [
          `${broken.issues.length} problem${broken.issues.length === 1 ? '' : 's'}`,
          `see them with "memnox policy check ${broken.file}"`,
        ],
      })),
    );
  }

  const surfaces = report.surfaces.filter((surface) => surface.kind !== SURFACE_KIND.MCP);
  /* The gap, and the reason anybody keeps reading: what can reach outside this laptop
     against how much of it anything is checking. Both are counts, never a score. */
  const gap = measureGap(report, counts.policies);
  flow.close(
    gap.governed === 0
      ? style.warn(
          `${surfaces.length} execution surfaces, and nothing is checking any of them.`,
        )
      : `${surfaces.length} execution surfaces.`,
  );
  for (const line of gapLines(gap)) flow.hint(line);
  if (counts.approvedAgents.length === 0) {
    flow.hint(
      'No agent has been approved or refused here. Decide with ' +
        `"memnox config set approvedAgents ${report.agents.map((agent) => agent.kind).join(',')}".`,
    );
  }
  flow.hint('memnox explain <name>   where any of these comes from');
  flow.hint('memnox protect          put the dangerous ones behind ask or deny');
}

/**
 * Nobody approved it, and until now nothing noticed.
 *
 * Only said when somebody has actually decided: an empty list means undecided,
 * not that everything is approved.
 */
function unregisteredRow(
  context: CliContext,
  report: DiscoveryReport,
  counts: LocalCounts,
): FlowRow[] {
  const unregistered = report.agents
    .map((agent) => agent.kind)
    .filter(
      (kind) => approvalOf(kind, counts.approvedAgents) === AGENT_APPROVAL.UNREGISTERED,
    );
  if (unregistered.length === 0) return [];
  return [
    {
      label: 'unapproved',
      value: context.style.warn(
        `${unregistered.join(', ')}, and nobody approved ${unregistered.length === 1 ? 'this' : 'these'}`,
      ),
    },
  ];
}

/**
 * A harness is one row that launches several principals, so the roster says so.
 *
 * Nothing here replaces what Hermes, OpenClaw or Ruflo already enforce, since
 * each filters its own tools and each is right to. What none of them can see is the
 * other two, the credentials on the disk underneath, and the shell all three share.
 */
function harnessRows(context: CliContext, report: DiscoveryReport): FlowRow[] {
  if (report.harnesses.length === 0) return [];
  const principals = report.harnesses.reduce(
    (total, harness) => total + principalCount(harness),
    0,
  );
  return [
    {
      label: 'harnesses',
      value: `${report.harnesses.map((harness) => harness.kind).join(', ')}  ${context.style.dim(
        `${principals} principal${principals === 1 ? '' : 's'}`,
      )}`,
    },
    ...report.harnesses.map((harness) => ({
      label: '',
      value: context.style.dim(`${harness.kind}: ${describeHarness(harness)}`),
    })),
    /* The far side of a federated link is another organization's machine, and no
       local scan can see it. Said plainly rather than left as an absence. */
    ...(report.harnesses.some((harness) => harness.federated)
      ? [
          {
            label: '',
            value: context.style.warn(
              'one of these works with agents on other machines; this scan sees only here',
            ),
          },
        ]
      : []),
  ];
}

/**
 * Personas installed into an agent's own directory, counted by what they grant.
 *
 * Not folded into the gap below it, and that is deliberate: the gap counts actions a
 * rule could be written about, and a definition is not an action: it is how wide
 * the session running those actions is. Counting them together would make one number out
 * of two different claims.
 */
function definitionRows(context: CliContext, report: DiscoveryReport): FlowRow[] {
  const installed = report.definitions.filter(
    (each) => each.kind === DEFINITION_KIND.AGENT,
  );
  if (installed.length === 0) return [];

  const agents = [...new Set(installed.map((each) => each.agent))].join(', ');
  /* The line that lands. A definition file reads as documentation, since the
     largest public roster's own security policy calls these non-executable prompt
     definitions, and on these harnesses one that names no tools runs with the
     shell and every server. */
  const inheriting = installed.filter((each) => each.grant.kind === GRANT.INHERITS);
  const declared = installed.filter((each) => each.grant.kind === GRANT.DECLARED);
  return [
    { label: 'definitions', value: `${installed.length} installed into ${agents}` },
    ...(inheriting.length === 0
      ? []
      : [
          {
            label: '',
            value: context.style.warn(
              `${inheriting.length} of them declare no tools, so each inherits every tool in the session`,
            ),
          },
        ]),
    ...(declared.length === 0
      ? []
      : [
          {
            label: '',
            value: context.style.dim(`${declared.length} name the tools they may use`),
          },
        ]),
  ];
}

/** Which agents speak MCP, which servers they hold, and what those servers can do. */
function serverRows(context: CliContext, report: DiscoveryReport): FlowRow[] {
  const { style } = context;
  const servers = report.surfaces.filter((surface) => surface.kind === SURFACE_KIND.MCP);
  if (servers.length === 0) return [];

  // Distinct: the same server in five editors is one server's worth of tools.
  const tools = distinctTools(servers);
  const named = [
    ...new Set(
      servers.flatMap((surface) => (surface.servers ?? []).map((each) => each.name)),
    ),
  ];
  /* A host that filters its own tools was right to, and the smaller number needs a
     reason beside it or it reads as a scan that missed something. */
  const filtered = servers.reduce(
    (total, surface) => total + (surface.filteredOut ?? 0),
    0,
  );
  // The line that lands: a count of destructive tools nothing is checking.
  const destructive = tools.filter((tool) => tool.effect === TOOL_EFFECT.DESTRUCTIVE);

  return [
    {
      label: 'mcp clients',
      value:
        servers.map((surface) => surface.agentId.replace('agt_', '')).join(', ') +
        (tools.length === 0 ? '' : style.dim(`  ${tools.length} tools`)),
    },
    ...(named.length === 0 ? [] : [{ label: 'mcp servers', value: named.join(', ') }]),
    ...(filtered === 0
      ? []
      : [
          {
            label: '',
            value: style.dim(
              `${filtered} more hidden by the host's own filter, so ${filtered === 1 ? 'it is' : 'they are'} not counted here`,
            ),
          },
        ]),
    ...(destructive.length === 0
      ? []
      : [
          {
            label: '',
            value: style.warn(
              `${destructive.length} of them destructive, and nothing is checking any of them`,
            ),
          },
        ]),
  ];
}

/**
 * The headline. A credential file is a fact; how many agents can read it is the line
 * people screenshot. Values never appear — only the path, the structure and a count.
 */
function renderCredentials(context: CliContext, report: DiscoveryReport): void {
  const { flow } = context;
  if (report.credentials.length === 0 && report.envFiles.length === 0) return;

  const refs = report.agents.map(agentRefOf);
  /* Counted per path off the same table the reachable block reads. Standing in the
     agent total here meant one screen said `5 agents` and `4 agents` about one file. */
  const reach = (path: string): string => {
    const count = agentsReachingPath(path, refs, report.surfaces).length;
    return `${count} agent${count === 1 ? '' : 's'}`;
  };

  /* Every path in this block sets the column, or the shortest list wins and the
     rest run on. A count is only scannable where it starts in one place. */
  const width = Math.max(
    ...report.credentials.map((each) => each.path.length),
    ...report.envFiles.map((each) => each.path.length),
  );

  flow.list('Credentials these agents can read', [
    ...report.credentials.map((credential) => ({
      tone: TONE.WARN,
      text: `${credential.path.padEnd(width)}  ${reach(credential.path)}`,
      detail: [credential.detail],
    })),
    // Counted, never read out: the variable names decide, and the values stay put.
    ...report.envFiles.map((env) => ({
      tone: TONE.WARN,
      text: `${env.path.padEnd(width)}  ${reach(env.path)}`,
      detail: [
        `${env.variables} variables${
          env.keyLike === 0
            ? ''
            : env.keyLike === 1
              ? ', 1 looks like a credential'
              : `, ${env.keyLike} look like credentials`
        }`,
      ],
    })),
  ]);
}

/**
 * The section that makes the CLI surface land: it turns a file into a verb. Everything
 * here comes from the same verb tables enforcement reads, so what this promises is
 * exactly what `protect` will gate.
 */
function renderAuthenticatedClis(context: CliContext, report: DiscoveryReport): void {
  const { flow, style } = context;
  if (report.authenticated.length === 0) return;

  const width = Math.max(...report.authenticated.map((cli) => cli.name.length));

  flow.list(
    'What they can do with them, through a shell',
    report.authenticated.map((cli) => ({
      tone: cli.destructiveVerbs === 0 ? TONE.DIM : TONE.WARN,
      text: `${cli.name.padEnd(width)}  ${cli.headline}${
        cli.destructiveVerbs === 0 ? '' : ` · ${cli.destructiveVerbs} destructive`
      }`,
      detail: [
        cli.detail,
        // A guess from a name is printed as a guess, never asserted as a fact.
        cli.productionLooking === undefined
          ? undefined
          : style.warn(`"${cli.productionLooking}" is named like production`),
      ],
    })),
  );
}

/**
 * The quietest credential on the machine. No file called `credentials`, no token in an
 * env var — just every site somebody is still signed into, reachable by anything that
 * can drive the browser.
 */
function renderBrowsers(context: CliContext, report: DiscoveryReport): void {
  const { flow } = context;
  if (report.browsers.length === 0) return;
  const carrying = report.browsers.filter((each) => each.persistentProfile !== undefined);

  flow.list(
    'Browser automation',
    report.browsers.map((browser) => ({
      tone: browser.persistentProfile === undefined ? TONE.PLAIN : TONE.WARN,
      text: describeBrowser(browser),
      detail: [browser.detectedFrom],
    })),
  );
  if (carrying.length > 0) {
    flow.aside(
      context.style.dim('A saved profile carries your logins; nothing here opened it.'),
    );
  }
}

/**
 * The section a per-call allow-list cannot produce. Every tool in a chain is ordinary,
 * every one of them passes review on its own, and holding all of them is the path.
 */
function renderCombined(context: CliContext, report: DiscoveryReport): void {
  const { flow } = context;
  const chains = report.combined.filter((each) =>
    each.capabilities.some((capability) => capability.individuallyHarmless),
  );
  if (chains.length === 0) return;

  flow.list(
    'Combined capability, where no single tool does this',
    chains.flatMap(({ agentId, capabilities }) =>
      capabilities
        .filter((capability) => capability.individuallyHarmless)
        .map((capability) => ({
          tone: TONE.WARN,
          text: `${agentId.replace('agt_', '')}: ${capability.consequence}`,
          detail: [describeCombined(capability)],
        })),
    ),
  );
  flow.aside(
    context.style.dim(
      'Each of these tools is ordinary. Holding all of them is the path.',
    ),
  );
}

/** What an agent could open right now, named rather than counted. */
function renderReachable(context: CliContext, report: DiscoveryReport): void {
  const { flow } = context;
  const reachable = report.resources.filter(
    (resource) =>
      resource.sensitivity !== SENSITIVITY.ORDINARY && resource.reachableBy.length > 0,
  );
  if (reachable.length === 0) return;

  const paths = reachable.map((resource) => resource.path ?? resource.id);
  const width = Math.max(...paths.map((path) => path.length));

  flow.list(
    'Reachable from an agent right now',
    reachable.map((resource, at) => {
      const count = resource.reachableBy.length;
      return {
        tone: TONE.WARN,
        text: `${(paths[at] ?? '').padEnd(width)}  ${count} agent${count === 1 ? '' : 's'}`,
        // A database or the network is not a file, so what named it is said plainly.
        detail: [resource.declaredIn],
      };
    }),
  );
}
