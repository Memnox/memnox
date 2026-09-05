/**
 * Whether Memnox is actually wired to anything, as opposed to installed. The two are
 * easy to confuse: every command below runs perfectly well on a machine where nothing
 * is being governed, and a doctor that reported a clean bill on that machine would be
 * the most expensive lie this product could tell.
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
  /** Binaries present in the interceptor directory. */
  interceptorsInstalled: string[];
  /** Binaries the classifier knows how to rule on. */
  interceptorsExpected: string[];
  /** True when the interceptor directory is ahead of the real binaries on PATH. */
  interceptorDirFirstOnPath: boolean;
  /** MCP servers found, and how many are routed through the proxy. */
  mcpServers: number;
  mcpWrapped: number;
  /** Whether the daemon socket exists, and whether it answered. */
  daemonSocket: boolean;
  daemonAnswered: boolean;
  /** Null when the database will not open; otherwise how many rows it holds. */
  ledgerEvents: number | null;
  ledgerError?: string;
}

function configCheck(facts: HealthFacts): HealthCheck {
  if (!facts.configFound) {
    return {
      name: CHECK_NAME.CONFIG,
      state: CHECK.OK,
      detail: 'no config yet; it is written on the first run and defaults to observe',
    };
  }
  if (facts.mode === 'off') {
    return {
      name: CHECK_NAME.CONFIG,
      state: CHECK.INERT,
      detail: 'mode is off, so nothing is evaluated at all',
      fix: 'memnox protect --observe',
    };
  }
  if (facts.mode === 'observe') {
    return {
      name: CHECK_NAME.CONFIG,
      state: CHECK.OK,
      detail: 'mode is observe — verdicts are recorded and nothing is denied',
      fix: 'memnox protect --enforce, once the verdicts look right',
    };
  }
  return { name: CHECK_NAME.CONFIG, state: CHECK.OK, detail: `mode is ${facts.mode}` };
}

function rulesCheck(facts: HealthFacts): HealthCheck {
  if (facts.rulesError !== undefined) {
    /* An unreadable rule set is never an empty one. Reporting "no rule covers this"
       about a machine whose rules simply failed to parse is a lie the reader acts on. */
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
  return {
    name: CHECK_NAME.RULES,
    state: CHECK.OK,
    detail: `${facts.ruleCount} rule(s) from ${facts.rulesPath}`,
  };
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
    /* Installed and unreachable is the worst of both: it looks governed and is not. */
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
    // Optional by design: an interceptor with no daemon evaluates in process.
    return {
      name: CHECK_NAME.DAEMON,
      state: CHECK.OK,
      detail: 'not running; interceptors evaluate in process, which is the same rules',
      fix: 'memnox daemon, if you want them to pay a connect instead of a file read',
    };
  }
  if (!facts.daemonAnswered) {
    return {
      name: CHECK_NAME.DAEMON,
      state: CHECK.BROKEN,
      detail: 'a socket is there but nothing answered — a stale one from a killed daemon',
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
