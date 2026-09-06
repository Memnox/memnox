import { describe, expect, it } from 'vitest';
import {
  SKILL_STANDING,
  describeSkill,
  discoverSkills,
  quarantined,
  reachOf,
  reviewSkills,
  type AcceptedSkill,
} from '../src/discovery/skills';
import { verbTableNames } from '../src/verbs/tables';
import { FakeMachine } from './fake-machine';

const HOME = '/home/dev';
const NOW = '2026-09-05T10:00:00.000Z';

const machine = (skills: Record<string, string>) =>
  FakeMachine.from(
    Object.fromEntries(
      Object.entries(skills).map(([name, body]) => [
        `${HOME}/.claude/skills/${name}/SKILL.md`,
        body,
      ]),
    ),
    HOME,
  );

describe('what a skill can reach', () => {
  it('matches a tool it names, whole', () => {
    expect(reachOf('run kubectl apply', verbTableNames())).toContain('kubectl');
  });

  it('does not match a longer word that merely contains one', () => {
    expect(reachOf('we are terraforming the site', verbTableNames())).not.toContain(
      'terraform',
    );
  });

  it('names nothing when it names nothing this knows', () => {
    expect(reachOf('summarise the meeting notes', verbTableNames())).toEqual([]);
  });
});

describe('finding them', () => {
  it('reads a skill out of the agent directory it lives in', async () => {
    const found = await discoverSkills(
      machine({ 'deploy-production': 'use kubectl and aws to ship' }),
      [HOME],
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('deploy-production');
    expect(found[0]?.agent).toBe('claude-code');
    expect(found[0]?.reaches).toEqual(['aws', 'kubectl']);
  });

  it('ignores a directory with no skill file in it', async () => {
    const bare = FakeMachine.from(
      { [`${HOME}/.claude/skills/empty/notes.txt`]: 'hello' },
      HOME,
    );
    expect(await discoverSkills(bare, [HOME])).toEqual([]);
  });

  it('finds nothing on a machine with no skills at all', async () => {
    expect(await discoverSkills(FakeMachine.from({}, HOME), [HOME])).toEqual([]);
  });
});

describe('what changed since somebody looked', () => {
  const accepted = (over: Partial<AcceptedSkill> = {}): AcceptedSkill => ({
    id: 'x',
    digest: 'd',
    reaches: [],
    acceptedAt: NOW,
    acceptedBy: 'tresor',
    ...over,
  });

  it('reports a skill nobody has seen as new', async () => {
    const found = await discoverSkills(machine({ helper: 'edit files' }), [HOME]);
    const [finding] = reviewSkills(found, []);
    expect(finding?.standing).toBe(SKILL_STANDING.NEW);
  });

  it('says nothing about one that has not changed', async () => {
    const found = await discoverSkills(machine({ helper: 'edit files' }), [HOME]);
    const [skill] = found;
    const [finding] = reviewSkills(found, [
      accepted({ id: skill!.id, digest: skill!.digest, reaches: skill!.reaches }),
    ]);
    expect(finding?.standing).toBe(SKILL_STANDING.KNOWN);
  });

  it('reports an edit that reaches no further as merely changed', async () => {
    const found = await discoverSkills(machine({ helper: 'edit files carefully' }), [
      HOME,
    ]);
    const [skill] = found;
    const [finding] = reviewSkills(found, [
      accepted({ id: skill!.id, digest: 'older', reaches: skill!.reaches }),
    ]);
    expect(finding?.standing).toBe(SKILL_STANDING.CHANGED);
    expect(quarantined([finding!])).toEqual([]);
  });

  /* The case nobody would otherwise notice: same skill, same name, and now it also
     names a tool that reaches production. */
  it('holds one that reaches further than the accepted version', async () => {
    const found = await discoverSkills(
      machine({ helper: 'edit files, then run kubectl apply' }),
      [HOME],
    );
    const [skill] = found;
    const [finding] = reviewSkills(found, [
      accepted({ id: skill!.id, digest: 'older', reaches: [] }),
    ]);
    expect(finding?.standing).toBe(SKILL_STANDING.WIDENED);
    expect(finding?.gained).toContain('kubectl');
    expect(quarantined([finding!])).toHaveLength(1);
    expect(describeSkill(finding!)).toContain('now also');
  });
});

describe('skills a harness keeps', () => {
  /* Hermes writes its own skills between runs, which is the case this screen exists
     for, and it groups them a directory deeper than everybody else. */
  it('walks a nested layout, naming the skill and not the group it sits in', async () => {
    const machine = FakeMachine.from({
      '/home/dev/.hermes/skills/software-development/DESCRIPTION.md': 'a group',
      '/home/dev/.hermes/skills/software-development/github/SKILL.md': 'uses gh and git',
      '/home/dev/.hermes/skills/apple/imessage/SKILL.md': 'sends messages',
    });

    const found = await discoverSkills(machine);

    expect(found.map((each) => each.name).sort()).toEqual(['github', 'imessage']);
    expect(found.every((each) => each.agent === 'hermes')).toBe(true);
    expect(found.find((each) => each.name === 'github')?.reaches).toEqual(['gh', 'git']);
  });

  it('keeps two skills of the same name apart by where they live', async () => {
    const machine = FakeMachine.from({
      '/home/dev/.hermes/skills/web/search/SKILL.md': 'one',
      '/home/dev/.hermes/skills/research/search/SKILL.md': 'another',
    });

    const found = await discoverSkills(machine);

    expect(found).toHaveLength(2);
    expect(new Set(found.map((each) => each.id)).size).toBe(2);
  });

  /* `.agents/skills` is the Codex-mode convention and anything may write there. Calling
     it Ruflo would report a swarm on a machine that has none. */
  it('attributes the shared agents directory to Codex, never to a harness', async () => {
    const machine = FakeMachine.from({ '/home/dev/.agents/skills/gsap/SKILL.md': 'x' });

    expect((await discoverSkills(machine))[0]?.agent).toBe('codex');
  });

  it('does not treat a group directory with no skill under it as a skill', async () => {
    const machine = FakeMachine.from({
      '/home/dev/.hermes/skills/empty/DESCRIPTION.md': 'a group and nothing else',
    });

    expect(await discoverSkills(machine)).toEqual([]);
  });
});
