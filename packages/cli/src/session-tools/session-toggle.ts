/**
 * `memnox mcp session on|off`: the session tools put into every installed agent or taken
 * out of all of them, and the choice written down so the daemon keeps to it.
 */
import type { CliContext } from '../cli-context';
import { markSession } from '../keeper/kept';
import { removeEverywhere, wireSessionTools } from './session-entry';

const SESSION_STATE = { ON: 'on', OFF: 'off' } as const;

/** Turns the tools on or off, and says which agents it changed. */
export async function runSessionToggle(
  context: CliContext,
  home: string,
  state: string,
  resolve?: (binary: string) => boolean,
): Promise<void> {
  const { flow, style } = context;
  flow.open(`memnox mcp session ${state}`);
  if (state === SESSION_STATE.OFF) {
    const from = await removeEverywhere(home);
    // Written down, or the daemon puts them back on its next pass.
    await markSession(home, false);
    flow.close(
      from.length === 0
        ? 'No agent had the Memnox session tools, and none will get them.'
        : style.ok(
            `Taken out of ${from.join(', ')}, and the daemon will leave them out.`,
          ),
    );
    return;
  }
  if (state !== SESSION_STATE.ON) throw new Error('Say "on" or "off".');
  const placed = await wireSessionTools(home, resolve);
  await markSession(home, true);
  flow.close(
    placed.held.length === 0
      ? 'No installed agent could take them. Is memnox-session on PATH?'
      : style.ok(`${placed.held.join(', ')} can ask Memnox from inside a session.`),
  );
  if (placed.written.length > 0)
    flow.hint('Restart the agent so it starts the new server.');
}
