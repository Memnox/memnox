/**
 * Provenance-based prompt-injection defense. Trust is decided at ingestion from
 * the source type AND the actor behind it — the same source type can be trusted
 * or untrusted depending on who authored the content.
 */

/** Provenance refs carried per assessment — enough to explain, bounded in storage. */
export const TAINT_MAX_SOURCE_REFS = 10;

/** Untrusted regardless of authority score — third-party-authored free text. */
export const ALWAYS_TAINTED_SOURCE_TYPES: readonly string[] = [
  'email_message',
  'document',
  'discord_message',
  'notion_page',
  'confluence_page',
  'google_doc',
];

/** Ground truth — code artifacts and recorded team decisions an authority score must never taint. */
export const NEVER_TAINTED_SOURCE_TYPES: readonly string[] = [
  'github_file',
  'github_symbol',
  'github_line_chunk',
  'extracted_decision',
];

/** Source types whose trust depends on WHO authored the content. */
export const GITHUB_ACTOR_SENSITIVE_SOURCE_TYPES: readonly string[] = [
  'github_issue',
  'github_comment',
  'github_review',
  'github_pull_request',
];

/** GitHub author_association values inside the repository's trust boundary. */
export const TRUSTED_GITHUB_AUTHOR_ASSOCIATIONS: readonly string[] = [
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
];

export const SLACK_SOURCE_TYPE = 'slack_message';
export const UNKNOWN_SOURCE_TYPE = 'unknown';

/** Actor facts the ingestion path resolves and forwards — the classifier never looks anything up. */
export const TAINT_META_AUTHOR_ASSOCIATION = 'authorAssociation';
export const TAINT_META_AUTHOR_IS_MEMBER = 'authorIsWorkspaceMember';
export const TAINT_META_SOURCE_TYPE = 'sourceType';
export const TAINT_META_TAINTED = 'tainted';

/** Session provenance outlives any single action — matched to the approval TTL. */
export const TAINT_SESSION_TTL_S = 7 * 24 * 60 * 60;
export const TAINT_SESSION_KEY_PREFIX = 'memnox:taint:session:';
export const TAINT_SESSION_LOCK_PREFIX = 'memnox:taint:lock:';
export const TAINT_SESSION_LOCK_TTL_S = 30;

export const TAINT_UNREADABLE_SOURCE_TYPE = 'unreadable_state';
export const TAINT_UNREADABLE_REASON =
  'session taint state unreadable — provenance cannot be proven clean';

/**
 * Irreversible, whole-estate destruction: while a session's context is tainted
 * these are blocked outright, and no approval — routine or break-glass — lifts it.
 */
export const TAINT_NO_OVERRIDE_ACTIONS: readonly string[] = [
  'project.delete',
  'database.drop',
];
