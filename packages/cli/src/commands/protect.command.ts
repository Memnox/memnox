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
import { TONE } from '../flow';
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
import { runClaudeHook } from '../protect/claude-hook';
import { runNative } from '../protect/native-permissions';
import {
  runHooks,
  runInterceptors,
  runOsGuard,
  runPathLine,
} from '../protect/seam-install';
import { runAllow, runForCli, runFromUsage } from '../protect/written-rules';

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
      '--allow <action...>',
      'stop being asked about something you have already approved enough times',
    )
    .option(
      '--from-usage <window>',
      'draft ask rules for what was granted and never used, e.g. 30d',
    )
    .option('--hooks', 'install git pre-push and pre-commit hooks in this repository')
    .option(
      '--claude-hook',
      'make Claude Code take a lease before it writes a file, so two sessions never write one at once',
    )
    .option('--revert-claude-hook', 'take that hook back out of Claude Code')
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
        allow?: string[];
        fromUsage?: string;
        interceptors?: boolean;
        hooks?: boolean;
        claudeHook?: boolean;
        revertClaudeHook?: boolean;
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
        /* One rail for every shape of this command. `protect` is a dozen
           different acts behind one verb, from setting a mode to writing rules
           to installing a seam to putting it all back, and each of them reports
           through a helper in `protect/`. Opening it here is what makes those helpers draw on the
           same gutter rather than each printing loose. */
        const { flow } = context;
        flow.open('memnox protect');
        if (options.observe === true || options.enforce === true) {
          const mode =
            options.enforce === true
              ? ENFORCEMENT_MODE.ENFORCE
              : ENFORCEMENT_MODE.OBSERVE;
          const home = homedir();
          const config = await loadOrCreateConfig(home);
          await saveConfig(home, { ...config, mode });
          flow.rows('Mode', [
            { label: 'was', value: config.mode },
            { label: 'now', value: mode },
            {
              label: 'means',
              value:
                mode === ENFORCEMENT_MODE.ENFORCE
                  ? 'verdicts bite'
                  : 'verdicts are recorded and nothing is denied',
            },
          ]);
          flow.close(`This machine is in ${mode}.`);
          flow.hint(
            mode === ENFORCEMENT_MODE.ENFORCE
              ? '"memnox protect --observe" puts it back.'
              : '"memnox protect --enforce" makes verdicts bite.',
          );
          return;
        }
        /* Ahead of the interactive branch below, or "--allow x --yes" would be read
           as the five-domain walk and hand nothing over. */
        if (options.allow !== undefined) {
          await runAllow(context, options.allow);
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
        if (options.claudeHook === true || options.revertClaudeHook === true) {
          await runClaudeHook(context, options.revertClaudeHook === true);
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
        const { style } = context;
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
            flow.close(
              'Nothing to revert: no harden step has been applied on this machine.',
            );
            return;
          }

          // An id that reverted everything took away a rule the reader meant to keep,
          // and said nothing about it. Name one and only that one goes.
          const named = typeof options.revert === 'string' ? options.revert : null;
          const chosen = named === null ? applied : applied.filter((s) => s.id === named);
          if (named !== null && chosen.length === 0) {
            flow.list(
              `No applied step with id ${named}. These are applied`,
              applied.map((step) => ({
                tone: TONE.DIM,
                text: `${step.id}  ${step.description}`,
              })),
            );
            flow.close(`Nothing was reverted, because ${named} names no applied step.`);
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
          flow.list(
            'Reverted',
            results.map((result) => ({
              tone: result.changed ? TONE.OK : TONE.DIM,
              text: `${result.changed ? 'reverted' : 'skipped '}  ${result.step.description}`,
            })),
          );
          const changed = results.filter((result) => result.changed).length;
          flow.close(`${changed} step(s) put back.`);
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
          flow.close(
            'Nothing to close: the doctor found nothing with a change behind it.',
          );
          return;
        }

        if (options.apply !== true) {
          flow.list(
            'Proposed',
            plan.steps.map((step, index) => ({
              tone: TONE.PLAIN,
              text: `${index + 1}. ${step.description}`,
              /* The undo is printed before anything runs, never after. No id while
                 proposing: nothing is applied yet, so an id here names a step that
                 does not exist and reverts nothing when a reader copies it. */
              detail: ['undo: memnox protect --revert'],
            })),
          );
          flow.close(`${plan.steps.length} step(s) proposed. Nothing was changed.`);
          flow.hint('Run "memnox protect --apply" to write these.');
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
        flow.list(
          'Applied',
          results.map((result) =>
            result.error === undefined
              ? {
                  tone: TONE.OK,
                  text: `applied  ${result.step.description}`,
                  // Real once applied, and the only id a revert can take.
                  detail: [`undo just this: memnox protect --revert ${result.step.id}`],
                }
              : {
                  tone: TONE.WARN,
                  text: `could not apply  ${result.step.description}`,
                  detail: [result.error],
                },
          ),
        );
        const failed = results.filter((result) => result.error !== undefined).length;
        flow.close(
          failed === 0
            ? style.ok(`${applied.length} step(s) applied.`)
            : style.warn(`${applied.length} applied, ${failed} could not be.`),
        );
        flow.hint('Put it all back with "memnox protect --revert".');
      },
    );
}
