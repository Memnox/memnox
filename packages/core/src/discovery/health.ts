import { ENFORCEMENT_MODE } from '../constants/enforcement.constants';

/**
 * Whether Memnox is wired to anything, as against installed, because every command runs
 * perfectly well on a machine where nothing is governed.
 */

export const CHECK = {
  OK: 'ok',
  /** Working, but not doing the thing somebody installed it for. */
  INERT: 'inert',
  /** Broken in a way that stops governance. */
  BROKEN: 'broken',
} as const;

export type CheckState = (typeof CHECK)[keyof typeof CHECK];

export const CHECK_NAME = {
  CONFIG: 'config',
  RULES: 'rules',
  INTERCEPTORS: 'interceptors',
  PATH: 'path',
  PROXY: 'proxy',
  DAEMON: 'daemon',
  LEDGER: 'ledger',
  /**
   * What stops work without a rule saying so: a paused session, a spent allowance, a held
   * path and an unanswered question. None appears in `why`, and all four look alike.
   */
  HOLDS: 'holds',
} as const;

export type CheckName = (typeof CHECK_NAME)[keyof typeof CHECK_NAME];

export interface HealthCheck {
  name: CheckName;
  state: CheckState;
  /** What is true, in one line. */
  detail: string;
  /** The command that fixes it. Absent only when there is nothing to fix. */
  fix?: string;
}

/**
 * What the caller found on the machine. Passed in rather than read, so every check
 * below is a pure function and the whole report is testable without a live install.
 */
export interface HealthFacts {
  /** The config file exists and parsed. */
  configFound: boolean;
  mode: string;
  /** Null when there is no rule file; the message when it would not load. */
  rulesPath: string | null;
  rulesError?: string;
  ruleCount: number;
  /** Content hash of the rule set, so two machines can be compared without diffing. */
  policyVersion: string;
  /**
   * Absolute paths of the rule files the seams actually load. A file nothing registered
   * is the worst state there is: `policy test` says DENY and every seam allows it.
   */
  registeredFiles: string[];
  /**
   * Rule files in the policies directory the registry does not name, which the seams
   * never load while they look exactly like one `memnox protect` wrote.
   */
  unregisteredRuleFiles: string[];
  /** Binaries present in the interceptor directory. */
  interceptorsInstalled: string[];
  /**
   * Binaries this machine has that the classifier can rule on, since `protect
   * --interceptors` wraps only what is installed and could never clear the rest.
   */
  interceptorsExpected: string[];
  /** True when the interceptor directory is ahead of the real binaries on PATH. */
  interceptorDirFirstOnPath: boolean;
  /**
   * Whether the binary every wrapper execs can be found, because without it each wrapped
   * command exits 127 and the agent is told `git: not found`.
   */
  interceptBinaryFound: boolean;
  /** MCP servers found, and how many are routed through the proxy. */
  mcpServers: number;
  mcpWrapped: number;
  /** Whether the daemon socket exists, and whether it answered. */
  daemonSocket: boolean;
  daemonAnswered: boolean;
  /** True when this machine is enrolled, so a heartbeat is something it owes. */
  enrolled: boolean;
  /** True when the machine starts the daemon itself, rather than a person doing it. */
  daemonStartsItself: boolean;
  /** Null when the database will not open; otherwise how many rows it holds. */
  ledgerEvents: number | null;
  /**
   * Recorded verdicts that did not simply proceed. In observe this is the work that
   * would have been stopped, which is what the decision to enforce is made on.
   */
  wouldHaveStopped: number;
  ledgerError?: string;
  /** Sessions the breaker is holding. Each one runs nothing until somebody lifts it. */
  pausedSessions: number;
  /** Calls waiting for a person right now. */
  waitingApprovals: number;
  /** Paths held by a session on this machine. */
  heldLeases: number;
  /** Budgets with nothing left in the window. Every action they cover is refused. */
  spentBudgets: string[];
}

