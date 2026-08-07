import { randomUUID } from 'node:crypto';
import type { ActionEvent, ActionRequest, AgentIdentity, Decision } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { matchesAny, matchesPattern } from '@memnox/policy-engine';
import type { DecisionRecord } from '@memnox/memory';
import { isEnforcing } from '@memnox/memory';
import type {
  AuthorityGrant,
  AuthorityStore,
  Fact,
  OrgDecision,
  OverLimitEffect,
  Ownership,
  Stated,
  StatedKind,
  StatedProvenance,
  StatedStore,
} from '@memnox/org-graph';
import {
  DEFAULT_WORKSPACE,
  ORG_DECISION,
  STATED_KIND,
  STATED_PROVENANCE,
  decideFrom,
  isBinding,
  mayRead,
  readableFacts,
  rejectStatement,
  resolveOwnership,
  searchStatements,
  statementFingerprint,
  supersede,
  verifiedStatement,
  verifyStatement,
} from '@memnox/org-graph';
import type { ActionGateway } from './action-gateway';
import type { DecisionMemoryService } from './decision-memory-service';

/** How many statements one answer reads before it reports itself truncated. */
const DEFAULT_CONTEXT_LIMIT = 20;
/** How far back precedent looks. Bounded: an unbounded audit scan is a scale hazard. */
const PRECEDENT_SCAN_LIMIT = 500;
const DEFAULT_PRECEDENT_LIMIT = 5;

/** Somebody who can authorize the action, and why they can. */
export interface Approver {
  id: string;
  /** The statement that grants them the authority, in the company's words. */
  because: string;
  limit?: number;
}

export interface EvaluateRequest {
  action: string;
  resource?: { type?: string; id?: string };
  principal?: string;
  amount?: number;
  environment?: string;
  reason?: string;
  reads?: readonly string[];
}

export interface EvaluateResponse {
  decision: OrgDecision;
  reason: string;
  approvers: Approver[];
  policies: string[];
  context: Fact[];
  constraints: string[];
  missingContext: string[];
  withheld: number;
  approvalId?: string;
  redacted?: boolean;
  truncated?: true;
  delegationNotAssessed?: true;
}

/** A decision the organization has approved and holds itself to. */
export interface Decided {
  id: string;
  title: string;
  statement: string;
  owner?: string;
  targets?: string[];
  status?: string;
  sourceRef?: string;
}

export interface ContextResponse {
  question: string;
  facts: Fact[];
  decisions: Decided[];
  withheld: number;
  restrictions: string[];
  principal?: string;
  truncated?: true;
}

export interface AgentCandidate {
  agentId: string;
  label: string;
  capabilities: string[];
  owner?: string;
  principal?: string;
  department?: string;
  spendLimit?: number;
}

export interface Precedent {
  occurredAt: string;
  verb: string;
  target?: string;
  intent?: string;
  reason?: string;
  to: string[];
}

export interface ShareResponse {
  shareable: boolean;
  refusal?: string;
  unknownFact?: true;
  unknownRecipient?: true;
}

/** What a person entering a statement supplies; the rest the service stamps. */
export interface RecordStatedInput {
  kind: StatedKind;
  statement: string;
  subject: string;
  principal?: string;
  capability?: string;
  limit?: number;
  object?: string;
  sourceRef?: string;
  clearance?: string[];
  effectiveFrom?: string;
  effectiveTo?: string;
  provenance?: StatedProvenance;
  recordedBy: string;
  /** The statement this replaces, when it replaces one. */
  supersedes?: string;
}

export interface DelegateInput {
  principal: string;
  actions: string[];
  agents?: string[];
  limit?: number;
  overLimit?: OverLimitEffect;
  approvers?: string[];
  expiresAt?: string;
  grantedBy: string;
}

/** What one extraction run added, and what it recognised as already held. */
export interface ProposeResult {
  stored: number;
  duplicates: number;
}

export interface OrganizationServiceDeps {
  gateway: ActionGateway;
  statements: StatedStore;
  grants: AuthorityStore;
  decisions: DecisionMemoryService;
  /** Injected so an effective-window boundary is testable without waiting for it. */
  now?: () => Date;
  /** Injected so a recorded statement's id is reproducible in a test. */
  newId?: () => string;
}

