"""Ask your organization before your agent acts. Standard library only.

The mirror of ``@memnox/organization``, and a separate client on purpose. The
runtime client next door asks whether an action **breaks a rule**; this asks
whether it **should happen** — who owns it, what the company already decided,
who authorizes it at this size, and how much of the evidence this agent is
entitled to see. They are separate services, separate credentials, and
separate questions, so they are separate objects.

Nothing here writes, and nothing here fails open: a call that cannot reach
Memnox raises rather than returning a permissive default.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .errors import MemnoxApiError, MemnoxError

DEFAULT_ORGANIZATION_URL = "https://api.memnox.com"
DEFAULT_TIMEOUT_S = 10

DECISION_ALLOW = "allow"
DECISION_DENY = "deny"
DECISION_ASK = "ask"
DECISION_ESCALATE = "escalate"
DECISION_DELEGATE = "delegate"
DECISION_CLARIFY = "clarify"

#: Every answer that is not a plain allow. Held, not failed.
HELD_DECISIONS = (
    DECISION_DENY,
    DECISION_ASK,
    DECISION_ESCALATE,
    DECISION_DELEGATE,
    DECISION_CLARIFY,
)


class OrganizationUnreachableError(MemnoxError):
    """Raised when the organization could not be asked at all.

    Its own type rather than a generic error, because the correct handling is
    the opposite of the obvious one: an agent that catches this and proceeds
    has turned an outage into the most permissive state in the system.
    """


@dataclass(frozen=True)
class Approver:
    """Somebody who can authorize this, and why they can."""

    id: str
    because: str
    #: Their ceiling for this action, when the organization states one.
    limit: float | None = None


@dataclass(frozen=True)
class Fact:
    """One piece of evidence the agent is entitled to use."""

    id: str
    content: str
    source_type: str | None = None
    source_ref: str | None = None
    occurred_at: str | None = None
    #: Untrusted provenance travels with the fact; never strip it.
    tainted: bool = False


@dataclass(frozen=True)
class Answer:
    """What came back from ``evaluate``."""

    decision: str
    reason: str
    approvers: Sequence[Approver] = field(default_factory=tuple)
    policies: Sequence[str] = field(default_factory=tuple)
    context: Sequence[Fact] = field(default_factory=tuple)
    constraints: Sequence[str] = field(default_factory=tuple)
    missing_context: Sequence[str] = field(default_factory=tuple)
    #: How much bearing evidence was withheld. Non-zero means ask a person.
    withheld: int = 0
    approval_id: str | None = None


@dataclass(frozen=True)
class AgentCandidate:
    """Another agent this company runs, offered as somewhere to send work."""

    agent_id: str
    label: str
    capabilities: Sequence[str] = field(default_factory=tuple)
    owner: str | None = None
    principal: str | None = None
    department: str | None = None
    spend_limit: float | None = None


@dataclass(frozen=True)
class Precedent:
    """One earlier occasion of the same action, as the organization recorded it."""

    occurred_at: str
    verb: str
    target: str | None = None
    #: What that asker said they were doing, in their own words.
    intent: str | None = None
    reason: str | None = None
    to: Sequence[str] = field(default_factory=tuple)


def may_proceed(answer: Answer) -> bool:
    """Whether the agent may act on its own.

    A withheld count does not make this false: a partial answer that was still
    allowed is allowed. It is a reason to involve a person, which is a
    judgement the caller makes, not a refusal this returns.
    """
    return answer.decision == DECISION_ALLOW


def is_held(decision: str) -> bool:
    """Whether this answer means stop and involve somebody."""
    return decision in HELD_DECISIONS


class MemnoxOrganization:
    """The organization, as one agent may ask it.

    :param token: the ask grant minted for this agent. Never a person's
        credential, and never the runtime's agent token.
    :param workspace: which organization's memory to ask.
    """

    def __init__(
        self,
        token: str,
        workspace: str,
        base_url: str = DEFAULT_ORGANIZATION_URL,
        timeout_s: int = DEFAULT_TIMEOUT_S,
    ) -> None:
        self._token = token
        self._workspace = workspace
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_s

    # -- the one call ----------------------------------------------------

    def evaluate(
        self,
        action: str,
        *,
        resource: Mapping[str, str] | None = None,
        principal: str | None = None,
        amount: float | None = None,
        environment: str | None = None,
        reason: str | None = None,
        reads: Sequence[str] | None = None,
    ) -> Answer:
        """Should this happen, and what may I know while doing it.

        ``reads`` is the one argument worth sending even when it feels
        optional: the fact ids an action relies on are what let the answer tell
        "you may not do this" apart from "you should not be the one who knows
        this". Without them you will never see a delegation.
        """
        body: dict[str, object] = {"action": action}
        if resource is not None:
            body["resource"] = dict(resource)
        if principal is not None:
            body["principal"] = principal
        if amount is not None:
            body["amount"] = amount
        if environment is not None:
            body["environment"] = environment
        if reason is not None:
            body["reason"] = reason
        if reads is not None:
            body["reads"] = list(reads)
        return _answer(self._post("/evaluate", body))

    def require(self, action: str, **kwargs: Any) -> Answer:
        """Evaluate, and raise unless the answer is a plain allow.

        For the call site that has nothing sensible to do with an escalation.
        Anything that can handle an approval should use ``evaluate``.
        """
        answer = self.evaluate(action, **kwargs)
        if not may_proceed(answer):
            raise MemnoxError(
                f"{action} was not allowed: {answer.decision} - {answer.reason}"
            )
        return answer

    # -- the reads -------------------------------------------------------

    def context(self, question: str, limit: int | None = None) -> Answer:
        """What the organization knows that bears on a question."""
        body: dict[str, object] = {"question": question}
        if limit is not None:
            body["limit"] = limit
        payload = self._post("/ask/context", body)
        return Answer(
            decision=DECISION_ALLOW,
            reason="context",
            context=tuple(_fact(each) for each in _list(payload.get("facts"))),
            constraints=tuple(_strings(payload.get("restrictions"))),
            withheld=int(payload.get("withheld") or 0),
        )

    def owner(self, subject: str) -> list[dict[str, Any]]:
        """Who owns this, and through which decision."""
        payload = self._post("/ask/owner", {"subject": subject})
        return [dict(each) for each in _list(payload.get("owners"))]

    def decisions(self, topic: str) -> list[dict[str, Any]]:
        """What has already been decided about a topic, so you do not re-decide it."""
        return [dict(each) for each in _as_list(self._post_raw("/ask/decisions", {"topic": topic}))]

    def agents_for(self, action: str) -> list[AgentCandidate]:
        """Which agents this company runs for an action, tightest remit first.

        The answer to "this is not what I am for". Never includes you, and an
        empty list means nobody is recorded for it — a reason to involve a
        person rather than to attempt it anyway.
        """
        raw = _as_list(self._post_raw("/ask/agents", {"action": action}))
        return [_candidate(each) for each in raw]

    def precedent(self, action: str, limit: int | None = None) -> list[Precedent]:
        """How the same action was routed the last few times somebody asked.

        The organization's behaviour rather than its statements. Carries the
        verb, who it went to and the stated intent — never what any of those
        answers contained.
        """
        body: dict[str, object] = {"action": action}
        if limit is not None:
            body["limit"] = limit
        raw = _as_list(self._post_raw("/ask/precedent", body))
        return [_precedent(each) for each in raw]

    def can_share(self, fact_id: str, recipient: str) -> dict[str, Any]:
        """Whether one fact may be repeated to one person.

        Answered against the recipient's clearance, never yours. The refusal
        reason must not be repeated to the recipient either.
        """
        return self._post(
            "/ask/can-share", {"factId": fact_id, "recipient": recipient}
        )

    # -- transport -------------------------------------------------------

    def _post(self, path: str, body: Mapping[str, object]) -> dict[str, Any]:
        parsed = self._post_raw(path, body)
        if not isinstance(parsed, dict):
            raise MemnoxError(f"{path} answered with {type(parsed).__name__}")
        return parsed

    def _post_raw(self, path: str, body: Mapping[str, object]) -> object:
        workspace = urllib.parse.quote(self._workspace, safe="")
        url = f"{self._base_url}/v1/workspaces/{workspace}{path}"
        request = urllib.request.Request(
            url,
            method="POST",
            data=json.dumps(dict(body)).encode("utf-8"),
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self._token}",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", errors="replace")
            raise MemnoxApiError(err.code, f"POST {path} failed: {detail}") from err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            # Never a permissive default. An organization that cannot be
            # reached has not said yes.
            raise OrganizationUnreachableError(
                f"POST {path} could not reach Memnox: {err}"
            ) from err


def _answer(payload: Mapping[str, Any]) -> Answer:
    return Answer(
        decision=str(payload.get("decision") or DECISION_CLARIFY),
        reason=str(payload.get("reason") or ""),
        approvers=tuple(_approver(each) for each in _list(payload.get("approvers"))),
        policies=tuple(_strings(payload.get("policies"))),
        context=tuple(_fact(each) for each in _list(payload.get("context"))),
        constraints=tuple(_strings(payload.get("constraints"))),
        missing_context=tuple(_strings(payload.get("missingContext"))),
        withheld=int(payload.get("withheld") or 0),
        approval_id=_optional_str(payload.get("approvalId")),
    )


def _approver(raw: Mapping[str, Any]) -> Approver:
    limit = raw.get("limit")
    return Approver(
        id=str(raw.get("id") or ""),
        because=str(raw.get("because") or ""),
        limit=float(limit) if isinstance(limit, (int, float)) else None,
    )


def _fact(raw: Mapping[str, Any]) -> Fact:
    return Fact(
        id=str(raw.get("id") or ""),
        content=str(raw.get("content") or ""),
        source_type=_optional_str(raw.get("sourceType")),
        source_ref=_optional_str(raw.get("sourceRef")),
        occurred_at=_optional_str(raw.get("occurredAt")),
        tainted=raw.get("tainted") is True,
    )


def _candidate(raw: Mapping[str, Any]) -> AgentCandidate:
    limit = raw.get("spendLimit")
    return AgentCandidate(
        agent_id=str(raw.get("agentId") or ""),
        label=str(raw.get("label") or ""),
        capabilities=tuple(_strings(raw.get("capabilities"))),
        owner=_optional_str(raw.get("owner")),
        principal=_optional_str(raw.get("principal")),
        department=_optional_str(raw.get("department")),
        spend_limit=float(limit) if isinstance(limit, (int, float)) else None,
    )


def _precedent(raw: Mapping[str, Any]) -> Precedent:
    return Precedent(
        occurred_at=str(raw.get("occurredAt") or ""),
        verb=str(raw.get("verb") or ""),
        target=_optional_str(raw.get("target")),
        intent=_optional_str(raw.get("intent")),
        reason=_optional_str(raw.get("reason")),
        to=tuple(_strings(raw.get("to"))),
    )


def _list(value: object) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        return []
    return [each for each in value if isinstance(each, Mapping)]


def _as_list(value: object) -> list[Mapping[str, Any]]:
    return _list(value)


def _strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [each for each in value if isinstance(each, str)]


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None
