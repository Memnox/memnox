# Memnox (Swift)

Runtime authorization for AI agents. Ask before acting; the runtime decides.

```swift
let client = MemnoxClient(baseURL: "http://127.0.0.1:7466", token: "mnx_your_agent_token")

do {
    try await client.guardAction(ActionRequest("database.delete").environment("production"))
    runTheDelete()
} catch let MemnoxError.blocked(reason, _) {
    print("refused: \(reason)")
} catch let MemnoxError.approvalRequired(_, approvalId) {
    print("waiting on \(approvalId ?? "?")")
}
```

`check` returns the decision whatever it is; `guardAction` throws on anything
other than allow, so a verdict cannot be ignored by accident.

No dependencies beyond Foundation. Under monitor mode an action is allowed while
policy would have stopped it — `decision.wouldHaveStopped` reports that.

## Testing without a runtime

`Transport` is a protocol. Conform to it to drive real client logic:

```swift
MemnoxClient(baseURL: "http://runtime.test", token: "t", transport: MyFake())
```
