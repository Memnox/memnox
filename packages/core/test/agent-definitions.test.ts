import { describe, expect, it } from 'vitest';
import {
  bulkArrivals,
  DEFINITION_KIND,
  describeGrant,
  describeSkill,
  discoverAgents,
  discoverDefinitions,
  GRANT,
  grantOf,
  grantWidened,
  quarantined,
  reviewSkills,
  SKILL_STANDING,
  type AcceptedSkill,
} from '../src/discovery/skills';
import { FakeMachine } from './fake-machine';

/**
 * Personas somebody installed, as opposed to skills an agent wrote.
 *
 * They arrive by the hundred from a public roster, the install overwrites without
 * keeping a copy, and on these harnesses one that declares no tools runs with the
 * shell and every connected server. None of that is visible in any client.
 */

const HOME = '/home/dev';

const persona = (name: string, tools?: string) =>
  [
    '---',
    `name: ${name}`,
    'color: orange',
    ...(tools === undefined ? [] : [`tools: ${tools}`]),
    '---',
    '',
    `You are ${name}.`,
  ].join('\n');

const installed = (files: Record<string, string>) =>
  FakeMachine.from(
    Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        `${HOME}/.claude/agents/${name}`,
        body,
      ]),
    ),
    HOME,
  );

describe('the grant a definition states', () => {
  it('reads the tools it names', () => {
    const grant = grantOf(persona('One', 'Read, Write'), '.md', true);
    expect(grant).toEqual({ kind: GRANT.DECLARED, tools: ['Read', 'Write'] });
  });

  it('names an absent key as inheriting, where the harness means that', () => {
    expect(grantOf(persona('One'), '.md', true).kind).toBe(GRANT.INHERITS);
  });

  it('says nothing where the harness does not document that meaning', () => {
    /* A guess reported as the widest grant on the machine is how a screen stops being
       believed, so an undocumented harness gets "this says nothing". */
    expect(grantOf(persona('One'), '.md', false).kind).toBe(GRANT.UNREAD);
  });

  it('reads a TOML definition through its own reader', () => {
    const declared = grantOf('name = "One"\ntools = ["read", "write"]\n', '.toml', false);
    expect(declared).toEqual({ kind: GRANT.DECLARED, tools: ['read', 'write'] });
    expect(grantOf('name = "One"\n', '.toml', false).kind).toBe(GRANT.UNREAD);
  });

  it('says the difference in words that keep it', () => {
    expect(describeGrant({ kind: GRANT.INHERITS, tools: [] })).toBe(
      'inherits every tool in the session',
    );
    expect(describeGrant({ kind: GRANT.DECLARED, tools: ['Read'] })).toBe(
      'declares Read',
    );
  });
});

describe('finding them', () => {
  it('reads every definition in the directory it was installed into', async () => {
    const found = await discoverAgents(
      installed({
        'devops-automator.md': persona('DevOps Automator'),
        'product-manager.md': persona('Product Manager', 'WebFetch, Read'),
      }),
      [HOME],
    );
    expect(found).toHaveLength(2);
    expect(found.map((each) => each.name)).toEqual([
      'devops-automator',
      'product-manager',
    ]);
    expect(found.every((each) => each.kind === DEFINITION_KIND.AGENT)).toBe(true);
    expect(found[0]?.grant.kind).toBe(GRANT.INHERITS);
    expect(found[1]?.grant.kind).toBe(GRANT.DECLARED);
  });

  it('ignores a file the harness does not read as a definition', async () => {
    const found = await discoverAgents(installed({ 'README.txt': 'not a definition' }), [
      HOME,
    ]);
    expect(found).toEqual([]);
  });

  it('still names the tools the prose mentions, separately from the grant', async () => {
    const found = await discoverAgents(
      installed({ 'ops.md': persona('Ops') + '\nrun kubectl apply' }),
      [HOME],
    );
    expect(found[0]?.reaches).toEqual(['kubectl']);
    expect(found[0]?.grant.kind).toBe(GRANT.INHERITS);
  });

  it('reports skills and definitions through one pass', async () => {
    const machine = FakeMachine.from(
      {
        [`${HOME}/.claude/skills/deploy/SKILL.md`]: 'use kubectl',
        [`${HOME}/.claude/agents/ops.md`]: persona('Ops'),
      },
      HOME,
    );
    const found = await discoverDefinitions(machine, [HOME]);
    expect(found.map((each) => each.kind)).toEqual([
      DEFINITION_KIND.AGENT,
      DEFINITION_KIND.SKILL,
    ]);
  });
});

