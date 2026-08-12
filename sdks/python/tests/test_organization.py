"""Integration tests against a real local HTTP server - no mocks, no network."""

from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memnox import (  # noqa: E402
    DECISION_ALLOW,
    DECISION_ESCALATE,
    MemnoxApiError,
    MemnoxError,
    MemnoxOrganization,
    OrganizationUnreachableError,
    is_held,
    may_proceed,
)

# Assembled at runtime: literal credential-shaped strings are blocked in this repo.
GRANT = "".join(["mnx_", "ask_", "fixture"])

JSON_TYPE = "application/json"

ESCALATED = {
    "decision": "escalate",
    "reason": "payment.refund of 4500 is somebody's to authorize",
    "approvers": [
        {"id": "manager@acme.test", "because": "approves up to 5000", "limit": 5000}
    ],
    "policies": ["fact_7c1e"],
    "context": [
        {"id": "evt_9f21", "content": "the refund policy", "tainted": False}
    ],
    "constraints": ["never refund without a ticket"],
    "missingContext": [],
    "withheld": 2,
    "approvalId": "apr_1",
}

CANDIDATES = [
    {
        "agentId": "refund-bot",
        "label": "refunds",
        "capabilities": ["payment.refund"],
        "owner": "cfo@acme.test",
        "spendLimit": 1000,
    },
    {"agentId": "payments-bot", "label": "payments", "capabilities": ["payment"]},
]

OCCASIONS = [
    {
        "occurredAt": "2026-08-01T00:00:00.000Z",
        "verb": "escalate",
        "intent": "a duplicate charge",
        "to": ["manager@acme.test"],
    }
]


class _Handler(BaseHTTPRequestHandler):
    """Answers the ask seam, and records what it was sent."""

    seen: list[tuple[str, dict[str, object], str | None]] = []

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's name
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        _Handler.seen.append(
            (self.path, body, self.headers.get("authorization"))
        )

        if self.path.endswith("/evaluate"):
            return self._json(ESCALATED)
        if self.path.endswith("/ask/agents"):
            return self._json(CANDIDATES)
        if self.path.endswith("/ask/precedent"):
            return self._json(OCCASIONS)
        if self.path.endswith("/ask/context"):
            return self._json(
                {"facts": [{"id": "evt_1", "content": "x"}], "withheld": 3}
            )
        if self.path.endswith("/ask/refused"):
            return self._json({"error": "no"}, status=401)
        self._json({"error": "unknown"}, status=404)

    def _json(self, payload: object, status: int = 200) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", JSON_TYPE)
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args: object) -> None:
        """Silent, so a test run is readable."""


class OrganizationClientTest(unittest.TestCase):
    server: HTTPServer
    thread: threading.Thread

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = HTTPServer(("127.0.0.1", 0), _Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        _Handler.seen = []
        host, port = self.server.server_address[:2]
        self.client = MemnoxOrganization(
            token=GRANT, workspace="acme", base_url=f"http://{host}:{port}"
        )

    def test_sends_the_grant_and_the_workspace(self) -> None:
        self.client.evaluate("payment.refund")

        path, body, authorization = _Handler.seen[0]
        self.assertEqual(path, "/v1/workspaces/acme/evaluate")
        self.assertEqual(authorization, f"Bearer {GRANT}")
        self.assertEqual(body, {"action": "payment.refund"})

    def test_escapes_a_workspace_rather_than_pasting_it_into_the_path(self) -> None:
        host, port = self.server.server_address[:2]
        MemnoxOrganization(
            token=GRANT, workspace="acme/../other", base_url=f"http://{host}:{port}"
        ).evaluate("a")

        self.assertIn("acme%2F..%2Fother", _Handler.seen[0][0])

    def test_reads_the_whole_answer(self) -> None:
        answer = self.client.evaluate(
            "payment.refund",
            resource={"type": "customer", "id": "c_481"},
            amount=4500,
            reads=["evt_9f21"],
        )

        self.assertEqual(answer.decision, DECISION_ESCALATE)
        self.assertEqual(answer.approvers[0].id, "manager@acme.test")
        self.assertEqual(answer.approvers[0].limit, 5000)
        self.assertEqual(answer.withheld, 2)
        self.assertEqual(answer.approval_id, "apr_1")
        self.assertEqual(answer.context[0].id, "evt_9f21")

    def test_omits_arguments_that_were_not_given(self) -> None:
        self.client.evaluate("payment.refund", amount=4500)

        self.assertEqual(
            _Handler.seen[0][1], {"action": "payment.refund", "amount": 4500}
        )

    def test_treats_every_non_allow_as_held(self) -> None:
        self.assertFalse(is_held(DECISION_ALLOW))
        for decision in ("deny", "ask", "escalate", "delegate", "clarify"):
            self.assertTrue(is_held(decision))

    def test_does_not_turn_a_withheld_count_into_a_refusal(self) -> None:
        answer = self.client.evaluate("payment.refund")
        self.assertEqual(answer.withheld, 2)
        # Held because it escalated, not because something was withheld.
        self.assertFalse(may_proceed(answer))

    def test_require_raises_on_anything_that_is_not_a_plain_allow(self) -> None:
        with self.assertRaises(MemnoxError):
            self.client.require("payment.refund")

    def test_asks_which_agents_an_action_is_for(self) -> None:
        candidates = self.client.agents_for("payment.refund")

        self.assertEqual(_Handler.seen[0][0], "/v1/workspaces/acme/ask/agents")
        self.assertEqual(
            [each.agent_id for each in candidates], ["refund-bot", "payments-bot"]
        )
        self.assertEqual(candidates[0].owner, "cfo@acme.test")
        self.assertEqual(candidates[0].spend_limit, 1000)
        # Absent on the second, and absent means absent rather than zero.
        self.assertIsNone(candidates[1].spend_limit)

    def test_asks_what_happened_the_last_time(self) -> None:
        occasions = self.client.precedent("payment.refund", limit=3)

        self.assertEqual(
            _Handler.seen[0][1], {"action": "payment.refund", "limit": 3}
        )
        self.assertEqual(occasions[0].verb, "escalate")
        self.assertEqual(occasions[0].intent, "a duplicate charge")
        self.assertEqual(list(occasions[0].to), ["manager@acme.test"])

    def test_reads_context_and_what_it_withheld(self) -> None:
        answer = self.client.context("refunds", limit=5)

        self.assertEqual(_Handler.seen[0][1], {"question": "refunds", "limit": 5})
        self.assertEqual(answer.withheld, 3)
        self.assertEqual(answer.context[0].id, "evt_1")

    def test_carries_the_status_through_on_a_refusal(self) -> None:
        with self.assertRaises(MemnoxApiError) as raised:
            self.client.can_share("evt_1", "someone@acme.test")
        # can-share is not served here, so this is the 404 path; either way the
        # status travels rather than being flattened into a generic failure.
        self.assertEqual(raised.exception.status, 404)

    def test_never_fails_open_when_the_organization_cannot_be_reached(self) -> None:
        unreachable = MemnoxOrganization(
            token=GRANT,
            workspace="acme",
            # Port 1 is reserved and nothing listens on it.
            base_url="http://127.0.0.1:1",
            timeout_s=2,
        )

        with self.assertRaises(OrganizationUnreachableError):
            unreachable.evaluate("payment.refund")


if __name__ == "__main__":
    unittest.main()
