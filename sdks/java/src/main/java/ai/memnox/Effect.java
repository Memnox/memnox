package ai.memnox;

/** What the runtime decided. Anything other than ALLOW stops the action. */
public enum Effect {
    ALLOW,
    BLOCK,
    REQUIRE_APPROVAL;

    static Effect from(String wire) {
        return switch (wire) {
            case "allow" -> ALLOW;
            case "block" -> BLOCK;
            case "require_approval" -> REQUIRE_APPROVAL;
            default -> throw new IllegalArgumentException("unknown effect: " + wire);
        };
    }
}
