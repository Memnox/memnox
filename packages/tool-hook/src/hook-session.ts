import { DECISION_EFFECT } from '@memnox/core';
import type { HookAuthorizer } from './hook-authorizer';
import { encodeVerdict } from './hook-decision';
import { readHookInput } from './hook-input';
import { toActionRequest, type ToolActionOptions } from './tool-action';
import { EXIT_OK, EXIT_UNUSABLE_INPUT } from './tool-hook.constants';

export interface HookOutcome {
  /** Written verbatim to stdout. Empty means no opinion, and the host proceeds. */
  stdout: string;
  exitCode: number;
}

export interface HookSessionDeps {
  authorizer: HookAuthorizer;
  action?: ToolActionOptions;
  log: (message: string) => void;
}

/** Every path through one tool call, with stdin and stdout left to the caller. */
export class HookSession {
  constructor(private readonly deps: HookSessionDeps) {}

  async handle(raw: string): Promise<HookOutcome> {
    const input = readHookInput(raw);
    if (input === null) {
      // A configuration fault, never a verdict: a crash and a refusal must not look
      // the same to whoever reads the transcript afterwards.
      this.deps.log('unusable hook payload — this seam ruled on nothing');
      return { stdout: '', exitCode: EXIT_UNUSABLE_INPUT };
    }

    const request = toActionRequest(input, this.deps.action ?? {});
    if (request === null) {
      // Not a tool this seam holds. Named in HOOK_BLIND_SPOTS, not silently implied.
      return { stdout: '', exitCode: EXIT_OK };
    }

    const verdict = await this.deps.authorizer.authorize(request);
    if (verdict.effect !== DECISION_EFFECT.ALLOW) {
      this.deps.log(`${verdict.effect} ${request.action}: ${verdict.reason}`);
    }
    // Always exit 0: the JSON carries the verdict, and a non-zero code here would
    // read as a broken hook rather than a governed refusal.
    return { stdout: encodeVerdict(verdict), exitCode: EXIT_OK };
  }
}
