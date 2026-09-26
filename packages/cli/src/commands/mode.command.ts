/**
 * `memnox mode`: how agents on this machine work right now, as one switch. Investigate
 * reads anything and changes nothing outside the machine; autonomous works freely and
 * stops at money, deploys, authority, deletes and production. Off is your rules alone.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Command } from 'commander';

import {
  isWorkMode,
  loadPoliciesFromFile,
  MEMNOX_HOME,
  modeOf,
  modePolicies,
  WORK_MODE,
  writePolicyDocumentFile,
  type WorkMode,
} from '@memnox/core';

import type { CliContext } from '../cli-context';
import { forgetPolicyFiles, registerPolicyFile } from '../policy-registry';

const MODE_FILE = 'mode.policies.toml';
const OFF = 'off';

/** What each mode lets through and stops, in the words a person reads it by. */
const SAID: Readonly<Record<WorkMode, { lets: string; stops: string }>> = {
  [WORK_MODE.INVESTIGATE]: {
    lets: 'every read: files, repositories, logs, databases, APIs, MCP tools',
    stops: 'every change outside this machine, pushes, and writes outside the workspace',
  },
  [WORK_MODE.AUTONOMOUS]: {
    lets: 'the work: edits, tests, commits, pushes, pull requests, reads anywhere',
    stops:
      'money, deploys, authority, deletes outside the machine, and any change in production',
  },
};

export function registerModeCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  program
    .command('mode [mode]')
    .description('How agents work here: investigate, autonomous, or off')
    .action(async (mode: string | undefined) => runMode(context, home(), mode));
}

async function runMode(
  context: CliContext,
  home: string,
  asked: string | undefined,
): Promise<void> {
  const { flow } = context;
  flow.open('memnox mode');
  const path = join(home, MEMNOX_HOME, MODE_FILE);
  if (asked === undefined) return renderCurrent(context, await currentMode(path));
  if (asked === OFF) {
    await forgetPolicyFiles(home, [path]);
    await rm(path, { force: true });
    flow.close('No mode: your own rules decide, as they did before.');
    return;
  }
  if (!isWorkMode(asked)) {
    throw new Error(`"${asked}" is not a mode. Try: investigate, autonomous or off.`);
  }
  // Owner only, as every file under the Memnox home is.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writePolicyDocumentFile(path, { version: 1, policies: modePolicies(asked) });
  await registerPolicyFile(home, path);
  renderMode(context, asked);
  flow.hint(`memnox mode off   back to your own rules. The rules are in ${path}`);
}

async function currentMode(path: string): Promise<WorkMode | null> {
  if (!existsSync(path)) return null;
  return modeOf(await loadPoliciesFromFile(path));
}

function renderCurrent(context: CliContext, mode: WorkMode | null): void {
  if (mode === null) {
    context.flow.close('No mode is on. Your own rules decide.');
    context.flow.hint('memnox mode investigate   or   memnox mode autonomous');
    return;
  }
  renderMode(context, mode);
}

function renderMode(context: CliContext, mode: WorkMode): void {
  const said = SAID[mode];
  context.flow.rows(`${mode} mode`, [
    { label: 'lets through', value: said.lets },
    { label: 'stops', value: said.stops },
  ]);
  context.flow.close(
    context.style.ok(`${mode} mode is on for every agent on this machine.`),
  );
}
