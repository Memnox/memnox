import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  applyNative,
  loadPoliciesFromFile,
  revertNative,
  toClaudeCodePermissions,
  type NativeSettings,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { resolvePolicyFile } from '../policy-path';

const CLAUDE_SETTINGS = join('.claude', 'settings.json');

/**
 * The same rules in Claude Code's own format, so they still bite when the agent is
 * not going through us. Backed up first: this is somebody's editor configuration.
 */
export async function runNative(context: CliContext, reverting: boolean): Promise<void> {
  const path = join(homedir(), CLAUDE_SETTINGS);
  if (!existsSync(path)) {
    throw new Error(`No Claude Code settings at ${path}, so there is nothing to write.`);
  }

  const raw = await readFile(path, 'utf8');
  const settings = JSON.parse(raw) as NativeSettings;
  await writeFile(`${path}.memnox-backup`, raw, 'utf8');

  if (reverting) {
    await writeFile(path, `${JSON.stringify(revertNative(settings), null, 2)}\n`, 'utf8');
    context.out.line('Took our rules back out of Claude Code.');
    return;
  }

  const rules = resolvePolicyFile();
  if (!existsSync(rules)) {
    throw new Error(`No rules at ${rules} to write. Try "memnox protect --interactive".`);
  }
  const translation = toClaudeCodePermissions(await loadPoliciesFromFile(rules));
  await writeFile(
    path,
    `${JSON.stringify(applyNative(settings, translation), null, 2)}\n`,
    'utf8',
  );

  const { permissions, untranslated } = translation;
  context.out.line(
    `Wrote ${permissions.allow.length} allow, ${permissions.ask.length} ask and ` +
      `${permissions.deny.length} deny into ${path}.`,
  );
  // Anything that could not be written is named, or somebody trusts a rule that is not there.
  for (const each of untranslated) {
    context.out.note(`  not written: ${each.policy} — ${each.because}`);
  }
  context.out.note('Undo with "memnox protect --revert-native".');
}
