import { homedir } from 'node:os';
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
import { TONE } from '../flow';
import { policySetInForce, resolvePolicyFile, sayWhatDidNotLoad } from '../policy-path';

/**
 * Can I leave this running?
 *
 * The boundary is rendered by asking the engine action by action, so what is on screen
 * is what will actually happen rather than a description of what the rules intend. A
 * screen that summarised the policy would be the one place a person trusts most and
 * the one most likely to be subtly wrong.
 *
 * Reached through `memnox next --agent`, because it answers the same question the
 * primary screen does from the other side: `next` reads the ledger for what a person
 * has already approved often enough to hand over, and this reads the rules for what
 * would happen if they did. Two commands for one decision was one of them going
 * unrun.
 */

export interface BoundaryOptions {
  agent?: string;
  file?: string;
  json?: boolean;
  role?: string;
  roles?: boolean;
}

/** True when the flags asked what an agent may do rather than what to hand over next. */
export function wantsBoundary(options: BoundaryOptions): boolean {
  return (
    options.agent !== undefined || options.role !== undefined || options.roles === true
  );
}

export async function renderBoundary(
  context: CliContext,
  options: BoundaryOptions,
): Promise<void> {
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

  const name = options.agent ?? 'claude-code';
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
  const { flow, style } = context;

  band(context, 'Runs on its own', inBand(boundary, BAND.AUTOMATIC), TONE.OK);
  band(context, 'Waits for you', inBand(boundary, BAND.NEEDS_APPROVAL), TONE.WARN);
  band(context, 'Never', inBand(boundary, BAND.NEVER), TONE.WARN);

  if (boundary.ungoverned.length > 0) {
    /* Not filed under "runs on its own": an unruled capability is not a permitted
       one, and putting it in the allowed band would be the screen telling a
       comfortable lie. */
    flow.list(`No rule at all, ${boundary.ungoverned.length} capabilities`, [
      ...boundary.ungoverned.slice(0, BAND_SHOWN).map((action) => ({
        tone: TONE.DIM,
        text: action,
      })),
      ...(boundary.ungoverned.length > BAND_SHOWN
        ? [
            {
              tone: TONE.DIM,
              text: `and ${boundary.ungoverned.length - BAND_SHOWN} more`,
            },
          ]
        : []),
    ]);
    flow.aside(
      style.dim(
        'These are not allowed or refused. Nothing has an opinion about them yet.',
      ),
    );
  }

  const ready = readyToEnable(radius);
  flow.rows('If this runs unattended', [
    { label: 'on its own', value: String(radius.automatic) },
    { label: 'waits', value: String(radius.needsApproval) },
    { label: 'never', value: String(radius.never) },
    { label: 'no rule', value: String(radius.ungoverned) },
    /* A role outlives the product holding it: a rule about "deployer" keeps
       holding when the team swaps Claude Code for Codex, which a rule about an
       agent cannot. */
    ...(role === undefined
      ? []
      : [
          {
            label: 'a job',
            value: 'not a product, so whichever agent is enrolled under it',
          },
        ]),
  ]);
  flow.close(
    ready.ready
      ? style.ok(`Ready: ${ready.because}`)
      : style.warn(`Not ready: ${ready.because}`),
  );
  if (!ready.ready) {
    flow.hint(
      '"memnox protect --yes" writes a baseline that closes the destructive ones.',
    );
  }
}

/** Enough of a band to recognise it, and never enough to scroll. */
const BAND_SHOWN = 12;

function band(
  context: CliContext,
  title: string,
  entries: readonly { action: string; because: string }[],
  tone: (typeof TONE)[keyof typeof TONE],
): void {
  if (entries.length === 0) return;
  context.flow.list(`${title}, ${entries.length}`, [
    ...entries.slice(0, BAND_SHOWN).map((entry) => ({ tone, text: entry.action })),
    ...(entries.length > BAND_SHOWN
      ? [{ tone: TONE.DIM, text: `and ${entries.length - BAND_SHOWN} more` }]
      : []),
  ]);
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
  const { flow } = context;

  if (roles.length === 0) {
    flow.close('No rule here names a job, so there is no workforce to show.');
    flow.hint(
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

  flow.table(
    'The jobs these rules name',
    ['Job', 'On its own', 'Asked', 'Never'],
    standings.map((standing) => [
      standing.role,
      String(standing.automatic),
      String(standing.needsApproval),
      String(standing.never),
    ]),
  );
  flow.close(`${standings.length} job(s) named by these rules.`);
  flow.hint('memnox next --role <name>   what one of them may do');
}
