import { homedir } from 'node:os';
import {
  findUnusedGrants,
  matchesPattern,
  rollUpUsage,
  TOOL_EFFECT,
  type DiscoveryReport,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { DAY_MS, windowDays } from '../duration';
import { withEvents } from '../event-store';

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
    const usage = rollUpUsage(
      events.map((event) => ({
        agentId: event.agent,
        action: event.operation,
        resourceKind: event.surface,
        resourceId: event.target ?? event.operation,
        at: event.at,
        effect: event.effect,
      })),
    );

    // Every tool an agent here can reach is a grant, whether or not a rule names it.
    const granted = report.surfaces.flatMap((surface) =>
      (surface.tools ?? []).map((tool) => ({
        agentId: surface.agentId,
        action: `${tool.server}.${tool.name}`,
        grantedVia: surface.detectedFrom,
      })),
    );
    const unused = findUnusedGrants(granted, usage, days, matchesPattern);

    if (asJson) {
      context.out.json({ window: `${days}d`, usage, unused });
      return;
    }

    const { flow, style } = context;
    if (events.length === 0) {
      flow.close('Nothing was recorded in that window, so nothing can be called unused.');
      flow.hint('Wrap an agent with "memnox mcp wrap" and use it for a few days first.');
      return;
    }

    flow.rows(`Granted against used, last ${days} days`, [
      { label: 'granted', value: String(granted.length) },
      { label: 'used', value: String(usage.length) },
      { label: 'never touched', value: String(unused.length) },
    ]);
    if (unused.length === 0) {
      flow.close(`${granted.length} grant(s), every one of them used.`);
      return;
    }

    const external = unused.filter((grant) =>
      report.surfaces.some((surface) =>
        (surface.tools ?? []).some(
          (tool) =>
            `${tool.server}.${tool.name}` === grant.action &&
            tool.effect !== TOOL_EFFECT.READ,
        ),
      ),
    );
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
  });
}

/** Enough to make the point without the block becoming the screen. */
const EXTERNAL_SHOWN = 10;
