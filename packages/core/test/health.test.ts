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
  interceptorsInstalled: ['git', 'rm'],
  interceptorsExpected: ['git', 'rm'],
  interceptorDirFirstOnPath: true,
  mcpServers: 2,
  mcpWrapped: 2,
  daemonSocket: true,
  daemonAnswered: true,
  ledgerEvents: 41,
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
