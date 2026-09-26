import { homedir } from 'node:os';

import {
  FileAllowances,
  LocalGate,
  openNotice,
  SessionTasks,
  overlaysInForce,
  stateLabelsOf,
  type Containment,
  type SessionTask,
  RepositoryTasks,
} from '@memnox/core';

import { repositoryRootOf } from './seam-runtime';

import { containmentFor } from './containment-loader';
import type { HookConfig } from './hook-config';
import { DEFAULT_AGENT_NAME } from './tool-hook.constants';

/**
 * Null leaves the runtime as the only gate: no rule file and nothing to contain.
 */
export async function loadHookGate(
  config: HookConfig,
  home: string = homedir(),
  now: () => string = () => new Date().toISOString(),
  warn: (message: string) => void = (message) => {
    process.stderr.write(`[memnox] ${message}\n`);
  },
): Promise<LocalGate | null> {
  const { task, containment } = await readSession(config, home, now);
  if (config.policyFiles.length === 0 && containment === null) return null;
  const overlays = await overlaysInForce(home);

  // A registered file that is gone stopped every command on the machine, git included,
  // so it is skipped out loud and the rules that are still there stay in force.
  const sources = config.fromRegistry
    ? {
        optional: new Set(config.policyFiles),
        onSkipped: (file: string) => {
          warn(
            `${file} is registered but gone, so its rules are not in force. ` +
              '"memnox policy check --prune" forgets it.',
          );
        },
      }
    : undefined;

  const gate = await LocalGate.fromFiles(
    config.policyFiles,
    {
      agentName: config.agentName ?? DEFAULT_AGENT_NAME,
      ...(config.agentRole === undefined ? {} : { agentRole: config.agentRole }),
      task,
      stateFacts: stateLabelsOf(overlays, now()),
      ...(containment === null ? {} : { containment }),
      allowances: await new FileAllowances(home).inForce(now()),
    },
    sources,
  );
  return noticing(gate, config, home);
}

/**
 * The same agent and session every seam of one run resolves, so a credential read by
 * one seam and a push through another are seen as one session.
 */
async function noticing(
  gate: LocalGate,
  config: HookConfig,
  home: string,
): Promise<LocalGate> {
  const sessionId = config.sessionId;
  gate.attachNotice(
    await openNotice(home, {
      agent: config.agentName ?? DEFAULT_AGENT_NAME,
      ...(sessionId === undefined ? {} : { sessionId }),
    }),
  );
  return gate;
}

/**
 * Read at the moment of the decision, so a freeze or a task declared mid-run bites the
 * next command, and containment needs no rule file, so a machine with none keeps writes home.
 */
async function readSession(
  config: HookConfig,
  home: string,
  now: () => string,
): Promise<{ task: SessionTask | null; containment: Containment | null }> {
  const sessionId = config.sessionId;
  const declared =
    sessionId === undefined ? null : await new SessionTasks(home).read(sessionId);
  // A session nobody named a task for takes the one somebody declared for its repository.
  const task =
    declared ??
    (await new RepositoryTasks(home).inForce(repositoryRootOf(process.cwd()), now()));
  const containment = await containmentFor({
    home,
    env: process.env,
    cwd: process.cwd(),
    now: new Date(now()),
    ...(config.agentName === undefined ? {} : { agent: config.agentName }),
    ...(task?.scope.paths === undefined ? {} : { paths: task.scope.paths }),
  });
  return { task, containment };
}
