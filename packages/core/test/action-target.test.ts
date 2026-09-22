import { describe, expect, it } from 'vitest';
import { actionResource } from '../src/coordination/action-target';

/* Two agents on one pull request, one commenting and one closing it, are not
   repeating each other and are still in each other's way. Nothing can see that
   without knowing which thing each call is about. */
describe('the thing a tool call acts on', () => {
  it('reads one pull request the same way from two different calls', () => {
    const comment = actionResource('github', {
      owner: 'acme',
      repo: 'api',
      pull_number: '12',
      body: 'looks good',
    });
    const close = actionResource('github', {
      owner: 'acme',
      repo: 'api',
      pull_number: '12',
      state: 'closed',
    });

    expect(comment).toBe('github:acme/api#pull/12');
    expect(close).toBe(comment);
  });

  it('takes the most specific thing a call names', () => {
    expect(
      actionResource('github', { owner: 'acme', repo: 'api', issue_number: '9' }),
    ).toBe('github:acme/api#issue/9');
  });

  /* A repository, a project or a board is where many pieces of work sit side by
     side. Two agents opening two different issues in one repository are not in
     each other's way, so a call that names only its container has no resource. */
  it('never files a call under the place it happens in', () => {
    expect(
      actionResource('github', { owner: 'acme', repo: 'api', title: 'Bug' }),
    ).toBeUndefined();
    expect(actionResource('gitlab', { project_id: '7' })).toBeUndefined();
    expect(actionResource('asana', { project_gid: 'p1' })).toBeUndefined();
    expect(actionResource('stripe', { customer: 'cus_1' })).toBeUndefined();
  });

  it('reads one event the same way whether or not the calendar is named', () => {
    expect(
      actionResource('google-calendar', { calendarId: 'primary', eventId: 'evt1' }),
    ).toBe(actionResource('google-calendar', { eventId: 'evt1' }));
  });

  /* The Atlassian server carries Jira and Confluence both, and a page on it
     used to be tried against the Jira fields only. */
  it('finds a Confluence page on the Atlassian server', () => {
    expect(actionResource('atlassian', { pageId: '123' })).toBe('confluence:123');
    expect(actionResource('atlassian', { issueIdOrKey: 'PROJ-1' })).toBe('jira:proj-1');
  });

  it('reads an issue, a page, a document and an event by their own names', () => {
    expect(actionResource('linear', { issueId: 'ENG-45' })).toBe('linear:eng-45');
    expect(actionResource('jira', { issueIdOrKey: 'PROJ-12' })).toBe('jira:proj-12');
    expect(actionResource('notion', { page_id: 'abc123' })).toBe('notion:page/abc123');
    expect(actionResource('google-docs', { documentId: 'doc1' })).toBe('gdoc:doc1');
    expect(actionResource('google-calendar', { eventId: 'evt1' })).toBe(
      'gcal:event/evt1',
    );
    expect(actionResource('hubspot', { dealId: 'd1' })).toBe('hubspot:deal/d1');
  });

  /* A thread is the thing two agents share; a channel is where everybody
     posts, and two messages in one channel are two pieces of work. */
  it('tells a Slack thread from the channel it is in', () => {
    expect(actionResource('slack', { channel: 'C1', thread_ts: '99.1' })).toBe(
      'slack:c1#99.1',
    );
    expect(actionResource('slack', { channel: 'C1', text: 'hello' })).toBeUndefined();
  });

  /* Named per provider, never guessed: a wrong resource is two agents told
     they are in each other's way when they are not, and that is silent. */
  it('names nothing for a provider with no entry', () => {
    expect(actionResource('some-internal-tool', { id: '42' })).toBeUndefined();
  });

  it('names nothing when the call carries none of the fields', () => {
    expect(actionResource('github', { query: 'is:open' })).toBeUndefined();
  });
});
