"""Integration tests against a real local HTTP server - no mocks, no network."""

from __future__ import annotations

import json
import sys
import threading
import unittest
import urllib.parse
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memnox import (  # noqa: E402
    EFFECT_ALLOW,
    EFFECT_WITHHOLD,
    EFFECT_ESCALATE,
    ActionWithheldError,
    EscalationRequiredError,
    MemnoxApiError,
    MemnoxClient,
    TaintAssessment,
    TaintSourceRef,
)

# Assembled at runtime: literal credential-shaped strings are withheld in this repo.
AGENT_TOKEN = "".join(["mnx_", "agent", "fixture"])
ADMIN_TOKEN = "".join(["mnx_", "admin", "fixture"])

JSON_TYPE = "application/json"
CSV_TYPE = "text/csv"
PROMETHEUS_TYPE = "text/plain; version=0.0.4; charset=utf-8"

BLOCKED_ACTIONS = frozenset({"database.delete", "resource.delete"})
APPROVAL_ACTIONS = frozenset({"deploy.service"})
APPROVAL_ID = "apr-1"

METRICS_TEXT = "memnox_actions_total{effect=\"allow\"} 3\n"
CSV_TEXT = "id,action,effect\nevt-1,repository.read,allow\n"


@dataclass
class Recorded:
    method: str
    path: str
    query: dict[str, str]
    authorization: str | None
    content_type: str | None
    body: object = None


Route = Callable[[Recorded], "tuple[int, str, str]"]


def _json_body(payload: object, status: int = 200) -> tuple[int, str, str]:
    return status, JSON_TYPE, json.dumps(payload)


def _decision_for(action: str) -> dict[str, object]:
    if action in BLOCKED_ACTIONS:
        return {
            "eventId": "evt-block",
            "effect": EFFECT_WITHHOLD,
            "riskLevel": "critical",
            "reason": "policy applied",
            "matchedPolicies": [
                {"name": "no-destruction", "effect": EFFECT_WITHHOLD, "reason": "policy"}
            ],
            "advisories": [
                {
                    "source": "decision-memory",
                    "reason": "conflicts with a team decision",
                    "signals": ["decision-memory:decision:dec-1"],
                    "escalateTo": EFFECT_WITHHOLD,
                    "nonOverridable": True,
                }
            ],
        }
    if action in APPROVAL_ACTIONS:
        return {
            "eventId": "evt-approval",
            "effect": EFFECT_ESCALATE,
            "riskLevel": "high",
            "reason": "human approval required and pending",
            "matchedPolicies": [],
            "advisories": [],
            "approvalId": APPROVAL_ID,
        }
    return {
        "eventId": "evt-allow",
        "effect": EFFECT_ALLOW,
        "riskLevel": "low",
        "reason": "no policy matched",
        "matchedPolicies": [],
        "advisories": [],
    }


def _audit_event(event_id: str = "evt-1") -> dict[str, object]:
    return {
        "id": event_id,
        "occurredAt": "2026-01-01T00:00:00.000Z",
        "agentId": "agt-1",
        "agentName": "claude-code",
        "action": "repository.read",
        "target": "README.md",
        "environment": "staging",
        "sessionId": "s1",
        "effect": EFFECT_ALLOW,
        "riskLevel": "low",
        "matchedPolicies": ["read-only"],
        "advisories": [],
        "reason": "no policy matched",
        "prevHash": "0" * 64,
        "hash": "a" * 64,
    }


def _agent(status: str = "active") -> dict[str, object]:
    return {
        "id": "agt-1",
        "name": "claude-code",
        "kind": "claude-code",
        "status": status,
        "autonomyLevel": 3,
        "stats": {"allowed": 12, "withheld": 1, "approvalsRequested": 2},
        "capabilities": ["repository.*"],
        "createdAt": "2026-01-01T00:00:00.000Z",
    }


