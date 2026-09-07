import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  BAND,
  LocalGate,
  actionsForCli,
  blastRadiusOf,
  boundaryFor,
  type Policy,
  rolesIn,
  standingFor,
  type CandidateAction,
  inBand,
  interceptedBinaries,
  readyToEnable,
  type BlastRadius,
  type Boundary,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { policySetInForce, resolvePolicyFile, sayWhatDidNotLoad } from '../policy-path';

/**
 * Can I leave this running?
 *
 * The boundary is rendered by asking the engine action by action, so what is on screen
 * is what will actually happen rather than a description of what the rules intend. A
 * screen that summarised the policy would be the one place a person trusts most and
 * the one most likely to be subtly wrong.
 */
export function registerAutopilotCommand(program: Command, context: CliContext): void {
  program
    .command('autopilot [agent]')
    .description('What an agent would do on its own, and what would still be asked')
    .option('-f, --file <path>', 'policy file (default: whichever exists)')
    .option('--role <name>', 'show the boundary of a job rather than of a product')
    .option('--roles', 'every job the rules name, and what each may do')
    .option('--json', 'machine-readable output')
    .action(
      async (
        agent: string | undefined,
        options: { file?: string; json?: boolean; role?: string; roles?: boolean },
      ) => {
        /* Every file in force, not this directory's: a registered checkout's rules
           govern this machine whichever directory the reader is standing in, and one
           that will not load must not take the boundary down with it. */
        const rules = await policySetInForce(homedir(), options.file);
        if (rules.policies.length === 0) {
          throw new Error(
            `No rules at ${resolvePolicyFile(options.file)}, so there is no boundary to show. Write one:  memnox protect --yes`,
          );
        }
        sayWhatDidNotLoad(context, rules);

        const candidatesFor = (): CandidateAction[] =>
          interceptedBinaries().flatMap((binary) => actionsForCli(binary));

        if (options.roles === true) {
          await renderWorkforce(
            context,
            rules.policies,
            candidatesFor(),
            options.json === true,
          );
          return;
        }

        const name = agent ?? 'claude-code';
        const gate = new LocalGate(rules.policies, {
          agentName: name,
          /* Evaluated as the job, so a `roles:` rule fires. Without this the screen
             would show what the product may do and call it what the role may do. */
          ...(options.role === undefined ? {} : { agentRole: options.role }),
        });
        const candidates = candidatesFor();

        const boundary = boundaryFor(options.role ?? name, candidates, (action) => {
          const verdict = gate.evaluate({ action });
          return {
            effect: verdict.effect,
            reason: verdict.reason,
            matched: verdict.matchedPolicies.length > 0,
          };
        });
        const radius = blastRadiusOf(boundary, credentialsIn(boundary));

        if (options.json === true) {
          context.out.json({
            boundary,
            radius,
            ready: readyToEnable(radius),
            ...(options.role === undefined ? {} : { role: options.role }),
          });
          return;
        }
        render(context, boundary, radius, options.role);
      },
    );
}

/** Named from the rules that fired, so nothing here opens a credential to list it. */
function credentialsIn(boundary: Boundary): string[] {
  return [
    ...new Set(
      boundary.entries
        .filter((entry) => entry.band !== BAND.AUTOMATIC)
        .map((entry) => entry.action.split('.')[0] ?? '')
        .filter((each) => each !== ''),
    ),
  ];
}

