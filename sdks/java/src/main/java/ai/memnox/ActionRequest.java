package ai.memnox;

import java.util.LinkedHashMap;
import java.util.Map;

/** One action to decide on. Only the action is required. */
public final class ActionRequest {
    private final Map<String, Object> fields = new LinkedHashMap<>();

    private ActionRequest(String action) {
        fields.put("action", action);
    }

    public static ActionRequest of(String action) {
        return new ActionRequest(action);
    }

    public ActionRequest target(String target) { return set("target", target); }
    public ActionRequest environment(String value) { return set("environment", value); }
    public ActionRequest session(String sessionId) { return set("sessionId", sessionId); }
    public ActionRequest model(String model) { return set("model", model); }
    public ActionRequest provider(String provider) { return set("provider", provider); }
    public ActionRequest dataClassification(String value) {
        return set("dataClassification", value);
    }
    public ActionRequest jurisdiction(String value) { return set("jurisdiction", value); }
    public ActionRequest reason(String reason) { return set("reason", reason); }
    public ActionRequest approvalId(String approvalId) { return set("approvalId", approvalId); }

    private ActionRequest set(String key, String value) {
        fields.put(key, value);
        return this;
    }

    String toJson() {
        return Json.writeObject(fields);
    }
}
