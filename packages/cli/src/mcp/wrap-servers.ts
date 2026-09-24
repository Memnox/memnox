/** Routing every MCP server on this machine through the proxy, and putting them back. */
import { planUnwrap, planUpgrade, planWrap } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import {
  isProxyOnPath,
  readConfigs,
  writeRelaunches,
  type BinaryResolver,
} from './server-configs';

/**
 * Wraps what is there, silently, for `setup` to call rather than tell somebody to. Skipped
 * where the proxy is not on PATH, since wrapping onto a missing binary stops agents starting.
 */
export async function wrapEveryServer(
  home: string,
  project: string,
  resolveBinary?: BinaryResolver,
): Promise<{ wrapped: number; skipped: boolean; names: string[]; files: string[] }> {
  if (!isProxyOnPath(resolveBinary)) {
    return { wrapped: 0, skipped: true, names: [], files: [] };
  }
  let wrapped = 0;
  // Named, so the daemon can say which server it just put through the proxy.
  const names: string[] = [];
  // And where, so the ledger row names the file that changed.
  const files: string[] = [];
  for (const file of await readConfigs(home, project)) {
    const plan = planWrap(file.servers, file.agent);
    // And the lines wrapped without the agent's name, so a refusal elsewhere names it.
    const upgrades = planUpgrade(file.servers, file.agent);
    if (plan.wrap.length === 0 && upgrades.length === 0) continue;
    await writeRelaunches(home, file, [...plan.wrap, ...upgrades]);
    wrapped += plan.wrap.length;
    names.push(...plan.wrap.map((each) => each.name));
    if (plan.wrap.length > 0) files.push(file.path);
  }
  return { wrapped, skipped: false, names, files };
}

/**
 * Puts every wrapped server back and answers how many, for `uninstall` too. The original
 * command is read out of the wrapped entry rather than the backup, so it survives `--purge`.
 */
export async function unwrapEveryServer(
  home: string,
  project: string,
  context: CliContext,
): Promise<number> {
  let restored = 0;
  for (const file of await readConfigs(home, project)) {
    const { restore } = planUnwrap(file.servers);
    if (restore.length === 0) continue;
    context.flow.list(
      file.path,
      restore.map((each) => ({
        tone: TONE.OK,
        text: `${each.name}  proxy → ${each.after.command}`,
      })),
    );
    restored += restore.length;
    await writeRelaunches(home, file, restore);
  }
  return restored;
}
