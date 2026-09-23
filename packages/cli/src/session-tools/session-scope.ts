/**
 * Which session a tool call is about: the run that launched the agent where `memnox run`
 * named one, else that agent's latest, so one agent never reads another's by default.
 */
import { LEDGER_LATEST_ONLY, SESSION_VAR, type SqliteEventStore } from '@memnox/core';

const SCOPE = {
  /** `memnox run` named the session in the agent's environment. */
  THIS_RUN: 'this run',
  /** The newest session this agent has on the record. */
  AGENT_LATEST: 'this agent, latest session',
  /** Asked for by id. */
  NAMED: 'the session named',
  NONE: 'no session on the record',
} as const;

export type ScopeKind = (typeof SCOPE)[keyof typeof SCOPE];

export interface SessionScope {
  sessionId: string | null;
  agent: string;
  scope: ScopeKind;
}

/** The session a call reads, and how it was found, said in the answer so nothing is guessed. */
export async function scopeOf(
  store: SqliteEventStore,
  agent: string,
  env: NodeJS.ProcessEnv,
  asked?: string,
): Promise<SessionScope> {
  if (asked !== undefined && asked !== '') {
    return { sessionId: asked, agent, scope: SCOPE.NAMED };
  }
  const running = env[SESSION_VAR];
  if (running !== undefined && running !== '') {
    return { sessionId: running, agent, scope: SCOPE.THIS_RUN };
  }
  const latest = await store.query({ agent, limit: LEDGER_LATEST_ONLY });
  const sessionId = latest[latest.length - 1]?.sessionId;
  return sessionId === undefined
    ? { sessionId: null, agent, scope: SCOPE.NONE }
    : { sessionId, agent, scope: SCOPE.AGENT_LATEST };
}
