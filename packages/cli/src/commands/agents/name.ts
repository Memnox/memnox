/** `memnox agents name`: read, set or clear what a person calls one agent. */
import type { SnapshotAgent } from '@memnox/core';
import {
  clearName,
  displayName,
  isDefaultName,
  readNames,
  setName,
  type AgentNames,
} from '../../agents/names';
import {
  renderNotFound,
  resolveHosted,
  type AgentsDeps,
  type JsonOptions,
} from './shared';

export interface NameOptions extends JsonOptions {
  clear?: boolean;
}

/** One agent, what it is called now, and what somebody asked to call it. */
interface Rename {
  found: SnapshotAgent;
  before: string;
  wanted: string;
}

/** Read, set or clear one agent's name, depending on which arguments arrived. */
export async function runName(
  deps: AgentsDeps,
  agent: string,
  wanted: string | undefined,
  options: NameOptions,
): Promise<void> {
  const { context, home } = deps;
  const { flow } = context;
  const asJson = options.json === true;
  if (!asJson) flow.open('memnox agents name');

  const found = await resolveHosted(deps, agent);
  if (found === null) {
    renderNotFound(context, agent, asJson);
    return;
  }
  const names = await readNames(home());
  if (options.clear === true) return clearOneName(deps, found, asJson);
  if (wanted === undefined) return renderOneName(deps, found, names, asJson);
  return writeOneName(deps, { found, before: displayName(names, found), wanted }, asJson);
}

/** Puts the detected name back. */
async function clearOneName(
  deps: AgentsDeps,
  found: SnapshotAgent,
  asJson: boolean,
): Promise<void> {
  const { context, home } = deps;
  const cleared = await clearName(home(), found.id);
  const after = displayName(await readNames(home()), found);
  if (asJson) {
    context.out.json({ agent: found.id, name: after, cleared });
    return;
  }
  context.flow.close(
    cleared
      ? context.style.ok(`${found.id} is "${after}" again.`)
      : `${found.id} was never renamed, so it is still "${after}".`,
  );
}

/** Says what this agent is called, and whether a person chose that. */
function renderOneName(
  deps: AgentsDeps,
  found: SnapshotAgent,
  names: AgentNames,
  asJson: boolean,
): void {
  const { context } = deps;
  const shown = displayName(names, found);
  const detected = isDefaultName(names, found);
  if (asJson) {
    context.out.json({ agent: found.id, name: shown, chosen: !detected });
    return;
  }
  context.flow.close(`${found.id} is called "${shown}".`);
  context.flow.hint(
    detected
      ? 'That is what the detector called it. Type a name after this command to give it your own.'
      : 'That is the name you gave it. "--clear" puts the detected one back.',
  );
}

/** Writes a chosen name, or says why it was refused. */
async function writeOneName(
  deps: AgentsDeps,
  rename: Rename,
  asJson: boolean,
): Promise<void> {
  const { context, home } = deps;
  const { found, before, wanted } = rename;
  const { flow, style } = context;
  const written = await setName(home(), found.id, wanted);

  if (!written.ok || written.name === undefined) {
    if (asJson) {
      context.out.json({ agent: found.id, name: before, refused: written.refused });
      return;
    }
    flow.close(style.warn(`Did not rename ${before}.`));
    flow.hint(written.because ?? 'that name was refused');
    process.exitCode = 1;
    return;
  }
  if (asJson) {
    context.out.json({ agent: found.id, name: written.name, was: before });
    return;
  }
  flow.close(style.ok(`${before} is now "${written.name}".`));
  flow.hint('Your workspace sees that name from the next sync.');
}
