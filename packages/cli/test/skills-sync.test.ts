import { describe, expect, it } from 'vitest';
import { DEFINITION_KIND, GRANT, SKILL_STANDING, type SkillFinding } from '@memnox/core';
import { SKILL_FINDING_KIND, skillChangesFrom, skillRef } from '../src/sync/skills';

/**
 * A skill an agent wrote for itself, and whether a person ever learns of it.
 *
 * `VISION.md` `I.4` asks for a self-taught capability to be treated like a
 * deployment. `memnox skills` has always found them and always printed them to
 * whoever was sitting at the machine — and nobody is sitting at the machine.
 */

const TAKEN_AT = '2026-09-01T10:00:00.000Z';

function skill(over: Partial<SkillFinding> = {}): SkillFinding {
  return {
    id: '.hermes/skills/ops/deploy',
    name: 'deploy',
    path: '/home/ana/.hermes/skills/ops/deploy/SKILL.md',
    agent: 'hermes',
    kind: DEFINITION_KIND.SKILL,
    grant: { kind: GRANT.UNREAD, tools: [] },
    reaches: ['kubectl', 'git'],
    digest: 'sha-1111',
    standing: SKILL_STANDING.NEW,
    gained: ['kubectl', 'git'],
    widerGrant: false,
    ...over,
  };
}

describe('the skill change this machine sends', () => {
  it('carries what the control plane projection reads', () => {
    const [row] = skillChangesFrom([skill()], TAKEN_AT);

    expect(row).toMatchObject({
      kind: 'finding.raised',
      actorType: 'automation',
      occurredAt: Date.parse(TAKEN_AT),
    });
    expect(row?.['payload']).toMatchObject({
      kind: SKILL_FINDING_KIND,
      subjectRef: '/home/ana/.hermes/skills/ops/deploy/SKILL.md',
      agentIds: ['hermes'],
    });
  });

  /* A skill somebody already accepted and which has not changed is not news.
     Reporting it would fill an inbox with things already reviewed, which is
     how a queue stops being read at all. */
  it('says nothing about a skill already accepted and unchanged', () => {
    const rows = skillChangesFrom(
      [skill({ standing: SKILL_STANDING.KNOWN, gained: [] })],
      TAKEN_AT,
    );
    expect(rows).toEqual([]);
  });

  /* The one this screen exists for: yesterday it edited files, today it also
     names kubectl. It outranks a skill that merely changed. */
  it('ranks a widened skill above one that only changed', () => {
    const [widened] = skillChangesFrom(
      [skill({ standing: SKILL_STANDING.WIDENED, gained: ['kubectl'] })],
      TAKEN_AT,
    );
    const [changed] = skillChangesFrom(
      [skill({ standing: SKILL_STANDING.CHANGED, gained: [] })],
      TAKEN_AT,
    );

    expect(widened?.['payload']).toMatchObject({ severity: 'high' });
    expect(changed?.['payload']).toMatchObject({ severity: 'medium' });
  });

  it('says what it gained, in a sentence somebody can act on', () => {
    const [row] = skillChangesFrom(
      [skill({ standing: SKILL_STANDING.WIDENED, gained: ['kubectl'] })],
      TAKEN_AT,
    );
    const payload = row?.['payload'] as { title: string };

    expect(payload.title).toContain('hermes');
    expect(payload.title).toContain('deploy');
    expect(payload.title).toContain('kubectl');
  });

  /* An unfixed machine reports the same row every sync and the control plane
     must append nothing; an agent that edits the skill again is genuinely new. */
  it('is the same row until the skill itself changes', () => {
    const before = skillRef(skill());
    expect(skillRef(skill())).toBe(before);
    expect(skillRef(skill({ digest: 'sha-2222' }))).not.toBe(before);
  });

  /* A skill id is a path, and paths carry the separator. Without hashing,
     `a/b` + `c` and `a` + `b/c` would be one row. */
  it('does not collide two skills whose parts join to the same string', () => {
    const left = skillRef(skill({ agent: 'a', id: 'b/c' }));
    const right = skillRef(skill({ agent: 'a/b', id: 'c' }));
    expect(left).not.toBe(right);
  });

  /**
   * The one thing that must never travel.
   *
   * A skill is something somebody wrote, often against their own codebase. A
   * control plane holding its customers' agent instructions would be keeping
   * the very thing it exists to govern.
   */
  it('never carries the text of the skill itself', () => {
    const rows = skillChangesFrom(
      [skill({ standing: SKILL_STANDING.WIDENED })],
      TAKEN_AT,
    );
    const wire = JSON.stringify(rows);

    expect(wire).not.toContain('sha-1111');
    expect(wire).toContain('/home/ana/.hermes/skills/ops/deploy/SKILL.md');
  });
});
