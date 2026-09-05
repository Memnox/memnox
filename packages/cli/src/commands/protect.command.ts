import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { dirname, join } from 'node:path';
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
  findUnusedGrants,
  matchesPattern,
  rollUpUsage,
  TOOL_EFFECT,
  loadOrCreateConfig,
  loadPoliciesFromFile,
  MEMNOX_HOME,
  revertNative,
  saveConfig,
  DECISION_EFFECT,
  DOMAIN_CHOICES,
  policiesFrom,
  recommendedAnswers,
  toClaudeCodePermissions,
  writePolicyDocumentFile,
  type DecisionEffect,
  type PolicyDomain,
  type NativeSettings,
  POLICY_FILE_EXTENSION,
  TOOL_CLASS,
  verbAction,
  verbTableFor,
  verbTableNames,
  guardFor,
  guardPlanFrom,
  landlockRuleset,
  OS_GUARD,
  seatbeltProfile,
  type Policy,
} from '@memnox/core';
import {
  installGitHooks,
  installInterceptors,
  interceptorDirFor,
} from '@memnox/interceptors';
import { registerPolicyFile } from '../policy-registry';
import type { CliContext } from '../cli-context';
import { DAY_MS, windowDays } from '../duration';
import { withEvents } from '../event-store';
import { guardProfilePath, landlockRulesetPath } from '../memnox-paths';
import { resolvePolicyFile } from '../policy-path';

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
  ask: DomainAsker = promptOnTerminal,
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
    .option('--apply-native', 'also write these rules into Claude Code’s own permissions')
    .option('--revert-native', 'take our rules back out of Claude Code')
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

/** The question, asked wherever the caller says. Injected, so tests need no terminal. */
type DomainAsker = (
  question: string,
  because: string,
  recommended: DecisionEffect,
) => Promise<DecisionEffect>;

const KEYS: Readonly<Record<string, DecisionEffect>> = {
  a: DECISION_EFFECT.ALLOW,
  k: DECISION_EFFECT.ASK,
  d: DECISION_EFFECT.DENY,
};

