# memnox (Rust)

Runtime authorization for AI agents. Ask before acting; the runtime decides.

```rust
use memnox::{ActionRequest, Client, MemnoxError};

let client = Client::new("http://127.0.0.1:7466", "mnx_your_agent_token");

// guard returns only when the action was allowed.
match client.guard(ActionRequest::new("database.delete").environment("production")) {
    Ok(_) => run_the_delete(),
    Err(MemnoxError::Withheld { reason, .. }) => eprintln!("refused: {reason}"),
    Err(MemnoxError::ApprovalRequired { approval_id, .. }) => {
        eprintln!("waiting on approval {approval_id:?}")
    }
    Err(err) => eprintln!("{err}"),
}
```

`check` returns the decision whatever it is; `guard` turns anything other than
allow into an error, so a verdict cannot be ignored by accident.

Under monitor mode an action is allowed while policy would have stopped it —
`decision.would_have_stopped()` reports that.

## Testing without a runtime

`Transport` is a trait. Implement it to drive real client logic against a fake:

```rust
Client::with_transport("http://runtime.test", "token", Box::new(MyFake))
```

Disable the bundled HTTP client with `default-features = false` if you would
rather supply your own.
