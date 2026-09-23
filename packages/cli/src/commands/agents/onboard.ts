/** `memnox agents onboard` and `offboard`: putting an agent under Memnox and taking it out. */
import { readAccount, type Account, type SnapshotAgent } from '@memnox/core';
import type { CliContext } from '../../cli-context';
import {
  OFFBOARD,
  ONBOARD,
  offboardAgent,
  onboardAgent,
  type OnboardResult,
} from '../../agents/onboard';
import {
  displayName,
  readNames,
  workspaceShown,
  type AgentNames,
} from '../../agents/names';
import {
  buildEnrolReporter,
  chooseCloudName,
  quoted,
  renderCandidates,
  renderNotFound,
  renderWhatWillHappen,
  resolveHosted,
  type AgentsDeps,
  type JsonOptions,
} from './shared';

export interface OnboardOptions extends JsonOptions {
  name?: string;
}

type OffboardResult = Awaited<ReturnType<typeof offboardAgent>>;

/** The agent being onboarded, the workspace it goes into, and what it is called now. */
interface OnboardTarget {
  found: SnapshotAgent;
  account: Account;
  names: AgentNames;
}

/** Put one agent under Memnox, or offer the candidates when none was named. */
export async function runOnboard(
  deps: AgentsDeps,
  agent: string | undefined,
  options: OnboardOptions,
): Promise<void> {
  const { context, home } = deps;
  const asJson = options.json === true;
  if (!asJson) context.flow.open('memnox agents onboard');

  const names = await readNames(home());
  if (agent === undefined) {
    await renderCandidates(deps, names, asJson);
    return;
  }
  const account = await readAccount(home());
  if (account === null) {
    renderNoAccount(context, asJson);
    return;
  }
  const found = await resolveHosted(deps, agent);
  if (found === null) {
    renderNotFound(context, agent, asJson);
    return;
  }
  await onboardOne(deps, { found, account, names }, options);
}

/** Names the agent, enrols it, and says what happened. */
async function onboardOne(
  deps: AgentsDeps,
  target: OnboardTarget,
  options: OnboardOptions,
): Promise<void> {
  const { context, home } = deps;
  const { found, account, names } = target;
  const asJson = options.json === true;
  if (!asJson)
    renderWhatWillHappen(context, displayName(names, found), found.kind, account);

  // Asked here rather than only at discovery, because this is the moment the name stops
  // being local: it is sent as the enrolment label and is what the console shows.
  const { name: shown } = await chooseCloudName({
    context,
    home: home(),
    agent: found,
    names,
    account,
    options,
    interactive: deps.interactive(),
    ask: deps.ask,
  });
  const result = await onboardAgent({
    home: home(),
    project: deps.project(),
    account,
    agentId: found.id,
    agentKind: found.kind,
    report: buildEnrolReporter(context.flow),
    shownAs: shown,
  });
  if (asJson) {
    context.out.json({ ...result, name: shown });
    return;
  }
  renderOnboarding(context, shown, account, result);
}

function renderNoAccount(context: CliContext, asJson: boolean): void {
  if (asJson) {
    context.out.json({ outcome: ONBOARD.NO_ACCOUNT });
    return;
  }
  context.flow.close('Not logged in, so there is nothing to onboard into.');
  context.flow.hint('Connect this machine with "memnox login".');
}

/** The card an onboarding leaves behind, or why it did not happen. */
function renderOnboarding(
  context: CliContext,
  shown: string,
  account: Account,
  result: OnboardResult,
): void {
  const { flow, style } = context;
  if (result.outcome !== ONBOARD.DONE || result.record === undefined) {
    flow.close(style.warn(`Did not onboard ${shown}.`));
    flow.hint(result.because ?? 'no reason given');
    flow.hint('Nothing on this machine was changed.');
    process.exitCode = 1;
    return;
  }
  const record = result.record;
  flow.rows(`${shown} is under Memnox`, [
    { label: 'known as', value: `${shown} in ${workspaceShown(account.workspaceId)}` },
    { label: 'product', value: record.product },
    { label: 'config', value: record.configPath },
    { label: 'backup', value: record.backupPath },
    { label: 'machine', value: record.machineId },
    {
      label: 'enrolled',
      value:
        result.approvedInBrowser === true
          ? 'approved in your browser'
          : "on this machine's own credential",
    },
  ]);
  flow.close(style.ok(`${shown} is under Memnox.`));
  // Said plainly, because this is the moment somebody wonders whether it was just
  // given permission to do more.
  flow.hint(
    'Authority is unchanged: what this agent may do is still decided on this machine.',
  );
  flow.hint(`Take it back out with "memnox agents offboard ${quoted(shown)}".`);
}

/** Put one agent's config back and revoke the credential it was given. */
export async function runOffboard(
  deps: AgentsDeps,
  agent: string,
  options: JsonOptions,
): Promise<void> {
  const { context, home } = deps;
  const { flow } = context;
  const asJson = options.json === true;
  if (!asJson) flow.open('memnox agents offboard');

  const account = await readAccount(home());
  if (account === null) {
    if (asJson) context.out.json({ outcome: ONBOARD.NO_ACCOUNT, name: agent });
    else flow.close('Not logged in, so nothing here was onboarded.');
    return;
  }
  const names = await readNames(home());
  const found = await resolveHosted(deps, agent);
  const agentId = found === null ? agent : found.id;
  const shown = found === null ? agent : displayName(names, found);

  const result = await offboardAgent(home(), account, agentId);
  if (asJson) {
    context.out.json({ ...result, name: shown });
    return;
  }
  renderOffboarding(context, shown, result);
}

function renderOffboarding(
  context: CliContext,
  shown: string,
  result: OffboardResult,
): void {
  const { flow, style } = context;
  if (result.outcome === OFFBOARD.NOT_ONBOARDED) {
    flow.close(result.because ?? `${shown} is not onboarded.`);
    return;
  }
  if (result.outcome === OFFBOARD.FAILED) {
    flow.close(style.warn(`Could not fully offboard ${shown}.`));
    flow.hint(result.because ?? 'no reason given');
    process.exitCode = 1;
    return;
  }
  flow.rows(`${shown} is out`, [
    {
      label: 'config',
      value:
        result.restoredFromBackup === true
          ? `restored from ${result.record?.backupPath ?? 'its backup'}`
          : 'no backup was found, so only the Memnox entry was removed',
    },
    {
      label: 'credential',
      value:
        result.revoked === true
          ? 'revoked'
          : style.warn('could not be revoked; revoke the machine in the console'),
    },
  ]);
  flow.close(style.ok(`${shown} is back to its own config.`));
}
