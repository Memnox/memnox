import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPResponse: Sendable {
    public let status: Int
    public let body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

/// The seam. Tests drive real client logic against a fake; production uses HTTP.
public protocol Transport: Sendable {
    func post(url: URL, token: String, body: Data) async throws -> HTTPResponse
}

/// URLSession-backed transport. A 4xx or 5xx is an answer, not a failure.
public struct URLSessionTransport: Transport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func post(url: URL, token: String, body: Data) async throws -> HTTPResponse {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = body

        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            return HTTPResponse(status: status, body: data)
        } catch {
            throw MemnoxError.transport(error.localizedDescription)
        }
    }
}

/// Runtime authorization for AI agents. Ask before acting; the runtime decides.
public struct MemnoxClient: Sendable {
    private static let checkPath = "/v1/actions/check"

    private let baseURL: String
    private let token: String
    private let transport: Transport

    public init(baseURL: String, token: String, transport: Transport = URLSessionTransport()) {
        var trimmed = baseURL
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        self.baseURL = trimmed
        self.token = token
        self.transport = transport
    }

    /// Asks for a decision and returns it, whatever the verdict.
    public func check(_ request: ActionRequest) async throws -> Decision {
        guard let url = URL(string: baseURL + Self.checkPath) else {
            throw MemnoxError.transport("invalid base URL")
        }
        let encoder = JSONEncoder()
        // Unset fields must never reach the wire as nulls.
        let body = try encoder.encode(request)
        let response = try await transport.post(url: url, token: token, body: body)

        guard (200..<300).contains(response.status) else {
            throw MemnoxError.api(
                status: response.status,
                message: String(data: response.body, encoding: .utf8) ?? "")
        }
        do {
            return try JSONDecoder().decode(Decision.self, from: response.body)
        } catch {
            throw MemnoxError.transport("unreadable decision")
        }
    }

    /// Returns only when the action was allowed; anything else throws. Reach for
    /// this one — a thrown error cannot be ignored the way a return value can.
    @discardableResult
    public func guardAction(_ request: ActionRequest) async throws -> Decision {
        let decision = try await check(request)
        switch decision.effect {
        case .allow:
            return decision
        case .block:
            throw MemnoxError.blocked(reason: decision.reason, eventId: decision.eventId)
        case .requireApproval:
            throw MemnoxError.approvalRequired(
                reason: decision.reason, approvalId: decision.approvalId)
        }
    }
}
