import type { AgentIdentity, IdentityStore, SeamStore } from '@memnox/core';
import {
  OWNER_STATUS,
  REGISTERED_VIA,
  type CensusEntry,
  type CensusSource,
} from '@memnox/organization';

/** Actions whose reach a census reports, resolved from what the agent may attempt. */
const PRODUCTION_HINTS = ['prod', 'production'];
const CUSTOMER_HINTS = ['customer', 'user', 'account', 'pii'];
const DESTRUCTIVE_HINTS = ['delete', 'drop', 'destroy', 'purge', 'truncate', 'revoke'];

/**
 * Agents that enrolled with this runtime. The only source that can prove a seam exists,
 * which is why everything else it reports is governable and the others may not be.
 */
export class EnrolmentSource implements CensusSource {
  readonly kind = REGISTERED_VIA.ENROLMENT;

  constructor(
    private readonly identities: IdentityStore,
    private readonly seams: SeamStore,
  ) {}

  async collect(): Promise<CensusEntry[]> {
    const agents = await this.identities.list();
    const entries: CensusEntry[] = [];
    for (const agent of agents) {
      const watched = await this.seams.listByAgent(agent.id);
      entries.push({
        subjectId: agent.id,
        source: REGISTERED_VIA.ENROLMENT,
        evidence: `agent:${agent.id}`,
        reach: reachOf(agent),
        // A seam exists or it does not; governability is a fact, never a filter.
        governable: watched.length > 0,
        ownerStatus:
          agent.owner === undefined ? OWNER_STATUS.UNKNOWN : OWNER_STATUS.NAMED,
        firstSeen: agent.createdAt,
      });
    }
    return entries;
  }
}

/**
 * Agents this runtime can see but not hold: a pipeline's OIDC subject, a vendor's
 * assistant. Reported from whatever record proves each exists, and marked ungovernable
 * because naming them is worth more than pretending otherwise.
 */
export class DeclaredSource implements CensusSource {
  constructor(
    readonly kind: CensusSource['kind'],
    private readonly declared: () => Promise<readonly DeclaredAgent[]>,
  ) {}

  async collect(): Promise<CensusEntry[]> {
    const found = await this.declared();
    return found.map((agent) => ({
      source: this.kind,
      evidence: agent.evidence,
      reach: {
        production: agent.production === true,
        customerData: agent.customerData === true,
        destructive: agent.destructive === true,
      },
      governable: agent.governable === true,
      ownerStatus: agent.owner === undefined ? OWNER_STATUS.UNKNOWN : OWNER_STATUS.NAMED,
      firstSeen: agent.firstSeen,
    }));
  }
}

export interface DeclaredAgent {
  /** The record that proved it exists — a workflow file, a seat, a vendor console. */
  evidence: string;
  firstSeen: string;
  owner?: string;
  production?: boolean;
  customerData?: boolean;
  destructive?: boolean;
  /** True only when some seam can actually hold it. Defaults to false, honestly. */
  governable?: boolean;
}

/** Read off the capabilities an agent holds, so the reach is evidenced rather than guessed. */
function reachOf(agent: AgentIdentity): CensusEntry['reach'] {
  const actions = agent.capabilities ?? [];
  // No declared capabilities means unbounded, which is the most alarming answer there is.
  if (actions.length === 0) {
    return { production: true, customerData: true, destructive: true };
  }
  const joined = actions.join(' ').toLowerCase();
  return {
    production: PRODUCTION_HINTS.some((hint) => joined.includes(hint)),
    customerData: CUSTOMER_HINTS.some((hint) => joined.includes(hint)),
    destructive: DESTRUCTIVE_HINTS.some((hint) => joined.includes(hint)),
  };
}
