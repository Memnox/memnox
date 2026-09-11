import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  applyHardening,
  chainsFor,
  discover,
  ENFORCEMENT_MODE,
  lastProbed,
  loadOrCreateConfig,
  planHardening,
  revertHardening,
  runDoctor,
  saveConfig,
  withToolsFrom,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import {
  defaultSeams,
  readState,
  registerApplied,
  writeState,
  type HardenSeamsFactory,
} from '../protect/harden-state';
import {
  promptOnTerminal,
  runInteractive,
  type DomainAsker,
} from '../protect/interactive-rules';
import { runNative } from '../protect/native-permissions';
import {
  runHooks,
  runInterceptors,
  runOsGuard,
  runPathLine,
} from '../protect/seam-install';
import { runForCli, runFromUsage } from '../protect/written-rules';

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
  ask: DomainAsker = promptOnTerminal,
): void {
  program
    .command('protect')
    // "Protect this" is what somebody says after a scan; harden is what it does.
    .description('Close what the doctor found, reversibly and proposed by default')
    .option('--apply', 'write the proposed steps')
    .option(
      '--revert [id]',
      'undo one applied step, or every one this machine applied when no id is given',
    )
    .option(
      '--interceptors',
      'install the PATH wrappers, so shell and git commands meet the rules too',
    )
    .option('--for <name>', 'write rules for one CLI or MCP server only')
    .option(
      '--from-usage <window>',
      'draft ask rules for what was granted and never used, e.g. 30d',
    )
    .option('--hooks', 'install git pre-push and pre-commit hooks in this repository')
    .option('--os-guard', 'write the kernel sandbox profile from your filesystem rules')
    .option('--interactive', 'walk the five domains and write the rules you choose')
    .option('--yes', 'take the recommended answer for every domain, asking nothing')
    .option('--observe', 'record verdicts and deny nothing')
    .option('--enforce', 'apply verdicts')
    .option(
      '--apply-native',
      'also write these rules into each agent’s own permission file',
    )
    .option('--revert-native', 'take our rules back out of those files')
    .option(
      '--path',
      'put the interceptors on your login PATH, so a windowed editor meets them too',
    )
    .option('--revert-path', 'take that line back out of your shell profile')
    .action(
      async (options: {
        apply?: boolean;
        revert?: boolean | string;
        for?: string;
        fromUsage?: string;
        interceptors?: boolean;
        hooks?: boolean;
        osGuard?: boolean;
        interactive?: boolean;
        yes?: boolean;
        observe?: boolean;
        enforce?: boolean;
        applyNative?: boolean;
        revertNative?: boolean;
        path?: boolean;
        revertPath?: boolean;
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
        if (options.fromUsage !== undefined) {
          await runFromUsage(context, options.fromUsage, cwd);
          return;
        }
        if (options.for !== undefined) {
          await runForCli(context, options.for);
          return;
        }
        if (options.interceptors === true) {
          await runInterceptors(context);
          return;
        }
        if (options.hooks === true) {
          await runHooks(context, cwd());
          return;
        }
        if (options.osGuard === true) {
          await runOsGuard(context, cwd());
          return;
        }
        if (options.interactive === true || options.yes === true) {
          await runInteractive(context, options.yes === true, ask);
          return;
        }
        if (options.path === true || options.revertPath === true) {
          await runPathLine(context, options.revertPath === true);
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
        /* Nothing here starts an MCP server, so the tools come from the last scan
           that did. Without them every tool-shaped finding is silently unreachable. */
        const probed = lastProbed(await seams.snapshots.history());
        const surfaces = withToolsFrom(discovered.surfaces, probed);
        const { findings } = runDoctor({
          resources: discovered.resources,
          reachability: discovered.reachability,
          surfaces,
          // From the hydrated surfaces, not the unprobed scan, or this is always empty.
          chains: chainsFor(
            discovered.agents.map((agent) => agent.id),
            surfaces,
          ),
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