/**
 * The organization as an application service.
 *
 * It owns no verdict of its own. Every answer here is the gate's decision said
 * in a wider vocabulary, plus the context the caller is cleared to read — which
 * is the seam that matters: adding a word to the vocabulary must never add a
 * way to reach `allow`. `decideFrom` is a pure function in the domain for that
 * reason, and this class only assembles the four facts it takes.
 */
export class OrganizationService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: OrganizationServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * The workspace an agent actually operates in.
   *
   * The credential decides, never the URL. A workspace named in a path is a
   * request, and honouring it would make the tenant boundary something a caller
   * picks — the one thing a multi-tenant deployment cannot let it be.
   */
  workspaceOf(agent: AgentIdentity): string {
    return agent.orgId ?? DEFAULT_WORKSPACE;
  }

  resolveAgent(token: string): Promise<AgentIdentity | null> {
    return this.deps.gateway.agents.resolveByToken(token);
  }

  /**
   * Ask before acting: one decision, plus what the caller may know about it.
   *
   * The gate runs first and unchanged, so this call is audited exactly like any
   * other action. What the organization adds is on either side of that verdict —
   * whose authority was drawn on going in, and which of the caller's cited facts
   * it turns out not to be cleared to read coming out.
   */
  async evaluate(
    token: string,
    agent: AgentIdentity,
    request: EvaluateRequest,
  ): Promise<EvaluateResponse> {
    const workspace = this.workspaceOf(agent);
    const statements = await this.deps.statements.list(workspace);
    const decision = await this.deps.gateway.authorize(token, toActionRequest(request));

    const reader = request.principal;
    const now = this.now();
    // One pass over the corpus, then everything below reads the result. Walking
    // it per field cost five scans a request and grew with the organization.
    const bearing = bearingOn(statements, request.action, now);
    const policies = readablePolicies(bearing, reader);

    const cited = this.assessCitations(statements, request.reads, reader);
    const readable = readableFacts(bearing, reader, now);
    const truncated = readable.facts.length > DEFAULT_CONTEXT_LIMIT;

    const approvers = this.approversFor(statements, decision, request, now);
    const verdict = decideFrom({
      effect: decision.effect,
      hasApprovers: approvers.length > 0,
      reliesOnWithheldFacts: cited.withheld.length > 0,
      unanswerable: cited.unknown.length > 0,
    });

    return {
      decision: verdict,
      reason: this.explain(verdict, decision.reason, cited),
      approvers,
      policies: [
        ...decision.matchedPolicies.map((policy) => policy.name),
        ...policies.map((stated) => stated.id),
      ],
      context: readable.facts.slice(0, DEFAULT_CONTEXT_LIMIT),
      constraints: policies.map((stated) => stated.statement),
      missingContext: [...cited.withheld, ...cited.unknown],
      withheld: readable.withheld,
      ...(decision.approvalId === undefined ? {} : { approvalId: decision.approvalId }),
      ...(decision.effect === DECISION_EFFECT.REDACT ? { redacted: true } : {}),
      ...(truncated ? { truncated: true as const } : {}),
      ...(request.reads === undefined || request.reads.length === 0
        ? { delegationNotAssessed: true as const }
        : {}),
    };
  }

  /**
   * The ids a caller cited that it turns out not to be entitled to rely on.
   *
   * Two different failures, kept apart because they mean different things about
   * the caller. A cited id the organization holds but will not show it is a
   * clearance problem, and the work should go to somebody cleared. A cited id
   * the organization has never heard of is a claim about a fact that does not
   * exist — most often a model that invented the citation — and no amount of
   * delegating fixes that, so it asks a person instead.
   */
  private assessCitations(
    statements: readonly Stated[],
    reads: readonly string[] | undefined,
    reader: string | undefined,
  ): { withheld: string[]; unknown: string[] } {
    if (reads === undefined || reads.length === 0) return { withheld: [], unknown: [] };
    const byId = new Map(statements.map((stated) => [stated.id, stated]));

    const withheld: string[] = [];
    const unknown: string[] = [];
    for (const id of reads) {
      const stated = byId.get(id);
      if (stated === undefined) {
        unknown.push(id);
        continue;
      }
      if (!mayRead(stated, reader)) withheld.push(id);
    }
    return { withheld, unknown };
  }

  private explain(
    verdict: OrgDecision,
    gateReason: string,
    cited: { withheld: string[]; unknown: string[] },
  ): string {
    if (verdict === ORG_DECISION.DELEGATE) {
      return `${gateReason} — but this action relies on ${cited.withheld.length} fact(s) you are not cleared to read`;
    }
    if (verdict === ORG_DECISION.CLARIFY) {
      return `${gateReason} — but ${cited.unknown.length} fact(s) this action cites are not held by this organization`;
    }
    return gateReason;
  }

  /**
   * Who can authorize this, and the statement that says they can.
   *
   * Named from what the organization states rather than from the policy file
   * alone, so an approver arrives with their warrant attached. A name with no
   * statement behind it is still returned — the gate decided it, and dropping
   * it would leave a caller escalating to nobody.
   */
  private approversFor(
    statements: readonly Stated[],
    decision: Decision,
    request: EvaluateRequest,
    now: Date,
  ): Approver[] {
    if (decision.effect !== DECISION_EFFECT.REQUIRE_APPROVAL) return [];

    const named = new Set<string>([
      ...decision.matchedPolicies.flatMap((policy) => policy.approvers ?? []),
      ...decision.advisories.flatMap((advisory) => advisory.approvers ?? []),
    ]);
    const authorities = statements
      .filter((stated) => stated.kind === STATED_KIND.AUTHORITY)
      .filter((stated) => isBinding(stated, now))
      .filter((stated) => matchesAny(capabilityPatterns(stated), request.action));

    return [...named].map((id) => {
      const warrant = authorities.find((stated) => stated.principal === id);
      if (warrant === undefined) {
        return { id, because: 'named by the rule that applied' };
      }
      return {
        id,
        because: warrant.statement,
        ...(warrant.limit === undefined ? {} : { limit: warrant.limit }),
      };
    });
  }

  /** What the organization knows that bears on a question, filtered to this reader. */
  async context(
    agent: AgentIdentity,
    question: string,
    principal: string | undefined,
    limit?: number,
  ): Promise<ContextResponse> {
    const workspace = this.workspaceOf(agent);
    const cap = limit ?? DEFAULT_CONTEXT_LIMIT;
    const statements = await this.deps.statements.list(workspace);
    const hits = searchStatements(statements, question);
    const readable = readableFacts(
      hits.map((hit) => hit.stated),
      principal,
      this.now(),
    );
    const decisions = await this.deps.decisions.searchByKeyword(question);

    return {
      question,
      facts: readable.facts.slice(0, cap),
      decisions: decisions.map((hit) => toDecided(hit.decision)).slice(0, cap),
      withheld: readable.withheld,
      restrictions: readablePolicies(
        bearingOn(statements, question, this.now()),
        principal,
      ).map((stated) => stated.statement),
      ...(principal === undefined ? {} : { principal }),
      ...(readable.facts.length > cap ? { truncated: true as const } : {}),
    };
  }

  async owner(agent: AgentIdentity, subject: string): Promise<Ownership> {
    const statements = await this.deps.statements.list(this.workspaceOf(agent));
    return resolveOwnership(statements, subject, this.now());
  }

  /** What has already been decided about a topic, so an agent does not re-decide it. */
  async decisions(agent: AgentIdentity, topic: string): Promise<Decided[]> {
    const workspace = this.workspaceOf(agent);
    const statements = await this.deps.statements.list(workspace);
    const stated = searchStatements(statements, topic)
      .map((hit) => hit.stated)
      .filter((entry) => entry.kind === STATED_KIND.DECISION)
      .filter((entry) => isBinding(entry, this.now()))
      .map(statedToDecided);

    const recorded = await this.deps.decisions.searchByKeyword(topic);
    return [
      ...stated,
      ...recorded
        .filter((hit) => isEnforcing(hit.decision))
        .map((hit) => toDecided(hit.decision)),
    ];
  }

  /**
   * Which agents this company runs for an action, tightest remit first.
   *
   * Never includes the asker, and deliberately says nothing about what any
   * candidate is cleared to know: naming who should take a job must not become
   * a way to enumerate what every other agent can read.
   */
  async agentsFor(agent: AgentIdentity, action: string): Promise<AgentCandidate[]> {
    const workspace = this.workspaceOf(agent);
    const [everyone, statements, grants] = await Promise.all([
      this.deps.gateway.listAgents(),
      this.deps.statements.list(workspace),
      this.deps.grants.list(workspace),
    ]);

    return everyone
      .filter((candidate) => candidate.id !== agent.id)
      .filter((candidate) => (candidate.orgId ?? DEFAULT_WORKSPACE) === workspace)
      .filter((candidate) => declaresAction(candidate, action))
      .map((candidate) => this.toCandidate(candidate, statements, grants, action))
      .sort((left, right) => left.capabilities.length - right.capabilities.length);
  }

  private toCandidate(
    candidate: AgentIdentity,
    statements: readonly Stated[],
    grants: readonly AuthorityGrant[],
    action: string,
  ): AgentCandidate {
    const owned = resolveOwnership(statements, candidate.name, this.now());
    const owner = owned.owners[0];
    const ceiling = grants
      .filter((grant) => matchesAny(grant.agents, candidate.name))
      .filter((grant) => matchesAny(grant.actions, action))
      .map((grant) => grant.limit)
      .filter((limit): limit is number => limit !== undefined);

    return {
      agentId: candidate.id,
      label: candidate.name,
      capabilities: candidate.capabilities ?? [],
      ...(owner === undefined ? {} : { owner: owner.name }),
      ...(ceiling.length === 0 ? {} : { spendLimit: Math.max(...ceiling) }),
    };
  }

  /**
   * How the same action was routed the last few times somebody asked.
   *
   * The organization's behaviour rather than its statements. Never carries what
   * any of those answers contained — only the verb, who it went to, and the
   * stated intent — because a history that carried content would be a way to
   * read, over time, everything a clearance withheld.
   */
  async precedent(
    agent: AgentIdentity,
    action: string,
    limit?: number,
  ): Promise<Precedent[]> {
    const events = await this.deps.gateway.queryAuditEvents({
      limit: PRECEDENT_SCAN_LIMIT,
      ...(agent.orgId === undefined ? {} : { orgId: agent.orgId }),
    });

    return events
      .filter((event) => matchesPattern(action, event.action))
      .slice(-(limit ?? DEFAULT_PRECEDENT_LIMIT))
      .reverse()
      .map(toPrecedent);
  }

  /** Everything the workspace states, for review. Candidates included. */
  listStatements(workspace: string): Promise<Stated[]> {
    return this.deps.statements.list(workspace);
  }

  /**
   * Records a statement a person entered, ready to bind.
   *
   * Separate from what the extractor writes, and it has to be: a route a human
   * reaches through an admin credential may produce a verified statement, and
   * nothing a model reaches can. Same store, two doors, and only one of them
   * opens onto `verified`.
   */
  async record(workspace: string, input: RecordStatedInput): Promise<Stated> {
    const stated = verifiedStatement({
      id: this.newId(),
      workspaceId: workspace,
      kind: input.kind,
      statement: input.statement,
      subject: input.subject,
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      ...(input.capability === undefined ? {} : { capability: input.capability }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.object === undefined ? {} : { object: input.object }),
      ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
      ...(input.clearance === undefined ? {} : { clearance: input.clearance }),
      ...(input.effectiveFrom === undefined
        ? {}
        : { effectiveFrom: input.effectiveFrom }),
      ...(input.effectiveTo === undefined ? {} : { effectiveTo: input.effectiveTo }),
      provenance: input.provenance ?? STATED_PROVENANCE.DECLARED,
      detectedAt: this.now().toISOString(),
      verifiedBy: input.recordedBy,
      verifiedAt: this.now().toISOString(),
    });

    if (input.supersedes === undefined) {
      await this.deps.statements.save(stated);
      return stated;
    }

    const previous = await this.deps.statements.findById(input.supersedes);
    if (previous === null || previous.workspaceId !== workspace) {
      await this.deps.statements.save(stated);
      return stated;
    }
    const pair = supersede(previous, stated);
    // One write: retiring a rule and recording its replacement land together or
    // not at all. As two saves there is a window with neither in force.
    await this.deps.statements.saveAll([pair.previous, pair.next]);
    return pair.next;
  }

  /**
   * Files candidates an extractor produced. They bind nothing until verified.
   *
   * A claim the workspace already holds is dropped, and that includes one a
   * person has already rejected — re-filing a refusal is the worst version of
   * this, because it asks somebody to make the same decision twice and teaches
   * them the queue is noise. Deduplication is on what the statement says, not
   * its id, since a re-read mints a new id for the same sentence.
   */
  async propose(
    workspace: string,
    candidates: readonly Stated[],
  ): Promise<ProposeResult> {
    const mine = candidates.filter((stated) => stated.workspaceId === workspace);
    const known = new Set(
      (await this.deps.statements.list(workspace)).map(statementFingerprint),
    );

    const fresh: Stated[] = [];
    for (const stated of mine) {
      const fingerprint = statementFingerprint(stated);
      if (known.has(fingerprint)) continue;
      known.add(fingerprint);
      fresh.push(stated);
    }
    if (fresh.length > 0) await this.deps.statements.saveAll(fresh);
    return { stored: fresh.length, duplicates: mine.length - fresh.length };
  }

  /** Null when there is no such candidate to confirm — see `verifyStatement`. */
  async verify(workspace: string, id: string, by: string): Promise<Stated | null> {
    return this.settle(workspace, id, (stated) =>
      verifyStatement(stated, by, this.now().toISOString()),
    );
  }

  async reject(workspace: string, id: string, by: string): Promise<Stated | null> {
    return this.settle(workspace, id, (stated) =>
      rejectStatement(stated, by, this.now().toISOString()),
    );
  }

  private async settle(
    workspace: string,
    id: string,
    apply: (stated: Stated) => Stated | null,
  ): Promise<Stated | null> {
    const stated = await this.deps.statements.findById(id);
    if (stated === null || stated.workspaceId !== workspace) return null;
    const settled = apply(stated);
    if (settled === null) return null;
    await this.deps.statements.save(settled);
    return settled;
  }

  /** Records what one person has delegated to the agents acting for them. */
  async delegate(workspace: string, input: DelegateInput): Promise<AuthorityGrant> {
    const grant: AuthorityGrant = {
      id: this.newId(),
      workspaceId: workspace,
      principal: input.principal,
      actions: input.actions,
      ...(input.agents === undefined ? {} : { agents: input.agents }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.overLimit === undefined ? {} : { overLimit: input.overLimit }),
      ...(input.approvers === undefined ? {} : { approvers: input.approvers }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      grantedBy: input.grantedBy,
      grantedAt: this.now().toISOString(),
    };
    await this.deps.grants.save(grant);
    return grant;
  }

  listGrants(workspace: string): Promise<AuthorityGrant[]> {
    return this.deps.grants.list(workspace);
  }

  /**
   * Revokes a delegation, and only one this workspace holds.
   *
   * Scoped by looking it up first rather than trusting the id: a grant id is
   * opaque and guessable enough that "delete by id" is otherwise a way to
   * revoke another customer's authority without ever naming their workspace.
   */
  async revokeGrant(workspace: string, id: string): Promise<boolean> {
    const held = await this.deps.grants.list(workspace);
    if (!held.some((grant) => grant.id === id)) return false;
    return this.deps.grants.remove(id);
  }

  /**
   * Whether one fact may be repeated to one person.
   *
   * Answered against the recipient's clearance, never the asker's. The refusal
   * names the rule and never repeats the content, so it is safe to log — and it
   * must not be repeated to the recipient either.
   */
  async canShare(
    agent: AgentIdentity,
    factId: string,
    recipient: string,
  ): Promise<ShareResponse> {
    const workspace = this.workspaceOf(agent);
    const stated = await this.deps.statements.findById(factId);
    if (stated === null || stated.workspaceId !== workspace) {
      return { shareable: false, unknownFact: true };
    }

    const statements = await this.deps.statements.list(workspace);
    if (!isKnownPerson(statements, recipient)) {
      return { shareable: false, unknownRecipient: true };
    }
    if (!mayRead(stated, recipient)) {
      return {
        shareable: false,
        refusal: `${recipient} is not cleared for this statement`,
      };
    }
    return { shareable: true };
  }
}

