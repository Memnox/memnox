import { describe, expect, it } from 'vitest';
import {
  CHECK,
  CHECK_NAME,
  checkInstallation,
  summarizeHealth,
  type HealthFacts,
} from '../src/discovery/health';

const HEALTHY: HealthFacts = {
  configFound: true,
  mode: 'enforce',
  rulesPath: 'memnox.policies.toml',
  ruleCount: 5,
  policyVersion: 'a1b2c3',
  unregisteredRuleFiles: [],
  registeredFiles: ['/work/api/memnox.policies.toml'],
  interceptorsInstalled: ['git', 'rm'],
  interceptorsExpected: ['git', 'rm'],
  interceptorDirFirstOnPath: true,
  mcpServers: 2,
  mcpWrapped: 2,
  daemonSocket: true,
  daemonAnswered: true,
  ledgerEvents: 41,
  pausedSessions: 0,
  waitingApprovals: 0,
  heldLeases: 0,
  spentBudgets: [],
};

const check = (facts: Partial<HealthFacts>, name: string) =>
  checkInstallation({ ...HEALTHY, ...facts }).find((each) => each.name === name);

describe('is this machine actually being governed', () => {
  it('says so plainly when everything is wired', () => {
    const checks = checkInstallation(HEALTHY);
    expect(checks.every((each) => each.state === CHECK.OK)).toBe(true);
    expect(summarizeHealth(checks).headline).toContain('governing this machine');
  });

  it('gives every failure a command that fixes it', () => {
    const checks = checkInstallation({
      ...HEALTHY,
      rulesPath: null,
      ruleCount: 0,
      interceptorsInstalled: [],
      mcpWrapped: 0,
      ledgerEvents: 0,
    });
    for (const each of checks.filter((c) => c.state !== CHECK.OK)) {
      expect(each.fix, `${each.name} has no fix line`).toBeDefined();
    }
  });
});

describe('the checks that catch a machine that only looks governed', () => {
  it('calls installed-but-not-on-PATH broken, because it looks governed and is not', () => {
    const path = check({ interceptorDirFirstOnPath: false }, CHECK_NAME.PATH);
    expect(path?.state).toBe(CHECK.BROKEN);
    expect(path?.fix).toContain('memnox run');
  });

  it('catches MCP servers only half routed', () => {
    const proxy = check({ mcpServers: 3, mcpWrapped: 1 }, CHECK_NAME.PROXY);
    expect(proxy?.state).toBe(CHECK.BROKEN);
    expect(proxy?.detail).toContain('the rest are not seen');
  });

  it('never reports rules that would not parse as no rules at all', () => {
    const rules = check(
      { rulesError: 'line 12: unexpected token', ruleCount: 0 },
      CHECK_NAME.RULES,
    );
    expect(rules?.state).toBe(CHECK.BROKEN);
    expect(rules?.detail).toContain('will not load');
    expect(rules?.detail).not.toContain('no rules');
  });

  it('calls mode off inert, because nothing is evaluated at all', () => {
    const config = check({ mode: 'off' }, CHECK_NAME.CONFIG);
    expect(config?.state).toBe(CHECK.INERT);
    expect(config?.fix).toContain('--observe');
  });

  it('treats observe as fine, and still names the next step', () => {
    const config = check({ mode: 'observe' }, CHECK_NAME.CONFIG);
    expect(config?.state).toBe(CHECK.OK);
    expect(config?.fix).toContain('--enforce');
  });

  it('flags a missing interceptor rather than counting the ones that are there', () => {
    const interceptors = check(
      { interceptorsInstalled: ['git'], interceptorsExpected: ['git', 'rm', 'curl'] },
      CHECK_NAME.INTERCEPTORS,
    );
    expect(interceptors?.state).toBe(CHECK.BROKEN);
    expect(interceptors?.detail).toContain('rm, curl');
  });
});

