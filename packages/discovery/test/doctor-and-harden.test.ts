import { describe, expect, it } from 'vitest';
import { discover } from '../src/discover';
import { runDoctor, scoreFindings } from '../src/doctor';
import {
  applyHardening,
  compareFindings,
  planHardening,
  revertHardening,
} from '../src/harden';
import {
  FINDING_SEVERITY,
  TOOL_EFFECT,
  EFFECT_INFERENCE,
} from '../src/discovery.constants';
import { inferToolEffect } from '../src/surface';
import { FakeMachine } from './fake-machine';

const NOW = '2026-08-31T09:00:00.000Z';
const LATER = '2026-08-31T09:01:00.000Z';

const MACHINE = {
  '/home/dev/.claude.json': JSON.stringify({
    mcpServers: { github: { command: 'npx', args: ['github-mcp'] } },
  }),
  '/home/dev/.aws/credentials': '[default]\naws_access_key_id = AKIAEXAMPLE',
};

async function report(): Promise<ReturnType<typeof runDoctor>> {
  const machine = FakeMachine.from(MACHINE);
  const discovered = await discover(machine, { now: NOW });
  let counter = 0;
  return runDoctor({
    resources: discovered.resources,
    reachability: discovered.reachability,
    surfaces: discovered.surfaces,
    newId: () => `f${(counter += 1)}`,
  });
}

describe('the doctor', () => {
  it('ranks findings by consequence and names the evidence for each', async () => {
    const { findings } = await report();

    expect(findings[0]?.severity).toBe(FINDING_SEVERITY.CRITICAL);
    expect(findings[0]?.evidence).toBe('/home/dev/.aws/credentials');
    expect(findings.every((finding) => finding.evidence.length > 0)).toBe(true);
  });

  it('scores by decomposing the list, so the number can be argued with', async () => {
    const { findings, score } = await report();

    expect(score.bySeverity[FINDING_SEVERITY.CRITICAL]).toBe(1);
    const recomputed = scoreFindings(findings);
    expect(recomputed).toEqual(score);
  });

  it('gives every credential finding one change that closes it', async () => {
    const { findings } = await report();
    const credential = findings.find((finding) =>
      finding.evidence.endsWith('credentials'),
    );

    expect(credential?.remediation?.apply.contents).toContain('effect: withhold');
  });

  it('names a substitute only where one exists, rather than inventing a path', async () => {
    // An agent sent at a .example that is not there is worse off than one told no.
    const machine = FakeMachine.from({ ...MACHINE, '/home/dev/.env': 'SECRET=1' });
    const discovered = await discover(machine, { now: NOW });
    const { findings } = runDoctor({
      resources: discovered.resources,
      reachability: discovered.reachability,
      surfaces: discovered.surfaces,
    });

    const env = findings.find((finding) => finding.evidence.endsWith('/.env'));
    const aws = findings.find((finding) => finding.evidence.endsWith('credentials'));

    expect(env?.remediation?.apply.contents).toContain('.env.example');
    expect(aws?.remediation?.apply.contents).not.toContain('alternative');
  });
});

describe('hardening', () => {
  it('prints the undo before anything runs', async () => {
    const { findings } = await report();
    const steps = findings.flatMap((finding) =>
      finding.remediation === undefined ? [] : [finding.remediation],
    );

    const plan = planHardening(steps);

    expect(plan.undo).toHaveLength(steps.length);
    expect(plan.undo[0]).toContain('--revert');
  });

  it('writes only inside Memnox, and a single revert puts the machine back', async () => {
    const machine = FakeMachine.from({});
    const { findings } = await report();
    const steps = findings.flatMap((finding) =>
      finding.remediation === undefined ? [] : [finding.remediation],
    );

    const applied = await applyHardening(machine, steps, NOW);
    expect(applied.every((result) => result.changed)).toBe(true);
    expect(machine.written.every((path) => path.startsWith('policies/'))).toBe(true);

    const reverted = await revertHardening(
      machine,
      applied.map((result) => result.step),
      LATER,
    );
    expect(reverted.every((result) => result.changed)).toBe(true);
    expect(machine.written).toEqual([]);
  });

  it('applies a step once, so a second run is not a second write', async () => {
    const machine = FakeMachine.from({});
    const { findings } = await report();
    const step = findings[0]?.remediation;
    expect(step).toBeDefined();

    const first = await applyHardening(machine, [step!], NOW);
    const second = await applyHardening(machine, [first[0]!.step], LATER);

    expect(second[0]?.changed).toBe(false);
  });

  it('shows the delta: which findings closed and which remain', async () => {
    const { findings } = await report();
    const remaining = findings.slice(1);

    const delta = compareFindings(findings, remaining);

    expect(delta.closed).toHaveLength(1);
    expect(delta.remaining).toEqual(remaining);
  });
});

describe('tool effect', () => {
  it('takes the server annotation when there is one', () => {
    expect(
      inferToolEffect({ name: 'anything', annotations: { destructiveHint: true } }),
    ).toEqual({
      effect: TOOL_EFFECT.DESTRUCTIVE,
      inferredFrom: EFFECT_INFERENCE.ANNOTATION,
    });
  });

  it('infers from the name when there is none, and says that is what it did', () => {
    expect(inferToolEffect({ name: 'delete_project' })).toEqual({
      effect: TOOL_EFFECT.DESTRUCTIVE,
      inferredFrom: EFFECT_INFERENCE.NAME,
    });
    expect(inferToolEffect({ name: 'get_issue' }).effect).toBe(TOOL_EFFECT.READ);
  });

  it('says unknown rather than guessing when nothing in the tool says what it does', () => {
    expect(inferToolEffect({ name: 'perform' }).effect).toBe(TOOL_EFFECT.UNKNOWN);
  });
});