/** The action patterns one authority statement covers, comma-separated in the field. */
function capabilityPatterns(stated: Stated): string[] | undefined {
  if (stated.capability === undefined) return undefined;
  return stated.capability.split(',').map((pattern) => pattern.trim());
}

function toActionRequest(request: EvaluateRequest): ActionRequest {
  const target = resourceId(request);
  return {
    action: request.action,
    ...(target === undefined ? {} : { target }),
    ...(request.principal === undefined ? {} : { principal: request.principal }),
    ...(request.amount === undefined ? {} : { amount: request.amount }),
    ...(request.environment === undefined ? {} : { environment: request.environment }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.reads === undefined ? {} : { reads: request.reads }),
  };
}

/** Named rather than chained: an absent resource is normal, a broken one is not. */
function resourceId(request: EvaluateRequest): string | undefined {
  const resource = request.resource;
  if (resource === undefined) return undefined;
  return resource.id;
}

/** Statements whose subject bears on the action, as pattern or as prefix. */
function bearingOn(statements: readonly Stated[], action: string, now: Date): Stated[] {
  return statements.filter(
    (stated) =>
      isBinding(stated, now) &&
      (matchesPattern(stated.subject, action) || action.startsWith(stated.subject)),
  );
}

/**
 * The rules in that set this reader is entitled to be told.
 *
 * Clearance is applied here and not only where facts are counted, because a
 * constraint quotes the statement verbatim: a rule the reader may not read
 * would otherwise arrive in full as advice about how to obey it, and the
 * `withheld` count beside it would say one thing was hidden while the text of
 * that thing sat in the same response.
 */
