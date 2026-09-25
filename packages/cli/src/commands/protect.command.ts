/**
 * `memnox protect`: propose, apply, revert. Every step prints its undo before it runs,
 * and a single command puts the machine back.
 */

import type { Command } from 'commander';
import { DECISION_EFFECT, EXIT } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { defaultSeams, type HardenSeamsFactory } from '../protect/harden-state';
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
import { runAllow, runDecide, runForCli, runFromUsage } from '../protect/written-rules';
import { runMode } from '../protect/mode';
import { runRevert } from '../protect/revert';
import { runPropose } from '../protect/propose';

/** Every flag `protect` takes. One shape, so the router and the action cannot drift. */
interface ProtectOptions {
  apply?: boolean;
  revert?: boolean | string;
  for?: string;
  allow?: string[];
  ask?: string[];
  deny?: string[];
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
}

/** What each branch is handed: the run's context and everything it might need. */
interface ProtectDeps {
  context: CliContext;
  buildSeams: HardenSeamsFactory;
  cwd: () => string;
  ask: DomainAsker;
  now: () => string;
}

/**
 * One branch of `protect`, and the flag that picks it. A table rather than a chain of
 * `if`, so adding a flag is a row here and the order they are tried in is visible.
 */
interface Branch {
  chosen: (options: ProtectOptions) => boolean;
  run: (deps: ProtectDeps, options: ProtectOptions) => Promise<void>;
}

/** Tried in order, first match wins. The order matters in one place, noted there. */
const BRANCHES: readonly Branch[] = [
  {
    chosen: (o) => o.observe === true || o.enforce === true,
    run: ({ context }, o) => runMode(context, o.enforce === true),
  },
  // Ahead of the interactive branch, or `--allow x --yes` reads as the five-domain walk.
  {
    chosen: (o) => o.allow !== undefined,
    run: ({ context }, o) => runAllow(context, o.allow ?? []),
  },
  {
    chosen: (o) => o.ask !== undefined,
    run: ({ context }, o) => runDecide(context, DECISION_EFFECT.ASK, o.ask ?? []),
  },
  {
    chosen: (o) => o.deny !== undefined,
    run: ({ context }, o) => runDecide(context, DECISION_EFFECT.DENY, o.deny ?? []),
  },
  {
    chosen: (o) => o.fromUsage !== undefined,
    run: ({ context, cwd }, o) => runFromUsage(context, o.fromUsage ?? '', cwd),
  },
  {
    chosen: (o) => o.for !== undefined,
    run: ({ context }, o) => runForCli(context, o.for ?? ''),
  },
  {
    chosen: (o) => o.interceptors === true,
    run: ({ context }) => runInterceptors(context),
  },
  {
    chosen: (o) => o.hooks === true,
    run: ({ context, cwd }) => runHooks(context, cwd()),
  },
  {
    chosen: (o) => o.claudeHook === true || o.revertClaudeHook === true,
    run: ({ context }, o) => runClaudeHook(context, o.revertClaudeHook === true),
  },
  {
    chosen: (o) => o.osGuard === true,
    run: ({ context, cwd }) => runOsGuard(context, cwd()),
  },
  {
    chosen: (o) => o.interactive === true || o.yes === true,
    run: ({ context, ask }, o) => runInteractive(context, o.yes === true, ask),
  },
  {
    chosen: (o) => o.path === true || o.revertPath === true,
    run: ({ context }, o) => runPathLine(context, o.revertPath === true),
  },
  {
    chosen: (o) => o.applyNative === true || o.revertNative === true,
    run: ({ context }, o) => runNative(context, o.revertNative === true),
  },
  {
    chosen: (o) => o.revert !== undefined && o.revert !== false,
    run: async ({ context, buildSeams, now }, o) => {
      // Cast is safe: `chosen` above ruled out undefined and false.
      const status = await runRevert(
        context,
        buildSeams(),
        o.revert as string | true,
        now(),
      );
      if (status !== EXIT.OK) process.exitCode = status;
    },
  },
];

export function registerProtectCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<Omit<ProtectDeps, 'context'>> = {},
): void {
  const deps: ProtectDeps = {
    context,
    buildSeams: defaultSeams,
    cwd: () => process.cwd(),
    ask: promptOnTerminal,
    now: () => new Date().toISOString(),
    ...overrides,
  };
  const protect = program
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
      '--ask <action...>',
      'always ask a person before these, and offer that to your team',
    )
    .option('--deny <action...>', 'never run these, and offer that to your team')
    .option(
      '--from-usage <window>',
      'draft ask rules for what was granted and never used, e.g. 30d',
    )
    .action(async (options: ProtectOptions) => runProtect(deps, options));
  declareSeamFlags(protect);
}

/** The flags that install or remove a seam, choose rules, or set the mode. */
function declareSeamFlags(protect: Command): void {
  protect
    .option('--hooks', 'install git pre-push and pre-commit hooks in this repository')
    .option(
      '--claude-hook',
      'make Claude Code take a lease before it writes a file, so two sessions never write one at once',
    )
    .option('--revert-claude-hook', 'take that hook back out of Claude Code')
    .option('--os-guard', 'write the kernel sandbox profile from your filesystem rules')
    .option('--interactive', 'walk the six domains and write the rules you choose')
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
    .option('--revert-path', 'take that line back out of your shell profile');
}

/** Picks the branch the flags chose, or proposes what the doctor found. */
async function runProtect(deps: ProtectDeps, options: ProtectOptions): Promise<void> {
  if (options.observe === true && options.enforce === true) {
    throw new Error('Pick one: --observe or --enforce, not both.');
  }
  // Opened here so every helper in `protect/` draws on the same rail.
  deps.context.flow.open('memnox protect');

  const branch = BRANCHES.find((each) => each.chosen(options));
  if (branch !== undefined) return branch.run(deps, options);

  return runPropose(deps.context, {
    seams: deps.buildSeams(),
    cwd: deps.cwd(),
    now: deps.now(),
    apply: options.apply === true,
  });
}
