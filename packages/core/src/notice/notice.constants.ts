/**
 * What noticing the unusual counts, and for how long it remembers. Named here so a window a
 * person reads in a reason and the window the code applies are the same number.
 */

/** The three things that make an allowed action worth a second look. */
export const NOTICE_SIGNAL = {
  /** This agent has not done this kind of thing to this kind of target before. */
  NOVEL: 'novel',
  /** Something worth having was taken earlier in the session, and this sends outward. */
  CHAIN: 'chain',
  /** A tool result earlier in the session read like instructions. */
  TAINT: 'taint',
  /** A session that only read outside this machine makes its first change there. */
  TURN: 'turn',
} as const;

export type NoticeSignal = (typeof NOTICE_SIGNAL)[keyof typeof NOTICE_SIGNAL];

/** How a notice names itself among a verdict's signals, beside `policy:` ones. */
export const NOTICE_SIGNAL_PREFIX = 'notice:';

/** Whether a notice changes the verdict, only records what it would have said, or is off. */
export const NOTICE_MODE = {
  ENFORCE: 'enforce',
  OBSERVE: 'observe',
  OFF: 'off',
} as const;

export type NoticeMode = (typeof NOTICE_MODE)[keyof typeof NOTICE_MODE];

/** Long enough to cover a monthly job, short enough that last year is not a licence. */
export const NOVELTY_HISTORY_DAYS = 30;

/** Day one records only, so a new install is not a wall of questions. */
export const DEFAULT_NOTICE_WARMUP_DAYS = 3;

/** Taking a credential and sending it half an hour later is still one motion. */
export const CHAIN_WINDOW_MINUTES = 30;

/** How long an instruction-shaped result keeps a session under suspicion. */
export const TAINT_WINDOW_MINUTES = 30;

/** A bound on the seen set, so remembering stays a small file for ever. */
export const MOST_SEEN_PER_AGENT = 2000;

/** A bound on the acquisitions a session remembers; the window drops the rest anyway. */
export const MOST_ACQUIRED_PER_SESSION = 16;

/** The acquisitions a chain reason names, so the sentence stays one sentence. */
export const MOST_STEPS_NAMED = 3;

/** Under the Memnox home. */
export const NOTICE_DIR = 'notice';
export const NOTICE_SEEN_DIR = 'seen';
export const NOTICE_SESSIONS_DIR = 'sessions';
export const NOTICE_STARTED_FILE = 'started.json';

/** The session a seam files signals under when `memnox run` named none: the agent itself. */
export const AGENT_SESSION_PREFIX = 'agent:';

/** The rows that record a session being put under suspicion and let out of it. */
export const NOTICE_OPERATION = {
  TAINTED: 'memnox.session-tainted',
  TAINT_CLEARED: 'memnox.session-taint-cleared',
} as const;
