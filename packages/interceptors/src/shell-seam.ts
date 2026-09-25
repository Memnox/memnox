import {
  ACTION,
  DECISION_EFFECT,
  describeAlternative,
  describeHold,
  digest,
  EXIT,
  HTTP_METHOD_ARGUMENT,
  isAllowed as holdAllowed,
  leasePathFor,
  leaseScopeFor,
  proceeds,
  resolveShellLine,
  takesLease,
  targetsRuledOn,
  TOOL_CLASS,
  UNNAMED_AGENT,
  UNNAMED_SESSION,
  alternativeFor,
  cloneTargetOf,
  normalizeShellCommand,
  PROBATION_KIND,
  ProbationRegister,
  type ActionRequest,
  type Alternative,
  type DecisionEffect,
  type HoldService,
} from '@memnox/core';

import {
  describeVerdict,
  type HookAuthorizer,
  type HookVerdict,
} from './hook-authorizer';
import type { SeamLeases } from './seam-runtime';

/**
 * One shell line, ruled on before anything runs, through the resolver every surface uses.
 * Every target the line names is ruled on, since `cat README ~/.ssh/id_ed25519` is two
 * rulings, and the decision is returned because the row wants the exit code.
 */

export const SHELL_ACTION = ACTION.SHELL_EXECUTE;

/** What this seam decided, in the shape the ledger takes once the command has run. */
export interface ShellDecision {
  /** The action that drove the verdict, so `next` counts a capability and not a shell. */
  action: string;
  target?: string;
  class: string;
  effect: DecisionEffect;
  reason: string;
  rule?: string;
  /**
   * True when a person was put in front of it, which is what a hand-over is counted from.
   */
  asked?: boolean;
  /** Where the refusal says to go instead, so a hooked shell tool names it too. */
  alternative?: Alternative;
  environment?: string;
  outOfScope?: boolean;
}

export interface ShellOutcome {
  /** The command to run, present only when it may proceed. */
  run?: readonly string[];
  /** Printed on stderr. A refusal that explains nothing gets the wrapper removed. */
  message?: string;
  exitCode: number;
  /** What to write to the ledger. Always present: an allow is a row too. */
  decision: ShellDecision;
}

/**
 * Re-exported under the seam's own names, because every caller here reads them that way.
 */
export const SHELL_EXIT_OK = EXIT.OK;
export const SHELL_EXIT_WITHHELD = EXIT.WITHHELD;

export interface ShellSeamDeps {
  authorizer: HookAuthorizer;
  sessionId?: string;
  /** The name a person chose for this agent, carried into the hold and the row. */
  agent?: string;
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Somebody to ask. Absent means an ASK is withheld
   * and says so, which is right for a test only.
   */
  hold?: HoldService;
  /**
   * Absent on a machine running one agent, which must stay free of every cost this adds.
   */
  leases?: SeamLeases;
  /** Where a repository an agent clones is put on probation. Absent, nothing is noted. */
  home?: string;
  now?: () => Date;
}

const NO_COMMAND = 'no command to run';

/**
 * Deny beats ask beats allow, so a line is ruled by its worst command and not its last.
 */
const SEVERITY: Record<string, number> = {
  [DECISION_EFFECT.ALLOW]: 0,
  [DECISION_EFFECT.ASK]: 1,
  [DECISION_EFFECT.DENY]: 2,
};

/**
 * A verdict and the action it was reached about, kept together so the row can name both.
 */
interface Ruling {
  verdict: HookVerdict;
  action: string;
  target?: string;
  class: string;
}

function worse(current: Ruling, next: Ruling): Ruling {
  const nextSeverity = SEVERITY[next.verdict.effect] ?? 0;
  return nextSeverity > (SEVERITY[current.verdict.effect] ?? 0) ? next : current;
}

export class ShellSeam {
  constructor(private readonly deps: ShellSeamDeps) {}

