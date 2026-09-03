import { describe, expect, it } from 'vitest';
import { ACTION_CLASS, CLASS_BASIS } from '../src/constants/action-class.constants';
import { classifyActionClass, describeActionClass } from '../src/domain/action-class';

describe('three classes, and the class is taken from the effect', () => {
  it('calls a destructive verb destructive wherever it arrives', () => {
    expect(classifyActionClass('stripe.delete_customer').class).toBe(
      ACTION_CLASS.DESTRUCTIVE,
    );
    expect(classifyActionClass('filesystem.purge').class).toBe(ACTION_CLASS.DESTRUCTIVE);
  });

  it('treats outward communication as external state whatever the tool calls itself', () => {
    const slack = classifyActionClass('slack.send_message');
    expect(slack.class).toBe(ACTION_CLASS.EXTERNAL_STATE);
    expect(slack.basis).toBe(CLASS_BASIS.OUTWARD);

    // The namespace says nothing; the verb does. An agent speaking as somebody is
    // the same act whichever server carries it.
    const unnamed = classifyActionClass('acme_relay.notify_customers');
    expect(unnamed.class).toBe(ACTION_CLASS.EXTERNAL_STATE);
    expect(unnamed.basis).toBe(CLASS_BASIS.OUTWARD);
  });

  it('leaves a read local wherever it reads from', () => {
    expect(classifyActionClass('github.get_issue').class).toBe(ACTION_CLASS.LOCAL);
    expect(classifyActionClass('github.list_repositories').basis).toBe(
      CLASS_BASIS.READ_VERB,
    );
  });

  it('keeps a write on the machine local', () => {
    expect(classifyActionClass('filesystem.write').class).toBe(ACTION_CLASS.LOCAL);
    expect(classifyActionClass('git.commit').class).toBe(ACTION_CLASS.LOCAL);
  });

  it('does not call an unproven action local', () => {
    const unknown = classifyActionClass('mcp.acme_widget');
    expect(unknown.class).toBe(ACTION_CLASS.EXTERNAL_STATE);
    expect(unknown.basis).toBe(CLASS_BASIS.UNPROVEN);
  });

  it('states the method, so a wrong call is arguable', () => {
    expect(describeActionClass(classifyActionClass('slack.send_message'))).toContain(
      'outward communication',
    );
  });
});
