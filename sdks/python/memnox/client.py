"""Python client for the Memnox runtime. Standard library only - inspectable end to end."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from typing import TypeVar

from .errors import ActionBlockedError, ApprovalRequiredError, MemnoxApiError
from .models import (
    EFFECT_BLOCK,
    EFFECT_REQUIRE_APPROVAL,
    ActionEvent,
    AgentRegistration,
    AgentSummary,
    Approval,
    AuditChainVerification,
    ComplianceReport,
    Decision,
    DecisionHealth,
    DecisionRecord,
    DecisionSearchHit,
    JsonMap,
    TaintAssessment,
    Verdict,
)

DEFAULT_BASE_URL = "http://127.0.0.1:7466"
DEFAULT_TIMEOUT_S = 10
DEFAULT_AGENT_KIND = "custom"

PATH_CHECK = "/v1/actions/check"
PATH_AGENTS = "/v1/agents"
PATH_AUDIT = "/v1/audit"
PATH_AUDIT_VERIFY = "/v1/audit/verify"
PATH_AUDIT_CSV = "/v1/audit/export.csv"
PATH_COMPLIANCE = "/v1/reports/compliance"
PATH_METRICS = "/v1/metrics"
PATH_DECISIONS = "/v1/memory/decisions"
PATH_DECISION_SEARCH = "/v1/memory/decisions/search"
PATH_DIGEST = "/v1/memory/digest"
PATH_MEMORY_HEALTH = "/v1/memory/health"
PATH_APPROVALS = "/v1/approvals"

ACTION_ACCESS = "resource.read"
ACTION_DEPLOY = "deploy.service"
ACTION_MODIFY = "code.modify"
ACTION_DELETE = "resource.delete"

T = TypeVar("T")


def _as_map(value: object) -> JsonMap:
    return value if isinstance(value, Mapping) else {}


def _as_maps(value: object) -> list[JsonMap]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        return []
    return [item for item in value if isinstance(item, Mapping)]


def _query(params: Mapping[str, str | int | None]) -> str:
    pairs = [(key, str(value)) for key, value in params.items() if value is not None]
    return f"?{urllib.parse.urlencode(pairs)}" if pairs else ""


class _TokenSafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Keeps the agent token from following a redirect off the runtime.

    ``urllib`` copies every header onto the redirected request, so a runtime
    address that answers with a 302 -- a hostile one, or a plaintext hop with
    someone in the middle -- collects the bearer token. Upgrading the same host
    from http to https is the one move that keeps it.
    """

    def redirect_request(  # noqa: PLR0913 - signature fixed by urllib
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: Mapping[str, str],
        newurl: str,
    ) -> urllib.request.Request | None:
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is None or _same_trust(req.full_url, newurl):
            return redirected
        for name in list(redirected.headers):
            if name.lower() == "authorization":
                del redirected.headers[name]
        return redirected


def _same_trust(origin_url: str, new_url: str) -> bool:
    origin = urllib.parse.urlsplit(origin_url)
    target = urllib.parse.urlsplit(new_url)
    if origin.netloc != target.netloc:
        return False
    return target.scheme == origin.scheme or (
        origin.scheme == "http" and target.scheme == "https"
    )


