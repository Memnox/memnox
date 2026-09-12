import { describe, expect, it } from 'vitest';
import {
  actionForVerb,
  parseQuestion,
  QUESTION_VERB,
  questionVerbs,
} from '../src/domain/question';

describe('the question grammar', () => {
  it('reads the shape the help line promises', () => {
    const { question } = parseQuestion('can claude read ~/.aws');
    expect(question).toEqual({
      agent: 'claude',
      verb: QUESTION_VERB.READ,
      resource: '~/.aws',
    });
  });

  it('drops the filler people actually type', () => {
    const { question } = parseQuestion(
      'Is claude able to deploy the payments service right now?',
    );
    expect(question).toEqual({
      agent: 'claude',
      verb: QUESTION_VERB.DEPLOY,
      resource: 'payments service',
    });
  });

  it.each([
    ['can cursor merge main', QUESTION_VERB.MERGE],
    ['can codex push origin', QUESTION_VERB.PUSH],
    ['can claude ship payments', QUESTION_VERB.DEPLOY],
    ['can claude drop users', QUESTION_VERB.DELETE],
    ['can claude email customers', QUESTION_VERB.SEND],
    ['can claude modify billing.ts', QUESTION_VERB.WRITE],
    ['can claude view secrets', QUESTION_VERB.READ],
  ])('maps the synonyms in %s', (raw, verb) => {
    expect(parseQuestion(raw).question?.verb).toBe(verb);
  });

  it('refuses an unknown phrasing rather than guessing at it', () => {
    const { question, error } = parseQuestion('can claude frobnicate the widget');
    expect(question).toBeUndefined();
    expect(error).toContain('will not guess');
    // The refusal has to say what to type instead, or it is a dead end.
    expect(error).toContain('can <agent> <verb> <resource>');
    expect(error).toContain('deploy');
  });

  it('asks for the agent when the question names none', () => {
    expect(parseQuestion('can read ~/.ssh').error).toContain('Name the agent');
  });

  it('asks for the resource when the question names none', () => {
    expect(parseQuestion('can claude deploy').error).toContain('Name what the agent');
  });

  it('says so plainly when there is no question at all', () => {
    expect(parseQuestion('   ').error).toContain('no question');
  });

  it('gives every verb an action namespace, so a question meets the same rules a call does', () => {
    for (const verb of questionVerbs()) {
      expect(actionForVerb(verb)).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});

/**
 * A rule names an absolute path, because that is what a seam hands the gate.
 * Asked with a `~`, `memnox explain` used to answer "no rule matched" about a
 * file that was in fact denied — the worst direction for the one command whose
 * job is telling somebody whether they are covered.
 */
describe('a home path asked the way a person writes it', () => {
  const HOME = '/Users/nia';

  it('expands a leading tilde to the home it was given', () => {
    const { question } = parseQuestion('can cursor read ~/.ssh/id_ed25519', HOME);

    expect(question?.resource).toBe('/Users/nia/.ssh/id_ed25519');
  });

  it('expands a bare tilde', () => {
    expect(parseQuestion('can cursor read ~', HOME).question?.resource).toBe(HOME);
  });

  it('leaves an absolute path exactly as it was', () => {
    const { question } = parseQuestion('can cursor read /etc/hosts', HOME);

    expect(question?.resource).toBe('/etc/hosts');
  });

  /* No home is a reason to answer about the literal text, not to guess at one. */
  it('leaves the tilde alone when no home was given', () => {
    expect(parseQuestion('can cursor read ~/.ssh/id_ed25519').question?.resource).toBe(
      '~/.ssh/id_ed25519',
    );
  });

  /* This knows one home. Inventing another person's would be a guess, so it stays
     a literal and matches nothing, which is the honest answer. */
  it('does not invent another user’s home', () => {
    expect(
      parseQuestion('can cursor read ~root/.ssh/id_rsa', HOME).question?.resource,
    ).toBe('~root/.ssh/id_rsa');
  });

  it('does not touch a tilde that is not leading', () => {
    expect(parseQuestion('can cursor read /tmp/a~b', HOME).question?.resource).toBe(
      '/tmp/a~b',
    );
  });
});
