import { describe, expect, it } from 'vitest';
import { discover } from '../src/discovery/discover';
import { countBySeverity, rankAgents, runDoctor } from '../src/discovery/doctor';
import {
  applyHardening,
  compareFindings,
  planHardening,
  revertHardening,
} from '../src/discovery/harden';
import {
  FINDING_SEVERITY,
  TOOL_EFFECT,
  EFFECT_INFERENCE,
} from '../src/discovery/discovery.constants';
import { inferToolEffect } from '../src/discovery/surface';
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

  it('counts by severity rather than totalling, so the answer stays arguable', async () => {
    const { findings, counts } = await report();

    expect(counts[FINDING_SEVERITY.CRITICAL]).toBe(1);
    expect(countBySeverity(findings)).toEqual(counts);
    // Three mediums must never read as one high.
    expect(Object.keys(counts)).not.toContain('total');
  });

  it('gives every credential finding one change that closes it', async () => {
    const { findings } = await report();
    const credential = findings.find((finding) =>
      finding.evidence.endsWith('credentials'),
    );

    expect(credential?.remediation?.apply.contents).toContain('effect: deny');
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

describe('local work with production credentials', () => {
  it('puts the two facts next to each other, and asks rather than refuses', async () => {
    const machine = FakeMachine.from({
      '/home/dev/.claude.json': JSON.stringify({ mcpServers: {} }),
      '/work/api/.env': 'DATABASE_URL=postgres://user:pw@db.production.internal/app',
    });
    const discovered = await discover(machine, { now: NOW, projectDirs: ['/work/api'] });
    const { findings } = runDoctor({
      resources: discovered.resources,
      reachability: discovered.reachability,
      surfaces: discovered.surfaces,
    });

    const mismatch = findings.find((finding) => finding.title.includes('is production'));
    expect(mismatch).toBeDefined();
    expect(mismatch?.remediation?.description).toBe(
      'ask before anything touches production',
    );
    expect(mismatch?.remediation?.apply.contents).toContain('effect: ask');
  });

  it('says nothing about production when nothing here is production', async () => {
    const machine = FakeMachine.from({
      '/home/dev/.claude.json': JSON.stringify({ mcpServers: {} }),
      '/work/api/.env': 'DATABASE_URL=postgres://user:pw@localhost/app',
    });
    const discovered = await discover(machine, { now: NOW, projectDirs: ['/work/api'] });
    const { findings } = runDoctor({
      resources: discovered.resources,
      reachability: discovered.reachability,
      surfaces: discovered.surfaces,
    });

    expect(findings.some((finding) => finding.title.includes('is production'))).toBe(
      false,
    );
  });
});

describe('the fleet on this machine', () => {
  it('decomposes findings per agent, and says it ranks nothing else', async () => {
    const machine = FakeMachine.from(MACHINE);
    const discovered = await discover(machine, { now: NOW });
    const { findings } = runDoctor({
      resources: discovered.resources,
      reachability: discovered.reachability,
      surfaces: discovered.surfaces,
    });

    const standings = rankAgents(findings, discovered.surfaces);

    expect(standings.length).toBeGreaterThan(0);
    expect(standings[0]?.agentId).toContain('claude-code');
    // The list underneath the count, so a ranking can be argued with.
    expect(Object.values(standings[0]?.bySeverity ?? {}).reduce((a, b) => a + b, 0)).toBe(
      standings[0]?.findings,
    );
  });
});

describe('three harmless capabilities at once', () => {
  it('names the combination one rule at a time would never catch', async () => {
    const machine = FakeMachine.from({
      '/home/dev/.claude.json': JSON.stringify({
        mcpServers: { slack: { command: 'npx', args: ['slack-mcp'] } },
      }),
      '/home/dev/.aws/credentials': '[default]\naws_access_key_id = AKIAEXAMPLE',
    });
    const discovered = await discover(machine, {
      now: NOW,
      lister: {
        listTools: async () => [{ name: 'send_message' }],
      },
    });
    const { findings } = runDoctor({
      resources: discovered.resources,
      reachability: discovered.reachability,
      surfaces: discovered.surfaces,
    });

    const combined = findings.find((finding) =>
      finding.title.includes('together that is an export'),
    );
    expect(combined).toBeDefined();
    expect(combined?.evidence).toContain('.aws/credentials');
    expect(combined?.evidence).toContain('slack.send_message');
  });

  it('says nothing when the agent cannot send anywhere', async () => {
    const machine = FakeMachine.from({
      '/home/dev/.claude.json': JSON.stringify({ mcpServers: {} }),
    });
    const discovered = await discover(machine, { now: NOW });
    const { findings } = runDoctor({
      resources: discovered.resources,
      reachability: discovered.reachability,
      surfaces: discovered.surfaces,
    });

    expect(
      findings.some((finding) => finding.title.includes('together that is an export')),
    ).toBe(false);
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
