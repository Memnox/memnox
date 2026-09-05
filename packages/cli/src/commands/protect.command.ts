import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  applyHardening,
  discover,
  HARDEN_TARGET,
  NodeHardenWriter,
  NodeMachineReader,
  planHardening,
  revertHardening,
  runDoctor,
  type HardenStep,
  type HardenWriter,
  type MachineReader,
  applyNative,
  ENFORCEMENT_MODE,
  loadOrCreateConfig,
  loadPoliciesFromFile,
  revertNative,
  saveConfig,
  toClaudeCodePermissions,
  type NativeSettings,
} from '@memnox/core';
import { registerPolicyFile } from '../policy-registry';
import type { CliContext } from '../cli-context';
import { DEFAULT_POLICY_FILE } from '../defaults';

/** Everything Memnox writes lives here, so nothing lands in a reviewed repository. */
const MEMNOX_HOME = '.memnox';

interface HardenSeams {
  reader: MachineReader;
  writer: HardenWriter;
  /** Where applied steps are recorded, so a later revert knows what to undo. */
  statePath: string;
  /** A written rule the runtime never reads is not a rule; this is what makes it one. */
  registerPolicy: (absolutePath: string) => Promise<void>;
  /** The writer roots its paths, and the registry needs the path from anywhere. */
  absolute: (path: string) => string;
}

type HardenSeamsFactory = () => HardenSeams;

function defaultSeams(): HardenSeams {
  const home = homedir();
  const root = join(home, MEMNOX_HOME);
  return {
    reader: new NodeMachineReader(home),
    writer: new NodeHardenWriter(root),
    statePath: 'harden-state.json',
    registerPolicy: async (path) => {
      await registerPolicyFile(home, path);
    },
    absolute: (path) => join(root, path),
  };
}

/**
 * Every policy file a step wrote, added to the set the runtime reads. Absolute, because
 * the registry is resolved from the runtime's own directory and not from this one.
 */
async function registerApplied(
  seams: HardenSeams,
  applied: readonly HardenStep[],
): Promise<void> {
  for (const step of applied) {
    if (step.target !== HARDEN_TARGET.POLICY) continue;
    await seams.registerPolicy(seams.absolute(step.apply.path));
  }
}

/** An id nobody applied is a typo, and exiting zero on one hides it. */
const EXIT_NO_SUCH_STEP = 1;

/**
 * Propose, apply, revert. Every step prints its undo before it runs, and a single
 * command puts the machine back: one over-eager default breaking a build at midnight
 * is the failure this product does not recover from.
 */
