package ai.memnox;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/** The runtime's answer, whatever it was. */
public final class Decision {
    private final String eventId;
    private final Effect effect;
    private final String reason;
    private final String approvalId;
    private final Effect shadowEffect;
    private final List<String> matchedPolicies;

    Decision(
            String eventId,
            Effect effect,
            String reason,
            String approvalId,
            Effect shadowEffect,
            List<String> matchedPolicies) {
        this.eventId = eventId;
        this.effect = effect;
        this.reason = reason;
        this.approvalId = approvalId;
        this.shadowEffect = shadowEffect;
        this.matchedPolicies = List.copyOf(matchedPolicies);
    }

    public String eventId() { return eventId; }
    public Effect effect() { return effect; }
    public String reason() { return reason; }
    public List<String> matchedPolicies() { return matchedPolicies; }
    public Optional<String> approvalId() { return Optional.ofNullable(approvalId); }

    public boolean allowed() {
        return effect == Effect.ALLOW;
    }

    /** True when monitor mode let this through but policy would have stopped it. */
    public boolean wouldHaveStopped() {
        return shadowEffect != null;
    }

    public Optional<Effect> shadowEffect() {
        return Optional.ofNullable(shadowEffect);
    }

    @SuppressWarnings("unchecked")
    static Decision fromJson(String body) {
        Object parsed = Json.parse(body);
        if (!(parsed instanceof Map<?, ?> map)) {
            throw new IllegalArgumentException("expected a decision object");
        }
        Map<String, Object> fields = (Map<String, Object>) map;
        Object withheld = fields.get("shadowEffect");
        Object matched = fields.get("matchedPolicies");

        return new Decision(
                text(fields.get("eventId")),
                Effect.from(text(fields.get("effect"))),
                text(fields.getOrDefault("reason", "")),
                fields.get("approvalId") == null ? null : text(fields.get("approvalId")),
                withheld == null ? null : Effect.from(text(withheld)),
                policyNames(matched));
    }

    @SuppressWarnings("unchecked")
    private static List<String> policyNames(Object matched) {
        if (!(matched instanceof List<?> items)) return List.of();
        return items.stream()
                .filter(item -> item instanceof Map)
                .map(item -> text(((Map<String, Object>) item).get("name")))
                .toList();
    }

    private static String text(Object value) {
        return value == null ? "" : String.valueOf(value);
    }
}