def _decision_record() -> dict[str, object]:
    return {
        "id": "dec-1",
        "title": "No schema migrations before Q4",
        "statement": "Hold all migrations until the Q4 freeze lifts.",
        "owner": "platform-team",
        "decidedAt": "2026-01-01T00:00:00.000Z",
        "actions": ["database.migrate"],
        "targets": ["production.*"],
        "environments": ["production"],
        "enforcement": "block",
        "status": "active",
        "reversibilityCost": "high",
        "sourceType": "manual",
    }


def _approval(status: str = "pending", override: bool = False) -> dict[str, object]:
    return {
        "id": APPROVAL_ID,
        "requestFingerprint": "fp-1",
        "agentId": "agt-1",
        "action": "deploy.service",
        "target": "checkout",
        "environment": "production",
        "approvers": ["security-team"],
        "status": status,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "expiresAt": "2026-01-08T00:00:00.000Z",
        "override": override,
    }


def _route_check(record: Recorded) -> tuple[int, str, str]:
    body = record.body if isinstance(record.body, Mapping) else {}
    action = body.get("action")
    return _json_body(_decision_for(action if isinstance(action, str) else ""))


def _route_register_agent(record: Recorded) -> tuple[int, str, str]:
    return _json_body({"agent": _agent(), "token": AGENT_TOKEN}, status=201)


def _route_agent_status(record: Recorded) -> tuple[int, str, str]:
    body = record.body if isinstance(record.body, Mapping) else {}
    status = body.get("status")
    return _json_body(_agent(status if isinstance(status, str) else "active"))


def _route_resolve_approval(record: Recorded) -> tuple[int, str, str]:
    body = record.body if isinstance(record.body, Mapping) else {}
    return _json_body(_approval("approved" if body.get("approved") else "denied"))


ROUTES: dict[tuple[str, str], Route] = {
    ("POST", "/v1/actions/check"): _route_check,
    ("POST", "/v1/agents"): _route_register_agent,
    ("GET", "/v1/agents"): lambda _r: _json_body([_agent()]),
    ("POST", "/v1/agents/agt-1/status"): _route_agent_status,
    ("GET", "/v1/audit"): lambda _r: _json_body([_audit_event()]),
    ("GET", "/v1/audit/verify"): lambda _r: _json_body(
        {"valid": False, "checked": 4, "brokenAtIndex": 4, "brokenEventId": "evt-9", "brokenReason": "content-mismatch"}
    ),
    ("GET", "/v1/audit/export.csv"): lambda _r: (200, CSV_TYPE, CSV_TEXT),
    ("GET", "/v1/metrics"): lambda _r: (200, PROMETHEUS_TYPE, METRICS_TEXT),
    ("GET", "/v1/reports/compliance"): lambda _r: _json_body(
        {
            "generatedAt": "2026-02-01T00:00:00.000Z",
            "period": {"from": "2026-01-01", "to": "2026-02-01"},
            "totals": {"actions": 9, "allowed": 6, "withheld": 2, "approvalsRequired": 1},
            "riskBreakdown": {"low": 6, "critical": 3},
            "topBlockedActions": [{"action": "database.delete", "count": 2}],
            "policyActivity": [{"policy": "no-destruction", "count": 2}],
            "agentActivity": [{"agent": "claude-code", "actions": 9, "withheld": 2}],
            "advisorySignals": [{"signal": "decision-memory:decision:dec-1", "count": 1}],
        }
    ),
    ("POST", "/v1/memory/decisions"): lambda _r: _json_body(_decision_record(), status=201),
    ("GET", "/v1/memory/decisions"): lambda _r: _json_body([_decision_record()]),
    ("GET", "/v1/memory/decisions/search"): lambda _r: _json_body(
        [{"decision": _decision_record(), "score": 4}]
    ),
    ("POST", "/v1/memory/decisions/dec-1/status"): lambda _r: _json_body(
        {**_decision_record(), "status": "retired"}
    ),
    ("DELETE", "/v1/memory/decisions/dec-1"): lambda _r: _json_body({"removed": True}),
    ("GET", "/v1/memory/digest"): lambda _r: _json_body({"digest": "# Active constraints"}),
    ("GET", "/v1/memory/health"): lambda _r: _json_body(
        {
            "score": 80,
            "activeDecisions": 2,
            "stale": 1,
            "frequentlyViolated": 0,
            "neverReferenced": 1,
            "entries": [
                {
                    "id": "dec-1",
                    "title": "No schema migrations before Q4",
                    "violations": 3,
                    "stale": True,
                    "neverReferenced": False,
                    "dueForReview": True,
                }
            ],
        }
    ),
    ("GET", "/v1/approvals"): lambda _r: _json_body([_approval()]),
    ("POST", f"/v1/approvals/{APPROVAL_ID}"): _route_resolve_approval,
    ("POST", f"/v1/approvals/{APPROVAL_ID}/override"): lambda _r: _json_body(
        _approval("approved", override=True)
    ),
}

