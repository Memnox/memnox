import { describe, expect, it } from 'vitest';
import {
  STATED_KIND,
  STATED_PROVENANCE,
  candidateStatement,
  isBinding,
  mayRead,
  readableFacts,
  rejectStatement,
  resolveOwnership,
  searchStatements,
  supersede,
  verifiedStatement,
  verifyStatement,
  type Stated,
} from '../src/index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

const verified = (over: Partial<Stated> = {}): Stated => ({
  ...verifiedStatement({
    id: 'stated-1',
    workspaceId: 'acme',
    kind: STATED_KIND.POLICY,
    statement: 'Refunds above 1,000 need the Finance Manager.',
    subject: 'payment.refund',
    provenance: STATED_PROVENANCE.DECLARED,
    detectedAt: '2026-01-01T00:00:00.000Z',
  }),
  ...over,
});

const candidate = (over: Partial<Stated> = {}): Stated => ({
  ...candidateStatement({
    id: 'candidate-1',
    workspaceId: 'acme',
    kind: STATED_KIND.DECISION,
    statement: 'We are standardising on PostgreSQL.',
    subject: 'database',
    evidence: ['msg-1'],
    confidence: 0.8,
    detectedAt: '2026-05-01T00:00:00.000Z',
  }),
  ...over,
});

describe('isBinding', () => {
  it('binds a verified statement inside its window', () => {
    expect(isBinding(verified(), NOW)).toBe(true);
  });

  it('never binds a candidate, however confident the reader was', () => {
    expect(isBinding(candidate({ confidence: 1 }), NOW)).toBe(false);
  });

  it('does not bind before it takes effect', () => {
    expect(isBinding(verified({ effectiveFrom: '2026-07-01T00:00:00.000Z' }), NOW)).toBe(
      false,
    );
  });

  it('stops binding once it has lapsed', () => {
    expect(isBinding(verified({ effectiveTo: '2026-05-01T00:00:00.000Z' }), NOW)).toBe(
      false,
    );
  });
});

describe('mayRead', () => {
  it('lets anyone read a statement with no clearance set', () => {
    expect(mayRead(verified(), 'anyone')).toBe(true);
    expect(mayRead(verified(), undefined)).toBe(true);
  });

  it('applies a clearance as a principal pattern', () => {
    const restricted = verified({ clearance: ['cfo@acme.com', '*@finance.acme.com'] });

    expect(mayRead(restricted, 'cfo@acme.com')).toBe(true);
    expect(mayRead(restricted, 'lead@finance.acme.com')).toBe(true);
    expect(mayRead(restricted, 'intern@acme.com')).toBe(false);
  });

  it('refuses an anonymous reader once a clearance exists', () => {
    expect(mayRead(verified({ clearance: ['cfo@acme.com'] }), undefined)).toBe(false);
  });
});

describe('readableFacts', () => {
  it('counts what it withheld without naming it', () => {
    const statements = [
      verified({ id: 'open' }),
      verified({ id: 'secret', clearance: ['cfo@acme.com'] }),
    ];

    const readable = readableFacts(statements, 'intern@acme.com', NOW);

    expect(readable.facts.map((fact) => fact.id)).toEqual(['open']);
    expect(readable.withheld).toBe(1);
  });

  it('does not count a candidate as withheld — it is not yet something we say', () => {
    const readable = readableFacts([verified(), candidate()], 'anyone', NOW);

    expect(readable.facts).toHaveLength(1);
    expect(readable.withheld).toBe(0);
  });

  it('marks a statement read out of a conversation as tainted', () => {
    const observed = verified({
      provenance: STATED_PROVENANCE.OBSERVED,
      id: 'from-slack',
    });

    const [fact] = readableFacts([observed], 'anyone', NOW).facts;

    expect(fact?.tainted).toBe(true);
  });
});

describe('verify and reject', () => {
  it('confirms a candidate and records who did it', () => {
    const settled = verifyStatement(candidate(), 'alice', NOW.toISOString());

    expect(settled?.status).toBe('verified');
    expect(settled?.verifiedBy).toBe('alice');
    expect(isBinding(settled as Stated, NOW)).toBe(true);
  });

  it('refuses to re-verify anything that is not a candidate', () => {
    expect(verifyStatement(verified(), 'alice', NOW.toISOString())).toBeNull();
    const rejected = rejectStatement(candidate(), 'alice', NOW.toISOString());
    expect(verifyStatement(rejected as Stated, 'bob', NOW.toISOString())).toBeNull();
  });

  it('keeps a refusal rather than deleting it', () => {
    const rejected = rejectStatement(candidate(), 'alice', NOW.toISOString());

    expect(rejected?.status).toBe('rejected');
    expect(isBinding(rejected as Stated, NOW)).toBe(false);
  });
});

describe('supersede', () => {
  it('retires the old statement and links the new one to it', () => {
    const pair = supersede(verified({ id: 'old' }), verified({ id: 'new' }));

    expect(pair.previous.status).toBe('superseded');
    expect(pair.next.supersedesId).toBe('old');
    expect(pair.next.version).toBe(2);
    expect(isBinding(pair.previous, NOW)).toBe(false);
  });
});

describe('resolveOwnership', () => {
  const owns = (subject: string, owner: string, id: string): Stated =>
    verified({
      id,
      kind: STATED_KIND.RESPONSIBILITY,
      subject,
      object: owner,
      statement: `${owner} owns ${subject}`,
    });

  it('reads an owner through the statement that made them one', () => {
    const owned = resolveOwnership([owns('checkout', 'platform', 'r1')], 'checkout', NOW);

    expect(owned.owners).toEqual([{ name: 'platform', throughDecision: 'r1' }]);
  });

  it('matches a subject pattern, so ownership is declared once', () => {
    const statements = [owns('production.*', 'platform', 'r1')];

    expect(resolveOwnership(statements, 'production.checkout', NOW).owners).toHaveLength(
      1,
    );
  });

  it('answers with nobody rather than guessing', () => {
    expect(resolveOwnership([], 'checkout', NOW).owners).toEqual([]);
  });

  it('ignores an owner nobody has confirmed', () => {
    const unconfirmed = candidate({
      kind: STATED_KIND.RESPONSIBILITY,
      subject: 'checkout',
      object: 'platform',
    });

    expect(resolveOwnership([unconfirmed], 'checkout', NOW).owners).toEqual([]);
  });
});

describe('searchStatements', () => {
  it('ranks a subject hit above a body-only hit', () => {
    const statements = [
      verified({
        id: 'body',
        subject: 'unrelated',
        statement: 'something about refunds',
      }),
      verified({ id: 'subject', subject: 'refunds', statement: 'unrelated text' }),
    ];

    const hits = searchStatements(statements, 'refunds');

    expect(hits[0]?.stated.id).toBe('subject');
  });

  it('ignores terms too short to carry signal', () => {
    expect(searchStatements([verified()], 'a of')).toEqual([]);
  });
});
