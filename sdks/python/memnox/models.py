"""Response types for the Memnox runtime API. Standard library only."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

JsonMap = Mapping[str, object]

EFFECT_ALLOW = "allow"
EFFECT_BLOCK = "block"
EFFECT_REQUIRE_APPROVAL = "require_approval"

RISK_LOW = "low"
RISK_MEDIUM = "medium"
RISK_HIGH = "high"
RISK_CRITICAL = "critical"

AGENT_STATUS_ACTIVE = "active"
AGENT_STATUS_SUSPENDED = "suspended"

APPROVAL_STATUS_PENDING = "pending"
APPROVAL_STATUS_APPROVED = "approved"
APPROVAL_STATUS_DENIED = "denied"
APPROVAL_STATUS_EXPIRED = "expired"

DECISION_STATUS_ACTIVE = "active"
DECISION_STATUS_SUPERSEDED = "superseded"
DECISION_STATUS_RETIRED = "retired"

ENFORCEMENT_WARN = "warn"
ENFORCEMENT_REQUIRE_APPROVAL = "require_approval"
ENFORCEMENT_BLOCK = "block"


def _text(data: JsonMap, key: str) -> str:
    value = data.get(key)
    return value if isinstance(value, str) else ""


def _opt_text(data: JsonMap, key: str) -> str | None:
    value = data.get(key)
    return value if isinstance(value, str) else None


def _number(data: JsonMap, key: str) -> int:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value)


def _flag(data: JsonMap, key: str) -> bool:
    return data.get(key) is True


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        return ()
    return value


def _texts(data: JsonMap, key: str) -> list[str]:
    return [item for item in _sequence(data.get(key)) if isinstance(item, str)]


def _maps(data: JsonMap, key: str) -> list[JsonMap]:
    return [item for item in _sequence(data.get(key)) if isinstance(item, Mapping)]


def _map(data: JsonMap, key: str) -> JsonMap:
    value = data.get(key)
    return value if isinstance(value, Mapping) else {}


def _counts(data: JsonMap, key: str) -> dict[str, int]:
    counted: dict[str, int] = {}
    for name, value in _map(data, key).items():
        if not isinstance(value, bool) and isinstance(value, (int, float)):
            counted[name] = int(value)
    return counted


@dataclass(frozen=True)
class MatchedPolicy:
    """A policy that matched the checked action."""

    name: str
    effect: str
    reason: str | None = None
    approvers: list[str] = field(default_factory=list)

    @staticmethod
    def from_json(data: JsonMap) -> MatchedPolicy:
        return MatchedPolicy(
            name=_text(data, "name"),
            effect=_text(data, "effect"),
            reason=_opt_text(data, "reason"),
            approvers=_texts(data, "approvers"),
        )


@dataclass(frozen=True)
class Advisory:
    """A deterministic escalation or signal contributed by an advisor."""

    source: str
    reason: str
    signals: list[str] = field(default_factory=list)
    escalate_to: str | None = None
    approvers: list[str] = field(default_factory=list)
    non_overridable: bool = False

    @staticmethod
    def from_json(data: JsonMap) -> Advisory:
        return Advisory(
            source=_text(data, "source"),
            reason=_text(data, "reason"),
            signals=_texts(data, "signals"),
            escalate_to=_opt_text(data, "escalateTo"),
            approvers=_texts(data, "approvers"),
            non_overridable=_flag(data, "nonOverridable"),
        )


@dataclass(frozen=True)
class TaintSourceRef:
    """One untrusted source that influenced the agent's context."""

    source_type: str
    reason: str
    reference: str | None = None

    def to_json(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "sourceType": self.source_type,
            "reason": self.reason,
        }
        if self.reference is not None:
            payload["reference"] = self.reference
        return payload

    @staticmethod
    def from_json(data: JsonMap) -> TaintSourceRef:
        return TaintSourceRef(
            source_type=_text(data, "sourceType"),
            reason=_text(data, "reason"),
            reference=_opt_text(data, "reference"),
        )


@dataclass(frozen=True)
class TaintAssessment:
    """Whether untrusted content influenced the agent, reported by the caller."""

    tainted: bool
    sources: list[TaintSourceRef] = field(default_factory=list)

    def to_json(self) -> dict[str, object]:
        return {
            "tainted": self.tainted,
            "sources": [source.to_json() for source in self.sources],
        }

    @staticmethod
    def from_json(data: JsonMap) -> TaintAssessment:
        return TaintAssessment(
            tainted=_flag(data, "tainted"),
            sources=[TaintSourceRef.from_json(item) for item in _maps(data, "sources")],
        )


