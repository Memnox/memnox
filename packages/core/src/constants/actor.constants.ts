/**
 * Who caused a change, normalized. "Who pressed the button" and "who caused this" are
 * different questions the moment an agent is in the loop, and a record that cannot
 * tell a person from a pipeline cannot answer the second one.
 *
 * Never inferred from a name. An actor kind is set by whatever observed the hop, the
 * same way a context block's trust is set by whoever supplied it.
 */
export const ACTOR_KIND = {
  HUMAN: 'human',
  AI_AGENT: 'ai-agent',
  CI: 'ci',
  AUTOMATION: 'automation',
  SERVICE: 'service',
} as const;

export type ActorKind = (typeof ACTOR_KIND)[keyof typeof ACTOR_KIND];

const ACTOR_KINDS: readonly string[] = Object.values(ACTOR_KIND);

export function isActorKind(value: unknown): value is ActorKind {
  return typeof value === 'string' && ACTOR_KINDS.includes(value);
}