AGENT_ROUTES = frozenset({("POST", "/v1/actions/check")})


@dataclass
class RequestLog:
    entries: list[Recorded] = field(default_factory=list)


LOG = RequestLog()


class FakeRuntimeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        record = Recorded(
            method=method,
            path=parsed.path,
            query=dict(urllib.parse.parse_qsl(parsed.query)),
            authorization=self.headers.get("authorization"),
            content_type=self.headers.get("content-type"),
            body=json.loads(raw) if raw else None,
        )
        LOG.entries.append(record)

        route = ROUTES.get((method, parsed.path))
        if route is None:
            self._reply(404, JSON_TYPE, json.dumps({"error": "not found"}))
            return
        expected = (
            AGENT_TOKEN if (method, parsed.path) in AGENT_ROUTES else ADMIN_TOKEN
        )
        if record.authorization != f"Bearer {expected}":
            self._reply(401, JSON_TYPE, json.dumps({"error": "unauthorized"}))
            return
        status, content_type, payload = route(record)
        self._reply(status, content_type, payload)

    def _reply(self, status: int, content_type: str, payload: str) -> None:
        encoded = payload.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args: object) -> None:
        """Silence the default stderr access log."""


class MemnoxClientTestCase(unittest.TestCase):
    server: HTTPServer
    base_url: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = HTTPServer(("127.0.0.1", 0), FakeRuntimeHandler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        LOG.entries.clear()
        self.client = MemnoxClient(
            base_url=self.base_url, token=AGENT_TOKEN, admin_token=ADMIN_TOKEN
        )

    def last(self) -> Recorded:
        self.assertTrue(LOG.entries, "no request reached the fixture server")
        return LOG.entries[-1]


class ActionTest(MemnoxClientTestCase):
    def test_check_sends_the_full_request_and_parses_the_decision(self) -> None:
        decision = self.client.check(
            "repository.read",
            target="README.md",
            environment="staging",
            session_id="s1",
            approval_id="apr-0",
            reason="reading docs",
            metadata={"pr": 42},
            taint=TaintAssessment(
                tainted=True,
                sources=[
                    TaintSourceRef(
                        source_type="github_issue_comment",
                        reason="third-party author",
                        reference="https://example.invalid/1",
                    )
                ],
            ),
        )
        self.assertEqual(decision.effect, EFFECT_ALLOW)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.event_id, "evt-allow")

        record = self.last()
        self.assertEqual(record.method, "POST")
        self.assertEqual(record.path, "/v1/actions/check")
        self.assertEqual(record.content_type, JSON_TYPE)
        self.assertEqual(record.authorization, f"Bearer {AGENT_TOKEN}")
        self.assertEqual(
            record.body,
            {
                "action": "repository.read",
                "target": "README.md",
                "environment": "staging",
                "sessionId": "s1",
                "approvalId": "apr-0",
                "reason": "reading docs",
                "metadata": {"pr": 42},
                "taint": {
                    "tainted": True,
                    "sources": [
                        {
                            "sourceType": "github_issue_comment",
                            "reason": "third-party author",
                            "reference": "https://example.invalid/1",
                        }
                    ],
                },
            },
        )

    def test_check_parses_matched_policies_and_advisories(self) -> None:
        decision = self.client.check("database.delete", environment="production")
        self.assertEqual(decision.effect, EFFECT_WITHHOLD)
        self.assertEqual(decision.matched_policies[0].name, "no-destruction")
        self.assertEqual(decision.advisories[0].source, "decision-memory")
        self.assertTrue(decision.advisories[0].non_overridable)
        self.assertEqual(
            decision.advisories[0].signals, ["decision-memory:decision:dec-1"]
        )

    def test_guard_runs_allowed_work(self) -> None:
        self.assertEqual(self.client.guard("repository.read", lambda: "done"), "done")

    def test_guard_raises_action_blocked(self) -> None:
        with self.assertRaises(ActionWithheldError) as ctx:
            self.client.guard("database.delete", lambda: "never")
        self.assertEqual(ctx.exception.decision.effect, EFFECT_WITHHOLD)
        self.assertIn("policy applied", str(ctx.exception))

    def test_guard_raises_approval_required(self) -> None:
        with self.assertRaises(EscalationRequiredError) as ctx:
            self.client.guard("deploy.service", lambda: "never")
        self.assertEqual(ctx.exception.decision.approval_id, APPROVAL_ID)

    def test_bad_token_raises_api_error(self) -> None:
        client = MemnoxClient(base_url=self.base_url, token="wrong")
        with self.assertRaises(MemnoxApiError) as ctx:
            client.check("repository.read")
        self.assertEqual(ctx.exception.status, 401)


