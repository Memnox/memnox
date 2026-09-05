import type { ActionRequest } from '@memnox/core';
import { DECISION_EFFECT, resolveShellLine } from '@memnox/core';
import type { HookAuthorizer, HookVerdict } from './hook-authorizer';

export const SHELL_ACTION = 'shell.execute';

export interface ShellOutcome {
  /** The command to run, present only when it may proceed. */
  run?: readonly string[];
  /** Printed on stderr. A refusal that explains nothing gets the wrapper removed. */
  message?: string;
  exitCode: number;
}

export const SHELL_EXIT_OK = 0;
export const SHELL_EXIT_WITHHELD = 77;

export interface ShellSeamDeps {
  authorizer: HookAuthorizer;
  sessionId?: string;
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

/** Deny beats ask beats allow, so a line is ruled by its worst command and not its last. */
const SEVERITY: Record<string, number> = {
  [DECISION_EFFECT.ALLOW]: 0,
  [DECISION_EFFECT.ASK]: 1,
  [DECISION_EFFECT.DENY]: 2,
};

function worse(a: HookVerdict, b: HookVerdict): HookVerdict {
  return (SEVERITY[b.effect] ?? 0) > (SEVERITY[a.effect] ?? 0) ? b : a;
}

/**
 * Gates a command and then gets out of the way. It never rewrites what was asked for:
 * a modified command is a bug the person cannot see and the reader cannot audit.
 *
 * Every command in the line is resolved through the one resolver in core, so a rule
 * named `gh.pr-merge` — which is what `protect --for gh` writes and what `explain`
 * promises — fires here too. Ruling on the raw line alone would have made every screen
 * that names a CLI verb describe a gate that never closes.
 */
export class ShellSeam {
  constructor(private readonly deps: ShellSeamDeps) {}

  async gate(command: readonly string[]): Promise<ShellOutcome> {
    if (command.length === 0) {
      return { message: 'no command to run', exitCode: SHELL_EXIT_WITHHELD };
    }

    const line = command.join(' ');
    /* The whole line is still ruled on: a `shell.execute` rule matching `*rm -rf /*`
       has to keep firing, and it is the only thing that can see a pipeline as a whole. */
    let verdict = await this.deps.authorizer.authorize(
      this.requestFor(SHELL_ACTION, line),
    );

    for (const resolved of resolveShellLine(line, this.deps.env ?? {}).actions) {
      if (resolved.action === SHELL_ACTION) continue;
      const request = this.requestFor(resolved.action, resolved.target ?? line);
      verdict = worse(verdict, await this.deps.authorizer.authorize(request));
    }

    if (verdict.effect === DECISION_EFFECT.ALLOW) {
      return { run: command, exitCode: SHELL_EXIT_OK };
    }
    return { message: describe(verdict), exitCode: SHELL_EXIT_WITHHELD };
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

/** The alternative rides all the way to the person, or the refusal is a dead end. */
function describe(verdict: HookVerdict): string {
  const parts = [verdict.reason];
  if (verdict.alternative !== undefined) {
    const target =
      verdict.alternative.resource === undefined
        ? ''
        : ` ${verdict.alternative.resource}`;
    parts.push(
      `Instead: ${verdict.alternative.action}${target} — ${verdict.alternative.note}`,
    );
  }
  if (verdict.approvalId !== undefined) {
    parts.push(`Ask a person: memnox approvals resolve ${verdict.approvalId} --by <you>`);
  }
  if (verdict.decisionId !== undefined)
    parts.push(`Why: memnox why ${verdict.decisionId}`);
  return parts.join(' ');
}
