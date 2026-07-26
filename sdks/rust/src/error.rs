use std::fmt;

/// Why a call did not produce a decision, or why the decision was not "allow".
#[derive(Debug)]
pub enum MemnoxError {
    /// Policy denied the action. The agent must not proceed.
    Blocked { reason: String, event_id: String },
    /// A human must approve before this action may run.
    ApprovalRequired { reason: String, approval_id: Option<String> },
    /// The runtime answered, but not with a decision.
    Api { status: u16, message: String },
    /// The runtime could not be reached, or the response was unreadable.
    Transport(String),
}

impl fmt::Display for MemnoxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Blocked { reason, .. } => write!(f, "blocked by policy: {reason}"),
            Self::ApprovalRequired { reason, .. } => {
                write!(f, "approval required: {reason}")
            }
            Self::Api { status, message } => write!(f, "runtime error {status}: {message}"),
            Self::Transport(message) => write!(f, "transport error: {message}"),
        }
    }
}

impl std::error::Error for MemnoxError {}

pub type Result<T> = std::result::Result<T, MemnoxError>;
