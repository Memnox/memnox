//! Runtime authorization for AI agents.
//!
//! ```no_run
//! use memnox::{Client, ActionRequest};
//! let client = Client::new("http://127.0.0.1:7466", "mnx_...");
//! client.guard(ActionRequest::new("database.delete").environment("production"))?;
//! # Ok::<(), memnox::MemnoxError>(())
//! ```
mod error;
mod transport;
mod types;

pub use error::{MemnoxError, Result};
pub use transport::{HttpResponse, Transport};
pub use types::{ActionRequest, Decision, Effect, MatchedPolicy};

#[cfg(feature = "http")]
pub use transport::UreqTransport;

const CHECK_PATH: &str = "/v1/actions/check";

pub struct Client {
    base_url: String,
    token: String,
    transport: Box<dyn Transport>,
}

impl Client {
    #[cfg(feature = "http")]
    pub fn new(base_url: impl Into<String>, token: impl Into<String>) -> Self {
        Self::with_transport(base_url, token, Box::new(UreqTransport::default()))
    }

    pub fn with_transport(
        base_url: impl Into<String>,
        token: impl Into<String>,
        transport: Box<dyn Transport>,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token: token.into(),
            transport,
        }
    }

    /// Asks for a decision and returns it, whatever the verdict.
    pub fn check(&self, request: ActionRequest) -> Result<Decision> {
        let body = serde_json::to_string(&request)
            .map_err(|err| MemnoxError::Transport(err.to_string()))?;
        let url = format!("{}{}", self.base_url, CHECK_PATH);
        let response = self.transport.post(&url, &self.token, &body)?;

        if !(200..300).contains(&response.status) {
            return Err(MemnoxError::Api {
                status: response.status,
                message: response.body,
            });
        }
        serde_json::from_str(&response.body)
            .map_err(|err| MemnoxError::Transport(err.to_string()))
    }

    /// Returns only when the action was allowed; anything else is an error.
    /// This is the call to reach for — it cannot be ignored by accident.
    pub fn guard(&self, request: ActionRequest) -> Result<Decision> {
        let decision = self.check(request)?;
        match decision.effect {
            Effect::Allow => Ok(decision),
            Effect::Block => Err(MemnoxError::Blocked {
                reason: decision.reason,
                event_id: decision.event_id,
            }),
            Effect::RequireApproval => Err(MemnoxError::ApprovalRequired {
                reason: decision.reason,
                approval_id: decision.approval_id,
            }),
        }
    }
}
