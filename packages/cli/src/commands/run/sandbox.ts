/**
 * The kernel's wall around a run: the profile `protect --os-guard` wrote, or an untrusted
 * session's own, held by seatbelt on macOS and by Landlock on Linux. Where neither is
 * available the run says so, and an untrusted one refuses to start without it.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname } from 'node:path';

import {
  guardFor,
  OS_GUARD,
  sandboxCommand,
  untrustedLandlockPlan,
  untrustedSeatbeltProfile,
  type ListDirectory,
  type UntrustedGuard,
} from '@memnox/core';
import {
  landlockCommand,
  landlockSupport,
  listDirectory,
  type LandlockSeams,
} from '../../landlock';
import {
  guardProfilePath,
  landlockRulesetPath,
  sessionGuardPath,
} from '../../memnox-paths';

const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const SEATBELT_EXTENSION = 'sb';
const PLAN_EXTENSION = 'json';

/** Every file an untrusted session's wall is written to, so the run can take them away. */
export const SESSION_GUARD_EXTENSIONS: readonly string[] = [
  SEATBELT_EXTENSION,
  PLAN_EXTENSION,
];

export interface GuardSeams extends LandlockSeams {
  /** Injected so a test states the directories rather than reading the disk. */
  list?: ListDirectory;
  exists?: (path: string) => boolean;
  /** Injected so a test writes no profile. */
  write?: (path: string, text: string) => void;
}

/** The command, and what the start screen says about the wall around it. */
export interface Sandboxed {
  command: readonly string[];
  /** Null where nothing is around it, with the reason in `because`. */
  guard: string | null;
  because: string;
}

/** Wrapped in the profile `protect --os-guard` wrote, when there is one and the kernel takes it. */
export function sandboxed(
  command: readonly string[],
  home: string,
  wanted: boolean,
  seams: GuardSeams = {},
): Sandboxed {
  if (!wanted) return { command, guard: null, because: 'not used' };
  const exists = seams.exists ?? existsSync;
  const kernel = seams.kernel ?? release();
  const support = guardFor(seams.platform ?? process.platform, kernel);
  if (support.guard === OS_GUARD.SEATBELT) {
    const profile = guardProfilePath(home);
    if (!exists(profile))
      return {
        command,
        guard: null,
        because: 'no profile yet: "memnox protect --os-guard"',
      };
    return {
      command: sandboxCommand(profile, command),
      guard: OS_GUARD.SEATBELT,
      because: 'inside the profile',
    };
  }
  if (support.guard !== OS_GUARD.LANDLOCK)
    return { command, guard: null, because: support.because };
  const plan = landlockRulesetPath(home);
  if (!exists(plan))
    return {
      command,
      guard: null,
      because: 'no ruleset yet: "memnox protect --os-guard"',
    };
  const landlock = landlockSupport(home, kernel, seams);
  if (landlock.abi === null) return { command, guard: null, because: landlock.because };
  return {
    command: landlockCommand(home, plan, command),
    guard: OS_GUARD.LANDLOCK,
    because: landlock.because,
  };
}

interface UntrustedSandboxInput {
  command: readonly string[];
  home: string;
  sessionId: string;
  guard: UntrustedGuard;
}

/** The untrusted session's own wall, written for this session, or the reason there is none. */
export function untrustedSandbox(
  input: UntrustedSandboxInput,
  seams: GuardSeams = {},
): Sandboxed {
  const { command, home, sessionId, guard } = input;
  const write = seams.write ?? writeOwnerOnly;
  const kernel = seams.kernel ?? release();
  const support = guardFor(seams.platform ?? process.platform, kernel);
  if (support.guard === OS_GUARD.SEATBELT) {
    const profile = sessionGuardPath(home, sessionId, SEATBELT_EXTENSION);
    write(profile, untrustedSeatbeltProfile(guard));
    return {
      command: sandboxCommand(profile, command),
      guard: OS_GUARD.SEATBELT,
      because: 'files, credentials and TCP',
    };
  }
  if (support.guard !== OS_GUARD.LANDLOCK)
    return { command, guard: null, because: support.because };
  const landlock = landlockSupport(home, kernel, seams);
  if (landlock.abi === null) return { command, guard: null, because: landlock.because };
  const plan = sessionGuardPath(home, sessionId, PLAN_EXTENSION);
  write(
    plan,
    `${JSON.stringify(untrustedLandlockPlan(guard, seams.list ?? listDirectory), null, 2)}\n`,
  );
  return {
    command: landlockCommand(home, plan, command),
    guard: OS_GUARD.LANDLOCK,
    because: landlock.because,
  };
}

function writeOwnerOnly(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR });
  writeFileSync(path, text, { encoding: 'utf8', mode: OWNER_ONLY_FILE });
}
