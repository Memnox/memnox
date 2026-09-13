import { policiesFrom, POLICY_FILE_EXTENSION, recommendedAnswers } from '@memnox/core';
import { installInterceptors, INTERCEPT_BINARY } from '@memnox/interceptors';
import { mergeRules } from './protect/merge-rules';
import { installService } from './daemon/service';

/**
 * The three things that turn an enrolled machine into a governed one.
 *
 * `setup` connected the machine and put its agents under Memnox, and then
 * stopped: no wrapper was in the path of any command, no rule had an opinion
 * about anything, and nothing pulled the workspace's rules unless somebody kept
 * a terminal open. So the guided run ended by saying the agents were under
 * Memnox while `scan` on the next line still said none of their capabilities
 * was governed. Onboarding is consent; this is the wiring that consent was for.
 *
 * Nothing here is new machinery. Each step calls what already owns it, which is
 * what makes `memnox uninstall` able to take all three back out.
 */

export const WIRED = {
  DONE: 'done',
  /** The platform has no per-user service manager, which is not a failure. */
  UNSUPPORTED: 'unsupported',
  FAILED: 'failed',
} as const;

export type WiredState = (typeof WIRED)[keyof typeof WIRED];

export interface Wiring {
  /** Wrappers now in `~/.memnox/bin`. Zero means nothing is gated. */
  interceptors: number;
  /** Binaries a rule could cover that this machine does not have. */
  absent: number;
  rules: number;
  daemon: WiredState;
  /** Set when the service file was written but the manager would not take it. */
  daemonNote?: string;
}

export interface WiringSeams {
  interceptors?: typeof installInterceptors;
  service?: typeof installService;
  /** Injected so a test writes no policy file into the directory it runs in. */
  rules?: (home: string, cwd: string) => Promise<number>;
}

/**
 * The baseline every machine should start with: destructive work denied, work
 * somebody else sees held for a person, reads left alone.
 *
 * Merged rather than written over, because a machine that already has rules is
 * the ordinary case on the second run and replacing them would be this command
 * quietly undoing somebody's edits.
 */
async function writeBaseline(home: string, cwd: string): Promise<number> {
  const policies = policiesFrom(recommendedAnswers());
  const path = `${cwd}/memnox.policies${POLICY_FILE_EXTENSION}`;
  await mergeRules(path, policies, home);
  return policies.length;
}

export async function wireMachine(
  home: string,
  cwd: string,
  seams: WiringSeams = {},
): Promise<Wiring> {
  const installed = await (seams.interceptors ?? installInterceptors)(
    home,
    INTERCEPT_BINARY,
  );
  const rules = await (seams.rules ?? writeBaseline)(home, cwd);
  const service = await (seams.service ?? installService)(home);

  return {
    interceptors: installed.installed.length,
    absent: installed.absent.length,
    rules,
    daemon: daemonState(service),
    ...(service.warning === undefined ? {} : { daemonNote: service.warning }),
  };
}

function daemonState(service: Awaited<ReturnType<typeof installService>>): WiredState {
  if (!service.state.supported) return WIRED.UNSUPPORTED;
  return service.state.installed ? WIRED.DONE : WIRED.FAILED;
}
