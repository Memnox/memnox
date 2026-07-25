package ai.memnox;

/**
 * Runtime authorization for AI agents. Ask before acting; the runtime decides.
 *
 * <pre>{@code
 * MemnoxClient client = new MemnoxClient("http://127.0.0.1:7466", "mnx_token");
 * client.guard(ActionRequest.of("database.delete").environment("production"));
 * }</pre>
 */
public final class MemnoxClient {
    private static final String CHECK_PATH = "/v1/actions/check";

    private final String baseUrl;
    private final String token;
    private final Transport transport;

    public MemnoxClient(String baseUrl, String token) {
        this(baseUrl, token, new HttpTransport());
    }

    public MemnoxClient(String baseUrl, String token, Transport transport) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.token = token;
        this.transport = transport;
    }

    /** Asks for a decision and returns it, whatever the verdict. */
    public Decision check(ActionRequest request) {
        Transport.Response response =
                transport.post(baseUrl + CHECK_PATH, token, request.toJson());
        if (response.status() < 200 || response.status() >= 300) {
            throw new MemnoxException.Api(response.status(), response.body());
        }
        try {
            return Decision.fromJson(response.body());
        } catch (RuntimeException err) {
            throw new MemnoxException.Transport("unreadable decision", err);
        }
    }

    /**
     * Returns only when the action was allowed; anything else throws. Reach for
     * this one — an exception cannot be ignored the way a return value can.
     */
    public Decision guard(ActionRequest request) {
        Decision decision = check(request);
        return switch (decision.effect()) {
            case ALLOW -> decision;
            case BLOCK -> throw new MemnoxException.Blocked(decision);
            case REQUIRE_APPROVAL -> throw new MemnoxException.ApprovalRequired(decision);
        };
    }
}
