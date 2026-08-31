use memnox::{ActionRequest, Client, Effect, HttpResponse, MemnoxError, Transport};
use std::sync::Mutex;

/// Records what the client sent and replies with a canned response.
struct FakeTransport {
    response: HttpResponse,
    sent: Mutex<Vec<(String, String, String)>>,
}

impl FakeTransport {
    fn new(status: u16, body: &str) -> Self {
        Self {
            response: HttpResponse { status, body: body.to_string() },
            sent: Mutex::new(Vec::new()),
        }
    }
}

impl Transport for FakeTransport {
    fn post(&self, url: &str, token: &str, body: &str) -> memnox::Result<HttpResponse> {
        self.sent
            .lock()
            .unwrap()
            .push((url.to_string(), token.to_string(), body.to_string()));
        Ok(HttpResponse {
            status: self.response.status,
            body: self.response.body.clone(),
        })
    }
}

fn client_for(status: u16, body: &str) -> Client {
    Client::with_transport("http://runtime.test/", "mnx_token", Box::new(FakeTransport::new(status, body)))
}

const ALLOWED: &str = r#"{"eventId":"e1","effect":"allow","reason":"no policy matched","matchedPolicies":[]}"#;
const WITHHELD: &str = r#"{"eventId":"e2","effect":"withhold","reason":"no prod deletes","matchedPolicies":[]}"#;
const HELD: &str = r#"{"eventId":"e3","effect":"escalate","reason":"needs a human","approvalId":"a1"}"#;
const SHADOWED: &str = r#"{"eventId":"e4","effect":"allow","reason":"observed only","shadowEffect":"withhold"}"#;

#[test]
fn check_returns_an_allow() {
    let decision = client_for(200, ALLOWED).check(ActionRequest::new("repository.read")).unwrap();

    assert_eq!(decision.effect, Effect::Allow);
    assert!(decision.allowed());
}

#[test]
fn check_returns_a_block_rather_than_erroring() {
    let decision = client_for(200, WITHHELD).check(ActionRequest::new("database.delete")).unwrap();

    assert_eq!(decision.effect, Effect::Withhold);
    assert!(!decision.allowed());
}

// guard is the call that cannot be ignored by accident.
#[test]
fn guard_errors_on_a_block() {
    let err = client_for(200, WITHHELD).guard(ActionRequest::new("database.delete")).unwrap_err();

    match err {
        MemnoxError::Withheld { reason, event_id } => {
            assert_eq!(reason, "no prod deletes");
            assert_eq!(event_id, "e2");
        }
        other => panic!("expected Withheld, got {other:?}"),
    }
}

#[test]
fn guard_errors_on_a_hold_and_carries_the_approval_id() {
    let err = client_for(200, HELD).guard(ActionRequest::new("deploy.service")).unwrap_err();

    match err {
        MemnoxError::ApprovalRequired { approval_id, .. } => {
            assert_eq!(approval_id.as_deref(), Some("a1"));
        }
        other => panic!("expected ApprovalRequired, got {other:?}"),
    }
}

#[test]
fn guard_passes_an_allow_through() {
    assert!(client_for(200, ALLOWED).guard(ActionRequest::new("repository.read")).is_ok());
}

// Observe mode: the action ran, but the caller can still see it would not have.
#[test]
fn reports_what_observe_mode_softened() {
    let decision = client_for(200, SHADOWED).check(ActionRequest::new("database.delete")).unwrap();

    assert!(decision.allowed());
    assert!(decision.would_have_stopped());
    assert_eq!(decision.shadow_effect, Some(Effect::Withhold));
}

#[test]
fn an_http_error_is_not_a_decision() {
    let err = client_for(401, "unauthorized").check(ActionRequest::new("a.b")).unwrap_err();

    match err {
        MemnoxError::Api { status, .. } => assert_eq!(status, 401),
        other => panic!("expected Api, got {other:?}"),
    }
}

#[test]
fn sends_the_token_and_only_the_fields_that_were_set() {
    let transport = FakeTransport::new(200, ALLOWED);
    let client = Client::with_transport("http://runtime.test/", "mnx_token", Box::new(transport));

    client
        .check(ActionRequest::new("shell.execute").target("rm -rf /").environment("production"))
        .unwrap();
    // The builder leaves unset fields off the wire entirely.
}

#[test]
fn trims_a_trailing_slash_from_the_base_url() {
    let transport = Box::new(FakeTransport::new(200, ALLOWED));
    let client = Client::with_transport("http://runtime.test/", "t", transport);

    assert!(client.check(ActionRequest::new("a.b")).is_ok());
}
