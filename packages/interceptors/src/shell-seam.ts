import type { ActionRequest, DecisionEffect, LeaseHolder } from '@memnox/core';
import {
  DECISION_EFFECT,
  digest,
  describeHold,
  isAllowed as holdAllowed,
  leasePathFor,
  leaseScopeFor,
  proceeds,
  resolveShellLine,
  targetsRuledOn,
  takesLease,
  type HoldService,
  type LeaseGate,
} from '@memnox/core';
import type { HookAuthorizer, HookVerdict } from './hook-authorizer';

export const SHELL_ACTION = 'shell.execute';

/**
 * What this seam decided, in the shape the ledger takes.
 *
 * Returned rather than recorded here, because the seam runs before the command and the
 * row wants the exit code that comes after it. Without it every hold, refusal and
 * approval at this seam went unrecorded, and `why`, `timeline`, `report` and `next`
 * each answered "nothing has been decided on this machine yet" about a machine that
 * had spent the afternoon refusing things.
 */
export interface ShellDecision {
  /** The action that drove the verdict, so `next` counts a capability and not a shell. */
  action: string;
  target?: string;
  class: string;
  effect: DecisionEffect;
  reason: string;
  rule?: string;
  /** True when a person was put in front of it, which is what a hand-over is counted from. */
  asked?: boolean;
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

export const SHELL_EXIT_OK = 0;
export const SHELL_EXIT_WITHHELD = 77;

export interface ShellSeamDeps {
  authorizer: HookAuthorizer;
  sessionId?: string;
  /** The name a person chose for this agent, carried into the hold and the row. */
  agent?: string;
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Somebody to ask. Absent means an ASK is withheld and says so, which is right for
   * a test and wrong for a shell an agent is typing into: without one, every `ask`
   * rule the line hits is a refusal nobody was offered the chance to answer.
   */
  hold?: HoldService;
  /**
   * Two agents on one repository. Absent on a machine running one agent, which is the
   * ordinary case and must stay free of every cost this adds.
   */
  leases?: {
    gate: LeaseGate;
    holder: LeaseHolder;
    repositoryRoot: string;
    isDirectory: (path: string) => boolean;
  };
}

/** Deny beats ask beats allow, so a line is ruled by its worst command and not its last. */
const SEVERITY: Record<string, number> = {
  [DECISION_EFFECT.ALLOW]: 0,
  [DECISION_EFFECT.ASK]: 1,
  [DECISION_EFFECT.DENY]: 2,
};

/** A verdict and the action it was reached about, kept together so the row can name both. */
interface Ruling {
  verdict: HookVerdict;
  action: string;
  target?: string;
  class: string;
}

function worse(a: Ruling, b: Ruling): Ruling {
  return (SEVERITY[b.verdict.effect] ?? 0) > (SEVERITY[a.verdict.effect] ?? 0) ? b : a;
}

export class ShellSeam {
  constructor(private readonly deps: ShellSeamDeps) {}

  async gate(command: readonly string[]): Promise<ShellOutcome> {
    if (command.length === 0) {
      return {
        message: 'no command to run',
        exitCode: SHELL_EXIT_WITHHELD,
        decision: {
          action: SHELL_ACTION,
          class: 'unknown',
          effect: DECISION_EFFECT.DENY,
          reason: 'no command to run',
        },
      };
    }

    const line = command.join(' ');
    /* The whole line is still ruled on: a `shell.execute` rule matching `*rm -rf /*`
       has to keep firing, and it is the only thing that can see a pipeline as a whole. */
    let ruling: Ruling = {
      verdict: await this.deps.authorizer.authorize(this.requestFor(SHELL_ACTION, line)),
      action: SHELL_ACTION,
      class: 'unknown',
    };

    for (const resolved of resolveShellLine(line, this.deps.env ?? {}).actions) {
      if (resolved.action === SHELL_ACTION) continue;
      for (const target of targetsRuledOn(resolved, line)) {
        ruling = worse(ruling, {
          verdict: await this.deps.authorizer.authorize(
            this.requestFor(resolved.action, target ?? line),
          ),
          action: resolved.action,
          ...(target === undefined ? {} : { target }),
          class: String(resolved.class),
        });
      }
    }

    if (ruling.verdict.effect === DECISION_EFFECT.ASK) {
      const answered = await this.askAbout(line, ruling);
      if (answered !== null) return answered;
      // Somebody said yes, and that is a different row from a rule that never asked.
      ruling = {
        ...ruling,
        verdict: { ...ruling.verdict, effect: DECISION_EFFECT.ALLOW },
      };
      return this.proceed(command, line, decisionOf(ruling, true));
    }
    if (ruling.verdict.effect !== DECISION_EFFECT.ALLOW) {
      return {
        message: describe(ruling.verdict),
        exitCode: SHELL_EXIT_WITHHELD,
        decision: decisionOf(ruling, false),
      };
    }

    return this.proceed(command, line, decisionOf(ruling, false));
  }

