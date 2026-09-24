import { createHash } from 'node:crypto';

import {
  DEFINITION_KIND,
  describeGrant,
  GRANT,
  SKILL_STANDING,
  type SkillFinding,
} from '@memnox/core';

import { CLOUD_EVENT, eventOf, type CloudEvent } from './cloud-event';

/**
 * What an agent runs on beyond its config, sent as a finding so a person at a console
 * reviews it. The ingest door refuses `finding.resolved`, so an agent cannot clear its own.
 */

/** What the control plane files these under, so a console can group them. */
export const SKILL_FINDING_KIND = 'skill.changed';

/**
 * Standings worth another person's attention: not `KNOWN`, which is already reviewed,
 * and `CHANGED` even though it reaches no further, because the text it runs on changed.
 */
const WORTH_REPORTING: readonly string[] = [
  SKILL_STANDING.NEW,
  SKILL_STANDING.CHANGED,
  SKILL_STANDING.WIDENED,
];

/**
 * How severe one of these is, in the words the findings table uses. A widened skill
 * outranks the rest, because that is what this screen exists for.
 */
function severityOf(finding: SkillFinding): string {
  if (finding.standing === SKILL_STANDING.WIDENED) return 'high';
  // A definition declaring no tools runs with the session's whole tool set, the widest grant.
  if (finding.grant.kind === GRANT.INHERITS) return 'high';
  return 'medium';
}

/**
 * The identity a re-scan deduplicates on: the skill and its content, so an edited skill
 * is new. Hashed because a skill id is a path and carries the separator.
 */
export function skillRef(finding: SkillFinding): string {
  const parts = [finding.agent, finding.id, finding.digest];
  const digest = createHash('sha256').update(parts.join(' ')).digest('hex');
  return `skl_${digest.slice(0, 32)}`;
}

/** What a person is told about it, in one line they can act on. */
function titleFor(finding: SkillFinding): string {
  if (finding.kind === DEFINITION_KIND.AGENT) return definitionTitle(finding);
  if (finding.standing === SKILL_STANDING.WIDENED) {
    return `${finding.agent} widened its own skill "${finding.name}": it now reaches ${finding.gained.join(', ')}`;
  }
  if (finding.standing === SKILL_STANDING.NEW) {
    const reaches =
      finding.reaches.length === 0
        ? 'no tools this machine recognises'
        : finding.reaches.join(', ');
    return `${finding.agent} wrote itself a new skill "${finding.name}", reaching ${reaches}`;
  }
  return `${finding.agent} changed its own skill "${finding.name}"`;
}

/**
 * A persona somebody installed, said as installed rather than as written by the agent,
 * because these arrive from a public roster by the hundred.
 */
function definitionTitle(finding: SkillFinding): string {
  const grant = describeGrant(finding.grant);
  if (finding.standing === SKILL_STANDING.WIDENED) {
    return `A definition installed into ${finding.agent}, "${finding.name}", widened: it ${grant}`;
  }
  if (finding.standing === SKILL_STANDING.NEW) {
    return `A definition was installed into ${finding.agent}, "${finding.name}", and it ${grant}`;
  }
  return `A definition installed into ${finding.agent}, "${finding.name}", changed`;
}

/**
 * One event per skill worth reviewing. The skill's text never leaves the machine, and
 * its tools are a name match, so every sentence says reaches rather than runs.
 */
export function skillChangesFrom(
  findings: readonly SkillFinding[],
  takenAt: string,
): CloudEvent[] {
  const at = Date.parse(takenAt);
  return findings
    .filter((finding) => WORTH_REPORTING.includes(finding.standing))
    .map((finding) => {
      const ref = skillRef(finding);
      return eventOf({
        kind: CLOUD_EVENT.FINDING_RAISED,
        dedupKey: ref,
        // The `findings` projection reads the subject off this and nowhere else.
        subjectId: ref,
        occurredAt: at,
        payload: {
          kind: SKILL_FINDING_KIND,
          severity: severityOf(finding),
          // Where it lives, never what it says.
          subjectRef: finding.path,
          title: titleFor(finding),
          // A list because the projection's column is one.
          agentIds: [finding.agent],
        },
      });
    });
}