const promptOnTerminal: DomainAsker = async (question, because, recommended) => {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\n  ${question}\n  ${because}\n  [a]llow  as[k]  [d]eny  (enter = ${recommended})  > `,
    );
    const key = answer.trim().toLowerCase().charAt(0);
    // Enter takes the recommendation, because that is what most people mean by it.
    return key === '' ? recommended : (KEYS[key] ?? recommended);
  } finally {
    rl.close();
  }
};

/**
 * Five questions, then a file they can read. The output is the point: a wizard whose
 * result you cannot open and edit is one you have to run again to change your mind.
 */
async function runInteractive(
  context: CliContext,
  takeRecommended: boolean,
  ask: DomainAsker,
): Promise<void> {
  const { out, style } = context;
  const answers = takeRecommended
    ? recommendedAnswers()
    : new Map<PolicyDomain, DecisionEffect>();

  if (!takeRecommended) {
    out.line(style.bold('What should the agents on this machine be allowed to do?'));
    for (const choice of DOMAIN_CHOICES) {
      answers.set(
        choice.domain,
        await ask(choice.question, choice.because, choice.recommended),
      );
    }
  }

  const policies = policiesFrom(answers);
  const path = `memnox.policies${POLICY_FILE_EXTENSION}`;
  await writePolicyDocumentFile(path, { version: 1, policies });
  await registerPolicyFile(homedir(), path);

  out.line('');
  for (const [domain, effect] of answers) {
    out.line(`  ${domain.padEnd(12)}${effect}`);
  }
  out.line('');
  out.line(`Wrote ${policies.length} rule(s) to ${path}.`);
  out.note('Open it — it is yours to edit. Test one with "memnox policy test".');
}

/** The binary every wrapper execs. Shipped by the CLI package, so it is beside us. */
const INTERCEPT_BINARY = 'memnox-intercept';

/**
 * PATH is the whole mechanism, and we deliberately do not edit anybody's shell
 * profile: the directory is printed and `memnox run` sets it for the agent it starts.
 * A tool that silently rewrote your `.zshrc` is one you would not trust twice.
 */
async function runInterceptors(context: CliContext): Promise<void> {
  const home = homedir();
  const report = await installInterceptors(home, INTERCEPT_BINARY);
  const { out, style } = context;

  out.line(`Installed ${report.installed.length} interceptor(s) in ${report.directory}`);
  out.line(`  ${report.installed.join(', ')}`);
  /* Named rather than silently skipped: a rule written for a CLI this machine does not
     have is not broken, and somebody installing it later needs to know to re-run this. */
  if (report.absent.length > 0) {
    out.line('');
    out.line(
      `  ${style.dim(`not on this machine, so not wrapped: ${report.absent.join(', ')}`)}`,
    );
    out.line(`  ${style.dim('install one of those later and run this again')}`);
  }
  out.line('');
  out.line('They only bite when that directory comes first on PATH:');
  out.line(`  ${style.bold('memnox run -- <your agent>')}   sets it for that agent`);
  out.line(`  ${style.dim(report.pathLine)}   sets it for your shell, if you want that`);
  out.line('');
  out.note(
    `Undo with "memnox uninstall". Nothing outside ${interceptorDirFor(home)} was touched.`,
  );
}

/**
 * One CLI, from its own verb table. Denying the credential *file* while allowing the
 * CLI is the distinction that makes this adoptable: the tool keeps working, and the
 * agent cannot read the key out from under it.
 */
async function runForCli(context: CliContext, name: string): Promise<void> {
  const table = verbTableFor(name);
  if (table === null) {
    throw new Error(
      `No verb table for "${name}". Known: ${verbTableNames().join(', ')}.`,
    );
  }

  const rules: Policy[] = [];
  const destructive = table.verbs.filter((verb) => verb.class === TOOL_CLASS.DESTRUCTIVE);
  const external = table.verbs.filter((verb) => verb.class === TOOL_CLASS.WRITE);

  if (destructive.length > 0) {
    rules.push(ruleFor(name, 'deny', destructive, 'these do not come back'));
  }
  if (external.length > 0) {
    rules.push(ruleFor(name, 'ask', external, 'somebody else sees the result'));
  }

  const paths = table.credential.filter((source) => source.startsWith('~'));
  if (paths.length > 0) {
    rules.push({
      name: `${name}-credential-deny`,
      description: `${name} keeps working; the agent just cannot read the key.`,
      match: {
        actions: ['filesystem.read'],
        targets: paths.flatMap((path) => [
          path.replace('~', '**'),
          `${path.replace('~', '**')}/**`,
        ]),
      },
      decision: {
        effect: DECISION_EFFECT.DENY,
        reason: `reading ${name}'s credential is not needed to use ${name}`,
        alternative: { action: name, note: `run ${name} instead of reading its key` },
      },
    } as unknown as Policy);
  }

  const path = `memnox.policies${POLICY_FILE_EXTENSION}`;
  await writePolicyDocumentFile(path, { version: 1, policies: rules });
  await registerPolicyFile(homedir(), path);

  const { out, style } = context;
  out.line('');
  for (const rule of rules) out.line(`  ${rule.decision.effect.padEnd(6)}${rule.name}`);
  out.line('');
  out.line(`Wrote ${rules.length} rule(s) for ${name} to ${path}.`);
  out.note(
    `${style.bold(name)} keeps working — only reading its credential file is denied.`,
  );
}

function ruleFor(
  cli: string,
  effect: string,
  verbs: readonly { match: string; alternative?: string }[],
  because: string,
): Policy {
  const first = verbs[0];
  return {
    name: `${cli}-${effect}`,
    match: {
      actions: verbs.map((verb) => verbAction(cli, verb as never)),
    },
    decision: {
      effect,
      reason: `${cli}: ${because}`,
      alternative: {
        action: cli,
        note: first?.alternative ?? 'ask somebody, or change this rule',
      },
    },
  } as unknown as Policy;
}

/**
 * Least privilege from what actually happened, not from a questionnaire. Everything
 * reachable that nothing touched in the window becomes an ask — never a deny, because
 * "unused for thirty days" is not the same as "never needed", and a rule that broke
 * somebody's quarterly job would be the last rule they let this write.
 */
async function runFromUsage(
  context: CliContext,
  window: string,
  cwd: () => string,
): Promise<void> {
  const days = windowDays(window, '--from-usage');
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const { out, style } = context;

  await withEvents(homedir(), async (store) => {
    const events = await store.query({ since });
    if (events.length === 0) {
      out.line(`Nothing was recorded in the last ${days} days.`);
      out.note('Nothing can be called unused until something has been used.');
      return;
    }

    const report = await discover(new NodeMachineReader(homedir()), {
      now: new Date().toISOString(),
      projectDirs: [cwd()],
    });
    const usage = rollUpUsage(
      events.map((event) => ({
        agentId: event.agent,
        action: event.operation,
        resourceKind: event.surface,
        resourceId: event.target ?? event.operation,
        at: event.at,
        effect: event.effect,
      })),
    );
    const granted = report.surfaces.flatMap((surface) =>
      (surface.tools ?? [])
        .filter((tool) => tool.effect !== TOOL_EFFECT.READ)
        .map((tool) => ({
          agentId: surface.agentId,
          action: `mcp.${tool.name}`,
          grantedVia: surface.detectedFrom,
        })),
    );

    const unused = findUnusedGrants(granted, usage, days, matchesPattern);
    if (unused.length === 0) {
      out.line(`Everything reachable was used in the last ${days} days.`);
      return;
    }

    const actions = [...new Set(unused.map((grant) => grant.action))];
    const rule = {
      name: `unused-${days}d`,
      description: `Reachable and untouched for ${days} days. Ask before the first use.`,
      match: { actions },
      decision: {
        effect: DECISION_EFFECT.ASK,
        reason: `nothing used this in ${days} days, so the first use is worth seeing`,
        alternative: {
          action: actions[0] as string,
          note: 'approve it once, or delete this rule if it is wrong',
        },
      },
    } as unknown as Policy;

    const path = `memnox.policies${POLICY_FILE_EXTENSION}`;
    await writePolicyDocumentFile(path, { version: 1, policies: [rule] });
    await registerPolicyFile(homedir(), path);

    out.line('');
    out.line(`${actions.length} capability(ies) were reachable and never used:`);
    for (const action of actions.slice(0, 12)) out.line(`  ${action}`);
    if (actions.length > 12)
      out.line(`  ${style.dim(`… and ${actions.length - 12} more`)}`);
    out.line('');
    out.line(`Wrote one ask rule to ${path}.`);
    // Ask, never deny: unused for a month is not the same as never needed.
    out.note('They are set to ask, not deny — the first real use will simply pause.');
  });
}

/**
 * Defence in depth, and the only gate that still holds when somebody runs a binary
 * without the interceptor directory on PATH. A hook is a file in the repository's own
 * `.git`, so it is installed per repository and never machine-wide.
 */
async function runHooks(context: CliContext, repoDir: string): Promise<void> {
  const { out, style } = context;
  const report = await installGitHooks(repoDir);

  if (report.installed.length === 0 && report.skipped.length === 0) {
    out.line(`No git repository at ${repoDir}, so there is nowhere to put a hook.`);
    return;
  }
  for (const hook of report.installed) out.line(`${style.ok('installed')}  ${hook}`);
  // A hook somebody else wrote is never overwritten; theirs is the one that matters.
  for (const hook of report.skipped) {
    out.line(`${style.warn('kept')}       ${hook} — yours, left alone`);
  }
  out.line('');
  out.line('A blocked push now stops even when the interceptors are not on PATH.');
  out.note('Undo with "memnox uninstall".');
}

/**
 * The kernel as a second line under the interceptors: a denied path stays unreadable
 * even to a binary that never saw a wrapper. What it cannot express is printed, because
 * a guard quietly covering less than the rules do is worse than no guard at all.
 */
async function runOsGuard(context: CliContext, repoDir: string): Promise<void> {
  const { out, style } = context;
  const home = homedir();
  const support = guardFor(process.platform, release());

  const file = resolvePolicyFile();
  if (!existsSync(file)) {
    throw new Error(`No rules at ${file}. Write some first:  memnox protect --yes`);
  }
  const plan = guardPlanFrom(await loadPoliciesFromFile(file), home, [repoDir]);
  const denied = plan.policy.denyRead.length + plan.policy.denyWrite.length;
  if (denied === 0) {
    out.line('No filesystem rule denies a path, so there is nothing to hand the kernel.');
    return;
  }

  if (support.guard === OS_GUARD.SEATBELT) {
    const path = guardProfilePath(home);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, seatbeltProfile(plan.policy), {
      encoding: 'utf8',
      mode: 0o600,
    });
    out.line(`Wrote a seatbelt profile covering ${denied} path(s) to ${path}`);
    out.line('');
    out.line(
      `  ${style.bold('memnox run -- <your agent>')}   starts it inside the sandbox`,
    );
  } else if (support.guard === OS_GUARD.LANDLOCK) {
    const ruleset = landlockRuleset(plan.policy);
    const path = landlockRulesetPath(home);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(ruleset, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    out.line(`Wrote a Landlock ruleset covering ${denied} path(s) to ${path}`);
  } else {
    out.line(`No kernel guard here: ${support.because}`);
    return;
  }

  for (const pattern of plan.skipped) {
    out.note(`the kernel cannot express "${pattern}" — the interceptors still cover it`);
  }
}