describe('the daemon, which is optional on purpose', () => {
  it('is fine when it is not running, and says why', () => {
    const daemon = check(
      { daemonSocket: false, daemonAnswered: false },
      CHECK_NAME.DAEMON,
    );
    expect(daemon?.state).toBe(CHECK.OK);
    expect(daemon?.detail).toContain('same rules');
  });

  it('is broken when a stale socket is left behind by a killed daemon', () => {
    const daemon = check(
      { daemonSocket: true, daemonAnswered: false },
      CHECK_NAME.DAEMON,
    );
    expect(daemon?.state).toBe(CHECK.BROKEN);
    expect(daemon?.detail).toContain('stale');
  });
});

describe('the ledger', () => {
  it('says a database that will not open is broken, and how to get a new one', () => {
    const ledger = check(
      { ledgerEvents: null, ledgerError: 'file is not a database' },
      CHECK_NAME.LEDGER,
    );
    expect(ledger?.state).toBe(CHECK.BROKEN);
    expect(ledger?.fix).toContain('memnox.db');
  });

  it('says an empty ledger means why has nothing to explain', () => {
    expect(check({ ledgerEvents: 0 }, CHECK_NAME.LEDGER)?.state).toBe(CHECK.INERT);
  });
});

describe('the one sentence at the top', () => {
  it('never congratulates a machine that is installed and inert', () => {
    const checks = checkInstallation({ ...HEALTHY, mcpWrapped: 0 });
    const { state, headline } = summarizeHealth(checks);
    expect(state).toBe(CHECK.INERT);
    expect(headline).toContain('not doing anything yet');
  });

  it('leads with broken over inert, because broken is the worse surprise', () => {
    const checks = checkInstallation({
      ...HEALTHY,
      mcpWrapped: 0,
      interceptorDirFirstOnPath: false,
    });
    expect(summarizeHealth(checks).state).toBe(CHECK.BROKEN);
  });
});

describe('rules that nothing loads', () => {
  /* The state this whole check exists to refuse to print a clean number about: the
     file is here, `policy test` answers from it, and no seam has ever opened it. */
  it('is broken, not ok, when a readable rule file is registered by nothing', () => {
    const checks = checkInstallation({ ...HEALTHY, registeredFiles: [] });
    const rules = checks.find((each) => each.name === CHECK_NAME.RULES);

    expect(rules?.state).toBe(CHECK.BROKEN);
    expect(rules?.detail).toContain('registered by nothing');
    expect(rules?.fix).toBe('memnox policy use memnox.policies.toml');
  });

  it('still reports no rules as inert rather than broken', () => {
    const checks = checkInstallation({
      ...HEALTHY,
      rulesPath: null,
      ruleCount: 0,
      registeredFiles: [],
    });

    expect(checks.find((each) => each.name === CHECK_NAME.RULES)?.state).toBe(
      CHECK.INERT,
    );
  });
});

describe('what is stopping work for a reason that is not a rule', () => {
  /* A paused session, a spent allowance and an unanswered question all look identical
     from inside an agent: it asked, and nothing happened. None is a policy decision,
     so none appears in `why`, and without this the honest answer would be a shrug. */
  it('says a paused session is why nothing is running', () => {
    const held = check({ pausedSessions: 2 }, CHECK_NAME.HOLDS);
    expect(held?.state).toBe(CHECK.BROKEN);
    expect(held?.detail).toContain('2 session(s) paused');
    expect(held?.fix).toContain('memnox resume');
  });

  it('names the budget that has nothing left, as an allowance and not a refusal', () => {
    const held = check({ spentBudgets: ['production deploys'] }, CHECK_NAME.HOLDS);
    expect(held?.state).toBe(CHECK.BROKEN);
    expect(held?.detail).toContain('no allowance left');
    expect(held?.detail).toContain('production deploys');
  });

  it('reports a question nobody has answered', () => {
    const held = check({ waitingApprovals: 3 }, CHECK_NAME.HOLDS);
    expect(held?.state).toBe(CHECK.INERT);
    expect(held?.fix).toBe('memnox approvals');
  });

  /* A held path is ordinary rather than wrong, so it is reported without being
     called a problem — a machine doing normal work must not read as broken. */
  it('mentions a held path without calling it a fault', () => {
    const held = check({ heldLeases: 1 }, CHECK_NAME.HOLDS);
    expect(held?.state).toBe(CHECK.OK);
    expect(held?.detail).toContain('1 path(s) held');
  });

  it('leads with the pause when several things are true at once', () => {
    const held = check(
      { pausedSessions: 1, spentBudgets: ['x'], waitingApprovals: 4 },
      CHECK_NAME.HOLDS,
    );
    expect(held?.detail).toContain('paused');
  });

  it('says plainly that nothing is held on an ordinary machine', () => {
    expect(check({}, CHECK_NAME.HOLDS)?.state).toBe(CHECK.OK);
    expect(check({}, CHECK_NAME.HOLDS)?.detail).toContain('nothing is paused');
  });
});

