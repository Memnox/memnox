import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FINDING_KIND,
  FINDING_SEVERITY,
  NodeFindingsStore,
  type Finding,
} from '@memnox/core';
import { findingRef, findingsFrom } from '../src/sync/findings';

/**
 * What this machine caught, and whether it survives the trip.
 *
 * `memnox doctor` found these and printed them, and that was the whole of it.
 * The control plane's `findings` projection, its table and the hole it leaves
 * in its ingest guard were all in place and all empty, because nothing here
 * ever sent one.
 */

const TAKEN_AT = '2026-09-01T10:00:00.000Z';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f-random-uuid',
    kind: FINDING_KIND.PRODUCTION_REACHABLE,
    severity: FINDING_SEVERITY.HIGH,
    title: '.env.production is production, and 2 agent(s) here reach it',
    agentIds: ['agt_claude', 'agt_cursor'],
    evidence: '/home/ana/app/.env.production',
    ...over,
  };
}

describe('the finding this machine sends', () => {
  it('carries what the control plane projection reads', () => {
    const [row] = findingsFrom([finding()], TAKEN_AT);

    expect(row).toMatchObject({
      kind: 'finding.raised',
      actorType: 'automation',
      occurredAt: Date.parse(TAKEN_AT),
    });
    expect(row?.['payload']).toMatchObject({
      kind: FINDING_KIND.PRODUCTION_REACHABLE,
      severity: FINDING_SEVERITY.HIGH,
      subjectRef: '/home/ana/app/.env.production',
      agentIds: ['agt_claude', 'agt_cursor'],
    });
  });

  /* The projection reads the finding id off `subjectId` and dedups the append
     on `dedupKey`. Both are the content identity, not the local UUID. */
  it('names itself by what it found, not by the scan that found it', () => {
    const [first] = findingsFrom([finding({ id: 'uuid-one' })], TAKEN_AT);
    const [second] = findingsFrom(
      [finding({ id: 'uuid-two' })],
      '2026-09-02T10:00:00.000Z',
    );

    expect(first?.['dedupKey']).toBe(second?.['dedupKey']);
    expect(first?.['subjectId']).toBe(first?.['dedupKey']);
  });

  it('tells two different problems apart', () => {
    expect(findingRef(finding())).not.toBe(
      findingRef(finding({ evidence: '/home/ana/app/.env.staging' })),
    );
    expect(findingRef(finding())).not.toBe(
      findingRef(finding({ kind: FINDING_KIND.EXPORT_PATH })),
    );
  });

  /* A path carries the separator, so concatenating the parts would read
     `a/b` + `c` and `a` + `b/c` as one finding. */
  it('does not confuse two findings whose parts run together', () => {
    const left = finding({ kind: FINDING_KIND.TOOL_CHAIN, evidence: 'a/b' });
    const right = finding({ kind: FINDING_KIND.TOOL_CHAIN, evidence: 'a' });
    expect(findingRef(left)).not.toBe(findingRef(right));
  });

  it('does not depend on the order the agents were listed in', () => {
    expect(findingRef(finding({ agentIds: ['agt_cursor', 'agt_claude'] }))).toBe(
      findingRef(finding({ agentIds: ['agt_claude', 'agt_cursor'] })),
    );
  });

  /**
   * The one rule this whole path is bound to.
   *
   * A control plane holding its customers' leaked credentials is a worse breach
   * than the one it is reporting. `evidence` is the file that proved the
   * finding and the title is a sentence about it; the value never leaves.
   */
  it('sends where, never what', () => {
    const rows = findingsFrom(
      [
        finding({
          title: 'config.ts holds a hardcoded key',
          evidence: '/home/ana/app/config.ts',
        }),
      ],
      TAKEN_AT,
    );

    expect(JSON.stringify(rows)).not.toContain('sk-live');
    expect(JSON.stringify(rows)).toContain('/home/ana/app/config.ts');
  });
});

describe('the findings a scan leaves behind', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-findings-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('answers nothing before a scan has ever run', async () => {
    expect(await new NodeFindingsStore(home).latest()).toBeNull();
  });

  it('keeps the last scan and reads it back', async () => {
    const store = new NodeFindingsStore(home);
    await store.keep({ takenAt: TAKEN_AT, findings: [finding()] });

    const kept = await store.latest();
    expect(kept?.takenAt).toBe(TAKEN_AT);
    expect(kept?.findings).toHaveLength(1);
  });

  /* The last run only. A fleet counting a problem somebody fixed last week is
     a fleet nobody trusts. */
  it('replaces the previous scan rather than accumulating', async () => {
    const store = new NodeFindingsStore(home);
    await store.keep({ takenAt: TAKEN_AT, findings: [finding(), finding()] });
    await store.keep({ takenAt: '2026-09-02T10:00:00.000Z', findings: [] });

    const kept = await store.latest();
    expect(kept?.findings).toEqual([]);
    expect(kept?.takenAt).toBe('2026-09-02T10:00:00.000Z');
  });
});
