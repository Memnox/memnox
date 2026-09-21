/**
 * Two agents in one file inside this window are working at the same time: long enough to
 * outlast a test run, short enough that yesterday's edit is not a collision.
 */
export const DEFAULT_COLLISION_WINDOW_MINUTES = 30;

/** One shared file is a coincidence; two is a reason to ask somebody. */
export const MINIMUM_SHARED_TARGETS = 2;

/** How many rows a screen that summarises the ledger reads: bounded, because a person is waiting. */
export const LEDGER_SCAN_LIMIT = 20_000;

/** A whole window's operations, which is the widest read any command makes. */
export const LEDGER_WINDOW_LIMIT = 50_000;

/** Searching back for one row by id, where the answer is usually near the end. */
export const LEDGER_LOOKUP_LIMIT = 5_000;

/** One session's worth, for a check that reads a transcript against the record. */
export const LEDGER_SESSION_LIMIT = 2_000;

/** A short look back, for a question about something that just happened. */
export const LEDGER_RECENT_LIMIT = 500;

/** The last matching row and nothing else. */
export const LEDGER_LATEST_ONLY = 1;
