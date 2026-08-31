import { describe, expect, it } from 'vitest';
import {
  SOURCE_KIND,
  SOURCE_STATUS,
  RESOLUTION_BASIS,
  TENANT_ISOLATION,
} from '../src/source.constants';
import {
  covers,
  disconnect,
  isDue,
  isReadable,
  newSource,
  reconnect,
  summarize,
  type Source,
} from '../src/source';
import { hashContent, isUnchanged, newRawDocument } from '../src/raw-document';
import {
  normalise,
  resolve,
  split,
  standing,
  type MergeRecord,
  type Resolvable,
} from '../src/resolution';
import {
  dedicatedTenant,
  guardRegion,
  guardWrite,
  scopeTo,
  sharedTenant,
  TENANCY_REFUSAL,
  validateTenant,
} from '../src/tenancy';

const AT = '2026-08-31T09:00:00.000Z';

const source = (over: Partial<Source> = {}): Source =>
  newSource({
    id: 'src_1',
    workspaceId: 'ws_1',
    kind: SOURCE_KIND.SLACK,
    displayName: '#eng-decisions',
    scope: { include: ['#eng-decisions', '#releases'] },
    connectedAt: AT,
    ...over,
  });

describe('a source', () => {
  it('reads only the named parts a workspace chose', () => {
    const chosen = source();

    expect(covers(chosen, '#eng-decisions')).toBe(true);
    expect(covers(chosen, '#random')).toBe(false);
  });

  it('honours an exclusion inside an included part', () => {
    const chosen = source({ scope: { include: ['#eng'], exclude: ['#eng'] } });

    expect(covers(chosen, '#eng')).toBe(false);
  });

  it('outlives its connection: losing access keeps what somebody chose', () => {
    const lost = disconnect(source(), AT, 'token revoked');

    expect(lost.status).toBe(SOURCE_STATUS.DISCONNECTED);
    expect(lost.scope.include).toEqual(['#eng-decisions', '#releases']);
    expect(isReadable(lost)).toBe(false);
  });

  it('reconnects without re-choosing anything', () => {
    const back = reconnect(disconnect(source(), AT, 'token revoked'));

    expect(back.status).toBe(SOURCE_STATUS.CONNECTED);
    expect(back.lastError).toBeUndefined();
    expect(back.scope.include).toEqual(['#eng-decisions', '#releases']);
  });

  it('is read continuously rather than on import', () => {
    const never = source();
    expect(isDue(never, new Date(AT))).toBe(true);

    const justRead = source({ lastReadAt: AT, refreshMinutes: 60 });
    expect(isDue(justRead, new Date('2026-08-31T09:30:00.000Z'))).toBe(false);
    expect(isDue(justRead, new Date('2026-08-31T10:01:00.000Z'))).toBe(true);
  });

  it('is never due while disconnected', () => {
    expect(isDue(disconnect(source(), AT), new Date('2027-01-01T00:00:00.000Z'))).toBe(
      false,
    );
  });

  it('says what it reads, so what was read is visible', () => {
    expect(summarize(source()).reads).toEqual(['#eng-decisions', '#releases']);
  });
});

