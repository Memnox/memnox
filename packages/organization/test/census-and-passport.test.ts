import { describe, expect, it } from 'vitest';
import {
  CENSUS_SOURCES,
  censusGap,
  takeCensus,
  ungovernable,
  type CensusSource,
} from '../src/census';
import { assemblePassport, passportGaps } from '../src/passport';
import {
  OWNER_STATUS,
  REGISTERED_VIA,
  SUBJECT_KIND,
  type CensusEntry,
  type Subject,
} from '../src/subject';

const entry = (over: Partial<CensusEntry> = {}): CensusEntry => ({
  source: REGISTERED_VIA.ENROLMENT,
  evidence: 'agent:agt_1',
  reach: { production: false, customerData: false, destructive: false },
  governable: true,
  ownerStatus: OWNER_STATUS.NAMED,
  firstSeen: '2026-08-31T09:00:00.000Z',
  ...over,
});

const source = (kind: CensusSource['kind'], entries: CensusEntry[]): CensusSource => ({
  kind,
  collect: async () => entries,
});

describe('taking a census', () => {
  it('gathers from every source it can read', async () => {
    const result = await takeCensus([
      source(REGISTERED_VIA.ENROLMENT, [entry()]),
      source(REGISTERED_VIA.VENDOR, [
        entry({ evidence: 'vendor:acme', governable: false }),
      ]),
    ]);

    expect(result.entries).toHaveLength(2);
    expect(result.unavailable).toEqual([]);
  });

  it('names a source it could not read, so a small number is not read as a clean one', async () => {
    const broken: CensusSource = {
      kind: REGISTERED_VIA.PROVIDER,
      collect: async () => {
        throw new Error('401');
      },
    };

    const result = await takeCensus([
      source(REGISTERED_VIA.ENROLMENT, [entry()]),
      broken,
    ]);

    expect(result.entries).toHaveLength(1);
    expect(result.unavailable).toEqual([REGISTERED_VIA.PROVIDER]);
  });

  it('counts one agent once when two sources both see it', async () => {
    const result = await takeCensus([
      source(REGISTERED_VIA.ENROLMENT, [entry({ ownerStatus: OWNER_STATUS.UNKNOWN })]),
      source(REGISTERED_VIA.PROVIDER, [
        entry({ source: REGISTERED_VIA.PROVIDER, ownerStatus: OWNER_STATUS.NAMED }),
      ]),
    ]);

    expect(result.entries).toHaveLength(1);
    // A named owner beats an unknown one; merging must not lose the better answer.
    expect(result.entries[0]?.ownerStatus).toBe(OWNER_STATUS.NAMED);
  });

  it('takes the widest reach when sources disagree, never the narrowest', async () => {
    const result = await takeCensus([
      source(REGISTERED_VIA.ENROLMENT, [entry()]),
      source(REGISTERED_VIA.PIPELINE, [
        entry({
          source: REGISTERED_VIA.PIPELINE,
          reach: { production: true, customerData: false, destructive: true },
        }),
      ]),
    ]);

    expect(result.entries[0]?.reach).toEqual({
      production: true,
      customerData: false,
      destructive: true,
    });
  });

  it('names the ungovernable rather than dropping them', async () => {
    const result = await takeCensus([
      source(REGISTERED_VIA.VENDOR, [
        entry({ evidence: 'vendor:acme', governable: false }),
      ]),
    ]);

    expect(ungovernable(result.entries)).toHaveLength(1);
  });

  it('reports the gap against the number they thought they had', () => {
    expect(censusGap([entry(), entry({ evidence: 'b' })], 1)).toBe(1);
  });

  it('has exactly four sources, because a fifth would be a new kind of evidence', () => {
    expect(CENSUS_SOURCES).toHaveLength(4);
  });
});

describe('the passport', () => {
  const subject: Subject = {
    id: 'sub_1',
    orgId: 'org_1',
    kind: SUBJECT_KIND.AGENT,
    displayName: 'release bot',
    registeredVia: REGISTERED_VIA.ENROLMENT,
    agentKind: 'claude-code',
  };

  it('is empty where a phase has nothing to say, rather than inventing a value', () => {
    const passport = assemblePassport({ subject });

    expect(passport.seams).toEqual([]);
    expect(passport.autonomyLevel).toBeUndefined();
  });

  it('names what is missing before this agent counts as managed', () => {
    const gaps = passportGaps(assemblePassport({ subject }));

    expect(gaps).toContain('no role: policy has nothing to attach to');
    expect(gaps).toContain('acts for nobody');
    expect(gaps).toContain('no seam watches it');
  });

  it('has nothing to say about a fully managed agent', () => {
    const passport = assemblePassport({
      subject: { ...subject, roleId: 'release-engineer', principalId: 'moise' },
      owner: 'moise',
      seams: [{ kind: 'mcp_proxy', mode: 'enforce', blindTo: [] }],
      autonomyLevel: 2,
    });

    expect(passportGaps(passport)).toEqual([]);
  });
});
