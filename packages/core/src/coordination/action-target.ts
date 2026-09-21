/**
 * The thing a tool call acts on, as a ref two agents would both produce, such as
 * `github:acme/api#pull/12`. Read from the call's own arguments, never fetched or guessed.
 */

/** One way a provider names a thing, never its container, since two messages in a channel do not collide. */
interface ResourceShape {
  /** Argument names, in order. Every one must be present, or this shape misses. */
  fields: readonly string[];
  /** What the ref reads as, with `$1`, `$2` … for the fields it found. */
  ref: string;
}

/** A provider, by the name the server is wrapped under, and its shapes. */
interface ProviderShapes {
  /** Matched against the server name, lowercased, as a substring. */
  matches: readonly string[];
  /** Tried in order, so the most specific shape a call satisfies is the one it is filed under. */
  shapes: readonly ResourceShape[];
}

const PROVIDERS: readonly ProviderShapes[] = [
  {
    matches: ['github'],
    shapes: [
      { fields: ['owner', 'repo', 'pull_number'], ref: 'github:$1/$2#pull/$3' },
      { fields: ['owner', 'repo', 'issue_number'], ref: 'github:$1/$2#issue/$3' },
      { fields: ['owner', 'repo', 'path'], ref: 'github:$1/$2#file/$3' },
    ],
  },
  {
    matches: ['gitlab'],
    shapes: [
      { fields: ['project_id', 'merge_request_iid'], ref: 'gitlab:$1#merge/$2' },
      { fields: ['project_id', 'issue_iid'], ref: 'gitlab:$1#issue/$2' },
    ],
  },
  {
    matches: ['slack'],
    shapes: [
      // A thread, where named: two replies to one thread collide, two posts to a channel do not.
      { fields: ['channel', 'thread_ts'], ref: 'slack:$1#$2' },
      { fields: ['channel_id', 'thread_ts'], ref: 'slack:$1#$2' },
      { fields: ['channel', 'ts'], ref: 'slack:$1#$2' },
      { fields: ['channel_id', 'ts'], ref: 'slack:$1#$2' },
    ],
  },
  {
    matches: ['linear'],
    shapes: [
      { fields: ['issueId'], ref: 'linear:$1' },
      { fields: ['issue_id'], ref: 'linear:$1' },
      { fields: ['issueKey'], ref: 'linear:$1' },
    ],
  },
  {
    // The Atlassian server carries Jira and Confluence both, so each entry matches it.
    matches: ['jira', 'atlassian'],
    shapes: [
      { fields: ['issueIdOrKey'], ref: 'jira:$1' },
      { fields: ['issue_key'], ref: 'jira:$1' },
      { fields: ['issueKey'], ref: 'jira:$1' },
    ],
  },
  {
    matches: ['confluence', 'atlassian'],
    shapes: [
      { fields: ['pageId'], ref: 'confluence:$1' },
      { fields: ['page_id'], ref: 'confluence:$1' },
    ],
  },
  {
    matches: ['notion'],
    shapes: [
      { fields: ['page_id'], ref: 'notion:page/$1' },
      { fields: ['database_id'], ref: 'notion:database/$1' },
      { fields: ['block_id'], ref: 'notion:block/$1' },
    ],
  },
  {
    matches: ['docs', 'drive'],
    shapes: [
      { fields: ['documentId'], ref: 'gdoc:$1' },
      { fields: ['document_id'], ref: 'gdoc:$1' },
      { fields: ['fileId'], ref: 'gdrive:$1' },
      { fields: ['file_id'], ref: 'gdrive:$1' },
    ],
  },
  {
    matches: ['calendar'],
    shapes: [
      // By the event alone, so two agents naming its calendar differently still meet.
      { fields: ['eventId'], ref: 'gcal:event/$1' },
      { fields: ['event_id'], ref: 'gcal:event/$1' },
    ],
  },
  {
    matches: ['gmail', 'mail'],
    shapes: [
      { fields: ['threadId'], ref: 'gmail:thread/$1' },
      { fields: ['thread_id'], ref: 'gmail:thread/$1' },
      { fields: ['messageId'], ref: 'gmail:message/$1' },
      { fields: ['message_id'], ref: 'gmail:message/$1' },
    ],
  },
  {
    matches: ['asana'],
    shapes: [{ fields: ['task_gid'], ref: 'asana:task/$1' }],
  },
  {
    matches: ['monday'],
    shapes: [
      { fields: ['itemId'], ref: 'monday:item/$1' },
      { fields: ['item_id'], ref: 'monday:item/$1' },
    ],
  },
  {
    matches: ['clickup'],
    shapes: [{ fields: ['task_id'], ref: 'clickup:task/$1' }],
  },
  {
    matches: ['hubspot'],
    shapes: [
      { fields: ['objectType', 'objectId'], ref: 'hubspot:$1/$2' },
      { fields: ['dealId'], ref: 'hubspot:deal/$1' },
      { fields: ['contactId'], ref: 'hubspot:contact/$1' },
    ],
  },
  {
    matches: ['salesforce'],
    shapes: [
      // A record id is unique across objects, so the object name stays out of the ref.
      { fields: ['recordId'], ref: 'salesforce:$1' },
    ],
  },
  {
    matches: ['intercom'],
    shapes: [
      { fields: ['conversation_id'], ref: 'intercom:conversation/$1' },
      { fields: ['contact_id'], ref: 'intercom:contact/$1' },
    ],
  },
  {
    matches: ['zendesk'],
    shapes: [{ fields: ['ticket_id'], ref: 'zendesk:ticket/$1' }],
  },
  {
    matches: ['pagerduty'],
    shapes: [{ fields: ['incident_id'], ref: 'pagerduty:incident/$1' }],
  },
  {
    matches: ['stripe'],
    shapes: [
      { fields: ['invoice'], ref: 'stripe:invoice/$1' },
      { fields: ['subscription'], ref: 'stripe:subscription/$1' },
    ],
  },
];

/**
 * The thing this call acts on, or undefined where nothing names it, which is ordinary:
 * the call is still compared exactly. A resource catches two different actions on one thing.
 */
export function actionResource(
  serverName: string,
  args: Record<string, string>,
): string | undefined {
  const name = serverName.toLowerCase();
  const shapes = PROVIDERS.filter((each) =>
    each.matches.some((match) => name.includes(match)),
  ).flatMap((each) => each.shapes);

  for (const shape of shapes) {
    const found = shape.fields.map((field) => args[field]);
    if (found.some((value) => value === undefined || value.trim() === '')) continue;
    const ref = shape.ref.replace(/\$(\d)/g, (_whole, index: string) =>
      (found[Number(index) - 1] ?? '').trim(),
    );
    return ref.toLowerCase();
  }
  return undefined;
}