/**
 * Two ways this check told somebody they were safe when they were not.
 *
 * The count came from the project's own rule file and nothing else, so every rule
 * `memnox protect --apply` writes into the registry was invisible: a laptop with
 * four denies actually in force read "no rules, so every action is allowed". And a
 * file hand-written into the policies directory is loaded by no seam, which looks
 * identical to one that is.
 */
describe('rules the seams load, and files they do not', () => {
  const withRules = (over: Partial<HealthFacts>) =>
    checkInstallation({ ...HEALTHY, ...over }).find(
      (check) => check.name === CHECK_NAME.RULES,
    ) as ReturnType<typeof checkInstallation>[number];

  it('counts what the registry holds, not only the project file', () => {
    const check = withRules({
      rulesPath: 'policies.json',
      ruleCount: 4,
      registeredFiles: ['/home/nia/.memnox/policies/deny-ssh.yaml'],
    });

    expect(check.state).toBe(CHECK.OK);
    expect(check.detail).toContain('4 rule(s)');
  });

  /* The sentence this whole check exists to avoid printing wrongly. */
  it('says every action is allowed only when nothing is in force', () => {
    expect(withRules({ rulesPath: null, ruleCount: 0 }).detail).toContain(
      'every action is allowed',
    );
    expect(
      withRules({
        rulesPath: 'policies.json',
        ruleCount: 4,
        registeredFiles: ['/home/nia/.memnox/policies/deny-ssh.yaml'],
      }).detail,
    ).not.toContain('every action is allowed');
  });

  it('names a rule file the registry does not, and how to put it in force', () => {
    const check = withRules({
      rulesPath: 'policies.json',
      ruleCount: 4,
      registeredFiles: ['/home/nia/.memnox/policies/deny-ssh.yaml'],
      unregisteredRuleFiles: ['/home/nia/.memnox/policies/mine.yaml'],
    });

    expect(check.detail).toContain('mine.yaml');
    expect(check.detail).toContain('registered by nothing');
    expect(check.detail).toContain('memnox policy use');
  });

  /* Still ok: what is registered is in force, so this is not a broken machine. */
  it('stays ok, because the registered rules are still governing', () => {
    expect(
      withRules({
        rulesPath: 'policies.json',
        ruleCount: 4,
        registeredFiles: ['/home/nia/.memnox/policies/deny-ssh.yaml'],
        unregisteredRuleFiles: ['/home/nia/.memnox/policies/mine.yaml'],
      }).state,
    ).toBe(CHECK.OK);
  });

  it('counts the others rather than listing every one', () => {
    const check = withRules({
      rulesPath: 'policies.json',
      ruleCount: 4,
      registeredFiles: ['/home/nia/.memnox/policies/deny-ssh.yaml'],
      unregisteredRuleFiles: ['/a/one.yaml', '/a/two.yaml', '/a/three.yaml'],
    });

    expect(check.detail).toContain('one.yaml');
    expect(check.detail).toContain('2 more');
  });
});
