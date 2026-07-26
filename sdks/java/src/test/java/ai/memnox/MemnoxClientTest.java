package ai.memnox;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class MemnoxClientTest {
    private static final String ALLOWED =
            "{\"eventId\":\"e1\",\"effect\":\"allow\",\"reason\":\"no policy matched\"}";
    private static final String BLOCKED =
            "{\"eventId\":\"e2\",\"effect\":\"block\",\"reason\":\"no prod deletes\","
                    + "\"matchedPolicies\":[{\"name\":\"prod-guard\",\"effect\":\"block\"}]}";
    private static final String HELD =
            "{\"eventId\":\"e3\",\"effect\":\"require_approval\",\"reason\":\"needs a human\","
                    + "\"approvalId\":\"a1\"}";
    private static final String WITHHELD =
            "{\"eventId\":\"e4\",\"effect\":\"allow\",\"reason\":\"observed only\","
                    + "\"withheldEffect\":\"block\"}";

    /** Records what the client sent and replies with a canned response. */
    private static final class FakeTransport implements Transport {
        private final int status;
        private final String body;
        final List<String> urls = new ArrayList<>();
        final List<String> tokens = new ArrayList<>();
        final List<String> bodies = new ArrayList<>();

        FakeTransport(int status, String body) {
            this.status = status;
            this.body = body;
        }

        @Override
        public Response post(String url, String token, String requestBody) {
            urls.add(url);
            tokens.add(token);
            bodies.add(requestBody);
            return new Response(status, body);
        }
    }

    private static MemnoxClient clientFor(int status, String body) {
        return new MemnoxClient("http://runtime.test/", "mnx_token",
                new FakeTransport(status, body));
    }

    @Test
    void checkReturnsAnAllow() {
        Decision decision = clientFor(200, ALLOWED).check(ActionRequest.of("repository.read"));

        assertEquals(Effect.ALLOW, decision.effect());
        assertTrue(decision.allowed());
    }

    @Test
    void checkReturnsABlockRatherThanThrowing() {
        Decision decision = clientFor(200, BLOCKED).check(ActionRequest.of("database.delete"));

        assertEquals(Effect.BLOCK, decision.effect());
        assertFalse(decision.allowed());
        assertEquals(List.of("prod-guard"), decision.matchedPolicies());
    }

    // guard is the call that cannot be ignored by accident.
    @Test
    void guardThrowsOnABlock() {
        MemnoxException.Blocked err = assertThrows(MemnoxException.Blocked.class,
                () -> clientFor(200, BLOCKED).guard(ActionRequest.of("database.delete")));

        assertTrue(err.getMessage().contains("no prod deletes"));
        assertEquals("e2", err.decision().orElseThrow().eventId());
    }

    @Test
    void guardThrowsOnAHoldAndCarriesTheApprovalId() {
        MemnoxException.ApprovalRequired err =
                assertThrows(MemnoxException.ApprovalRequired.class,
                        () -> clientFor(200, HELD).guard(ActionRequest.of("deploy.service")));

        assertEquals("a1", err.decision().orElseThrow().approvalId().orElseThrow());
    }

    @Test
    void guardPassesAnAllowThrough() {
        assertTrue(clientFor(200, ALLOWED).guard(ActionRequest.of("repository.read")).allowed());
    }

    // Monitor mode: the action ran, but the caller can still see it would not have.
    @Test
    void reportsWhatMonitorModeWithheld() {
        Decision decision = clientFor(200, WITHHELD).check(ActionRequest.of("database.delete"));

        assertTrue(decision.allowed());
        assertTrue(decision.wouldHaveStopped());
        assertEquals(Effect.BLOCK, decision.withheldEffect().orElseThrow());
    }

    @Test
    void anHttpErrorIsNotADecision() {
        MemnoxException.Api err = assertThrows(MemnoxException.Api.class,
                () -> clientFor(401, "unauthorized").check(ActionRequest.of("a.b")));

        assertEquals(401, err.status());
    }

    @Test
    void anUnreadableBodyIsATransportFailure() {
        assertThrows(MemnoxException.Transport.class,
                () -> clientFor(200, "not json").check(ActionRequest.of("a.b")));
    }

    @Test
    void sendsTheTokenAndTrimsTheBaseUrl() {
        FakeTransport transport = new FakeTransport(200, ALLOWED);
        new MemnoxClient("http://runtime.test//", "mnx_token", transport)
                .check(ActionRequest.of("a.b"));

        assertEquals("http://runtime.test/v1/actions/check", transport.urls.get(0));
        assertEquals("mnx_token", transport.tokens.get(0));
    }

    // Unset fields must never reach the wire as nulls.
    @Test
    void sendsOnlyTheFieldsThatWereSet() {
        FakeTransport transport = new FakeTransport(200, ALLOWED);
        new MemnoxClient("http://runtime.test", "t", transport).check(
                ActionRequest.of("shell.execute").target("rm -rf /").environment("production"));

        String body = transport.bodies.get(0);
        assertTrue(body.contains("\"action\":\"shell.execute\""));
        assertTrue(body.contains("\"environment\":\"production\""));
        assertFalse(body.contains("sessionId"));
        assertFalse(body.contains("null"));
    }
}
