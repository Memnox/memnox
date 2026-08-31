use serde::{Deserialize, Serialize};

/// What the runtime decided. Anything other than `Allow` stops the action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    Allow,
    Withhold,
    Escalate,
}

/// One action to decide on. Only `action` is required.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ActionRequest {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_classification: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jurisdiction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
}

impl ActionRequest {
    pub fn new(action: impl Into<String>) -> Self {
        Self { action: action.into(), ..Default::default() }
    }

    pub fn target(mut self, target: impl Into<String>) -> Self {
        self.target = Some(target.into());
        self
    }

    pub fn environment(mut self, environment: impl Into<String>) -> Self {
        self.environment = Some(environment.into());
        self
    }

    pub fn session(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    pub fn provider(mut self, provider: impl Into<String>) -> Self {
        self.provider = Some(provider.into());
        self
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct MatchedPolicy {
    pub name: String,
    pub effect: Effect,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub event_id: String,
    pub effect: Effect,
    pub reason: String,
    #[serde(default)]
    pub matched_policies: Vec<MatchedPolicy>,
    #[serde(default)]
    pub approval_id: Option<String>,
    /// What enforce would have said, when the mode kept it from being applied.
    #[serde(default)]
    pub shadow_effect: Option<Effect>,
}

impl Decision {
    pub fn allowed(&self) -> bool {
        self.effect == Effect::Allow
    }

    /// True when observe mode let this through but enforce would have stopped it.
    pub fn would_have_stopped(&self) -> bool {
        self.shadow_effect.is_some()
    }
}
