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
