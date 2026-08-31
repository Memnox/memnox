import { describe, expect, it } from 'vitest';
import {
  installDrift,
  isEnrollable,
  OWNER_STATUS,
  REGISTERED_VIA,
  SUBJECT_KIND,
  summarizeCensus,
  type CensusEntry,
  type Install,
  type Subject,
} from '../src/subject';

const agent = (over: Partial<Subject> = {}): Subject => ({
  id: 'sub_1',
  orgId: 'org_1',
  kind: SUBJECT_KIND.AGENT,
  displayName: 'release bot',
  ownerId: 'sub_moise',
  registeredVia: REGISTERED_VIA.ENROLMENT,
  agentKind: 'claude-code',
  roleId: 'release-engineer',
  principalId: 'sub_moise',
  ...over,
});

const entry = (over: Partial<CensusEntry> = {}): CensusEntry => ({
  source: REGISTERED_VIA.ENROLMENT,
  evidence: '~/.claude.json',
  reach: { production: false, customerData: false, destructive: false },
  governable: true,
  ownerStatus: OWNER_STATUS.NAMED,
  firstSeen: '2026-08-31T09:00:00.000Z',
  ...over,
});

describe('identity in three parts', () => {
  it('enrolls an agent that has a kind, a role and a principal', () => {
    expect(isEnrollable(agent())).toBe(true);
  });

  it('refuses one with a product and no job, which is the unmanaged category', () => {
    expect(isEnrollable(agent({ roleId: undefined }))).toBe(false);
  });

  it('refuses one that acts for nobody, because an incident must name a human', () => {
    expect(isEnrollable(agent({ principalId: undefined }))).toBe(false);
  });

  it('asks none of it of a person', () => {
    expect(isEnrollable({ ...agent(), kind: SUBJECT_KIND.HUMAN })).toBe(true);
  });
});

describe('the census', () => {
  it('counts what it cannot govern rather than dropping it', () => {
    const summary = summarizeCensus([
      entry(),
      entry({
        source: REGISTERED_VIA.VENDOR,
        governable: false,
        ownerStatus: OWNER_STATUS.UNKNOWN,
      }),
      entry({
        source: REGISTERED_VIA.PIPELINE,
        reach: { production: true, customerData: false, destructive: true },
      }),
    ]);

    expect(summary.total).toBe(3);
    expect(summary.ungovernable).toBe(1);
    expect(summary.noNamedOwner).toBe(1);
    expect(summary.reachProduction).toBe(1);
    expect(summary.destructive).toBe(1);
  });

  it('records an entry before a subject exists, so nothing is an absence', () => {
    const unmanaged = entry({ subjectId: undefined, governable: false });

    expect(summarizeCensus([unmanaged]).total).toBe(1);
  });

  it('names the sources the count came from, so every row links to evidence', () => {
    const summary = summarizeCensus([
      entry(),
      entry({ source: REGISTERED_VIA.PROVIDER }),
    ]);

    expect(summary.bySource).toEqual({ enrolment: 1, provider: 1 });
  });
});

describe('the fleet', () => {
  const install = (id: string, version: string): Install => ({
    id,
    orgId: 'org_1',
    subjectIds: ['sub_1'],
    hostLabel: id,
    runtimeVersion: '0.3.1',
    seams: [],
    policyBundleVersion: version,
    lastSeenAt: '2026-08-31T09:00:00.000Z',
  });

  it('names the one machine that drifted, not the thirty-nine that did not', () => {
    const installs = [
      ...Array.from({ length: 39 }, (_, index) => install(`host-${index}`, 'v9')),
      install('host-odd', 'v4'),
    ];

    expect(installDrift(installs).map((each) => each.id)).toEqual(['host-odd']);
  });
});