class RuntimeApiHelperTest(MemnoxClientTestCase):
    def test_should_execute_returns_a_truthy_verdict(self) -> None:
        verdict = self.client.should_execute(
            "repository.read", target="README.md", environment="staging"
        )
        self.assertTrue(verdict)
        self.assertTrue(verdict.allowed)
        self.assertEqual(verdict.decision.event_id, "evt-allow")
        self.assertEqual(self.last().body["action"], "repository.read")

    def test_can_access(self) -> None:
        self.assertTrue(self.client.can_access("production.users"))
        self.assertEqual(self.last().body["action"], "resource.read")
        self.assertEqual(self.last().body["target"], "production.users")

    def test_can_deploy_is_falsy_when_approval_is_required(self) -> None:
        verdict = self.client.can_deploy("checkout", environment="production")
        self.assertFalse(verdict)
        self.assertEqual(verdict.decision.effect, EFFECT_ESCALATE)
        self.assertEqual(self.last().body["action"], "deploy.service")
        self.assertEqual(self.last().body["environment"], "production")

    def test_can_modify(self) -> None:
        self.assertTrue(self.client.can_modify("payment/checkout.ts"))
        self.assertEqual(self.last().body["action"], "code.modify")

    def test_can_delete_is_falsy_when_blocked(self) -> None:
        verdict = self.client.can_delete("production.users", environment="production")
        self.assertFalse(verdict)
        self.assertEqual(verdict.decision.effect, EFFECT_WITHHOLD)
        self.assertEqual(self.last().body["action"], "resource.delete")


class AgentTest(MemnoxClientTestCase):
    def test_register_agent(self) -> None:
        registration = self.client.register_agent(
            "claude-code", kind="claude-code", capabilities=["repository.*"], org_id="acme"
        )
        self.assertEqual(registration.token, AGENT_TOKEN)
        self.assertEqual(registration.agent.id, "agt-1")
        record = self.last()
        self.assertEqual(record.authorization, f"Bearer {ADMIN_TOKEN}")
        self.assertEqual(
            record.body,
            {
                "name": "claude-code",
                "kind": "claude-code",
                "capabilities": ["repository.*"],
                "orgId": "acme",
            },
        )

    def test_list_agents(self) -> None:
        agents = self.client.list_agents()
        self.assertEqual(agents[0].autonomy_level, 3)
        self.assertEqual(agents[0].stats.approvals_requested, 2)
        self.assertEqual(agents[0].capabilities, ["repository.*"])
        self.assertEqual(self.last().method, "GET")

    def test_set_agent_status(self) -> None:
        agent = self.client.set_agent_status("agt-1", "suspended")
        self.assertEqual(agent.status, "suspended")
        self.assertEqual(self.last().path, "/v1/agents/agt-1/status")
        self.assertEqual(self.last().body, {"status": "suspended"})


