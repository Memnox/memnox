package ai.memnox;

/** What the runtime decided. Anything other than ALLOW stops the action. */
public enum Effect {
    ALLOW,
    WITHHOLD,
    ESCALATE;

    static Effect from(String wire) {
        return switch (wire) {
            case "allow" -> ALLOW;
            case "withhold" -> WITHHOLD;
            case "escalate" -> ESCALATE;
            default -> throw new IllegalArgumentException("unknown effect: " + wire);
        };
    }
}
