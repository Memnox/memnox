/** Getting this run an account, including the move when it was pointed somewhere else. */
import { readAccount, type Account } from '@memnox/core';
import { describeCount } from '../../plural';
import { sameControlPlane } from '../../sync/client';
import { OFFBOARD } from '../../agents/onboard';
import { listRecords, onboardedInto, type OnboardRecord } from '../../agents/onboarding';
import { forgetNames, workspaceShown } from '../../agents/names';
import { forgetDeclined } from '../../agents/declined';
import type { SetupDeps, SetupOptions } from '../setup.command';

/** The run's collaborators and the flags it was started with. */
interface PlaneInput {
  deps: SetupDeps;
  options: SetupOptions;
}

/** Said wherever this run connects, because it is the promise the rest of it keeps. */
const ONLY_APPROVAL = 'That is the only approval this run needs.';

/**
 * The account this machine already has, or null, because setup governs the machine on
 * its own and never makes the first network call. Only an explicit `--url` connects here,
 * so a console command written before this still works; `memnox login` is the usual door.
 */
export async function connectedAccount(input: PlaneInput): Promise<Account | null> {
  const { deps, options } = input;
  const { context } = deps;
  const existing = await readAccount(deps.home());
  if (existing === null) {
    if (options.url === undefined) return null;
    const account = await connect(input, options.url);
    context.flow.aside(context.style.dim(ONLY_APPROVAL));
    return account;
  }
  // No `--url` means the plane it is already on, so a self-hosted login is never undone.
  if (options.url === undefined || sameControlPlane(existing.baseUrl, options.url)) {
    context.flow.step(
      'Already connected',
      `${existing.workspaceId} at ${existing.baseUrl}`,
    );
    return existing;
  }
  return moveOrStay(input, existing, options.url);
}

/** Runs the device flow, naming the machine on the same rail and asker the agents use. */
async function connect(input: PlaneInput, url: string): Promise<Account> {
  const { deps, options } = input;
  const { context } = deps;
  const connected = await deps.connect(
    context,
    deps.home(),
    { ...options, url },
    {
      askName: deps.ask,
      interactive: deps.interactive,
      ...deps.connectSeams,
    },
  );
  return connected.account;
}

/**
 * Enrolled somewhere other than this run was pointed at. Asked, defaulting to no, because
 * a mistyped Enter must not take a laptop off the plane governing it; with nobody to ask,
 * the existing enrolment wins and the command that moves it is named.
 */
async function moveOrStay(
  input: PlaneInput,
  existing: Account,
  url: string,
): Promise<Account> {
  const { deps } = input;
  const { flow } = deps.context;
  flow.step(
    'Connected to a different control plane',
    `${existing.workspaceId} at ${existing.baseUrl}`,
  );
  flow.aside(`This run was pointed at ${url}.`);

  if (!deps.interactive()) {
    flow.aside(`Staying on ${existing.baseUrl}, because nobody can be asked.`);
    flow.hint(`Move it with "memnox login --url ${url}".`);
    return existing;
  }
  const move = await deps
    .confirm(`${flow.prompt}Move this machine to ${url}?`, false)
    .catch(() => false);
  if (!move) {
    flow.aside(`Staying on ${existing.baseUrl}.`);
    return existing;
  }
  return moveTo(input, existing, url);
}

/**
 * Hands the agents back before the new credential is minted, because revoking one takes
 * the account that sponsored it and enrolling first would replace that account.
 */
async function moveTo(
  input: PlaneInput,
  existing: Account,
  url: string,
): Promise<Account> {
  const { context } = input.deps;
  const handed = await handBack(input.deps, existing);
  try {
    const account = await connect(input, url);
    await forgetVocabulary(input.deps);
    context.flow.aside(context.style.dim(ONLY_APPROVAL));
    return account;
  } catch (err) {
    // Said rather than left to a stack trace: the agents handed back are ungoverned,
    // the old credential still stands, and running this again is the whole recovery.
    if (handed > 0) {
      context.flow.aside(
        context.style.warn(
          `${describeCount(handed, 'agent is', 'agents are')} back to their own configs and are not under Memnox. Run this again to finish the move.`,
        ),
      );
    }
    context.flow.aside(`This machine is still enrolled in ${existing.workspaceId}.`);
    throw err;
  }
}

/**
 * Every agent the plane being left was holding, handed back to it, so onboarding here
 * backs up a config pointing at nothing of ours. A revocation the old plane did not
 * answer is named rather than treated as done.
 */
async function handBack(deps: SetupDeps, leaving: Account): Promise<number> {
  const home = deps.home();
  const held = (await listRecords(home)).filter((record) =>
    onboardedInto(record, leaving),
  );
  if (held.length === 0) return 0;

  deps.context.flow.step(
    `Handing ${describeCount(held.length, 'agent')} back to ${workspaceShown(leaving.workspaceId)}`,
  );
  let handed = 0;
  for (const record of held) {
    if (await handBackOne(deps, leaving, record)) handed += 1;
  }
  return handed;
}

/** One agent handed back, and whether the plane being left confirmed it. */
async function handBackOne(
  deps: SetupDeps,
  leaving: Account,
  record: OnboardRecord,
): Promise<boolean> {
  const { flow, style } = deps.context;
  const result = await deps
    .offboard(deps.home(), leaving, record.agentId)
    .catch(() => null);
  if (result === null || result.outcome !== OFFBOARD.DONE) {
    flow.aside(
      style.warn(
        `${record.product} could not be handed back: ${result?.because ?? 'the attempt failed'}`,
      ),
    );
    return false;
  }
  flow.aside(
    result.revoked === true
      ? `${record.product} is back to its own config, and its credential is revoked.`
      : style.warn(
          `${record.product} is back to its own config. ${workspaceShown(leaving.workspaceId)} did not answer, so revoke ${record.machineId} there.`,
        ),
  );
  return true;
}

/**
 * The names and answers the plane that was left was holding, forgotten, since both are
 * about a workspace. Only once the new credential is in hand: a failed move should keep
 * what it knew.
 */
async function forgetVocabulary(deps: SetupDeps): Promise<void> {
  const home = deps.home();
  const names = await forgetNames(home).catch(() => 0);
  const declined = await forgetDeclined(home).catch(() => 0);
  if (names === 0 && declined === 0) return;
  deps.context.flow.aside(
    deps.context.style.dim(
      'Agent names and answers here were for the workspace you left, so this asks again.',
    ),
  );
}
