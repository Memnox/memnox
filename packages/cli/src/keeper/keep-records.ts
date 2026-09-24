/**
 * What the keeper changed, as ledger rows: the agent, the file it rewrote, and what that
 * file held of ours before and after. Never the file's contents.
 */
import { join } from 'node:path';

import { TOOL_CLASS } from '@memnox/core';

import type { EditHookTarget } from '../protect/agent-hooks';
import { CONFIG_RULE, type ConfigRecord } from './config-events';
import { KEPT_CHANGE, type KeptChange } from './keep-boundary';

/** The ledger's word for each keeper change, under `config.` beside the drift it notices. */
const KEPT_OPERATION_PREFIX = 'config.';

/** What each hook change did, as a before and an after. Read on call, since the import is circular. */
function hookBeforeAfter(kind: KeptChange['kind']): string {
  if (kind === KEPT_CHANGE.ADOPTED)
    return 'before: never hooked; after: the Memnox hook added';
  if (kind === KEPT_CHANGE.UPGRADED) {
    return 'before: a hook that only took leases; after: one that rules on every tool call';
  }
  return 'before: the Memnox hook taken out; after: put back';
}

/** One row per change, naming the file each hook lives in from the table that wrote it. */
export function keptRecords(
  home: string,
  changes: readonly KeptChange[],
  targets: readonly EditHookTarget[],
): ConfigRecord[] {
  return changes.map((change) => {
    const operation = `${KEPT_OPERATION_PREFIX}${change.kind}`;
    if (change.kind === KEPT_CHANGE.WRAPPED) {
      return {
        operation,
        ...(change.files === undefined ? {} : { file: change.files.join(', ') }),
        summary: `MCP servers ${change.servers.join(', ')}. before: launched directly; after: through the Memnox proxy`,
        class: TOOL_CLASS.WRITE,
        rule: CONFIG_RULE.KEPT,
      };
    }
    if (change.kind === KEPT_CHANGE.SESSION) {
      return {
        operation,
        file: change.files.join(', '),
        summary: `${change.agents.join(', ')}. before: no Memnox session tools; after: put back`,
        class: TOOL_CLASS.WRITE,
        rule: CONFIG_RULE.KEPT,
      };
    }
    const target = targets.find((each) => each.name === change.agent);
    return {
      operation,
      agent: change.agent,
      ...(target === undefined ? {} : { file: join(home, target.file) }),
      summary: `${change.agent}. ${hookBeforeAfter(change.kind)}`,
      class: TOOL_CLASS.WRITE,
      rule: CONFIG_RULE.KEPT,
    };
  });
}
