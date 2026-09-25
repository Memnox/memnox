/**
 * `memnox run --untrusted`: the preset for a repository nobody here has vouched for.
 * Writes reach the repository and temp only, credentials and home dotfiles are unreadable,
 * TCP reaches the egress proxy only, and every outward or destructive action asks.
 */
import { basename, join } from 'node:path';

import { MEMNOX_HOME, type UntrustedGuard } from '@memnox/core';
import { POLICY_FILES } from '../../policy-path';

/** What the agent itself keeps under the home, by prefix, which it cannot start without. */
const AGENT_STATE: Readonly<Record<string, readonly string[]>> = {
  claude: ['.claude'],
  codex: ['.codex'],
  'cursor-agent': ['.cursor'],
  gemini: ['.gemini'],
};

/**
 * Where agents and their runtimes are installed under the home, which has to stay
 * readable or nothing starts: node under nvm, a CLI under ~/.local/bin. Each holds
 * programs and no credentials, which is why `.cargo/bin` is here and `.cargo` is not.
 */
const TOOLCHAINS: readonly string[] = [
  '.nvm',
  '.fnm',
  '.volta',
  '.bun',
  '.deno',
  '.pyenv',
  '.rbenv',
  '.asdf',
  '.rustup',
  '.npm-global',
  join('.cargo', 'bin'),
  join('.local', 'bin'),
  join('.local', 'share', 'claude'),
  join('.local', 'share', 'pnpm'),
];

/** Credentials that are not dotfiles, and so are not covered by refusing those. */
const UNREADABLE: readonly string[] = [
  join('Library', 'Keychains'),
  join('Library', 'Cookies'),
  join('Library', 'Application Support', 'Google', 'Chrome'),
  join('Library', 'Application Support', 'Firefox'),
  join('Library', 'Application Support', 'com.apple.TCC'),
];

/** Package manager caches, pointed into the session's temp, since the home is not writable. */
const CACHE_VARIABLES: readonly string[] = [
  'npm_config_cache',
  'YARN_CACHE_FOLDER',
  'PIP_CACHE_DIR',
  'GOCACHE',
  'GOMODCACHE',
];

/**
 * Under the Memnox home and still refused: the rules, the trust given, and the answers to
 * held calls, which an agent able to write would approve itself. The rule files likewise.
 */
const PROTECTED: readonly string[] = [
  'policies.json',
  'policies',
  'config.toml',
  'account.json',
  'probation.json',
  'overlays.json',
  'kept.json',
  'pending',
  'guard',
  'containment',
  'tasks',
  'bin',
];

/** Writable everywhere an agent writes a device: a terminal, and /dev/null. */
const DEVICES = '/dev';

interface UntrustedInput {
  home: string;
  /** The repository the session starts in, or the directory when it is not one. */
  workspace: string;
  /** Temp, resolved, since seatbelt matches `/private/var` rather than `/var`. */
  temps: readonly string[];
  /** The session's own scratch directory, where the caches go. */
  scratch: string;
  binary: string;
  proxyPort: number;
}

interface UntrustedPreset {
  guard: UntrustedGuard;
  /** Added to the agent's environment. */
  env: Record<string, string>;
}

/** The whole preset, as data: the kernel's walls and the environment that fits inside them. */
export function untrustedPreset(input: UntrustedInput): UntrustedPreset {
  const { home } = input;
  const own = (AGENT_STATE[basename(input.binary)] ?? []).map((each) => join(home, each));
  const memnox = join(home, MEMNOX_HOME);
  return {
    guard: {
      home,
      writable: [input.workspace, ...input.temps, input.scratch, DEVICES, memnox],
      // Memnox readable so a seam inside finds its rules, and writable for the ledger.
      readable: [memnox, ...TOOLCHAINS.map((each) => join(home, each))],
      unreadable: UNREADABLE.map((each) => join(home, each)),
      unwritable: [
        ...PROTECTED.map((each) => join(memnox, each)),
        ...POLICY_FILES.map((each) => join(input.workspace, each)),
      ],
      statePrefixes: own,
      proxyPort: input.proxyPort,
      workspace: input.workspace,
    },
    env: Object.fromEntries(
      CACHE_VARIABLES.map((name) => [name, join(input.scratch, name.toLowerCase())]),
    ),
  };
}