  async gate(command: readonly string[]): Promise<ShellOutcome> {
    if (command.length === 0) return nothingToRun();

    const line = command.join(' ');
    const ruling = await this.rule(line);
    if (ruling.verdict.effect === DECISION_EFFECT.ASK) {
      const answered = await this.askAbout(line, ruling);
      if (answered !== null) return answered;
      // Somebody said yes, and that is a different row from a rule that never asked.
      const allowed = {
        ...ruling,
        verdict: { ...ruling.verdict, effect: DECISION_EFFECT.ALLOW },
      };
      return this.proceed(command, line, decisionOf(allowed, true));
    }
    if (ruling.verdict.effect !== DECISION_EFFECT.ALLOW) {
      return {
        message: describeVerdict(ruling.verdict),
        exitCode: SHELL_EXIT_WITHHELD,
        decision: decisionOf(ruling, false),
      };
    }
    return this.proceed(command, line, decisionOf(ruling, false));
  }

  /**
   * The whole line first, since only it can see a
   * pipeline, then every action and target in it.
   */
  private async rule(line: string): Promise<Ruling> {
    let ruling: Ruling = {
      verdict: await this.deps.authorizer.authorize(this.requestFor(SHELL_ACTION, line)),
      action: SHELL_ACTION,
      class: TOOL_CLASS.UNKNOWN,
    };
    for (const resolved of resolveShellLine(line, this.deps.env ?? {}).actions) {
      if (resolved.action === SHELL_ACTION) continue;
      for (const target of targetsRuledOn(resolved, line)) {
        const request = this.requestFor(resolved.action, target ?? line, {
          toolClass: String(resolved.class),
          ...(resolved.method === undefined ? {} : { method: resolved.method }),
          ...(resolved.environment === undefined
            ? {}
            : { environment: resolved.environment }),
        });
        const verdict = await this.deps.authorizer.authorize(request);
        const alternative = alternativeFor(
          verdict.alternative,
          resolved.alternative,
          resolved.action,
        );
        ruling = worse(ruling, {
          verdict: {
            ...verdict,
            ...(alternative === undefined ? {} : { alternative }),
            ...(resolved.environment === undefined
              ? {}
              : { environment: resolved.environment }),
          },
          action: resolved.action,
          ...(target === undefined ? {} : { target }),
          class: String(resolved.class),
        });
      }
    }
    return ruling;
  }

  /**
   * Policy first, then coordination, so nothing
   * holds a path it was never allowed to write.
   */
  private async proceed(
    command: readonly string[],
    line: string,
    decision: ShellDecision,
  ): Promise<ShellOutcome> {
    const held = await this.claim(line);
    if (held === null) {
      await this.noteClones(line);
      return { run: command, exitCode: SHELL_EXIT_OK, decision };
    }
    // A refusal, because the command did not run, and
    // the reason names another agent rather than a rule.
    return {
      ...held,
      decision: { ...decision, effect: DECISION_EFFECT.DENY, reason: held.message },
    };
  }

  /** Null when a person allowed it. A walk-away is withheld, never a yes. */
  private async askAbout(line: string, ruling: Ruling): Promise<ShellOutcome | null> {
    const hold = this.deps.hold;
    if (hold === undefined) {
      return {
        message: `${describeVerdict(ruling.verdict)}\nNobody could be asked, so it was withheld. Run the agent under "memnox run".`,
        exitCode: SHELL_EXIT_WITHHELD,
        decision: decisionOf(ruling, false),
      };
    }

    const request = {
      sessionId: this.deps.sessionId ?? UNNAMED_SESSION,
      agent: this.deps.agent ?? UNNAMED_AGENT,
      operation: ruling.action,
      fingerprint: digest(line),
      reason: ruling.verdict.reason,
      command: line,
      class: ruling.class,
    };
    const result = await hold.hold(request);
    // One yes covered the whole line, so everything it asked about is learned.
    if (holdAllowed(result)) return this.allowedByPerson();

    // What actually happened: a refusal, a late
    // answer and nobody to ask each read differently.
    const what = describeHold(result, request);
    const alternative = ruling.verdict.alternative;
    return {
      message:
        alternative === undefined ? what : `${what} ${describeAlternative(alternative)}`,
      exitCode: SHELL_EXIT_WITHHELD,
      // The ledger reads the same way `why` will: refused, and by what.
      decision: {
        ...decisionOf(ruling, true),
        effect: DECISION_EFFECT.DENY,
        reason: what,
      },
    };
  }