function render(
  context: CliContext,
  boundary: Boundary,
  radius: BlastRadius,
  role?: string,
): void {
  const { out, style } = context;

  out.line('');
  out.line(
    style.bold(
      role === undefined
        ? `${boundary.agent.toUpperCase()} AUTOPILOT`
        : `${role.toUpperCase()} — WHAT THIS JOB MAY DO`,
    ),
  );
  /* A role outlives the product holding it: a rule about "deployer" keeps holding when
     the team swaps Claude Code for Codex, which a rule about an agent cannot. */
  if (role !== undefined) {
    out.line(style.dim('  a job, not a product — whichever agent is enrolled under it'));
  }

  band(context, 'Runs on its own', inBand(boundary, BAND.AUTOMATIC), style.ok('+'));
  band(context, 'Waits for you', inBand(boundary, BAND.NEEDS_APPROVAL), style.warn('?'));
  band(context, 'Never', inBand(boundary, BAND.NEVER), style.warn('x'));

  if (boundary.ungoverned.length > 0) {
    out.line('');
    out.line(
      style.bold('NO RULE AT ALL') +
        style.dim(`  ${boundary.ungoverned.length} capabilities`),
    );
    out.line('');
    for (const action of boundary.ungoverned.slice(0, 8)) {
      out.line(`  ${style.dim(action)}`);
    }
    if (boundary.ungoverned.length > 8) {
      out.line(`  ${style.dim(`and ${boundary.ungoverned.length - 8} more`)}`);
    }
    /* Not filed under "runs on its own": an unruled capability is not a permitted one,
       and putting it in the allowed band would be the screen telling a comfortable lie. */
    out.note('These are not allowed or refused. Nothing has an opinion about them yet.');
  }

  const ready = readyToEnable(radius);
  out.line('');
  out.line(style.bold('IF THIS RUNS UNATTENDED'));
  out.line(
    `  ${radius.automatic} run on their own, ${radius.needsApproval} wait for you, ${radius.never} never run.`,
  );
  out.line(`  ${radius.ungoverned} have no rule.`);
  out.line('');
  out.line(
    ready.ready
      ? style.ok(`  Ready: ${ready.because}`)
      : style.warn(`  Not ready: ${ready.because}`),
  );
  if (!ready.ready) {
    out.note(
      '"memnox protect --yes" writes a baseline that closes the destructive ones.',
    );
  }
}

function band(
  context: CliContext,
  title: string,
  entries: readonly { action: string; because: string }[],
  mark: string,
): void {
  if (entries.length === 0) return;
  context.out.line('');
  context.out.line(context.style.bold(title.toUpperCase()));
  context.out.line('');
  for (const entry of entries.slice(0, 12)) {
    context.out.line(`  ${mark}  ${entry.action}`);
  }
  if (entries.length > 12) {
    context.out.line(`  ${context.style.dim(`and ${entries.length - 12} more`)}`);
  }
}

/**
 * Every job the rules name, and what each may do.
 *
 * The question a workforce raises is not "what may this binary do" but "who is allowed
 * to do what", and the answer has to come from asking the engine once per role rather
 * than from reading the rule file — a table that summarised the rules would be the one
 * screen people trust most and the one most likely to be subtly wrong.
 */
async function renderWorkforce(
  context: CliContext,
  policies: readonly Policy[],
  candidates: CandidateAction[],
  asJson: boolean,
): Promise<void> {
  const roles = rolesIn([...policies]);
  const { out, style } = context;

  if (roles.length === 0) {
    out.line('No rule here names a job, so there is no workforce to show.');
    out.note(
      'Add `roles: ["deployer"]` to a rule, then run an agent with --role deployer.',
    );
    return;
  }

  const standings = [];
  for (const role of roles) {
    const gate = new LocalGate([...policies], { agentName: role, agentRole: role });
    const boundary = boundaryFor(role, candidates, (action) => {
      const verdict = gate.evaluate({ action });
      return {
        effect: verdict.effect,
        reason: verdict.reason,
        matched: verdict.matchedPolicies.length > 0,
      };
    });
    standings.push(standingFor(role, boundary));
  }

  if (asJson) {
    context.out.json({ roles: standings });
    return;
  }

  out.line('');
  out.line(style.bold('THE JOBS THESE RULES NAME'));
  out.line('');
  const width = Math.max(...standings.map((each) => each.role.length)) + 2;
  for (const standing of standings) {
    out.line(
      `  ${standing.role.padEnd(width)}` +
        `${style.ok(String(standing.automatic).padStart(3))} on its own  ` +
        `${style.warn(String(standing.needsApproval).padStart(3))} asked  ` +
        `${style.warn(String(standing.never).padStart(3))} never`,
    );
  }
  out.line('');
  out.line(`  ${style.dim('memnox autopilot --role <name>')}   what one of them may do`);
  out.line('');
}