class AuditTest(MemnoxClientTestCase):
    def test_recent_audit_sends_the_limit(self) -> None:
        events = self.client.recent_audit(limit=25)
        self.assertEqual(events[0].id, "evt-1")
        self.assertEqual(events[0].matched_policies, ["read-only"])
        self.assertEqual(self.last().query, {"limit": "25"})

    def test_recent_audit_without_a_limit_sends_no_query(self) -> None:
        self.client.recent_audit()
        self.assertEqual(self.last().query, {})

    def test_query_audit_maps_every_filter(self) -> None:
        self.client.query_audit(
            session_id="s1",
            agent_id="agt-1",
            org_id="acme",
            from_time="2026-01-01",
            to_time="2026-02-01",
            limit=10,
        )
        self.assertEqual(
            self.last().query,
            {
                "session": "s1",
                "agent": "agt-1",
                "org": "acme",
                "from": "2026-01-01",
                "to": "2026-02-01",
                "limit": "10",
            },
        )

    def test_verify_audit(self) -> None:
        verification = self.client.verify_audit()
        self.assertFalse(verification.valid)
        self.assertEqual(verification.broken_at_index, 4)
        self.assertEqual(verification.broken_reason, "content-mismatch")

    def test_export_audit_csv(self) -> None:
        csv = self.client.export_audit_csv(from_time="2026-01-01", to_time="2026-02-01")
        self.assertEqual(csv, CSV_TEXT)
        self.assertEqual(self.last().query, {"from": "2026-01-01", "to": "2026-02-01"})

    def test_compliance_report(self) -> None:
        report = self.client.compliance_report(from_time="2026-01-01", to_time="2026-02-01")
        self.assertEqual(report.totals.actions, 9)
        self.assertEqual(report.risk_breakdown["critical"], 3)
        self.assertEqual(report.top_blocked_actions[0].action, "database.delete")
        self.assertEqual(report.policy_activity[0].policy, "no-destruction")
        self.assertEqual(report.agent_activity[0].agent, "claude-code")
        self.assertEqual(report.advisory_signals[0].count, 1)
        self.assertEqual(report.period_from, "2026-01-01")

    def test_metrics(self) -> None:
        self.assertEqual(self.client.metrics(), METRICS_TEXT)
        self.assertEqual(self.last().path, "/v1/metrics")


class DecisionMemoryTest(MemnoxClientTestCase):
    def test_add_decision(self) -> None:
        record = self.client.add_decision(
            title="No schema migrations before Q4",
            statement="Hold all migrations until the Q4 freeze lifts.",
            owner="platform-team",
            actions=["database.migrate"],
            targets=["production.*"],
            environments=["production"],
            enforcement="block",
            reversibility_cost="high",
            source_type="manual",
            source_ref="https://example.invalid/decision",
            review_after="2026-10-01",
            supersedes="dec-0",
        )
        self.assertEqual(record.id, "dec-1")
        self.assertEqual(record.enforcement, "block")
        self.assertEqual(
            self.last().body,
            {
                "title": "No schema migrations before Q4",
                "statement": "Hold all migrations until the Q4 freeze lifts.",
                "owner": "platform-team",
                "actions": ["database.migrate"],
                "targets": ["production.*"],
                "environments": ["production"],
                "enforcement": "block",
                "reversibilityCost": "high",
                "sourceType": "manual",
                "sourceRef": "https://example.invalid/decision",
                "reviewAfter": "2026-10-01",
                "supersedes": "dec-0",
            },
        )

    def test_list_decisions(self) -> None:
        decisions = self.client.list_decisions()
        self.assertEqual(decisions[0].targets, ["production.*"])
        self.assertEqual(decisions[0].reversibility_cost, "high")

    def test_search_decisions(self) -> None:
        hits = self.client.search_decisions("migration freeze")
        self.assertEqual(hits[0].score, 4)
        self.assertEqual(hits[0].decision.id, "dec-1")
        self.assertEqual(self.last().query, {"q": "migration freeze"})

    def test_set_decision_status(self) -> None:
        record = self.client.set_decision_status("dec-1", "retired")
        self.assertEqual(record.status, "retired")
        self.assertEqual(self.last().body, {"status": "retired"})

    def test_decision_digest(self) -> None:
        self.assertEqual(self.client.decision_digest(), "# Active constraints")

    def test_decision_health(self) -> None:
        health = self.client.decision_health()
        self.assertEqual(health.score, 80)
        self.assertEqual(health.entries[0].violations, 3)
        self.assertTrue(health.entries[0].due_for_review)

    def test_remove_decision(self) -> None:
        self.assertIsNone(self.client.remove_decision("dec-1"))
        self.assertEqual(self.last().method, "DELETE")
        self.assertEqual(self.last().path, "/v1/memory/decisions/dec-1")


