/** Every agent that was offered, and what became of it. */
import type { Account } from '@memnox/core';
import type { CliContext } from '../../cli-context';
import { describeCount } from '../../plural';
import { WIRED, type Wiring } from '../../setup-wiring';
import { workspaceShown } from '../../agents/names';

/** What became of one agent, one row each, including the ones nothing happened to. */
export const STATUS = {
  ONBOARDED: 'onboarded',
  SKIPPED: 'skipped',
  ALREADY: 'already',
  /** Onboarded into a control plane that is not the one this run is pointed at. */
  ELSEWHERE: 'elsewhere',
  CANNOT: 'cannot',
  FAILED: 'failed',
} as const;

export interface Result {
  name: string;
  status: (typeof STATUS)[keyof typeof STATUS];
  because?: string;
}

/** Everything the closing screen reports on. */
interface SetupOutcome {
  account: Account;
  results: readonly Result[];
  reported: boolean;
  wired: Wiring;
}

/** One row per agent offered, because a summary of successes alone overstates what is governed. */
export function renderSummary(context: CliContext, outcome: SetupOutcome): void {
  const { flow, style } = context;
  const { results } = outcome;
  const done = results.filter((each) => each.status === STATUS.ONBOARDED);

  flow.table(
    `In ${workspaceShown(outcome.account.workspaceId)}`,
    ['Agent', 'Status', 'Reason'],
    // Coloured, never padded here: `Flow.table` pads, and an escape sequence has a width.
    results.map((each) => [
      each.name,
      mark(context, each.status),
      style.dim(each.because ?? ''),
    ]),
  );
  flow.close(
    done.length === 0
      ? 'Nothing was onboarded, and nothing on this machine changed.'
      : style.ok(`${describeCount(done.length, 'agent is', 'agents are')} under Memnox.`),
  );
  renderLeftBehind(context, results);
  if (done.length === 0) return;
  renderWhatIsInPlace(context, outcome);
}

/** The agents this run could not take on, and the command that says why. */
function renderLeftBehind(context: CliContext, results: readonly Result[]): void {
  const elsewhere = results.filter((each) => each.status === STATUS.ELSEWHERE);
  if (elsewhere.length > 0) {
    context.flow.hint(
      `${elsewhere.length} belong to another workspace. Hand one back with "memnox agents offboard <name>", then run this again.`,
    );
  }
  const stuck = results.filter((each) => each.status === STATUS.CANNOT);
  if (stuck.length > 0) {
    context.flow.hint(
      `${stuck.length} could not be managed from here. "memnox agents status <name>" says what was found.`,
    );
  }
}

/** What now stands between these agents and the machine, counted rather than claimed. */
function renderWhatIsInPlace(context: CliContext, outcome: SetupOutcome): void {
  const { flow } = context;
  const { wired } = outcome;
  // The console learns of an onboarded agent through the scan, so a run that sent none says so.
  if (!outcome.reported) {
    flow.hint(
      'This scan did not reach the control plane, so the Agents page will fill on the next sync.',
    );
  }
  flow.hint('Authority is unchanged: what each may do is still decided on this machine.');
  // With no wrapper in the path of anything, every rule is a rule about nothing.
  if (wired.interceptors === 0) {
    flow.hint(
      'No interceptors are installed, so nothing is gated yet. "memnox protect --interceptors" fixes it.',
    );
  } else {
    flow.hint(
      `${wired.interceptors} interceptors and ${wired.rules} rules are in place. They bite when you start an agent with "memnox run -- <agent>".`,
    );
  }
  if (wired.daemon !== WIRED.DONE) flow.hint(describeDaemonGap(wired));
  flow.hint(
    'This machine is watching, not stopping. "memnox doctor --wiring" shows what is in the path, and "memnox config set mode enforce" turns it on when you have read a week of it.',
  );
  flow.hint('Take all of it back out with "memnox uninstall".');
}

/** Without the daemon the workspace's rules never arrive and a held question reaches nobody. */
function describeDaemonGap(wired: Wiring): string {
  if (wired.daemonNote === undefined) {
    return 'Nothing starts the daemon, so rules are not pulled on their own. "memnox daemon --install" hands it to the machine.';
  }
  return `The daemon would not start (${wired.daemonNote}). "memnox daemon --status" says where it stands.`;
}

/** Which coding agents now take a lease before they write, named because the unhooked ones still collide. */
export function describeEditors(wired: Wiring): string {
  const editors = [...(wired.claudeHook ? ['Claude Code'] : []), ...wired.editHooks];
  const hooked =
    editors.length === 0
      ? ''
      : `, ${editors.join(', ')} ${editors.length === 1 ? 'takes' : 'take'} a lease before writing`;
  // Named, because it is what covers every agent with no hook of its own.
  const watched =
    wired.watching === undefined
      ? ''
      : ', edits by anything else in this repository watched';
  return `${hooked}${watched}`;
}

/**
 * What happened to the MCP servers, and said out loud when wrapping was skipped, since
 * unwrapped servers leave an agent's outward work compared against nothing.
 */
export function describeMcp(wired: Wiring): string {
  return `${describeWrapping(wired)}${describeSessionTools(wired)}`;
}

function describeWrapping(wired: Wiring): string {
  if (wired.mcpUnwrapped === true) {
    return ', MCP servers left alone (the proxy is not on PATH)';
  }
  if (wired.mcpServers === 0) return '';
  return `, ${wired.mcpServers} MCP server(s) through the proxy`;
}

/** Named, because asking Memnox from inside the conversation is how it is mostly used. */
function describeSessionTools(wired: Wiring): string {
  const agents = wired.sessionTools ?? [];
  if (agents.length === 0) return '';
  return `, ${agents.join(', ')} can ask Memnox from inside a session`;
}

/** The daemon half of the wiring line, in the words the summary will use again. */
export function describeDaemon(wired: Wiring): string {
  if (wired.daemon === WIRED.DONE) return 'daemon installed';
  if (wired.daemon === WIRED.UNSUPPORTED) return 'no service manager here';
  return 'daemon not started';
}

/** Which control plane a record was written against, for the row that says so. */
export function describePlane(record: {
  workspaceId?: string;
  baseUrl?: string;
}): string {
  const which =
    record.workspaceId === undefined
      ? 'another workspace'
      : workspaceShown(record.workspaceId);
  return record.baseUrl === undefined
    ? `under ${which}`
    : `under ${which} at ${record.baseUrl}`;
}

/** The status word in the colour its meaning calls for; the table does the padding. */
function mark(context: CliContext, status: Result['status']): string {
  const { style } = context;
  if (status === STATUS.ONBOARDED) return style.ok(status);
  const warned: readonly string[] = [STATUS.FAILED, STATUS.CANNOT, STATUS.ELSEWHERE];
  if (warned.includes(status)) return style.warn(status);
  return style.dim(status);
}
