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
import { TONE, type Tone } from '../flow';
import {
  policySetInForce,
  resolvePolicyFile,
  renderWhatDidNotLoad,
} from '../policy-path';

/**
 * Whether an agent can be left running, rendered by asking the engine action by action.
 * Reached through `memnox next --agent`: `next` reads the ledger backwards for what was
 * approved, and this reads the rules forwards for what would happen.
 */

export interface BoundaryOptions {
  agent?: string;
  file?: string;
  json?: boolean;
  role?: string;
  roles?: boolean;
}

/** Enough of a band to recognise it, and never enough to scroll. */
const BAND_SHOWN = 12;

const DEFAULT_AGENT = 'claude-code';

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
  // Every file in force rather than this directory's, and one that will not load stays out.
  const rules = await policySetInForce(homedir(), options.file);
  if (rules.policies.length === 0) {
    throw new Error(
      `No rules at ${resolvePolicyFile(options.file)}, so there is no boundary to show. Write one:  memnox protect --yes`,
    );
  }
  renderWhatDidNotLoad(context, rules);

  const candidates = interceptedBinaries().flatMap((binary) => actionsForCli(binary));
  if (options.roles === true) {
    await renderWorkforce(context, rules.policies, candidates, options.json === true);
    return;
  }
  renderAgentBoundary(context, { policies: rules.policies, candidates, options });
}

interface AgentBoundaryInput {
  policies: readonly Policy[];
  candidates: readonly CandidateAction[];
  options: BoundaryOptions;
}

function renderAgentBoundary(context: CliContext, input: AgentBoundaryInput): void {
  const { role, json } = input.options;
  const name = input.options.agent ?? DEFAULT_AGENT;
  // Evaluated as the job, so a `roles:` rule fires rather than the product's own rules.
  const gate = new LocalGate([...input.policies], {
    agentName: name,
    ...(role === undefined ? {} : { agentRole: role }),
  });
  const boundary = boundaryThrough(gate, role ?? name, input.candidates);
  const radius = blastRadiusOf(boundary, credentialsIn(boundary));

  if (json === true) {
    context.out.json({
      boundary,
      radius,
      ready: readyToEnable(radius),
      ...(role === undefined ? {} : { role }),
    });
    return;
  }
  render(context, boundary, radius, role);
}

/** Every candidate asked of the engine, so the screen is what will happen. */
function boundaryThrough(
  gate: LocalGate,
  subject: string,
  candidates: readonly CandidateAction[],
): Boundary {
  return boundaryFor(subject, candidates, (action, toolClass) => {
    const verdict = gate.evaluate({ action, toolClass });
    return {
      effect: verdict.effect,
      reason: verdict.reason,
      matched: verdict.matchedPolicies.length > 0,
    };
  });
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
  renderBand(context, 'Runs on its own', inBand(boundary, BAND.AUTOMATIC), TONE.OK);
  renderBand(context, 'Waits for you', inBand(boundary, BAND.NEEDS_APPROVAL), TONE.WARN);
  renderBand(context, 'Never', inBand(boundary, BAND.NEVER), TONE.WARN);
  renderUngoverned(context, boundary.ungoverned);
  renderRadius(context, radius, role);

  const ready = readyToEnable(radius);
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

/** Not filed under "runs on its own": an unruled capability is not a permitted one. */
function renderUngoverned(context: CliContext, ungoverned: readonly string[]): void {
  if (ungoverned.length === 0) return;
  context.flow.list(`No rule at all, ${ungoverned.length} capabilities`, [
    ...ungoverned
      .slice(0, BAND_SHOWN)
      .map((action) => ({ tone: TONE.DIM, text: action })),
    ...moreThanShown(ungoverned.length),
  ]);
  context.flow.aside(
    context.style.dim(
      'These are not allowed or refused. Nothing has an opinion about them yet.',
    ),
  );
}

function renderRadius(context: CliContext, radius: BlastRadius, role?: string): void {
  context.flow.rows('If this runs unattended', [
    { label: 'on its own', value: String(radius.automatic) },
    { label: 'waits', value: String(radius.needsApproval) },
    { label: 'never', value: String(radius.never) },
    { label: 'no rule', value: String(radius.ungoverned) },
    // A role outlives the product holding it, so a rule about a job survives a swap.
    ...(role === undefined
      ? []
      : [
          {
            label: 'a job',
            value: 'not a product, so whichever agent is enrolled under it',
          },
        ]),
  ]);
}

/** The line that says a band was cut short, or nothing when all of it fit. */
function moreThanShown(total: number): { tone: Tone; text: string }[] {
  if (total <= BAND_SHOWN) return [];
  return [{ tone: TONE.DIM, text: `and ${total - BAND_SHOWN} more` }];
}

function renderBand(
  context: CliContext,
  title: string,
  entries: readonly { action: string; because: string }[],
  tone: Tone,
): void {
  if (entries.length === 0) return;
  context.flow.list(`${title}, ${entries.length}`, [
    ...entries.slice(0, BAND_SHOWN).map((entry) => ({ tone, text: entry.action })),
    ...moreThanShown(entries.length),
  ]);
}

/** Every job the rules name, and what each may do, asked of the engine once per role. */
async function renderWorkforce(
  context: CliContext,
  policies: readonly Policy[],
  candidates: readonly CandidateAction[],
  asJson: boolean,
): Promise<void> {
  const { flow } = context;
  const roles = rolesIn([...policies]);
  if (roles.length === 0) {
    flow.close('No rule here names a job, so there is no workforce to show.');
    flow.hint(
      'Add `roles: ["deployer"]` to a rule, then run an agent with --role deployer.',
    );
    return;
  }

  const standings = roles.map((role) => {
    const gate = new LocalGate([...policies], { agentName: role, agentRole: role });
    return standingFor(role, boundaryThrough(gate, role, candidates));
  });
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