describe('a roster that arrived at once', () => {
  const roster = (count: number, withTools = 0) =>
    installed(
      Object.fromEntries(
        Array.from({ length: count }, (_, at) => [
          `agent-${at}.md`,
          persona(`Agent ${at}`, at < withTools ? 'Read' : undefined),
        ]),
      ),
    );

  it('is held, even though one new definition on its own is not', async () => {
    const one = reviewSkills(await discoverAgents(roster(1), [HOME]), []);
    expect(quarantined(one)).toEqual([]);

    const many = reviewSkills(await discoverAgents(roster(20), [HOME]), []);
    expect(quarantined(many)).toHaveLength(20);
  });

  it('is one finding rather than one per file', async () => {
    const findings = reviewSkills(await discoverAgents(roster(20, 2), [HOME]), []);
    const arrivals = bulkArrivals(findings);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]?.agent).toBe('claude-code');
    expect(arrivals[0]?.root).toBe(`${HOME}/.claude/agents`);
    expect(arrivals[0]?.definitions).toHaveLength(20);
    // The count that matters: the two that name tools are not among them.
    expect(arrivals[0]?.inheriting).toBe(18);
  });

  it('is not raised by skills an agent wrote for itself', async () => {
    const machine = FakeMachine.from(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, at) => [
          `${HOME}/.claude/skills/skill-${at}/SKILL.md`,
          'use kubectl',
        ]),
      ),
      HOME,
    );
    const findings = reviewSkills(await discoverDefinitions(machine, [HOME]), []);
    expect(bulkArrivals(findings)).toEqual([]);
  });
});

describe('a fence that was removed', () => {
  const accepted = (over: Partial<AcceptedSkill>): AcceptedSkill[] => [
    {
      id: 'placeholder',
      digest: 'old',
      reaches: [],
      acceptedAt: '2026-09-01T00:00:00.000Z',
      acceptedBy: 'dev',
      ...over,
    },
  ];

  it('is a widening, even when the prose names nothing new', async () => {
    const found = await discoverAgents(installed({ 'ops.md': persona('Ops') }), [HOME]);
    const before = accepted({
      id: found[0]?.id ?? '',
      grant: { kind: GRANT.DECLARED, tools: ['Read'] },
    });
    const [finding] = reviewSkills(found, before);

    expect(finding?.standing).toBe(SKILL_STANDING.WIDENED);
    expect(finding?.widerGrant).toBe(true);
    expect(finding?.gained).toEqual([]);
    expect(describeSkill(finding!)).toContain('inherits every tool in the session');
  });

  it('is not raised when the grant only got narrower', () => {
    expect(
      grantWidened(
        { kind: GRANT.INHERITS, tools: [] },
        { kind: GRANT.DECLARED, tools: ['Read'] },
      ),
    ).toBe(false);
  });

  it('is not claimed about a record written before grants were read', () => {
    // An old accepted row carries no grant, and inventing one would hold everything.
    expect(grantWidened(undefined, { kind: GRANT.INHERITS, tools: [] })).toBe(false);
  });

  it('is raised when a declared list grew', () => {
    expect(
      grantWidened(
        { kind: GRANT.DECLARED, tools: ['Read'] },
        { kind: GRANT.DECLARED, tools: ['Read', 'Bash'] },
      ),
    ).toBe(true);
  });
});