export function registerProtectCommand(
  program: Command,
  context: CliContext,
  buildSeams: HardenSeamsFactory = defaultSeams,
  cwd: () => string = () => process.cwd(),
): void {
  program
    .command('protect')
    // "Protect this" is what somebody says after a scan; harden is what it does.
    .description('Close what the doctor found, reversibly — proposed by default')
    .option('--apply', 'write the proposed steps')
    .option(
      '--revert [id]',
      'undo one applied step, or every one this machine applied when no id is given',
    )
    .option('--observe', 'record verdicts and deny nothing')
    .option('--enforce', 'apply verdicts')
    .option('--apply-native', 'also write these rules into Claude Code’s own permissions')
    .option('--revert-native', 'take our rules back out of Claude Code')
    .action(
      async (options: {
        apply?: boolean;
        revert?: boolean | string;
        observe?: boolean;
        enforce?: boolean;
        applyNative?: boolean;
        revertNative?: boolean;
      }) => {
        if (options.observe === true && options.enforce === true) {
          throw new Error('Pick one: --observe or --enforce, not both.');
        }
        if (options.observe === true || options.enforce === true) {
          const mode =
            options.enforce === true
              ? ENFORCEMENT_MODE.ENFORCE
              : ENFORCEMENT_MODE.OBSERVE;
          const home = homedir();
          const config = await loadOrCreateConfig(home);
          await saveConfig(home, { ...config, mode });
          context.out.line(`mode: ${config.mode} → ${mode}`);
          if (mode === ENFORCEMENT_MODE.ENFORCE) {
            context.out.note(
              'Verdicts now bite. "memnox protect --observe" puts it back.',
            );
          }
          return;
        }
        if (options.applyNative === true || options.revertNative === true) {
          await runNative(context, options.revertNative === true);
          return;
        }
        const { out, style } = context;
        const seams = buildSeams();
        const now = new Date().toISOString();

        if (options.revert !== undefined && options.revert !== false) {
          const recorded = await readState(seams);
          // The state keeps what was reverted, so a listing off it offered steps that
          // were already gone as though they could go again.
          const applied = recorded.filter(
            (step) => step.appliedAt !== undefined && step.revertedAt === undefined,
          );
          if (applied.length === 0) {
            out.line(
              'Nothing to revert: no harden step has been applied on this machine.',
            );
            return;
          }

          // An id that reverted everything took away a rule the reader meant to keep,
          // and said nothing about it. Name one and only that one goes.
          const named = typeof options.revert === 'string' ? options.revert : null;
          const chosen = named === null ? applied : applied.filter((s) => s.id === named);
          if (named !== null && chosen.length === 0) {
            out.line(`No applied step with id ${named}.`);
            out.note('');
            for (const step of applied) out.note(`  ${step.id}  ${step.description}`);
            process.exitCode = EXIT_NO_SUCH_STEP;
            return;
          }

          const results = await revertHardening(seams.writer, chosen, now);
          // Everything not chosen stays applied, or a named revert quietly widens.
          const untouched = recorded.filter(
            (step) => !chosen.some((each) => each.id === step.id),
          );
          await writeState(seams, [
            ...untouched,
            ...results.map((result) => result.step),
          ]);
          for (const result of results) {
            out.line(
              `  ${result.changed ? style.ok('reverted') : style.dim('skipped ')}  ${result.step.description}`,
            );
          }
          return;
        }

        // Same ground as doctor, or harden writes no rule for the credential it ranked.
        const discovered = await discover(seams.reader, { now, projectDirs: [cwd()] });
        const { findings } = runDoctor({
          resources: discovered.resources,
          reachability: discovered.reachability,
          surfaces: discovered.surfaces,
        });
        const proposed = findings.flatMap((finding) =>
          finding.remediation === undefined ? [] : [finding.remediation],
        );
        const plan = planHardening(proposed);

        if (plan.steps.length === 0) {
          out.line('Nothing to close: the doctor found nothing with a change behind it.');
          return;
        }

        out.line(style.bold(options.apply === true ? 'APPLYING' : 'PROPOSED'));
        out.line('');
        plan.steps.forEach((step, index) => {
          out.line(`  ${index + 1}. ${step.description}`);
          /* The undo is printed before anything runs, never after. No id while
           proposing: nothing is applied yet, so an id here names a step that does
           not exist and reverts nothing when a reader copies it. */
          out.line(`     ${style.dim('undo: memnox protect --revert')}`);
        });
        out.line('');

        if (options.apply !== true) {
          out.line(
            `Nothing was changed. Run ${style.bold('memnox protect --apply')} to write these.`,
          );
          return;
        }

        const results = await applyHardening(seams.writer, plan.steps, now);
        const applied = results
          .filter((result) => result.changed)
          .map((result) => result.step);
        // Appended, never replaced: writing only this batch lost the record of an
        // earlier one, and a revert cannot undo a step it has no note of.
        const already = await readState(seams);
        await writeState(seams, [...already, ...applied]);

        /* A rule nobody loads is not a rule. harden wrote its files into the Memnox
         home and registered none of them, so every step reported `applied` and the
         runtime went on answering "no policy matched" for the file it had protected. */
        await registerApplied(seams, applied);
        for (const result of results) {
          if (result.error !== undefined) {
            out.note(`could not apply ${result.step.id}: ${result.error}`);
            continue;
          }
          out.line(`  ${style.ok('applied')}  ${result.step.description}`);
          // Real once applied, and the only id a revert can take.
          out.line(
            `            ${style.dim(`undo just this: memnox protect --revert ${result.step.id}`)}`,
          );
        }
        out.line('');
        out.line(`Put it all back with ${style.bold('memnox protect --revert')}.`);
      },
    );
}

async function readState(seams: HardenSeams): Promise<HardenStep[]> {
  const raw = await seams.writer.read(seams.statePath);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HardenStep[]) : [];
  } catch {
    // A corrupt state file must not stop a revert of what is still on disk.
    return [];
  }
}

async function writeState(
  seams: HardenSeams,
  steps: readonly HardenStep[],
): Promise<void> {
  await seams.writer.write(seams.statePath, JSON.stringify(steps, null, 2));
}

const CLAUDE_SETTINGS = join('.claude', 'settings.json');

/**
 * The same rules in Claude Code's own format, so they still bite when the agent is
 * not going through us. Backed up first: this is somebody's editor configuration.
 */
async function runNative(context: CliContext, reverting: boolean): Promise<void> {
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

  if (!existsSync(DEFAULT_POLICY_FILE)) {
    throw new Error(`No rules at ${DEFAULT_POLICY_FILE} to write.`);
  }
  const translation = toClaudeCodePermissions(
    await loadPoliciesFromFile(DEFAULT_POLICY_FILE),
  );
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