describe('raw documents', () => {
  const document = (content: string) =>
    newRawDocument({
      sourceId: 'src_1',
      workspaceId: 'ws_1',
      externalId: 'msg_1',
      kind: 'message',
      content,
      fetchedAt: AT,
    });

  it('keys deterministically, so a re-read overwrites rather than duplicates', () => {
    expect(document('a').id).toBe(document('b').id);
  });

  it('skips re-extraction when a re-read returned the same bytes', () => {
    expect(isUnchanged(document('same'), document('same'))).toBe(true);
    expect(isUnchanged(document('before'), document('after'))).toBe(false);
  });

  it('treats a first read as changed', () => {
    expect(isUnchanged(null, document('a'))).toBe(false);
  });

  it('hashes rather than truncates, so two documents are told apart', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});

describe('resolution', () => {
  const record = (over: Partial<Resolvable>): Resolvable => ({
    id: 'n_1',
    workspaceId: 'ws_1',
    name: 'Payments Team',
    ...over,
  });

  it('merges on external reference first, which is the only certain match', () => {
    const existing = [
      record({
        id: 'n_a',
        name: 'something else',
        externalRef: { sourceId: 's', externalId: 'T1' },
      }),
    ];

    const outcome = resolve(
      record({ id: 'n_b', externalRef: { sourceId: 's', externalId: 'T1' } }),
      existing,
    );

    expect(outcome).toEqual({
      merged: true,
      into: 'n_a',
      basis: RESOLUTION_BASIS.EXTERNAL_REF,
    });
  });

  it('falls back to normalised identity, and says that is what it did', () => {
    const outcome = resolve(record({ id: 'n_b', name: 'payments-team' }), [
      record({ id: 'n_a' }),
    ]);

    expect(outcome).toEqual({
      merged: true,
      into: 'n_a',
      basis: RESOLUTION_BASIS.IDENTITY,
    });
  });

  it('does not merge two records that agree on nothing', () => {
    expect(
      resolve(record({ id: 'n_b', name: 'Billing' }), [record({ id: 'n_a' })]),
    ).toEqual({
      merged: false,
    });
  });

  it('normalises case and punctuation, and nothing cleverer', () => {
    expect(normalise('Payments Team')).toBe(normalise('payments-team'));
    expect(normalise('Payments')).not.toBe(normalise('Payment'));
  });

  it('records a merge so a wrong one can be split', () => {
    const merge: MergeRecord = {
      id: 'm_1',
      workspaceId: 'ws_1',
      keptId: 'n_a',
      mergedId: 'n_b',
      basis: RESOLUTION_BASIS.IDENTITY,
      at: AT,
    };

    const undone = split(merge, AT, 'moise');

    expect(undone.splitBy).toBe('moise');
    expect(standing([undone])).toEqual([]);
    expect(standing([merge])).toEqual([merge]);
  });
});

describe('tenancy', () => {
  it('refuses a dedicated tenant with no region, because that is a promise nobody can keep', () => {
    expect(
      validateTenant({ workspaceId: 'ws_1', isolation: TENANT_ISOLATION.DEDICATED }),
    ).toEqual({ ok: false, reason: TENANCY_REFUSAL.NO_REGION });
  });

  it('refuses a shared tenant that claims a region, because that promise is already false', () => {
    expect(
      validateTenant({
        workspaceId: 'ws_1',
        isolation: TENANT_ISOLATION.SHARED,
        region: 'eu',
      }),
    ).toEqual({ ok: false, reason: TENANCY_REFUSAL.SHARED_REGION });
  });

  it('accepts a dedicated tenant that names both a region and a database', () => {
    expect(validateTenant(dedicatedTenant('ws_1', 'eu', 'db_ws_1'))).toEqual({
      ok: true,
    });
  });

  it('filters every read to one workspace at the port, not at each caller', () => {
    const rows = [
      { workspaceId: 'ws_1', id: 'a' },
      { workspaceId: 'ws_2', id: 'b' },
    ];

    expect(scopeTo(sharedTenant('ws_1'), rows).map((row) => row.id)).toEqual(['a']);
  });

  it('refuses a cross-tenant write rather than filtering it away silently', () => {
    expect(guardWrite(sharedTenant('ws_1'), { workspaceId: 'ws_2' })).toEqual({
      ok: false,
      reason: TENANCY_REFUSAL.WRONG_TENANT,
    });
  });

  it('keeps a dedicated tenant inside the region it was pinned to', () => {
    const tenant = dedicatedTenant('ws_1', 'eu', 'db_ws_1');

    expect(guardRegion(tenant, 'eu')).toEqual({ ok: true });
    expect(guardRegion(tenant, 'us')).toEqual({
      ok: false,
      reason: TENANCY_REFUSAL.CROSS_REGION,
    });
  });

  it('does not pin a shared tenant to anywhere', () => {
    expect(guardRegion(sharedTenant('ws_1'), 'us')).toEqual({ ok: true });
  });
});