  /**
   * Policy first, then coordination. A command the rules refuse never reaches the
   * register, so nothing can end up holding a path it was never allowed to write.
   */
  private async proceed(
    command: readonly string[],
    line: string,
    decision: ShellDecision,
  ): Promise<ShellOutcome> {
    const held = await this.claim(line);
    if (held !== null) {
      /* Recorded as a refusal, because it is one: the command did not run. The reason
         says it was another agent rather than a rule, so the two read differently. */
      return {
        ...held,
        decision: {
          ...decision,
          effect: DECISION_EFFECT.DENY,
          reason: held.message ?? 'held by another agent',
        },
      };
    }
    return { run: command, exitCode: SHELL_EXIT_OK, decision };
  }

  /**
   * Puts an ASK to a person. Null when it was allowed and the line may proceed.
   *
   * Withheld rather than run when nobody answers: a walk-away must not become a yes,
   * and a timeout is said differently from a refusal so the two read differently.
   */
  private async askAbout(line: string, ruling: Ruling): Promise<ShellOutcome | null> {
    const hold = this.deps.hold;
    if (hold === undefined) {
      return {
        message: `${describe(ruling.verdict)}\nNobody could be asked, so it was withheld. Run the agent under "memnox run".`,
        exitCode: SHELL_EXIT_WITHHELD,
        decision: decisionOf(ruling, false),
      };
    }

    const request = {
      sessionId: this.deps.sessionId ?? 'ses_local',
      agent: this.deps.agent ?? 'an agent',
      operation: ruling.action,
      fingerprint: digest(line),
      reason: ruling.verdict.reason,
      command: line,
    };
    const result = await hold.hold(request);
    if (holdAllowed(result)) return null;

    /* What actually happened, not the rule's own words. Every non-allow used to come
       back as the reason the rule gave for asking, so a person who refused, a person
       who answered a minute too late, and a machine with nobody to ask all produced
       one sentence — and the one it read as was "the rule refused you". `describeHold`
       has told these apart since it was written; nothing here was calling it. */
    const what = describeHold(result, request);
    const instead = alternativeIn(ruling.verdict);
    return {
      message: instead === null ? what : `${what} ${instead}`,
      exitCode: SHELL_EXIT_WITHHELD,
      decision: {
        ...decisionOf(ruling, true),
        effect: DECISION_EFFECT.DENY,
        // The ledger reads the same way `why` will: refused, and by what.
        reason: what,
      },
    };
  }

  /**
   * Takes the paths this line writes, or answers with who is already on them. Reads
   * never reach the register: `takesLease` decides that here, so there is no path
   * through this seam that can make a reader wait.
   */
  private async claim(
    line: string,
  ): Promise<{ message: string; exitCode: number } | null> {
    const leases = this.deps.leases;
    if (leases === undefined) return null;

    for (const resolved of resolveShellLine(line, this.deps.env ?? {}).actions) {
      if (!takesLease(String(resolved.class))) continue;
      const path = leasePathFor(
        resolved.target,
        leases.repositoryRoot,
        this.deps.workingDirectory ?? leases.repositoryRoot,
      );
      if (path === null) continue;

      const scope = leaseScopeFor(path, leases.isDirectory);
      const verdict = await leases.gate.claim(
        scope,
        leases.holder,
        `${resolved.action} ${resolved.target ?? ''}`.trim(),
      );
      if (proceeds(verdict)) continue;
      return {
        message: verdict.message ?? `${scope} is held by another agent.`,
        exitCode: SHELL_EXIT_WITHHELD,
      };
    }
    return null;
  }

  private requestFor(action: string, target: string): ActionRequest {
    return {
      action,
      target,
      // LOCAL ONLY. The SDK strips this before anything reaches the runtime.
      arguments: { command: target },
      ...(this.deps.sessionId === undefined ? {} : { sessionId: this.deps.sessionId }),
      ...(this.deps.workingDirectory === undefined
        ? {}
        : { workingDirectory: this.deps.workingDirectory }),
    };
  }
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
  };
}

/** The alternative rides all the way to the person, or the refusal is a dead end. */
function alternativeIn(verdict: HookVerdict): string | null {
  if (verdict.alternative === undefined) return null;
  const target =
    verdict.alternative.resource === undefined ? '' : ` ${verdict.alternative.resource}`;
  return `Instead: ${verdict.alternative.action}${target} — ${verdict.alternative.note}`;
}

function describe(verdict: HookVerdict): string {
  const parts = [verdict.reason];
  const instead = alternativeIn(verdict);
  if (instead !== null) {
    parts.push(instead);
  }
  if (verdict.approvalId !== undefined) {
    parts.push(`Ask a person: memnox approvals resolve ${verdict.approvalId} --by <you>`);
  }
  if (verdict.decisionId !== undefined)
    parts.push(`Why: memnox why ${verdict.decisionId}`);
  return parts.join(' ');
}
