import { describe, expect, it } from 'vitest';
import { runDoctor, type DoctorReport, type GovernedBy } from '../src/discovery/doctor';
import {
  DISCOVERED_AGENT_KIND,
  FINDING_SEVERITY,
  RESOURCE_KIND,
  SENSITIVITY,
} from '../src/discovery/discovery.constants';
import type { Resource } from '../src/discovery/resource';

/**
 * The loop that did not close.
 *
 * Running `memnox protect --apply` wrote deny rules for exactly the findings the
 * doctor had raised, and the next `memnox doctor` gave back the same criticals
 * with the same `fix:` line. The person did the work and the report could not
 * tell them, which is the one thing a report about safety has to be able to do.
 */
describe('a finding a rule already covers', () => {
  const credential = (): Resource => ({
    id: 'res_key',
    kind: RESOURCE_KIND.SECRET,
    path: '/Users/nia/.ssh/id_ed25519',
    sensitivity: SENSITIVITY.CRITICAL,
    reachableBy: [
      { id: 'cursor', kind: DISCOVERED_AGENT_KIND.CURSOR },
      { id: 'claude-code', kind: DISCOVERED_AGENT_KIND.CLAUDE_CODE },
    ],
  });

  const report = (governedBy?: GovernedBy): DoctorReport =>
    runDoctor({
      resources: [credential()],
      reachability: [],
      surfaces: [],
      newId: () => 'f1',
      ...(governedBy === undefined ? {} : { governedBy }),
    });

  it('is still reported, because the file is still readable', () => {
    const finding = report(() => 'deny-nia-ssh').findings[0];

    expect(finding).toBeDefined();
    expect(finding?.title).toContain('/Users/nia/.ssh/id_ed25519');
  });

  it('names the rule that covers it', () => {
    expect(report(() => 'deny-nia-ssh').findings[0]?.title).toContain('"deny-nia-ssh"');
  });

  /* One rung down and never to nothing: a rule covers the seams, and a process
     that never meets one is still reaching the file. */
  it('drops a rung rather than disappearing', () => {
    expect(report().findings[0]?.severity).toBe(FINDING_SEVERITY.CRITICAL);
    expect(report(() => 'deny-nia-ssh').findings[0]?.severity).toBe(
      FINDING_SEVERITY.MEDIUM,
    );
  });

  /* Offering the deny again is how a person learns to stop reading this list. */
  it('offers what is left to close rather than the deny already written', () => {
    const open = report().findings[0]?.remediation;
    const covered = report(() => 'deny-nia-ssh').findings[0]?.remediation;

    expect(open?.description).toContain('deny reads of');
    expect(covered?.description).toContain('kernel sandbox');
    expect(covered?.apply.command).toContain('--os-guard');
  });

  it('counts it where it now sits, so the summary moves when the work is done', () => {
    expect(report().counts[FINDING_SEVERITY.CRITICAL]).toBe(1);
    expect(report(() => 'deny-nia-ssh').counts[FINDING_SEVERITY.CRITICAL]).toBe(0);
  });

  /* A caller that loaded no rules knows nothing about them, which reads as
     ungoverned rather than as a claim that no rule exists. */
  it('reads as ungoverned when nothing was asked', () => {
    expect(report().findings[0]?.title).not.toContain('denies it');
  });
});
