# memnox (Java)

Runtime authorization for AI agents. Ask before acting; the runtime decides.

```java
MemnoxClient client = new MemnoxClient("http://127.0.0.1:7466", "mnx_your_agent_token");

try {
    client.guard(ActionRequest.of("database.delete").environment("production"));
    runTheDelete();
} catch (MemnoxException.Blocked err) {
    log.warn("refused: {}", err.getMessage());
} catch (MemnoxException.ApprovalRequired err) {
    log.info("waiting on {}", err.decision().orElseThrow().approvalId().orElse("?"));
}
```

`check` returns the decision whatever it is; `guard` throws on anything other
than allow, so a verdict cannot be ignored by accident.

**No runtime dependencies.** JDK-only HTTP and JSON, so nothing here conflicts
with the versions your application already pins.

Under monitor mode an action is allowed while policy would have stopped it —
`decision.wouldHaveStopped()` reports that.

## Testing without a runtime

`Transport` is an interface. Implement it to drive real client logic:

```java
new MemnoxClient("http://runtime.test", "token", myFakeTransport);
```