function readablePolicies(
  bearing: readonly Stated[],
  reader: string | undefined,
): Stated[] {
  return bearing
    .filter((stated) => stated.kind === STATED_KIND.POLICY)
    .filter((stated) => mayRead(stated, reader));
}

function statedToDecided(stated: Stated): Decided {
  return {
    id: stated.id,
    title: stated.subject,
    statement: stated.statement,
    ...(stated.verifiedBy === undefined ? {} : { owner: stated.verifiedBy }),
    status: stated.status,
    ...(stated.sourceRef === undefined ? {} : { sourceRef: stated.sourceRef }),
  };
}

function toDecided(record: DecisionRecord): Decided {
  return {
    id: record.id,
    title: record.title,
    statement: record.statement,
    owner: record.owner,
    ...(record.targets === undefined ? {} : { targets: record.targets }),
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.sourceRef === undefined ? {} : { sourceRef: record.sourceRef }),
  };
}

/** An agent with no declared capabilities is for anything, so it is a candidate. */
function declaresAction(agent: AgentIdentity, action: string): boolean {
  const capabilities = agent.capabilities;
  if (capabilities === undefined || capabilities.length === 0) return true;
  return matchesAny(capabilities, action);
}

/**
 * The verb as it was then, from what the event recorded.
 *
 * `escalate` only when the trail names who it went to. Reconstructing that from
 * today's rule set would answer what would happen now, which is a different
 * question and the wrong one to answer with a past tense.
 */