/** What is being stopped for a reason that is not a rule, as one line rather than four empty rows. */
function holdsCheck(facts: HealthFacts): HealthCheck {
  if (facts.pausedSessions > 0) {
    return {
      name: CHECK_NAME.HOLDS,
      state: CHECK.BROKEN,
      detail: `${facts.pausedSessions} session(s) paused, running nothing until somebody lifts them`,
      fix: 'memnox paused, then memnox resume <session> --by <you>',
    };
  }
  if (facts.spentBudgets.length > 0) {
    return {
      name: CHECK_NAME.HOLDS,
      state: CHECK.BROKEN,
      // An allowance rather than a refusal, because the two send somebody to different places.
      detail: `no allowance left on: ${facts.spentBudgets.join(', ')}`,
      fix: 'memnox budget, to raise the limit, or wait for the window',
    };
  }
  if (facts.waitingApprovals > 0) {
    return {
      name: CHECK_NAME.HOLDS,
      state: CHECK.INERT,
      detail: `${facts.waitingApprovals} call(s) waiting for a person`,
      fix: 'memnox approvals',
    };
  }
  if (facts.heldLeases > 0) {
    return {
      name: CHECK_NAME.HOLDS,
      state: CHECK.OK,
      detail: `${facts.heldLeases} path(s) held by a session here`,
      fix: 'memnox lock --list',
    };
  }
  return {
    name: CHECK_NAME.HOLDS,
    state: CHECK.OK,
    detail: 'nothing is paused, waiting or out of allowance',
  };
}

function configCheck(facts: HealthFacts): HealthCheck {
  if (!facts.configFound) {
    return {
      name: CHECK_NAME.CONFIG,
      state: CHECK.OK,
      detail: 'no config yet; it is written on the first run and defaults to observe',
    };
  }
  if (facts.mode === ENFORCEMENT_MODE.OFF) {
    return {
      name: CHECK_NAME.CONFIG,
      state: CHECK.INERT,
      detail: 'mode is off, so nothing is evaluated at all',
      fix: 'memnox protect --observe',
    };
  }
  if (facts.mode === ENFORCEMENT_MODE.OBSERVE) return observeCheck(facts);
  return { name: CHECK_NAME.CONFIG, state: CHECK.OK, detail: `mode is ${facts.mode}` };
}

/**
 * Observe is the right default and can sit a month governing nothing while every row
 * stays green, so the count of what would have stopped is the reading to take.
 */
function observeCheck(facts: HealthFacts): HealthCheck {
  if (facts.wouldHaveStopped === 0) {
    return {
      name: CHECK_NAME.CONFIG,
      state: CHECK.OK,
      detail:
        facts.ledgerEvents === null || facts.ledgerEvents === 0
          ? 'mode is observe, and nothing has run under it yet'
          : `mode is observe, and none of ${facts.ledgerEvents} recorded action(s) would have been stopped`,
      fix: 'memnox run -- <agent>, and read it again in a week',
    };
  }
  return {
    name: CHECK_NAME.CONFIG,
    state: CHECK.OK,
    detail: `mode is observe, and ${facts.wouldHaveStopped} recorded verdict(s) would have stopped something`,
    fix: 'read them with "memnox timeline --only deny", then "memnox config set mode enforce"',
  };
}

function rulesCheck(facts: HealthFacts): HealthCheck {
  if (facts.rulesError !== undefined) {
    // An unreadable rule set is never an empty one, and "no rule covers this" would be a lie.
    return {
      name: CHECK_NAME.RULES,
      state: CHECK.BROKEN,
      detail: `rules will not load: ${facts.rulesError}`,
      fix: 'fix the file, or write a fresh one with "memnox protect --yes"',
    };
  }
  if (facts.rulesPath === null || facts.ruleCount === 0) {
    return {
      name: CHECK_NAME.RULES,
      state: CHECK.INERT,
      detail: 'no rules, so every action is allowed',
      fix: 'memnox protect --interactive',
    };
  }
  return registrationCheck(facts);
}

