import { describe, expect, it } from 'vitest';
import {
  BAND,
  actionsForCli,
  blastRadiusOf,
  boundaryFor,
  rolesIn,
  standingFor,
  inBand,
  readyToEnable,
  type CandidateAction,
} from '../src/session/autopilot';
import type { Policy } from '../src/policy/policy';
import { DECISION_EFFECT } from '../src/constants/decision.constants';
import { TOOL_CLASS } from '../src/discovery/classify';

const candidates: CandidateAction[] = [
  { action: 'git.status', class: TOOL_CLASS.READ },
  { action: 'git.push', class: TOOL_CLASS.WRITE },
  { action: 'git.push-force', class: TOOL_CLASS.DESTRUCTIVE },
  { action: 'aws.s3-rm', class: TOOL_CLASS.DESTRUCTIVE },
];

const decide =
  (map: Record<string, string>) =>
  (action: string): { effect: never; reason: string; matched: boolean } => {
    const effect = map[action];
    return {
      effect: (effect ?? DECISION_EFFECT.ALLOW) as never,
      reason: effect === undefined ? 'no rule matched' : `rule for ${action}`,
      matched: effect !== undefined,
    };
  };

describe('the boundary is the verdict, not a description of the rules', () => {
  it('puts each action in the band the engine actually reached', () => {
    const boundary = boundaryFor(
      'claude-code',
      candidates,
      decide({
        'git.status': DECISION_EFFECT.ALLOW,
        'git.push': DECISION_EFFECT.ASK,
        'git.push-force': DECISION_EFFECT.DENY,
        'aws.s3-rm': DECISION_EFFECT.DENY,
      }),
    );
    expect(inBand(boundary, BAND.AUTOMATIC).map((e) => e.action)).toEqual(['git.status']);
    expect(inBand(boundary, BAND.NEEDS_APPROVAL).map((e) => e.action)).toEqual([
      'git.push',
    ]);
    expect(inBand(boundary, BAND.NEVER)).toHaveLength(2);
  });

  /* An unruled capability is not a permitted one, and putting it in the allowed band
     would be the one screen a person trusts most telling a comfortable lie. */
  it('counts what no rule covers instead of calling it automatic', () => {
    const boundary = boundaryFor(
      'claude-code',
      candidates,
      decide({ 'git.status': DECISION_EFFECT.ALLOW }),
    );
    expect(inBand(boundary, BAND.AUTOMATIC).map((e) => e.action)).toEqual(['git.status']);
    expect(boundary.ungoverned).toEqual(['aws.s3-rm', 'git.push', 'git.push-force']);
  });
});

describe('before somebody turns it on', () => {
  it('refuses to call it ready when something destructive runs unasked', () => {
    const boundary = boundaryFor(
      'claude-code',
      candidates,
      decide({
        'git.status': DECISION_EFFECT.ALLOW,
        'git.push': DECISION_EFFECT.ALLOW,
        'git.push-force': DECISION_EFFECT.ALLOW,
        'aws.s3-rm': DECISION_EFFECT.ASK,
      }),
    );
    const ready = readyToEnable(blastRadiusOf(boundary, []));
    expect(ready.ready).toBe(false);
    expect(ready.because).toContain('destructive');
  });

  it('refuses when most of what the agent can do has no rule', () => {
    const boundary = boundaryFor(
      'claude-code',
      candidates,
      decide({ 'git.status': DECISION_EFFECT.ALLOW }),
    );
    const ready = readyToEnable(blastRadiusOf(boundary, []));
    expect(ready.ready).toBe(false);
    expect(ready.because).toContain('no rule at all');
  });

  it('is ready when every destructive action is held or refused', () => {
    const boundary = boundaryFor(
      'claude-code',
      candidates,
      decide({
        'git.status': DECISION_EFFECT.ALLOW,
        'git.push': DECISION_EFFECT.ALLOW,
        'git.push-force': DECISION_EFFECT.DENY,
        'aws.s3-rm': DECISION_EFFECT.ASK,
      }),
    );
    const radius = blastRadiusOf(boundary, ['aws']);
    expect(readyToEnable(radius).ready).toBe(true);
    expect(radius.destructiveAutomatic).toBe(false);
    expect(radius.credentials).toEqual(['aws']);
  });
});

describe('what a CLI could do', () => {
  it('reads the actions off the same verb table enforcement reads', () => {
    const actions = actionsForCli('git');
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((each) => each.action.startsWith('git.'))).toBe(true);
  });

  it('says nothing about a binary with no table behind it', () => {
    expect(actionsForCli('definitely-not-a-real-cli')).toEqual([]);
  });
});

describe('what is never handed over', () => {
  const allow = () => ({
    effect: 'allow' as const,
    reason: 'no rule stops it',
    matched: true,
  });

  /* The invariant: an irreversible action is never automatic, whatever the rule says.
     A wrong ask costs an interruption; a wrong send costs a sent email. */
  it('holds an irreversible action back even when a rule allows it', () => {
    const boundary = boundaryFor(
      'hermes',
      [
        { action: 'slack.send-message', class: 'communication' },
        { action: 'vercel.deploy', class: 'write' },
      ],
      allow,
    );

    for (const entry of boundary.entries) {
      expect(entry.band).toBe('needs-approval');
      expect(entry.reversibility).toBe('irreversible');
      expect(entry.because).toContain('cannot be undone');
    }
  });

  it('leaves an action a milestone can put back automatic', () => {
    const boundary = boundaryFor(
      'claude-code',
      [{ action: 'git.commit', class: 'write' }],
      allow,
    );

    expect(boundary.entries[0]?.band).toBe('automatic');
  });

  it('never promotes a denial into an approval by way of reversibility', () => {
    const boundary = boundaryFor(
      'hermes',
      [{ action: 'slack.send-message', class: 'communication' }],
      () => ({ effect: 'deny' as const, reason: 'no outbound messages', matched: true }),
    );

    // A deny stays a deny: this gate only ever narrows what is automatic.
    expect(boundary.entries[0]?.band).toBe('never');
  });
});

describe('the jobs a rule set names', () => {
  const policy = (roles?: string[]): Policy =>
    ({
      name: 'r',
      match: { actions: ['git.push'], ...(roles === undefined ? {} : { roles }) },
      decision: { effect: 'allow', reason: 'because' },
    }) as unknown as Policy;

  it('names every job the rules mention, once, in order', () => {
    expect(rolesIn([policy(['deployer', 'coder']), policy(['coder'])])).toEqual([
      'coder',
      'deployer',
    ]);
  });

  /* A wildcard is every role rather than a role, and a rule that names none governs
     everybody — neither puts a name in a roster of jobs somebody can be enrolled under. */
  it('does not invent a job from a wildcard or from a rule that names none', () => {
    expect(rolesIn([policy(['*']), policy(), policy([''])])).toEqual([]);
  });

  it('counts what one job may do, per band', () => {
    const boundary = boundaryFor(
      'deployer',
      [
        { action: 'git.status', class: 'read' },
        { action: 'git.push', class: 'write' },
        { action: 'git.push-force', class: 'destructive' },
      ],
      (action) => ({
        effect:
          action === 'git.status'
            ? ('allow' as const)
            : action === 'git.push'
              ? ('ask' as const)
              : ('deny' as const),
        reason: 'because',
        matched: true,
      }),
    );

    expect(standingFor('deployer', boundary)).toEqual({
      role: 'deployer',
      automatic: 1,
      needsApproval: 1,
      never: 1,
    });
  });
});
