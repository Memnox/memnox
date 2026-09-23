import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boundaryContext,
  DECISION_EFFECT,
  DECISION_ORIGIN,
  decisionsCovering,
  decisionsMentioned,
  decisionsOf,
  describeDecision,
  emptyContextState,
  ENFORCEMENT_MODE,
  HOW_TO_ANSWER,
  markShown,
  MEMNOX_HOME,
  MOST_BOUNDARY_CHARS,
  MOST_PENDING_ASKS,
  MOST_PRUNED_PER_PASS,
  MOST_SHOWN_PER_SESSION,
  notYetShown,
  orgPolicyPathFor,
  pruneSessionFiles,
  rememberAsk,
  rulesHere,
  SessionContextStore,
  takeAsk,
  writePolicyDocumentFile,
  type PendingAsk,
  type Policy,
} from '../src/index';

/**
 * What Memnox says inside an agent's session is read by the model on every turn, so it has
 * to be short, the same every time, and said once. These pin the block's bounds, what a
 * remembered decision matches, and the session record that keeps each said only once.
 */

const RULES: Policy[] = [
  {
    name: 'secrets-deny',
    match: { actions: ['filesystem.read'], targets: ['**/.ssh/**', '**/.env'] },
    decision: { effect: DECISION_EFFECT.DENY, reason: 'keys stay on this machine' },
  },
  {
    name: 'payments-ask',
    match: { actions: ['filesystem.write'], targets: ['src/payments/**'] },
    decision: {
      effect: DECISION_EFFECT.ASK,
      reason: 'Priya decided payments changes are reviewed, approved by Sam',
    },
  },
  {
    name: 'push-watch',
    match: { actions: ['git.push'] },
    decision: { effect: DECISION_EFFECT.DENY, reason: 'watched only', mode: 'observe' },
  },
];

const NOW = new Date('2026-09-24T10:00:00.000Z');

describe('the boundary said when a session starts', () => {
  it('names the mode, what is refused and asked, the boundary, probation and how to answer', () => {
    const text = boundaryContext({
      mode: ENFORCEMENT_MODE.ENFORCE,
      rules: RULES,
      containment: {
        root: '/work/repo',
        probation: {
          name: 'claude-code',
          until: '2026-10-01T00:00:00.000Z',
          trustCommand: 'memnox agents trust claude-code',
        },
      },
    });

    expect(text).toContain('enforce mode');
    expect(text).toContain('Never run here: filesystem.read on **/.ssh/**, **/.env');
    expect(text).toContain(
      'A person is asked first: filesystem.write on src/payments/**',
    );
    expect(text).toContain('Project boundary: /work/repo');
    expect(text).toContain('claude-code is on probation until 2026-10-01');
    expect(text.endsWith(HOW_TO_ANSWER)).toBe(true);
    // An observed rule decides nothing, so it is not described as refusing anything.
    expect(text).not.toContain('git.push');
  });

  it('says it is only watching in observe mode, and nothing at all when off', () => {
    const watching = boundaryContext({
      mode: ENFORCEMENT_MODE.OBSERVE,
      rules: [],
      containment: null,
    });
    expect(watching).toContain('observe mode: nothing is stopped');
    expect(
      boundaryContext({ mode: ENFORCEMENT_MODE.OFF, rules: RULES, containment: null }),
    ).toBe('');
  });

  it('stays inside its bound however many rules and however long their reasons', () => {
    const many: Policy[] = Array.from({ length: 50 }, (_, index) => ({
      name: `rule-${index}`,
      match: {
        actions: [`tool.action-${index}`],
        targets: [`/some/very/long/path/${'x'.repeat(200)}`],
      },
      decision: {
        effect: index % 2 === 0 ? DECISION_EFFECT.DENY : DECISION_EFFECT.ASK,
        reason: 'y'.repeat(500),
      },
    }));
    const text = boundaryContext({
      mode: ENFORCEMENT_MODE.ENFORCE,
      rules: many,
      containment: { root: '/work/repo' },
    });

    expect(text.length).toBeLessThanOrEqual(MOST_BOUNDARY_CHARS);
    expect(text).toContain('and 21 more');
    expect(text).toContain(HOW_TO_ANSWER);
    expect(
      boundaryContext({ mode: ENFORCEMENT_MODE.ENFORCE, rules: many, containment: null }),
    ).toBe(
      boundaryContext({ mode: ENFORCEMENT_MODE.ENFORCE, rules: many, containment: null }),
    );
  });
});

