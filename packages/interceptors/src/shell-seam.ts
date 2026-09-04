import type { ActionRequest } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { HookAuthorizer, HookVerdict } from './hook-authorizer';

export const SHELL_ACTION = 'shell.execute';

/** Declared, and shown wherever coverage is reported. */
export const SHELL_BLIND_SPOTS: readonly string[] = [
  'anything the command does once it is allowed to start',
  'a shell started without this wrapper in front of it',
  'a command built at runtime inside the shell it starts',
];

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
}

/**
 * Gates a command and then gets out of the way. It never rewrites what was asked for:
 * a modified command is a bug the person cannot see and the reader cannot audit.
 */
export class ShellSeam {
  constructor(private readonly deps: ShellSeamDeps) {}

  async gate(command: readonly string[]): Promise<ShellOutcome> {
    if (command.length === 0) {
      return { message: 'no command to run', exitCode: SHELL_EXIT_WITHHELD };
    }

    const line = command.join(' ');
    const request: ActionRequest = {
      action: SHELL_ACTION,
      target: line,
      // LOCAL ONLY. The SDK strips this before anything reaches the runtime.
      arguments: { command: line },
      ...(this.deps.sessionId === undefined ? {} : { sessionId: this.deps.sessionId }),
      ...(this.deps.workingDirectory === undefined
        ? {}
        : { workingDirectory: this.deps.workingDirectory }),
    };

    const verdict = await this.deps.authorizer.authorize(request);
    if (verdict.effect === DECISION_EFFECT.ALLOW) {
      return { run: command, exitCode: SHELL_EXIT_OK };
    }
    return { message: describe(verdict), exitCode: SHELL_EXIT_WITHHELD };
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
