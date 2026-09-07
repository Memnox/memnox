import { createHash } from 'node:crypto';
import { SKILL_STANDING, type SkillFinding } from '@memnox/core';

/**
 * A skill an agent wrote for itself, sent so a person reviews it.
 *
 * `VISION.md` `I.4`: an agent that improves itself changes what it will do
 * tomorrow, and *"Memnox should treat every newly generated skill like a
 * software deployment"*. The local half of that has always worked — `memnox
 * skills` finds them, holds them, and prints them to whoever is sitting at the
 * machine. Nobody is sitting at the machine. The person who decides how much
 * autonomy an agent gets is looking at a console, and until this existed a
 * self-taught capability never reached them.
 *
 * Sent as a finding rather than under a kind of its own, and that is not
 * shorthand. It is what the control plane's ingest door already understands as
 * "a local scanner caught something a person must look at", which brings three
 * things this needs and none of which are worth rebuilding: a row in
 * `findings`, a place in somebody's inbox, and `finding.resolved` as the way it
 * is cleared.
 *
 * That third one is the point. `finding.resolved` is refused at the ingest door
 * — it is on the control plane's `INTERNAL_KINDS` because a machine posting one
 * would make a risk disappear. So a self-improving agent can report the skill
 * it just wrote and *cannot* mark it reviewed. The agent proposes; a person
 * accepts. That is the same rule the rest of this product runs on, and here it
 * costs nothing because it was already enforced.
 */

const FINDING_RAISED = 'finding.raised';

/** What the control plane files these under, so a console can group them. */
export const SKILL_FINDING_KIND = 'skill.changed';

/**
 * Standings worth another person's attention.
 *
 * `KNOWN` is a skill somebody already accepted, unchanged since — reporting it
 * would fill an inbox with things that have already been reviewed, which is how
 * a queue stops being read. `CHANGED` is here even though it reaches no
 * further: the text an agent runs on changed, and "it does the same things
 * differently now" is exactly the deployment this section asks to be shown.
 */
const WORTH_REPORTING: readonly string[] = [
  SKILL_STANDING.NEW,
  SKILL_STANDING.CHANGED,
  SKILL_STANDING.WIDENED,
];

/**
 * How severe a standing is, in the words the findings table already uses.
 *
 * A skill that reaches further than the accepted version is the one this whole
 * screen exists for — yesterday it edited files, today it also names `kubectl`
 * — so it is the one that outranks the rest.
 */
function severityOf(standing: string): string {
  return standing === SKILL_STANDING.WIDENED ? 'high' : 'medium';
}

/**
 * The identity a re-scan deduplicates on.
 *
 * The skill *and its content*, so an unfixed machine reports the same row every
 * sync and the control plane appends nothing, while an agent that edits the
 * skill again is a genuinely new thing to look at. Digest included for exactly
 * that reason: without it, a skill widened twice would be reviewed once.
 *
 * Hashed rather than joined because a skill id is a path and paths carry the
 * separator, so `a/b` + `c` and `a` + `b/c` would otherwise be one finding —
 * the same trap `findingRef` documents beside it.
 */
export function skillRef(finding: SkillFinding): string {
  const parts = [finding.agent, finding.id, finding.digest];
  const digest = createHash('sha256').update(parts.join(' ')).digest('hex');
  return `skl_${digest.slice(0, 32)}`;
}

/** What a person is told about it, in one line they can act on. */
function titleFor(finding: SkillFinding): string {
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
 * One event per skill worth reviewing, in the shape the control plane reads.
 *
 * **The skill's text never leaves the machine.** What travels is its name, the
 * agent whose directory it was found in, the tools it *names*, and a digest.
 * A skill is something somebody wrote, often against their own codebase, and a
 * control plane holding its customers' agent instructions would be keeping the
 * thing it is meant to be governing.
 *
 * The tool list is evidence and not proof — the discovery is a name match
 * against verb tables — so every sentence here says "reaches" and "names",
 * never "runs". A console repeating that as certainty would be claiming a
 * measurement nobody took.
 */
export function skillChangesFrom(
  findings: readonly SkillFinding[],
  takenAt: string,
): Record<string, unknown>[] {
  const at = Date.parse(takenAt);
  return findings
    .filter((finding) => WORTH_REPORTING.includes(finding.standing))
    .map((finding) => {
      const ref = skillRef(finding);
      return {
        kind: FINDING_RAISED,
        dedupKey: ref,
        /* Read off `subjectId` and nowhere else by the `findings` projection. */
        subjectId: ref,
        actorType: 'automation',
        occurredAt: at,
        payload: {
          kind: SKILL_FINDING_KIND,
          severity: severityOf(finding.standing),
          /* Where it lives, never what it says. */
          subjectRef: finding.path,
          title: titleFor(finding),
          /* The one agent whose directory holds it. A list because the
             projection's column is one, and because a skill shared between two
             agents is a shape this discovery does not yet report. */
          agentIds: [finding.agent],
        },
      };
    });
}