describe('a decision found again where it applies', () => {
  const decisions = decisionsOf(RULES, DECISION_ORIGIN.TEAM);

  it('covers a path the rule names, and says who decided in the rule words', () => {
    const found = decisionsCovering(decisions, {
      action: 'filesystem.write',
      target: 'src/payments/charge.ts',
    });

    expect(found).toHaveLength(1);
    expect(describeDecision(found[0]!)).toBe(
      "A previous decision covers src/payments/charge.ts: a person is asked first, because Priya decided payments changes are reviewed, approved by Sam (your team's published rules).",
    );
  });

  it('never reads a rule over every action as a decision about this one', () => {
    const everything = decisionsOf(
      [
        {
          name: 'all',
          match: { actions: ['*'] },
          decision: { effect: DECISION_EFFECT.ASK },
        },
      ],
      DECISION_ORIGIN.MACHINE,
    );
    expect(
      decisionsCovering(everything, { action: 'filesystem.read', target: '/x' }),
    ).toEqual([]);
  });

  it('finds the decision a prompt names by a folder or by an action in words', () => {
    const byPath = decisionsMentioned(decisions, 'Please refactor "payments/" today.');
    expect(byPath.map((each) => each.subject)).toEqual(['payments/']);

    const spoken = decisionsMentioned(decisions, 'then git push it');
    expect(spoken.map((each) => each.decision.actions)).toEqual([['git.push']]);
    expect(decisionsMentioned(decisions, 'fix the typo in the readme')).toEqual([]);
  });

  it('carries the date a person decided it on this machine', () => {
    const dated = decisionsOf(RULES, DECISION_ORIGIN.MACHINE, [
      {
        operation: 'filesystem.read',
        effect: 'deny',
        decidedAt: '2026-09-01T09:00:00.000Z',
      },
    ]);
    const [found] = decisionsCovering(dated, {
      action: 'filesystem.read',
      target: '/h/.env',
    });
    expect(describeDecision(found!)).toContain('(decided on this machine on 2026-09-01)');
  });
});

function ask(fingerprint: string, at: string): PendingAsk {
  return {
    fingerprint,
    at,
    tool: 'Bash',
    action: 'git.push',
    class: 'write',
    mode: 'enforce',
    reason: 'r',
  };
}

describe("a session's record of what it was told and asked", () => {
  it('shows each decision once, and forgets the oldest past its bound', () => {
    let state = markShown(emptyContextState(), ['a'], NOW.toISOString());
    expect(notYetShown(state, ['a', 'b'])).toEqual(['b']);

    const ids = Array.from(
      { length: MOST_SHOWN_PER_SESSION + 5 },
      (_, index) => `id-${index}`,
    );
    for (const [index, id] of ids.entries()) {
      state = markShown(
        state,
        [id],
        new Date(NOW.getTime() + index * 1000).toISOString(),
      );
    }
    expect(Object.keys(state.shown)).toHaveLength(MOST_SHOWN_PER_SESSION);
    expect(notYetShown(state, ['a'])).toEqual(['a']);
  });

  it('answers a question once, and never after its window', () => {
    let state = rememberAsk(emptyContextState(), ask('call-1', NOW.toISOString()));
    const taken = takeAsk(state, 'call-1', NOW.toISOString());
    expect(taken.ask?.fingerprint).toBe('call-1');
    expect(takeAsk(taken.state, 'call-1', NOW.toISOString()).ask).toBeNull();

    state = rememberAsk(emptyContextState(), ask('call-2', NOW.toISOString()));
    expect(takeAsk(state, 'call-2', '2026-09-24T11:00:00.000Z').ask).toBeNull();
  });

  it('keeps a bounded number of questions waiting', () => {
    let state = emptyContextState();
    for (let index = 0; index < MOST_PENDING_ASKS + 3; index += 1) {
      state = rememberAsk(state, ask(`call-${index}`, NOW.toISOString()));
    }
    expect(state.asks).toHaveLength(MOST_PENDING_ASKS);
    expect(state.asks[0]?.fingerprint).toBe('call-3');
  });

  it('round trips through its file, and reads a torn one as nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-context-'));
    const store = new SessionContextStore(home);
    await store.write('s1', markShown(emptyContextState(), ['a'], NOW.toISOString()));
    expect(notYetShown(await store.read('s1'), ['a'])).toEqual([]);
    expect(await store.read('s2')).toEqual(emptyContextState());
  });
});

