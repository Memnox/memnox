import Foundation

/// What the runtime decided. Anything other than `allow` stops the action.
public enum Effect: String, Codable, Sendable {
    case allow
    case withhold
    case escalate
}

/// One action to decide on. Only `action` is required.
public struct ActionRequest: Encodable, Sendable {
    public var action: String
    public var target: String?
    public var environment: String?
    public var sessionId: String?
    public var model: String?
    public var provider: String?
    public var dataClassification: String?
    public var jurisdiction: String?
    public var reason: String?
    public var approvalId: String?

    public init(_ action: String) {
        self.action = action
    }

    public func target(_ value: String) -> Self { with { $0.target = value } }
    public func environment(_ value: String) -> Self { with { $0.environment = value } }
    public func session(_ value: String) -> Self { with { $0.sessionId = value } }
    public func model(_ value: String) -> Self { with { $0.model = value } }
    public func provider(_ value: String) -> Self { with { $0.provider = value } }

    private func with(_ change: (inout Self) -> Void) -> Self {
        var copy = self
        change(&copy)
        return copy
    }
}

public struct MatchedPolicy: Decodable, Sendable {
    public let name: String
    public let effect: Effect
    public let reason: String?
}

/// The runtime's answer, whatever it was.
public struct Decision: Decodable, Sendable {
    public let eventId: String
    public let effect: Effect
    public let reason: String
    public let matchedPolicies: [MatchedPolicy]
    public let approvalId: String?
    /// Set when the environment's mode kept a verdict from being applied.
    public let shadowEffect: Effect?

    public var allowed: Bool { effect == .allow }

    /// True when monitor mode let this through but policy would have stopped it.
    public var wouldHaveStopped: Bool { shadowEffect != nil }

    private enum CodingKeys: String, CodingKey {
        case eventId, effect, reason, matchedPolicies, approvalId, shadowEffect
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventId = try container.decode(String.self, forKey: .eventId)
        effect = try container.decode(Effect.self, forKey: .effect)
        reason = try container.decodeIfPresent(String.self, forKey: .reason) ?? ""
        matchedPolicies =
            try container.decodeIfPresent([MatchedPolicy].self, forKey: .matchedPolicies) ?? []
        approvalId = try container.decodeIfPresent(String.self, forKey: .approvalId)
        shadowEffect = try container.decodeIfPresent(Effect.self, forKey: .shadowEffect)
    }
}

/// Why a call did not produce a decision, or why the decision was not allow.
public enum MemnoxError: Error, Sendable {
    /// Policy denied the action. The agent must not proceed.
    case withheld(reason: String, eventId: String)
    /// A human must approve before this action may run.
    case approvalRequired(reason: String, approvalId: String?)
    /// The runtime answered, but not with a decision.
    case api(status: Int, message: String)
    /// The runtime could not be reached, or the response was unreadable.
    case transport(String)
}

extension MemnoxError: CustomStringConvertible {
    public var description: String {
        switch self {
        case let .withheld(reason, _): return "withheld by policy: \(reason)"
        case let .approvalRequired(reason, _): return "approval required: \(reason)"
        case let .api(status, message): return "runtime error \(status): \(message)"
        case let .transport(message): return "transport error: \(message)"
        }
    }
}