class MemnoxClient:
    """Ask the runtime for a decision before an AI action executes."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        token: str | None = None,
        admin_token: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._admin_token = admin_token
        self._timeout = timeout
        self._opener = urllib.request.build_opener(_TokenSafeRedirectHandler)

    # --- Actions -----------------------------------------------------------

    def check(
        self,
        action: str,
        target: str | None = None,
        environment: str | None = None,
        session_id: str | None = None,
        approval_id: str | None = None,
        reason: str | None = None,
        metadata: Mapping[str, object] | None = None,
        taint: TaintAssessment | None = None,
    ) -> Decision:
        """Ask the runtime for a decision. Never raises on a block - inspect the effect."""
        body: dict[str, object] = {"action": action}
        if target is not None:
            body["target"] = target
        if environment is not None:
            body["environment"] = environment
        if session_id is not None:
            body["sessionId"] = session_id
        if approval_id is not None:
            body["approvalId"] = approval_id
        if reason is not None:
            body["reason"] = reason
        if metadata is not None:
            body["metadata"] = dict(metadata)
        if taint is not None:
            body["taint"] = taint.to_json()
        return Decision.from_json(
            _as_map(self._json("POST", PATH_CHECK, body, self._token))
        )

    def guard(
        self,
        action: str,
        execute: Callable[[], T],
        target: str | None = None,
        environment: str | None = None,
        session_id: str | None = None,
        reason: str | None = None,
        metadata: Mapping[str, object] | None = None,
        taint: TaintAssessment | None = None,
    ) -> T:
        """Run `execute` only if the runtime allows the action."""
        decision = self.check(
            action,
            target=target,
            environment=environment,
            session_id=session_id,
            reason=reason,
            metadata=metadata,
            taint=taint,
        )
        if decision.effect == EFFECT_BLOCK:
            raise ActionBlockedError(decision)
        if decision.effect == EFFECT_REQUIRE_APPROVAL:
            raise ApprovalRequiredError(decision)
        return execute()

    # --- Runtime API helpers ----------------------------------------------

    def should_execute(
        self,
        action: str,
        target: str | None = None,
        environment: str | None = None,
        session_id: str | None = None,
    ) -> Verdict:
        """Truthy verdict for any action verb, carrying the full decision."""
        return Verdict.of(
            self.check(
                action, target=target, environment=environment, session_id=session_id
            )
        )

    def can_access(
        self,
        resource: str,
        environment: str | None = None,
        session_id: str | None = None,
    ) -> Verdict:
        """May the agent read this resource?"""
        return self.should_execute(
            ACTION_ACCESS,
            target=resource,
            environment=environment,
            session_id=session_id,
        )

    def can_deploy(
        self,
        service: str,
        environment: str | None = None,
        session_id: str | None = None,
    ) -> Verdict:
        """May the agent deploy this service?"""
        return self.should_execute(
            ACTION_DEPLOY,
            target=service,
            environment=environment,
            session_id=session_id,
        )

    def can_modify(
        self,
        target: str,
        environment: str | None = None,
        session_id: str | None = None,
    ) -> Verdict:
        """May the agent modify this file or record?"""
        return self.should_execute(
            ACTION_MODIFY,
            target=target,
            environment=environment,
            session_id=session_id,
        )

    def can_delete(
        self,
        target: str,
        environment: str | None = None,
        session_id: str | None = None,
    ) -> Verdict:
        """May the agent delete this resource?"""
        return self.should_execute(
            ACTION_DELETE,
            target=target,
            environment=environment,
            session_id=session_id,
        )

    # --- Agent identity ----------------------------------------------------

    def register_agent(
        self,
        name: str,
        kind: str = DEFAULT_AGENT_KIND,
        capabilities: Sequence[str] | None = None,
        org_id: str | None = None,
    ) -> AgentRegistration:
        """Register an agent. The returned token is shown only once."""
        body: dict[str, object] = {"name": name, "kind": kind}
        if capabilities is not None:
            body["capabilities"] = list(capabilities)
        if org_id is not None:
            body["orgId"] = org_id
        return AgentRegistration.from_json(
            _as_map(self._json("POST", PATH_AGENTS, body, self._admin_token))
        )

    def list_agents(self) -> list[AgentSummary]:
        """Every registered agent with its trust score."""
        payload = self._json("GET", PATH_AGENTS, None, self._admin_token)
        return [AgentSummary.from_json(item) for item in _as_maps(payload)]

    def set_agent_status(self, agent_id: str, status: str) -> AgentSummary:
        """Suspend or reactivate an agent."""
        return AgentSummary.from_json(
            _as_map(
                self._json(
                    "POST",
                    f"{PATH_AGENTS}/{urllib.parse.quote(agent_id)}/status",
                    {"status": status},
                    self._admin_token,
                )
            )
        )

    # --- Audit and reporting ----------------------------------------------

    def recent_audit(self, limit: int | None = None) -> list[ActionEvent]:
        """The most recent audit events, chronologically."""
        payload = self._json(
            "GET", f"{PATH_AUDIT}{_query({'limit': limit})}", None, self._admin_token
        )
        return [ActionEvent.from_json(item) for item in _as_maps(payload)]

    def query_audit(
        self,
        session_id: str | None = None,
        agent_id: str | None = None,
        org_id: str | None = None,
        from_time: str | None = None,
        to_time: str | None = None,
        limit: int | None = None,
    ) -> list[ActionEvent]:
        """Filtered audit timeline. All filters are optional and combine with AND."""
        query = _query(
            {
                "session": session_id,
                "agent": agent_id,
                "org": org_id,
                "from": from_time,
                "to": to_time,
                "limit": limit,
            }
        )
        payload = self._json("GET", f"{PATH_AUDIT}{query}", None, self._admin_token)
        return [ActionEvent.from_json(item) for item in _as_maps(payload)]

    def verify_audit(self) -> AuditChainVerification:
        """Walk the audit hash chain server-side and report the first broken link."""
        return AuditChainVerification.from_json(
            _as_map(self._json("GET", PATH_AUDIT_VERIFY, None, self._admin_token))
        )

    def export_audit_csv(
        self, from_time: str | None = None, to_time: str | None = None
    ) -> str:
        """Audit evidence as CSV text."""
        query = _query({"from": from_time, "to": to_time})
        return self._text("GET", f"{PATH_AUDIT_CSV}{query}", self._admin_token)

    def compliance_report(
        self, from_time: str | None = None, to_time: str | None = None
    ) -> ComplianceReport:
        """Governance evidence aggregated over the period."""
        query = _query({"from": from_time, "to": to_time})
        payload = self._json("GET", f"{PATH_COMPLIANCE}{query}", None, self._admin_token)
        return ComplianceReport.from_json(_as_map(payload))

    def metrics(self) -> str:
        """This pod's counters in Prometheus text format."""
        return self._text("GET", PATH_METRICS, self._admin_token)

    # --- Decision memory ---------------------------------------------------

    def add_decision(
        self,
        title: str,
        statement: str,
        owner: str,
        actions: Sequence[str],
        targets: Sequence[str] | None = None,
        environments: Sequence[str] | None = None,
        enforcement: str | None = None,
        reversibility_cost: str | None = None,
        source_type: str | None = None,
        source_ref: str | None = None,
        review_after: str | None = None,
        supersedes: str | None = None,
    ) -> DecisionRecord:
        """Record a team decision as a machine-checkable constraint."""
        body: dict[str, object] = {
            "title": title,
            "statement": statement,
            "owner": owner,
            "actions": list(actions),
        }
        if targets is not None:
            body["targets"] = list(targets)
        if environments is not None:
            body["environments"] = list(environments)
        if enforcement is not None:
            body["enforcement"] = enforcement
        if reversibility_cost is not None:
            body["reversibilityCost"] = reversibility_cost
        if source_type is not None:
            body["sourceType"] = source_type
        if source_ref is not None:
            body["sourceRef"] = source_ref
        if review_after is not None:
            body["reviewAfter"] = review_after
        if supersedes is not None:
            body["supersedes"] = supersedes
        return DecisionRecord.from_json(
            _as_map(self._json("POST", PATH_DECISIONS, body, self._admin_token))
        )

    def list_decisions(self) -> list[DecisionRecord]:
        """The whole decision corpus, active and retired."""
        payload = self._json("GET", PATH_DECISIONS, None, self._admin_token)
        return [DecisionRecord.from_json(item) for item in _as_maps(payload)]

    def search_decisions(self, query: str) -> list[DecisionSearchHit]:
        """Deterministic keyword search over the active corpus."""
        payload = self._json(
            "GET",
            f"{PATH_DECISION_SEARCH}{_query({'q': query})}",
            None,
            self._admin_token,
        )
        return [DecisionSearchHit.from_json(item) for item in _as_maps(payload)]

    def set_decision_status(self, decision_id: str, status: str) -> DecisionRecord:
        """Retire, supersede, or reactivate a decision."""
        return DecisionRecord.from_json(
            _as_map(
                self._json(
                    "POST",
                    f"{PATH_DECISIONS}/{urllib.parse.quote(decision_id)}/status",
                    {"status": status},
                    self._admin_token,
                )
            )
        )

    def decision_digest(self) -> str:
        """Prompt-injectable markdown digest of the active constraints."""
        payload = _as_map(self._json("GET", PATH_DIGEST, None, self._admin_token))
        digest = payload.get("digest")
        return digest if isinstance(digest, str) else ""

    def decision_health(self) -> DecisionHealth:
        """Corpus quality scored from enforcement telemetry."""
        return DecisionHealth.from_json(
            _as_map(self._json("GET", PATH_MEMORY_HEALTH, None, self._admin_token))
        )

    def remove_decision(self, decision_id: str) -> None:
        """Delete a decision outright. Prefer set_decision_status for an audit trail."""
        self._json(
            "DELETE",
            f"{PATH_DECISIONS}/{urllib.parse.quote(decision_id)}",
            None,
            self._admin_token,
        )

    # --- Approvals ---------------------------------------------------------

    def pending_approvals(self) -> list[Approval]:
        """Approvals still waiting on a human."""
        payload = self._json("GET", PATH_APPROVALS, None, self._admin_token)
        return [Approval.from_json(item) for item in _as_maps(payload)]

    def resolve_approval(
        self, approval_id: str, approved: bool, resolved_by: str
    ) -> Approval:
        """Approve or deny a pending approval."""
        return Approval.from_json(
            _as_map(
                self._json(
                    "POST",
                    f"{PATH_APPROVALS}/{urllib.parse.quote(approval_id)}",
                    {"approved": approved, "resolvedBy": resolved_by},
                    self._admin_token,
                )
            )
        )

    def override_approval(self, approval_id: str, reason: str) -> Approval:
        """Break-glass: admin-only, requires a reason, audited as critical."""
        return Approval.from_json(
            _as_map(
                self._json(
                    "POST",
                    f"{PATH_APPROVALS}/{urllib.parse.quote(approval_id)}/override",
                    {"reason": reason},
                    self._admin_token,
                )
            )
        )

    # --- Transport ---------------------------------------------------------

    def _json(
        self,
        method: str,
        path: str,
        body: Mapping[str, object] | None,
        bearer: str | None,
    ) -> object:
        payload = self._send(method, path, body, bearer)
        return json.loads(payload) if payload else None

    def _text(self, method: str, path: str, bearer: str | None) -> str:
        return self._send(method, path, None, bearer)

    def _send(
        self,
        method: str,
        path: str,
        body: Mapping[str, object] | None,
        bearer: str | None,
    ) -> str:
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            method=method,
            data=None if body is None else json.dumps(body).encode("utf-8"),
            headers={"content-type": "application/json"},
        )
        if bearer:
            request.add_header("authorization", f"Bearer {bearer}")
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                return response.read().decode("utf-8")
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", errors="replace")
            raise MemnoxApiError(err.code, f"{method} {path} failed: {detail}") from err