describe('old session files are let go on a schedule', () => {
  async function sessionFiles(
    home: string,
    dir: string,
    count: number,
    at: Date,
  ): Promise<void> {
    const path = join(home, MEMNOX_HOME, dir, 'sessions');
    await mkdir(path, { recursive: true });
    for (let index = 0; index < count; index += 1) {
      const file = join(path, `${dir}-${at.getTime()}-${index}.json`);
      await writeFile(file, '{}');
      await utimes(file, at, at);
    }
  }

  it('removes week old files under noticing and context, keeps recent ones, once a day', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-prune-'));
    const old = new Date('2026-09-01T00:00:00.000Z');
    await sessionFiles(home, 'notice', 3, old);
    await sessionFiles(home, 'context', 2, old);
    await sessionFiles(home, 'notice', 1, NOW);

    expect(await pruneSessionFiles(home, NOW)).toBe(5);
    expect(await readdir(join(home, MEMNOX_HOME, 'notice', 'sessions'))).toHaveLength(1);

    await sessionFiles(home, 'notice', 2, old);
    expect(await pruneSessionFiles(home, new Date(NOW.getTime() + 1000))).toBe(0);
  });

  it('removes a bounded number in one pass', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-prune-'));
    await sessionFiles(
      home,
      'notice',
      MOST_PRUNED_PER_PASS + 10,
      new Date('2026-09-01T00:00:00.000Z'),
    );
    expect(await pruneSessionFiles(home, NOW)).toBe(MOST_PRUNED_PER_PASS);
  });
});

describe('the rules that apply to one repository', () => {
  it('credits the team, the machine and the repository, and leaves another repository out', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-rules-'));
    const team = orgPolicyPathFor(home);
    const machine = join(home, MEMNOX_HOME, 'machine.policies.toml');
    const repo = join(home, 'work', 'repo', 'memnox.policies.toml');
    const other = join(home, 'work', 'other', 'memnox.policies.toml');
    for (const [file, rule] of [
      [team, RULES[1]!],
      [machine, RULES[0]!],
      [repo, { ...RULES[0]!, name: 'repo-rule' }],
      [other, { ...RULES[0]!, name: 'other-rule' }],
    ] as const) {
      await mkdir(join(file, '..'), { recursive: true });
      await writePolicyDocumentFile(file, { version: 1, policies: [rule] });
    }

    const here = await rulesHere({
      home,
      policyFiles: [team, machine, repo, other, join(home, 'gone.toml')],
      root: join(home, 'work', 'repo'),
      agent: 'claude-code',
    });

    expect(here.rules.map((rule) => rule.name)).toEqual([
      'payments-ask',
      'secrets-deny',
      'repo-rule',
    ]);
    expect(here.decisions.map((each) => each.origin)).toEqual([
      DECISION_ORIGIN.TEAM,
      DECISION_ORIGIN.MACHINE,
      DECISION_ORIGIN.REPOSITORY,
    ]);
  });
});
