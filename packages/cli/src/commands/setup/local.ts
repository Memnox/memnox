/** Setup on a machine with no account: what the agents reach, one question, then the wiring. */
import { SENSITIVITY } from '@memnox/core';
import type { FlowRow } from '../../flow';
import { describeCount } from '../../plural';
import { underHome } from '../../memnox-paths';
import { WIRED, type Wiring } from '../../setup-wiring';
import type { Scanned, SetupDeps } from '../setup.command';

/** Enough to make the point without the block becoming the screen. */
const SHOWN = 5;

/** What the scan proved for the whole machine, shown before the question it is the reason for. */
export function describeMachine(deps: SetupDeps, scanned: Scanned): void {
  const { context } = deps;
  const home = deps.home();
  const { snapshot, report } = scanned;
  const sensitive = report.resources
    .filter((resource) => resource.sensitivity !== SENSITIVITY.ORDINARY)
    .filter((resource) => resource.reachableBy.length > 0)
    .map((resource) => underHome(resource.path ?? resource.id, home));
  const rows: FlowRow[] = [
    { label: 'mcp', value: describeCount(snapshot.servers.length, 'server') },
  ];
  if (sensitive.length > 0) {
    const more = sensitive.length > SHOWN ? ` and ${sensitive.length - SHOWN} more` : '';
    rows.push({
      label: 'can reach',
      value: `${sensitive.slice(0, SHOWN).join(', ')}${more}`,
    });
  }
  context.flow.rows('What they can reach today', rows);
}

/**
 * One question for the machine, because the wiring is machine-wide: a hook goes into every
 * agent that is installed, and a server is wrapped wherever it is configured.
 */
export async function askToProtect(
  deps: SetupDeps,
  scanned: Scanned,
  alreadyYes: boolean,
): Promise<boolean> {
  if (alreadyYes) return true;
  const { flow } = deps.context;
  if (!deps.interactive()) {
    flow.close('Nothing is attached to this terminal, so nobody can be asked.');
    flow.hint('Run "memnox setup --yes" to wire this machine without the question.');
    return false;
  }
  const these = scanned.snapshot.agents.length === 1 ? 'it' : 'them';
  const yes = await deps
    .confirm(`${flow.prompt}Put ${these} under Memnox?`)
    .catch(() => false);
  if (!yes) flow.close('Nothing on this machine changed.');
  return yes;
}

/**
 * What stands on this machine now, and the one step that is left for later. Every line
 * is counted from what the wiring did, so it never claims a daemon that did not start.
 */
export function renderLocalSummary(deps: SetupDeps, wired: Wiring): void {
  const { flow, style } = deps.context;
  flow.close(style.ok('This machine is under Memnox.'));
  flow.hint('Nothing left this machine: no account, no key, no network call.');
  // With no wrapper in the path of anything, every rule is a rule about nothing.
  if (wired.interceptors === 0) {
    flow.hint(
      'No interceptors are installed, so shell commands are not gated yet. "memnox protect --interceptors" fixes it.',
    );
  }
  if (wired.daemon === WIRED.DONE) {
    flow.hint(
      'The daemon keeps it that way. An agent or MCP server you install later is hooked on its own, and a hook taken out is put back, so this is the only time you run setup.',
    );
  }
  flow.hint(
    'It is watching, not stopping. "memnox status" shows where it stands, and "memnox config set mode enforce" turns it on when you have read a week of it.',
  );
  flow.hint(
    'When a second person or a second machine should share this, "memnox login" connects it to your team.',
  );
  flow.hint('Take all of it back out with "memnox uninstall".');
}
