/** `memnox agents status`: what is known about one agent on this machine. */
import type { SnapshotAgent } from '@memnox/core';
import type { CliContext } from '../../cli-context';
import { readRecord, type OnboardRecord } from '../../agents/onboarding';
import { displayName, readNames } from '../../agents/names';
import {
  describeProduct,
  quoted,
  renderNotFound,
  resolveHosted,
  type AgentsDeps,
  type JsonOptions,
} from './shared';

/** What is known about one agent: its id, its product, and whether Memnox holds it. */
export async function runStatus(
  deps: AgentsDeps,
  agent: string,
  options: JsonOptions,
): Promise<void> {
  const { context, home } = deps;
  const asJson = options.json === true;
  if (!asJson) context.flow.open('memnox agents status');

  const found = await resolveHosted(deps, agent);
  if (found === null) {
    renderNotFound(context, agent, asJson);
    return;
  }

  const shown = displayName(await readNames(home()), found);
  const record = await readRecord(home(), found.id);
  if (asJson) {
    context.out.json({ agent: { ...found, name: shown }, onboarded: record !== null });
    return;
  }
  renderStatus(context, found, shown, record);
}

function renderStatus(
  context: CliContext,
  found: SnapshotAgent,
  shown: string,
  record: OnboardRecord | null,
): void {
  const { flow, style } = context;
  flow.rows(shown, [
    { label: 'id', value: found.id },
    { label: 'product', value: describeProduct(found) },
    {
      label: 'working',
      value:
        record === null
          ? style.warn('not onboarded')
          : style.ok(`onboarded ${record.onboardedAt}`),
    },
  ]);
  renderReach(context, found);
  if (record === null) {
    flow.close(`${shown} is on this machine and not under Memnox.`);
    flow.hint(`memnox agents onboard ${quoted(shown)}`);
    return;
  }
  flow.close(style.ok(`${shown} is under Memnox.`));
  flow.hint(`memnox agents offboard ${quoted(shown)}`);
}

// The file that proved each surface rather than a count: a number says how much this
// agent can reach, and the path says who granted it.
function renderReach(context: CliContext, found: SnapshotAgent): void {
  if (found.surfaces.length === 0) {
    context.flow.step('What it can reach', 'nothing this scan could prove');
    return;
  }
  context.flow.table(
    'What it can reach, and who granted it',
    ['Surface', 'Proved by'],
    found.surfaces.map((surface) => [surface.kind, surface.detectedFrom]),
  );
}
