import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicySet } from '../src/gate/policy-file';
import { validatePolicyDocument } from '../src/policy/policy-validator';

const rule = (name: string, effect: string): string =>
  `version: 1
policies:
  - name: ${name}
    match: { actions: ["file.write"] }
    decision: { effect: ${effect}, reason: ${name} }
`;

describe('reading every rule file on a machine', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-set-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /* The registry lists every repository on the disk. One stale checkout used to make
     the scan report "no rule covers this" about a machine with rules in force. */
  it('keeps one repository from blanking every other repository', async () => {
    const good = join(dir, 'good.yaml');
    const stale = join(dir, 'stale.yaml');
    await writeFile(good, rule('good-rule', 'deny'), 'utf8');
    await writeFile(stale, rule('stale-rule', 'block'), 'utf8');

    const set = await loadPolicySet([stale, good]);

    expect(set.policies.map((policy) => policy.name)).toEqual(['good-rule']);
    expect(set.loaded).toEqual([{ file: good, rules: 1 }]);
    expect(set.unreadable.map((broken) => broken.file)).toEqual([stale]);
  });

  it('lists everything wrong with a file, not just the first thing', async () => {
    const broken = join(dir, 'broken.yaml');
    await writeFile(
      broken,
      `version: 1
policies:
  - name: one
    match: { actions: ["file.write"] }
    decision: { effect: block }
  - name: two
    match: { actions: ["file.write"] }
    decision: { effect: require_approval }
`,
      'utf8',
    );

    const [entry] = (await loadPolicySet([broken])).unreadable;

    expect(entry?.issues).toHaveLength(2);
  });

  /* A registered path belongs to somebody's checkout, which moves. That is not a fault
     to fix, so it is reported apart from a file that is there and will not parse. */
  it('separates a checkout that moved from a file that will not parse', async () => {
    const gone = join(dir, 'gone.yaml');

    const set = await loadPolicySet([gone]);

    expect(set.missing).toEqual([gone]);
    expect(set.unreadable).toEqual([]);
  });

  it('counts the rules each file contributed', async () => {
    const file = join(dir, 'two.yaml');
    await writeFile(
      file,
      `version: 1
policies:
  - name: one
    match: { actions: ["file.write"] }
    decision: { effect: deny }
  - name: two
    match: { actions: ["file.read"] }
    decision: { effect: ask }
`,
      'utf8',
    );

    expect((await loadPolicySet([file])).loaded).toEqual([{ file, rules: 2 }]);
  });
});

describe('an effect this file used to call something else', () => {
  const documentWith = (effect: string): unknown => ({
    version: 1,
    policies: [{ name: 'x', match: { actions: ['file.write'] }, decision: { effect } }],
  });

  /* Somebody's file predates a rename. Listing the three valid names leaves them
     guessing which of the three their word became; saying it outright does not. */
  it.each([
    ['block', 'deny'],
    ['withhold', 'deny'],
    ['require_approval', 'ask'],
    ['escalate', 'ask'],
  ])('tells a file that says %s to write %s', (was, now) => {
    expect(() => validatePolicyDocument(documentWith(was))).toThrow(
      `"${was}" is now "${now}"`,
    );
  });

  it('still lists the three when the word was never an effect at all', () => {
    expect(() => validatePolicyDocument(documentWith('maybe'))).toThrow(
      'must be one of: allow, deny, ask',
    );
  });
});