/** Rules that load, and whether the seams load them. */
function registrationCheck(facts: HealthFacts): HealthCheck {
  if (facts.registeredFiles.length === 0) {
    // Broken rather than ok, because "3 rules" beside an ungoverned machine is the lie.
    return {
      name: CHECK_NAME.RULES,
      state: CHECK.BROKEN,
      detail: `${facts.ruleCount} rule(s) in ${facts.rulesPath}, registered by nothing, so the seams load none of them`,
      fix: `memnox policy use ${facts.rulesPath}`,
    };
  }
  const loaded = `${facts.ruleCount} rule(s) from ${facts.rulesPath} · v${facts.policyVersion}`;
  if (facts.unregisteredRuleFiles.length > 0) {
    // Still ok, because what is registered is in force; the file is named so nobody needs `ls`.
    const [first] = facts.unregisteredRuleFiles;
    const rest = facts.unregisteredRuleFiles.length - 1;
    const which = rest > 0 ? `${first} and ${String(rest)} more` : String(first);
    return {
      name: CHECK_NAME.RULES,
      state: CHECK.OK,
      detail: `${loaded}, and ${which} is in the policies directory, registered by nothing, and loads for no seam: "memnox policy use" puts it in force`,
    };
  }
  // The version is what makes "4 laptops are on v3" answerable without diffing files.
  return { name: CHECK_NAME.RULES, state: CHECK.OK, detail: loaded };
}

function interceptorCheck(facts: HealthFacts): HealthCheck {
  const missing = facts.interceptorsExpected.filter(
    (binary) => !facts.interceptorsInstalled.includes(binary),
  );
  if (facts.interceptorsInstalled.length === 0) {
    return {
      name: CHECK_NAME.INTERCEPTORS,
      state: CHECK.INERT,
      detail: 'no interceptors installed, so shell and git commands are not seen',
      fix: 'memnox protect --interceptors',
    };
  }
  if (missing.length > 0) {
    return {
      name: CHECK_NAME.INTERCEPTORS,
      state: CHECK.BROKEN,
      detail: `${missing.length} missing: ${missing.join(', ')}`,
      fix: 'memnox protect --interceptors',
    };
  }
  // After the count, which hides it: every file is there and none can run.
  if (!facts.interceptBinaryFound) {
    return {
      name: CHECK_NAME.INTERCEPTORS,
      state: CHECK.BROKEN,
      detail: `${facts.interceptorsInstalled.length} installed, but "memnox-intercept" is not on PATH, so each one exits 127`,
      fix: 'reinstall the CLI, then "memnox protect --interceptors"',
    };
  }
  return {
    name: CHECK_NAME.INTERCEPTORS,
    state: CHECK.OK,
    detail: `${facts.interceptorsInstalled.length} installed`,
  };
}

function pathCheck(facts: HealthFacts): HealthCheck {
  if (facts.interceptorsInstalled.length === 0) {
    return {
      name: CHECK_NAME.PATH,
      state: CHECK.INERT,
      detail: 'nothing to put on PATH yet',
      fix: 'memnox protect --interceptors',
    };
  }
  if (!facts.interceptorDirFirstOnPath) {
    // Installed and unreachable is the worst of both: it looks governed and is not.
    return {
      name: CHECK_NAME.PATH,
      state: CHECK.BROKEN,
      detail: 'interceptors are installed but are not ahead of the real binaries on PATH',
      fix: 'start the agent with "memnox run -- <agent>", which sets PATH for it',
    };
  }
  return {
    name: CHECK_NAME.PATH,
    state: CHECK.OK,
    detail: 'interceptors come first on PATH',
  };
}