class ApprovalTest(MemnoxClientTestCase):
    def test_pending_approvals(self) -> None:
        approvals = self.client.pending_approvals()
        self.assertEqual(approvals[0].id, APPROVAL_ID)
        self.assertEqual(approvals[0].approvers, ["security-team"])
        self.assertEqual(approvals[0].status, "pending")

    def test_resolve_approval(self) -> None:
        approval = self.client.resolve_approval(APPROVAL_ID, True, "alice")
        self.assertEqual(approval.status, "approved")
        self.assertEqual(
            self.last().body, {"approved": True, "resolvedBy": "alice"}
        )

    def test_override_approval(self) -> None:
        approval = self.client.override_approval(APPROVAL_ID, "incident 412")
        self.assertTrue(approval.override)
        self.assertEqual(self.last().path, f"/v1/approvals/{APPROVAL_ID}/override")
        self.assertEqual(self.last().body, {"reason": "incident 412"})


class _Collector(BaseHTTPRequestHandler):
    """Stands in for wherever a redirect points. Records what it was handed."""

    seen: dict[str, str | None] = {}

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        _Collector.seen["authorization"] = self.headers.get("authorization")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args: object) -> None:
        return


def _redirector(location: Callable[[], str]) -> type[BaseHTTPRequestHandler]:
    class Redirecting(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            self.send_response(302)
            self.send_header("location", location())
            # Explicit, so urllib's read of the redirect body cannot race the close.
            self.send_header("content-length", "0")
            self.end_headers()

        def log_message(self, *args: object) -> None:
            return

    return Redirecting


class RedirectTest(unittest.TestCase):
    """A runtime address that answers with a redirect must not collect the token.

    urllib copies every header onto the redirected request, so before this the
    bearer token followed a 302 to any host it named.
    """

    def setUp(self) -> None:
        _Collector.seen = {}
        self.collector = HTTPServer(("127.0.0.1", 0), _Collector)
        self.collector_port = self.collector.server_address[1]
        threading.Thread(target=self.collector.serve_forever, daemon=True).start()

        elsewhere = f"http://localhost:{self.collector_port}/collected"
        self.runtime = HTTPServer(("127.0.0.1", 0), _redirector(lambda: elsewhere))
        threading.Thread(target=self.runtime.serve_forever, daemon=True).start()
        self.base_url = f"http://127.0.0.1:{self.runtime.server_address[1]}"

    def tearDown(self) -> None:
        self.collector.shutdown()
        self.collector.server_close()
        self.runtime.shutdown()
        self.runtime.server_close()

    def test_token_does_not_follow_a_redirect_to_another_host(self) -> None:
        client = MemnoxClient(self.base_url, token=AGENT_TOKEN)

        client.check("repository.read")

        self.assertIsNone(_Collector.seen.get("authorization"))


if __name__ == "__main__":
    unittest.main()
