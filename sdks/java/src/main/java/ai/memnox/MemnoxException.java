package ai.memnox;

import java.util.Optional;

/** Thrown when an action was not allowed, or no decision could be obtained. */
public class MemnoxException extends RuntimeException {
    private final Decision decision;

    MemnoxException(String message, Decision decision) {
        super(message);
        this.decision = decision;
    }

    MemnoxException(String message, Throwable cause) {
        super(message, cause);
        this.decision = null;
    }

    /** The decision that caused this, when the runtime answered. */
    public Optional<Decision> decision() {
        return Optional.ofNullable(decision);
    }

    /** Policy denied the action. */
    public static final class Withheld extends MemnoxException {
        Withheld(Decision decision) {
            super("withheld by policy: " + decision.reason(), decision);
        }
    }

    /** The action escalated: a person must answer before it may run. */
    public static final class Escalated extends MemnoxException {
        Escalated(Decision decision) {
            super("escalated: " + decision.reason(), decision);
        }
    }

    /** The runtime answered, but not with a decision. */
    public static final class Api extends MemnoxException {
        private final int status;

        Api(int status, String body) {
            super("runtime error " + status + ": " + body, (Decision) null);
            this.status = status;
        }

        public int status() {
            return status;
        }
    }

    /** The runtime could not be reached, or the response was unreadable. */
    public static final class Transport extends MemnoxException {
        Transport(String message, Throwable cause) {
            super("transport error: " + message, cause);
        }
    }
}
