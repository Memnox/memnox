import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '../src/index';
import { LocalGate } from '../src/gate/local-gate';
import { resolveAction, resolveShellLine } from '../src/intercept/resolve';

/**
 * The seam every other test skipped. Rules were tested against a request somebody had
 * already built, and resolution was tested for the action name alone, so nothing
 * asked the one question a user asks: does the rule in the README stop the command
 * the README says it stops. It did not — `target` was the subcommand, so every
 * `targets`-scoped rule matched nothing, and every test still passed.
 *
 * Anything added here must go the whole way: a command line a person would type,
 * through resolution, to a verdict.
 */

/** The rule as it appears in README.md and docs/policies.md, word for word. */
const RULE_FILE = `
version = 1

[[policies]]
name = "no-force-push-to-main"

[policies.match]
actions = ["git.push*"]
targets = ["*main*"]

[policies.decision]
effect = "deny"
reason = "main is shared, and a force push loses somebody's work."

[policies.decision.alternative]
action = "git.push"
resource = "a branch"
note = "Push a branch and open a PR."
`;

function verdictFor(gate: LocalGate, line: string) {
  const [binary, ...args] = line.split(' ');
  const resolved = resolveAction(binary as string, args);
  return gate.evaluate({
    action: resolved.action,
    ...(resolved.target === undefined ? {} : { target: resolved.target }),
  });
}

describe('a command line, through the rules, to a verdict', () => {
  let directory: string;
  let gate: LocalGate;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memnox-verdict-'));
    const file = join(directory, 'memnox.policies.toml');
    await writeFile(file, RULE_FILE, 'utf8');
    gate = await LocalGate.fromFiles([file], { agentName: 'claude-code' });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /* Three spellings of the same intent, and each resolves to its own action name so a
     rule about force-pushing cannot deny an ordinary push. A rule meant to cover the
     family says so with a wildcard, which is why the documented one does. */
  it.each([
    ['the long flag', 'git push --force origin main'],
    ['the short flag', 'git push -f origin main'],
    ['no flag at all', 'git push origin main'],
  ])('denies a push at main written with %s', (_name, line) => {
    const verdict = verdictFor(gate, line);

    expect(verdict.effect).toBe(DECISION_EFFECT.DENY);
    expect(verdict.reason).toContain('main is shared');
  });

  it('names what to do instead, so the refusal is not a dead end', () => {
    const verdict = verdictFor(gate, 'git push --force origin main');

    expect(verdict.alternative?.note).toBe('Push a branch and open a PR.');
  });

  it('leaves a push at any other branch alone', () => {
    const verdict = verdictFor(gate, 'git push origin feature/checkout');

    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  // Nothing follows the verb, so there is nothing the rule could be scoped to.
  it('leaves a bare push alone', () => {
    expect(verdictFor(gate, 'git push').effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('leaves a read alone', () => {
    expect(verdictFor(gate, 'git status').effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('what a command was aimed at', () => {
  /* The object of a command sits last in CLI grammar. Taking the first positional
     returned the subcommand on every one of these. */
  it.each([
    ['git', ['push', 'origin', 'main'], 'main'],
    ['git', ['push', '--force', 'origin', 'main'], 'main'],
    ['git', ['checkout', '-b', 'release'], 'release'],
    ['kubectl', ['delete', 'pod', 'api-7'], 'api-7'],
    ['gh', ['pr', 'merge', '123'], '123'],
  ])('reads %s %j as %s', (binary, argv, expected) => {
    expect(resolveAction(binary as string, argv as string[]).target).toBe(expected);
  });

  // A flag's value sits before the object, which is why the last one is taken.
  it('is not confused by a flag carrying a value', () => {
    const resolved = resolveAction('kubectl', [
      'delete',
      '--namespace',
      'payments',
      'pod',
      'api-7',
    ]);

    expect(resolved.target).toBe('api-7');
  });

  it('has no target when the verb consumed everything', () => {
    expect(resolveAction('git', ['push']).target).toBeUndefined();
    expect(resolveAction('git', ['status']).target).toBeUndefined();
  });
});

describe('a shell line an agent actually types', () => {
  /* `$SHELL -c "a && b"` is what an agent's Bash tool calls, and each command in it is
     ruled on separately — so a rule cannot be dodged by chaining. */
  it('rules on every command in the line, each with its own target', () => {
    const { actions } = resolveShellLine('git status && git push --force origin main');

    expect(actions).toHaveLength(2);
    expect(actions[0]?.action).toBe('git.status');
    expect(actions[1]?.action).toBe('git.push-force');
    expect(actions[1]?.target).toBe('main');
  });
});