@dataclass(frozen=True)
class Decision:
    """The runtime's verdict for one action request."""

    event_id: str
    effect: str
    risk_level: str
    reason: str
    matched_policies: list[MatchedPolicy] = field(default_factory=list)
    advisories: list[Advisory] = field(default_factory=list)
    approval_id: str | None = None

    @property
    def allowed(self) -> bool:
        return self.effect == EFFECT_ALLOW

    @staticmethod
    def from_json(data: JsonMap) -> Decision:
        return Decision(
            event_id=_text(data, "eventId"),
            effect=_text(data, "effect"),
            risk_level=_text(data, "riskLevel"),
            reason=_text(data, "reason"),
            matched_policies=[
                MatchedPolicy.from_json(item) for item in _maps(data, "matchedPolicies")
            ],
            advisories=[Advisory.from_json(item) for item in _maps(data, "advisories")],
            approval_id=_opt_text(data, "approvalId"),
        )


@dataclass(frozen=True)
class Verdict:
    """Boolean-style answer from the Runtime API helpers; truthy when allowed."""

    allowed: bool
    decision: Decision

    def __bool__(self) -> bool:
        return self.allowed

    @staticmethod
    def of(decision: Decision) -> Verdict:
        return Verdict(allowed=decision.allowed, decision=decision)


@dataclass(frozen=True)
class ActionEvent:
    """One append-only audit record."""

    id: str
    occurred_at: str
    agent_id: str
    agent_name: str
    action: str
    effect: str
    risk_level: str
    reason: str
    target: str | None = None
    environment: str | None = None
    session_id: str | None = None
    org_id: str | None = None
    matched_policies: list[str] = field(default_factory=list)
    advisories: list[str] = field(default_factory=list)
    taint: TaintAssessment | None = None
    prev_hash: str | None = None
    hash: str | None = None

    @staticmethod
    def from_json(data: JsonMap) -> ActionEvent:
        raw_taint = data.get("taint")
        return ActionEvent(
            id=_text(data, "id"),
            occurred_at=_text(data, "occurredAt"),
            agent_id=_text(data, "agentId"),
            agent_name=_text(data, "agentName"),
            action=_text(data, "action"),
            effect=_text(data, "effect"),
            risk_level=_text(data, "riskLevel"),
            reason=_text(data, "reason"),
            target=_opt_text(data, "target"),
            environment=_opt_text(data, "environment"),
            session_id=_opt_text(data, "sessionId"),
            org_id=_opt_text(data, "orgId"),
            matched_policies=_texts(data, "matchedPolicies"),
            advisories=_texts(data, "advisories"),
            taint=(
                TaintAssessment.from_json(raw_taint)
                if isinstance(raw_taint, Mapping)
                else None
            ),
            prev_hash=_opt_text(data, "prevHash"),
            hash=_opt_text(data, "hash"),
        )


@dataclass(frozen=True)
class AuditChainVerification:
    """Result of walking the audit hash chain server-side."""

    valid: bool
    checked: int
    broken_at_index: int
    broken_event_id: str | None = None
    broken_reason: str | None = None

    @staticmethod
    def from_json(data: JsonMap) -> AuditChainVerification:
        return AuditChainVerification(
            valid=_flag(data, "valid"),
            checked=_number(data, "checked"),
            broken_at_index=_number(data, "brokenAtIndex"),
            broken_event_id=_opt_text(data, "brokenEventId"),
            broken_reason=_opt_text(data, "brokenReason"),
        )


@dataclass(frozen=True)
class AgentStats:
    """Lifetime action counters used to derive an agent's trust score."""

    allowed: int = 0
    blocked: int = 0
    approvals_requested: int = 0

    @staticmethod
    def from_json(data: JsonMap) -> AgentStats:
        return AgentStats(
            allowed=_number(data, "allowed"),
            blocked=_number(data, "blocked"),
            approvals_requested=_number(data, "approvalsRequested"),
        )


