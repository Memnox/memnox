import { homedir } from 'node:os';
import {
  TOOL_EFFECT,
  findUnusedGrants,
  matchesPattern,
  rollUpUsage,
  usageFrom,
  type DiscoveryReport,
  type GrantedAction,
  type UnusedGrant,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { DAY_MS, windowDays } from '../duration';
import { withEvents } from '../event-store';

/** Enough to make the point without the block becoming the screen. */
const EXTERNAL_SHOWN = 10;

/**
 * Granted against used. The sentence nobody else can produce about a machine: this
 * agent can reach twenty things and touched three, and here are the seventeen.
 */
export async function renderUsage(
  context: CliContext,
  report: DiscoveryReport,
  window: string,
  asJson: boolean,
): Promise<void> {
  const days = windowDays(window, '--usage');
  const since = new Date(Date.now() - days * DAY_MS).toISOString();

  await withEvents(homedir(), async (store) => {
    const events = await store.query({ since });
    const usage = rollUpUsage(usageFrom(events));
    const granted = grantsIn(report);
    const unused = findUnusedGrants(granted, usage, days, matchesPattern);

    if (asJson) {
      context.out.json({ window: `${days}d`, usage, unused });
      return;
    }
    if (events.length === 0) {
      context.flow.close(
        'Nothing was recorded in that window, so nothing can be called unused.',
      );
      context.flow.hint(
        'Wrap an agent with "memnox mcp wrap" and use it for a few days first.',
      );
      return;
    }
    context.flow.rows(`Granted against used, last ${days} days`, [
      { label: 'granted', value: String(granted.length) },
      { label: 'used', value: String(usage.length) },
      { label: 'never touched', value: String(unused.length) },
    ]);
    renderUnused(context, report, { granted: granted.length, unused });
  });
}

/** Every tool an agent here can reach is a grant, whether or not a rule names it. */
function grantsIn(report: DiscoveryReport): GrantedAction[] {
  return report.surfaces.flatMap((surface) =>
    (surface.tools ?? []).map((tool) => ({
      agentId: surface.agentId,
      action: `${tool.server}.${tool.name}`,
      grantedVia: surface.detectedFrom,
    })),
  );
}

interface UnusedView {
  granted: number;
  unused: readonly UnusedGrant[];
}

function renderUnused(
  context: CliContext,
  report: DiscoveryReport,
  view: UnusedView,
): void {
  const { flow, style } = context;
  const { unused } = view;
  if (unused.length === 0) {
    flow.close(`${view.granted} grant(s), every one of them used.`);
    return;
  }
  const external = unused.filter((grant) => changesExternalState(report, grant.action));
  if (external.length > 0) {
    flow.list(
      `${external.length} unused tool(s) can change external state`,
      external.slice(0, EXTERNAL_SHOWN).map((grant) => ({
        tone: TONE.WARN,
        text: grant.action,
        detail: [grant.grantedVia],
      })),
    );
  }
  flow.close(
    external.length === 0
      ? `${unused.length} grant(s) were never touched.`
      : style.warn(
          `${unused.length} grant(s) were never touched, ${external.length} of which change external state.`,
        ),
  );
  flow.hint('memnox protect   proposes rules for what is not being used');
}

function changesExternalState(report: DiscoveryReport, action: string): boolean {
  return report.surfaces.some((surface) =>
    (surface.tools ?? []).some(
      (tool) =>
        `${tool.server}.${tool.name}` === action && tool.effect !== TOOL_EFFECT.READ,
    ),
  );
}
