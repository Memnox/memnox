import XCTest
@testable import Memnox

/// Records what the client sent and replies with a canned response.
private actor Recorder {
    private(set) var urls: [URL] = []
    private(set) var tokens: [String] = []
    private(set) var bodies: [String] = []

    func record(url: URL, token: String, body: Data) {
        urls.append(url)
        tokens.append(token)
        bodies.append(String(data: body, encoding: .utf8) ?? "")
    }
}

private struct FakeTransport: Transport {
    let status: Int
    let body: String
    let recorder: Recorder

    func post(url: URL, token: String, body requestBody: Data) async throws -> HTTPResponse {
        await recorder.record(url: url, token: token, body: requestBody)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}

final class MemnoxClientTests: XCTestCase {
    private let allowed = #"{"eventId":"e1","effect":"allow","reason":"no policy matched"}"#
    private let withheld = #"{"eventId":"e2","effect":"withhold","reason":"no prod deletes","matchedPolicies":[{"name":"prod-guard","effect":"withhold"}]}"#
    private let held = #"{"eventId":"e3","effect":"escalate","reason":"needs a human","approvalId":"a1"}"#
    private let shadowed = #"{"eventId":"e4","effect":"allow","reason":"observed only","shadowEffect":"withhold"}"#

    private func client(_ status: Int, _ body: String, recorder: Recorder = Recorder())
        -> MemnoxClient
    {
        MemnoxClient(
            baseURL: "http://runtime.test/",
            token: "mnx_token",
            transport: FakeTransport(status: status, body: body, recorder: recorder))
    }

    func testCheckReturnsAnAllow() async throws {
        let decision = try await client(200, allowed).check(ActionRequest("repository.read"))

        XCTAssertEqual(decision.effect, .allow)
        XCTAssertTrue(decision.allowed)
    }

    func testCheckReturnsAWithholdRatherThanThrowing() async throws {
        let decision = try await client(200, withheld).check(ActionRequest("database.delete"))

        XCTAssertEqual(decision.effect, .withhold)
        XCTAssertFalse(decision.allowed)
        XCTAssertEqual(decision.matchedPolicies.first?.name, "prod-guard")
    }

    // guardAction is the call that cannot be ignored by accident.
    func testGuardThrowsOnAWithhold() async {
        do {
            _ = try await client(200, withheld).guardAction(ActionRequest("database.delete"))
            XCTFail("expected a withhold")
        } catch let MemnoxError.withheld(reason, eventId) {
            XCTAssertEqual(reason, "no prod deletes")
            XCTAssertEqual(eventId, "e2")
        } catch {
            XCTFail("expected .withheld, got \(error)")
        }
    }

    func testGuardThrowsOnAHoldAndCarriesTheApprovalId() async {
        do {
            _ = try await client(200, held).guardAction(ActionRequest("deploy.service"))
            XCTFail("expected an approval requirement")
        } catch let MemnoxError.approvalRequired(_, approvalId) {
            XCTAssertEqual(approvalId, "a1")
        } catch {
            XCTFail("expected .approvalRequired, got \(error)")
        }
    }

    func testGuardPassesAnAllowThrough() async throws {
        let decision = try await client(200, allowed).guardAction(ActionRequest("repository.read"))

        XCTAssertTrue(decision.allowed)
    }

    // Observe mode: the action ran, but the caller can still see it would not have.
    func testReportsWhatObserveModeSoftened() async throws {
        let decision = try await client(200, shadowed).check(ActionRequest("database.delete"))

        XCTAssertTrue(decision.allowed)
        XCTAssertTrue(decision.wouldHaveStopped)
        XCTAssertEqual(decision.shadowEffect, .withhold)
    }

    func testAnHttpErrorIsNotADecision() async {
        do {
            _ = try await client(401, "unauthorized").check(ActionRequest("a.b"))
            XCTFail("expected an API error")
        } catch let MemnoxError.api(status, _) {
            XCTAssertEqual(status, 401)
        } catch {
            XCTFail("expected .api, got \(error)")
        }
    }

    func testAnUnreadableBodyIsATransportFailure() async {
        do {
            _ = try await client(200, "not json").check(ActionRequest("a.b"))
            XCTFail("expected a transport error")
        } catch MemnoxError.transport {
            // expected
        } catch {
            XCTFail("expected .transport, got \(error)")
        }
    }

    func testSendsTheTokenAndTrimsTheBaseUrl() async throws {
        let recorder = Recorder()
        let subject = MemnoxClient(
            baseURL: "http://runtime.test//",
            token: "mnx_token",
            transport: FakeTransport(status: 200, body: allowed, recorder: recorder))

        _ = try await subject.check(ActionRequest("a.b"))

        let urls = await recorder.urls
        let tokens = await recorder.tokens
        XCTAssertEqual(urls.first?.absoluteString, "http://runtime.test/v1/actions/check")
        XCTAssertEqual(tokens.first, "mnx_token")
    }

    // Unset fields must never reach the wire as nulls.
    func testSendsOnlyTheFieldsThatWereSet() async throws {
        let recorder = Recorder()
        let subject = MemnoxClient(
            baseURL: "http://runtime.test",
            token: "t",
            transport: FakeTransport(status: 200, body: allowed, recorder: recorder))

        _ = try await subject.check(
            ActionRequest("shell.execute").target("rm -rf /").environment("production"))

        let body = await recorder.bodies.first ?? ""
        XCTAssertTrue(body.contains("\"action\":\"shell.execute\""))
        XCTAssertTrue(body.contains("\"environment\":\"production\""))
        XCTAssertFalse(body.contains("sessionId"))
        XCTAssertFalse(body.contains("null"))
    }
}