@dataclass(frozen=True)
class AgentSummary:
    """A registered agent as returned by the management routes."""

    id: str
    name: str
    kind: str
    status: str
    trust_score: int = 0
    stats: AgentStats = field(default_factory=AgentStats)
    capabilities: list[str] = field(default_factory=list)
    created_at: str | None = None
    org_id: str | None = None

    @staticmethod
    def from_json(data: JsonMap) -> AgentSummary:
        return AgentSummary(
            id=_text(data, "id"),
            name=_text(data, "name"),
            kind=_text(data, "kind"),
            status=_text(data, "status"),
            trust_score=_number(data, "trustScore"),
            stats=AgentStats.from_json(_map(data, "stats")),
            capabilities=_texts(data, "capabilities"),
            created_at=_opt_text(data, "createdAt"),
            org_id=_opt_text(data, "orgId"),
        )


@dataclass(frozen=True)
class AgentRegistration:
    """A freshly registered agent plus its token — the token is shown only once."""

    agent: AgentSummary
    token: str

    @staticmethod
    def from_json(data: JsonMap) -> AgentRegistration:
        return AgentRegistration(
            agent=AgentSummary.from_json(_map(data, "agent")),
            token=_text(data, "token"),
        )


@dataclass(frozen=True)
class Approval:
    """A human approval bound to one exact action fingerprint."""

    id: str
    request_fingerprint: str
    agent_id: str
    action: str
    status: str
    created_at: str
    approvers: list[str] = field(default_factory=list)
    target: str | None = None
    environment: str | None = None
    expires_at: str | None = None
    resolved_at: str | None = None
    resolved_by: str | None = None
    override: bool = False
    org_id: str | None = None

    @staticmethod
    def from_json(data: JsonMap) -> Approval:
        return Approval(
            id=_text(data, "id"),
            request_fingerprint=_text(data, "requestFingerprint"),
            agent_id=_text(data, "agentId"),
            action=_text(data, "action"),
            status=_text(data, "status"),
            created_at=_text(data, "createdAt"),
            approvers=_texts(data, "approvers"),
            target=_opt_text(data, "target"),
            environment=_opt_text(data, "environment"),
            expires_at=_opt_text(data, "expiresAt"),
            resolved_at=_opt_text(data, "resolvedAt"),
            resolved_by=_opt_text(data, "resolvedBy"),
            override=_flag(data, "override"),
            org_id=_opt_text(data, "orgId"),
        )


@dataclass(frozen=True)
class DecisionRecord:
    """A team decision captured as a machine-checkable constraint."""

    id: str
    title: str
    statement: str
    owner: str
    decided_at: str
    enforcement: str
    actions: list[str] = field(default_factory=list)
    targets: list[str] = field(default_factory=list)
    environments: list[str] = field(default_factory=list)
    status: str | None = None
    superseded_by_id: str | None = None
    reversibility_cost: str | None = None
    source_type: str | None = None
    source_ref: str | None = None
    review_after: str | None = None
    org_id: str | None = None

    @staticmethod
    def from_json(data: JsonMap) -> DecisionRecord:
        return DecisionRecord(
            id=_text(data, "id"),
            title=_text(data, "title"),
            statement=_text(data, "statement"),
            owner=_text(data, "owner"),
            decided_at=_text(data, "decidedAt"),
            enforcement=_text(data, "enforcement"),
            actions=_texts(data, "actions"),
            targets=_texts(data, "targets"),
            environments=_texts(data, "environments"),
            status=_opt_text(data, "status"),
            superseded_by_id=_opt_text(data, "supersededById"),
            reversibility_cost=_opt_text(data, "reversibilityCost"),
            source_type=_opt_text(data, "sourceType"),
            source_ref=_opt_text(data, "sourceRef"),
            review_after=_opt_text(data, "reviewAfter"),
            org_id=_opt_text(data, "orgId"),
        )


@dataclass(frozen=True)
class DecisionSearchHit:
    """A decision matched by keyword search, with its relevance score."""

    decision: DecisionRecord
    score: int

    @staticmethod
    def from_json(data: JsonMap) -> DecisionSearchHit:
        return DecisionSearchHit(
            decision=DecisionRecord.from_json(_map(data, "decision")),
            score=_number(data, "score"),
        )


