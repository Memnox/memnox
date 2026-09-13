import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  chainsFor,
  CHECK,
  checkInstallation,
  discover,
  lastProbed,
  MEMNOX_HOME,
  NodeFindingsStore,
  type FindingsStore,
  NodeMachineReader,
  NodeSnapshotStore,
  rankAgents,
  RISK_LEVEL,
  runDoctor,
  PolicyEngine,
  DECISION_EFFECT,
  type GovernedBy,
  summarizeHealth,
  withToolsFrom,
  type AgentStanding,
  type Finding,
  type HealthCheck,
  type MachineReader,
  type SnapshotStore,
} from '@memnox/core';
import { policySetInForce } from '../policy-path';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { gatherHealth } from '../health-probe';
import { proveEnforcement, type ProbeContext } from '../verify/enforcement';
import { renderEnforcement } from '../verify/enforcement-report';
import type { SeamProof } from '@memnox/core';

const SEVERITY_WIDTH = 10;

/**
 * Each finding names the agent, the resource, the evidence and the one change that
 * closes it. No estimated loss, ever, and no rank against anybody else's machine.
 */
export function registerDoctorCommand(
  program: Command,
  context: CliContext,
  buildReader: () => MachineReader = () => new NodeMachineReader(homedir()),
  cwd: () => string = () => process.cwd(),
  buildSnapshots: () => SnapshotStore = () =>
    new NodeSnapshotStore(join(homedir(), MEMNOX_HOME)),
  buildFindings: () => FindingsStore = () =>
    new NodeFindingsStore(join(homedir(), MEMNOX_HOME)),
  probe: (ctx: ProbeContext) => Promise<SeamProof[]> = proveEnforcement,
): void {
  program
    .command('doctor')
    .description(
      'What on this machine is risky, why, and the one change that closes each',
    )
    .option('--json', 'emit the findings as JSON')
    .option(
      '--wiring',
      'whether Memnox is actually gating anything, rather than only installed',
    )
    .option(
      '--by-agent',
      'the same findings per agent on this machine, never a rating of the products',
    )
    .option(
      '--prove',
      'ask every seam to refuse something, and report what actually came back',
    )
    .action(
      async (options: {
        json?: boolean;
        byAgent?: boolean;
        wiring?: boolean;
        prove?: boolean;
      }) => {
        const { flow, style } = context;
        if (options.json !== true) flow.open('memnox doctor');

        /* Before --wiring, because somebody who passed both wants the stronger
         answer: what was configured matters less than what happened. */
        if (options.prove === true) {
          await renderEnforcement(context, await probe({ home: homedir(), dir: cwd() }));
          return;
        }
        if (options.wiring === true) {
          const checks = checkInstallation(await gatherHealth(homedir(), cwd()));
          if (options.json === true) {
            context.out.json({ ...summarizeHealth(checks), checks });
            return;
          }
          renderWiring(context, checks);
          return;
        }
        const reader: MachineReader = buildReader();
        // The same ground `memnox` covers: a finding it showed and doctor cannot
        // rank is a credential the reader was told about and never offered a fix for.
        const discovered = await discover(reader, {
          now: new Date().toISOString(),
          projectDirs: [cwd()],
        });
        /* Doctor never starts an MCP server, so the tools come from the last scan that
         did. Without them every tool-shaped finding here is unreachable however true
         it is, and the reader is told about a credential with no fix beside it. */
        const surfaces = withToolsFrom(
          discovered.surfaces,
          lastProbed(await buildSnapshots().history()),
        );
        /* What the rules already close, asked of the engine rather than decided
           here: a rule may name a directory and cover a key it never mentions,
           and a second matcher would drift from the one the gate uses. */
        const report = runDoctor({
          resources: discovered.resources,
          reachability: discovered.reachability,
          surfaces,
          governedBy: await deniesReadsOf(homedir()),
          // From the hydrated surfaces, not the unprobed scan, or this is always empty.
          chains: chainsFor(
            discovered.agents.map((agent) => agent.id),
            surfaces,
          ),
        });

        /* Kept so the sync pass can send it. Printing was the whole of what this
         command did with a finding, which left the fleet page empty on every
         deployment while every laptop knew exactly what was wrong with it.

         Best effort: a machine that cannot write this still shows its report.
         The scan is what the reader asked for; reporting it onward is not. */
        try {
          await buildFindings().keep({
            takenAt: new Date().toISOString(),
            findings: report.findings,
          });
        } catch (err) {
          flow.aside(style.dim(`findings not kept for sync: ${String(err)}`));
        }

        const standings = rankAgents(report.findings, surfaces);

        if (options.json === true) {
          context.out.json({ ...report, agents: standings });
          return;
        }

        if (options.byAgent === true) {
          renderByAgent(context, standings);
          return;
        }
        if (report.findings.length === 0) {
          flow.close('Nothing on this machine is reachable that should not be.');
          return;
        }

        flow.list(
          'What is reachable that should not be',
          report.findings.map((finding) => ({
            tone: finding.severity === RISK_LEVEL.LOW ? TONE.DIM : TONE.WARN,
            text: `${severity(style, finding)}${finding.title}`,
            detail: [
              /* Skipped when it is the path the title just gave: a resource with
                 nothing else naming it carries itself as its own evidence, and
                 printing it twice reads as two facts about one file. */
              finding.title.includes(finding.evidence) ? undefined : finding.evidence,
              finding.remediation === undefined
                ? undefined
                : `fix: ${finding.remediation.description}`,
            ],
          })),
        );

        // Counts, never a total: a number nobody can argue with is a number nobody acts on.
        const { counts } = report;
        flow.close(
          `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low.`,
        );
        flow.hint('Nothing here compares this machine to another.');
        if (report.findings.some((finding) => finding.remediation !== undefined)) {
          flow.hint('Close what has a change behind it with "memnox protect".');
        }
      },
    );
}