function toPrecedent(event: ActionEvent): Precedent {
  const to = event.approvers ?? [];
  return {
    occurredAt: event.occurredAt,
    verb: precedentVerb(event, to),
    ...(event.target === undefined ? {} : { target: event.target }),
    ...(event.reason === undefined ? {} : { intent: event.reason }),
    reason: event.reason,
    to,
  };
}

function precedentVerb(event: ActionEvent, to: readonly string[]): OrgDecision {
  if (event.effect === DECISION_EFFECT.BLOCK) return ORG_DECISION.DENY;
  if (event.effect === DECISION_EFFECT.REQUIRE_APPROVAL) {
    return to.length > 0 ? ORG_DECISION.ESCALATE : ORG_DECISION.ASK;
  }
  return ORG_DECISION.ALLOW;
}

/**
 * Whether the organization has heard of this person at all.
 *
 * An unknown recipient is answered as unknown rather than as refused, because
 * the two lead somewhere different: a refusal says the clearance was checked
 * and failed, and saying that about a name nobody has recorded would be a
 * clearance answer the organization is not in a position to give.
 */
function isKnownPerson(statements: readonly Stated[], person: string): boolean {
  return statements.some(
    (stated) =>
      stated.principal === person ||
      stated.object === person ||
      stated.subject === person ||
      stated.verifiedBy === person,
  );
}