function proxyCheck(facts: HealthFacts): HealthCheck {
  if (facts.mcpServers === 0) {
    return {
      name: CHECK_NAME.PROXY,
      state: CHECK.OK,
      detail: 'no MCP servers on this machine, so there is nothing to route',
    };
  }
  if (facts.mcpWrapped === 0) {
    return {
      name: CHECK_NAME.PROXY,
      state: CHECK.INERT,
      detail: `${facts.mcpServers} MCP server(s), none routed through the proxy`,
      fix: 'memnox mcp wrap',
    };
  }
  if (facts.mcpWrapped < facts.mcpServers) {
    return {
      name: CHECK_NAME.PROXY,
      state: CHECK.BROKEN,
      detail: `${facts.mcpWrapped} of ${facts.mcpServers} routed; the rest are not seen`,
      fix: 'memnox mcp wrap',
    };
  }
  return {
    name: CHECK_NAME.PROXY,
    state: CHECK.OK,
    detail: `all ${facts.mcpServers} MCP server(s) routed through the proxy`,
  };
}

function daemonCheck(facts: HealthFacts): HealthCheck {
  if (!facts.daemonSocket) {
    // Optional for enforcement, since interceptors evaluate in process, but required once
    // enrolled, because only the daemon pulls rules and sends what happened.
    if (facts.enrolled && !facts.daemonStartsItself) {
      return {
        name: CHECK_NAME.DAEMON,
        state: CHECK.INERT,
        detail:
          'nothing starts it, so this machine pulls no rules and sends nothing until somebody runs it',
        fix: 'memnox daemon --install',
      };
    }
    return {
      name: CHECK_NAME.DAEMON,
      state: CHECK.OK,
      detail: facts.daemonStartsItself
        ? 'not running just now; the machine starts it and interceptors evaluate in process meanwhile'
        : 'not running; interceptors evaluate in process, which is the same rules',
      fix: 'memnox daemon, if you want them to pay a connect instead of a file read',
    };
  }
  if (!facts.daemonAnswered) {
    return {
      name: CHECK_NAME.DAEMON,
      state: CHECK.BROKEN,
      detail:
        'a socket is there but nothing answered, so it is stale from a killed daemon',
      fix: 'memnox daemon',
    };
  }
  return { name: CHECK_NAME.DAEMON, state: CHECK.OK, detail: 'running and answering' };
}

function ledgerCheck(facts: HealthFacts): HealthCheck {
  if (facts.ledgerError !== undefined) {
    return {
      name: CHECK_NAME.LEDGER,
      state: CHECK.BROKEN,
      detail: `the database will not open: ${facts.ledgerError}`,
      fix: 'move ~/.memnox/memnox.db aside; a new one is created on the next run',
    };
  }
  if (facts.ledgerEvents === 0) {
    return {
      name: CHECK_NAME.LEDGER,
      state: CHECK.INERT,
      detail: 'nothing recorded yet, so "memnox why" has nothing to explain',
      fix: 'memnox run -- <agent>, then use it',
    };
  }
  return {
    name: CHECK_NAME.LEDGER,
    state: CHECK.OK,
    detail: `${facts.ledgerEvents} event(s) recorded`,
  };
}

export function checkInstallation(facts: HealthFacts): HealthCheck[] {
  return [
    configCheck(facts),
    rulesCheck(facts),
    interceptorCheck(facts),
    pathCheck(facts),
    proxyCheck(facts),
    daemonCheck(facts),
    ledgerCheck(facts),
    holdsCheck(facts),
  ];
}

/**
 * The one sentence somebody needs. "Installed" and "governing something" are different
 * states, and a machine in the first is told so plainly rather than congratulated.
 */
export function summarizeHealth(checks: readonly HealthCheck[]): {
  state: CheckState;
  headline: string;
} {
  const broken = checks.filter((check) => check.state === CHECK.BROKEN);
  if (broken.length > 0) {
    return {
      state: CHECK.BROKEN,
      headline: `${broken.length} thing(s) are wired wrong. Nothing below is being governed as you expect.`,
    };
  }
  const inert = checks.filter((check) => check.state === CHECK.INERT);
  if (inert.length > 0) {
    return {
      state: CHECK.INERT,
      headline: `Memnox is installed but ${inert.length} thing(s) are not doing anything yet.`,
    };
  }
  return { state: CHECK.OK, headline: 'Memnox is wired up and governing this machine.' };
}