/**
 * Five agents installed on five different days, put side by side. Ranked by what is
 * configured here — never a safety rating of the products, which would be a claim
 * about software nobody tested.
 */
function renderByAgent(context: CliContext, standings: readonly AgentStanding[]): void {
  const { flow } = context;

  if (standings.length === 0) {
    flow.close('No agent on this machine has a finding against it.');
    return;
  }

  flow.list(
    'On this machine',
    standings.map((standing) => ({
      tone: standing.findings === 0 ? TONE.DIM : TONE.WARN,
      text: `${standing.agentId.replace('agt_', '')}  ${standing.findings} finding${standing.findings === 1 ? '' : 's'}`,
      detail: [
        standing.externalWriteTools > 0
          ? `${standing.externalWriteTools} tool(s) change external state`
          : undefined,
        standing.surfaces.length === 0 ? undefined : standing.surfaces.join(' · '),
      ],
    })),
  );
  flow.close(`${standings.length} agent(s) with something against them.`);
  flow.hint(
    'Ranked by what is configured here, not by the product. This is never a safety',
  );
  flow.hint('rating of software nobody in this room has tested.');
}

/* Padded before it is styled: an escape sequence has a width nobody can see and
   `padEnd` can, so colouring first left every title flush against its severity. */
function severity(style: CliContext['style'], finding: Finding): string {
  return style.risk(
    finding.severity,
    finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH),
  );
}

const CHECK_WIDTH = 14;

/**
 * Installed and governing nothing is the state this exists to catch. Every line says
 * what is true, and every line that is not "ok" says the command that changes it.
 */
function renderWiring(context: CliContext, checks: readonly HealthCheck[]): void {
  const { flow, style } = context;
  const { state, headline } = summarizeHealth(checks);

  flow.list(
    'What is actually gating',
    checks.map((check) => ({
      tone:
        check.state === CHECK.OK
          ? TONE.OK
          : check.state === CHECK.INERT
            ? TONE.DIM
            : TONE.WARN,
      text: `${check.name.padEnd(CHECK_WIDTH)}${check.detail}`,
      detail: [
        check.fix === undefined || check.state === CHECK.OK
          ? undefined
          : `→ ${check.fix}`,
      ],
    })),
  );
  flow.close(state === CHECK.OK ? style.ok(headline) : style.warn(headline));
  if (state !== CHECK.OK) {
    flow.hint(
      'Installed and governing nothing is the state this command exists to catch.',
    );
  }
}

/**
 * Whether a rule in force already denies reading a path, and which rule does.
 *
 * The whole reason `memnox doctor` can now say "you have closed this": before it,
 * applying every fix the doctor proposed changed nothing about what the doctor
 * said next, so the reader had no way to tell a closed finding from an open one.
 *
 * A machine with no rules yet answers nothing for every path, which is correct
 * rather than a failure: nothing is governed because nothing has been written.
 * A rule set that will not load answers nothing too, and the finding stays at its
 * full severity, which is the direction to be wrong in.
 */
async function deniesReadsOf(home: string): Promise<GovernedBy> {
  let engine: PolicyEngine;
  try {
    const set = await policySetInForce(home);
    engine = new PolicyEngine(set.policies);
  } catch {
    // Unreadable rules are reported by `doctor --wiring`; here they mean ungoverned.
    return () => undefined;
  }
  return (path: string): string | undefined => {
    const verdict = engine.evaluate(
      { action: FILESYSTEM_READ, target: path },
      { agentName: ANY_AGENT },
    );
    if (verdict.effect !== DECISION_EFFECT.DENY) return undefined;
    return verdict.rule?.name ?? verdict.matchedPolicies[0]?.name;
  };
}

/* The action a credential finding is about, spelled the way `denyReadStep` writes
   it, so the question asked here is the one the rule answers. */
const FILESYSTEM_READ = 'filesystem.read';
/* Asked for no agent in particular: the finding is that *any* of them can read it,
   and a rule naming one agent does not close it for the rest. */
const ANY_AGENT = 'any-agent';