  /**
   * A repository an agent is about to clone is a stranger's code, so it starts on
   * probation and the work done inside it is contained until a person trusts it.
   */
  private async noteClones(line: string): Promise<void> {
    const home = this.deps.home;
    if (home === undefined) return;
    const cwd = this.deps.workingDirectory ?? process.cwd();
    const register = new ProbationRegister(home);
    for (const command of normalizeShellCommand(line).parsed) {
      const target = cloneTargetOf(command.argv, cwd);
      if (target === null) continue;
      await register
        .start(
          { kind: PROBATION_KIND.REPOSITORY, name: target.directory, label: target.url },
          (this.deps.now ?? ((): Date => new Date()))(),
        )
        .catch(() => null);
    }
  }

  private allowedByPerson(): null {
    this.deps.authorizer.personAllowed();
    return null;
  }

  /**
   * Takes the paths this line writes, or answers with
   * who is on them. A read never reaches the register.
   */
  private async claim(
    line: string,
  ): Promise<{ message: string; exitCode: number } | null> {
    const leases = this.deps.leases;
    if (leases === undefined) return null;

    const workingDirectory = this.deps.workingDirectory ?? leases.repositoryRoot;
    // Every file a command writes, since `touch a b` or `mv x y` claims both ends.
    const claimed = new Set<string>();
    for (const resolved of resolveShellLine(line, this.deps.env ?? {}).actions) {
      if (!takesLease(String(resolved.class))) continue;
      for (const target of targetsRuledOn(resolved)) {
        const path = leasePathFor(target, leases.repositoryRoot, workingDirectory);
        if (path === null) continue;
        const scope = leaseScopeFor(path, leases.isDirectory);
        if (claimed.has(scope)) continue;
        claimed.add(scope);
        const intent = `${resolved.action} ${target ?? ''}`.trim();
        const verdict = await leases.gate.claim(scope, leases.holder, intent);
        if (proceeds(verdict)) continue;
        return {
          message: verdict.message ?? `${scope} is held by another agent.`,
          exitCode: SHELL_EXIT_WITHHELD,
        };
      }
    }
    return null;
  }

  private requestFor(
    action: string,
    target: string,
    {
      toolClass,
      method,
      environment,
    }: { toolClass?: string; method?: string; environment?: string } = {},
  ): ActionRequest {
    return {
      action,
      target,
      ...(toolClass === undefined ? {} : { toolClass }),
      ...(environment === undefined ? {} : { environment }),
      // LOCAL ONLY. The SDK strips this before anything reaches the runtime.
      arguments: {
        command: target,
        ...(method === undefined ? {} : { [HTTP_METHOD_ARGUMENT]: method }),
      },
      ...(this.deps.sessionId === undefined ? {} : { sessionId: this.deps.sessionId }),
      ...(this.deps.workingDirectory === undefined
        ? {}
        : { workingDirectory: this.deps.workingDirectory }),
    };
  }
}

function nothingToRun(): ShellOutcome {
  return {
    message: NO_COMMAND,
    exitCode: SHELL_EXIT_WITHHELD,
    decision: {
      action: SHELL_ACTION,
      class: TOOL_CLASS.UNKNOWN,
      effect: DECISION_EFFECT.DENY,
      reason: NO_COMMAND,
    },
  };
}

/** The row this ruling becomes. One place, so a hold and a refusal cannot disagree. */
function decisionOf(ruling: Ruling, asked: boolean): ShellDecision {
  return {
    action: ruling.action,
    class: ruling.class,
    effect: ruling.verdict.effect,
    reason: ruling.verdict.reason,
    ...(ruling.target === undefined ? {} : { target: ruling.target }),
    ...(ruling.verdict.rule === undefined ? {} : { rule: ruling.verdict.rule }),
    ...(asked ? { asked: true } : {}),
    ...(ruling.verdict.alternative === undefined
      ? {}
      : { alternative: ruling.verdict.alternative }),
    ...(ruling.verdict.environment === undefined
      ? {}
      : { environment: ruling.verdict.environment }),
    ...(ruling.verdict.outOfScope === true ? { outOfScope: true } : {}),
  };
}