@dataclass(frozen=True)
class DecisionHealthEntry:
    """Per-decision health signals inside the corpus report."""

    id: str
    title: str
    violations: int
    stale: bool
    never_referenced: bool
    due_for_review: bool

    @staticmethod
    def from_json(data: JsonMap) -> DecisionHealthEntry:
        return DecisionHealthEntry(
            id=_text(data, "id"),
            title=_text(data, "title"),
            violations=_number(data, "violations"),
            stale=_flag(data, "stale"),
            never_referenced=_flag(data, "neverReferenced"),
            due_for_review=_flag(data, "dueForReview"),
        )


@dataclass(frozen=True)
class DecisionHealth:
    """Corpus quality of the decision memory, scored 0-100."""

    score: int
    active_decisions: int
    stale: int
    frequently_violated: int
    never_referenced: int
    entries: list[DecisionHealthEntry] = field(default_factory=list)

    @staticmethod
    def from_json(data: JsonMap) -> DecisionHealth:
        return DecisionHealth(
            score=_number(data, "score"),
            active_decisions=_number(data, "activeDecisions"),
            stale=_number(data, "stale"),
            frequently_violated=_number(data, "frequentlyViolated"),
            never_referenced=_number(data, "neverReferenced"),
            entries=[
                DecisionHealthEntry.from_json(item) for item in _maps(data, "entries")
            ],
        )


@dataclass(frozen=True)
class ComplianceTotals:
    """Headline counters for a compliance period."""

    actions: int = 0
    allowed: int = 0
    blocked: int = 0
    approvals_required: int = 0

    @staticmethod
    def from_json(data: JsonMap) -> ComplianceTotals:
        return ComplianceTotals(
            actions=_number(data, "actions"),
            allowed=_number(data, "allowed"),
            blocked=_number(data, "blocked"),
            approvals_required=_number(data, "approvalsRequired"),
        )


@dataclass(frozen=True)
class ActionCount:
    """How often one action was blocked in the period."""

    action: str
    count: int

    @staticmethod
    def from_json(data: JsonMap) -> ActionCount:
        return ActionCount(action=_text(data, "action"), count=_number(data, "count"))


@dataclass(frozen=True)
class PolicyCount:
    """How often one policy matched in the period."""

    policy: str
    count: int

    @staticmethod
    def from_json(data: JsonMap) -> PolicyCount:
        return PolicyCount(policy=_text(data, "policy"), count=_number(data, "count"))


@dataclass(frozen=True)
class AgentActivity:
    """Per-agent action volume in the period."""

    agent: str
    actions: int
    blocked: int

    @staticmethod
    def from_json(data: JsonMap) -> AgentActivity:
        return AgentActivity(
            agent=_text(data, "agent"),
            actions=_number(data, "actions"),
            blocked=_number(data, "blocked"),
        )


@dataclass(frozen=True)
class SignalCount:
    """How often one advisory signal fired in the period."""

    signal: str
    count: int

    @staticmethod
    def from_json(data: JsonMap) -> SignalCount:
        return SignalCount(signal=_text(data, "signal"), count=_number(data, "count"))


@dataclass(frozen=True)
class ComplianceReport:
    """Governance evidence aggregated from the audit log."""

    generated_at: str
    period_from: str | None = None
    period_to: str | None = None
    totals: ComplianceTotals = field(default_factory=ComplianceTotals)
    risk_breakdown: dict[str, int] = field(default_factory=dict)
    top_blocked_actions: list[ActionCount] = field(default_factory=list)
    policy_activity: list[PolicyCount] = field(default_factory=list)
    agent_activity: list[AgentActivity] = field(default_factory=list)
    advisory_signals: list[SignalCount] = field(default_factory=list)

    @staticmethod
    def from_json(data: JsonMap) -> ComplianceReport:
        period = _map(data, "period")
        return ComplianceReport(
            generated_at=_text(data, "generatedAt"),
            period_from=_opt_text(period, "from"),
            period_to=_opt_text(period, "to"),
            totals=ComplianceTotals.from_json(_map(data, "totals")),
            risk_breakdown=_counts(data, "riskBreakdown"),
            top_blocked_actions=[
                ActionCount.from_json(item) for item in _maps(data, "topBlockedActions")
            ],
            policy_activity=[
                PolicyCount.from_json(item) for item in _maps(data, "policyActivity")
            ],
            agent_activity=[
                AgentActivity.from_json(item) for item in _maps(data, "agentActivity")
            ],
            advisory_signals=[
                SignalCount.from_json(item) for item in _maps(data, "advisorySignals")
            ],
        )
