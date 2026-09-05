import { homedir } from 'node:os';
import {
  findUnusedGrants,
  matchesPattern,
  rollUpUsage,
  TOOL_EFFECT,
  type DiscoveryReport,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
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

    const { out, style } = context;
    out.line('');
    out.line(style.bold(`GRANTED AGAINST USED — last ${days} days`));
    out.line('');
    if (events.length === 0) {
      out.line('  Nothing was recorded in that window, so nothing can be called unused.');
      out.note('Wrap an agent with "memnox mcp wrap" and use it for a few days first.');
      return;
    }

    out.line(
      `  ${granted.length} granted    ${usage.length} used    ${unused.length} never touched`,
    );
    if (unused.length === 0) return;

    out.line('');
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
      out.line(
        `  ${style.warn('!')} ${external.length} unused tool(s) can change external state:`,
      );
      for (const grant of external.slice(0, 10)) {
        out.line(`      ${grant.action}  (${grant.grantedVia})`);
      }
    }
    out.line('');
    out.line(
      `  ${style.dim('memnox protect')}  propose rules for what is not being used`,
    );
  });
}
