use crate::error::{MemnoxError, Result};

pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// The seam. Tests drive real client logic against a fake; production uses HTTP.
pub trait Transport: Send + Sync {
    fn post(&self, url: &str, token: &str, body: &str) -> Result<HttpResponse>;
}

#[cfg(feature = "http")]
pub struct UreqTransport {
    timeout: std::time::Duration,
}

#[cfg(feature = "http")]
impl UreqTransport {
    pub fn new(timeout: std::time::Duration) -> Self {
        Self { timeout }
    }
}

#[cfg(feature = "http")]
impl Default for UreqTransport {
    fn default() -> Self {
        Self::new(std::time::Duration::from_secs(10))
    }
}

#[cfg(feature = "http")]
impl Transport for UreqTransport {
    fn post(&self, url: &str, token: &str, body: &str) -> Result<HttpResponse> {
        let agent = ureq::AgentBuilder::new().timeout(self.timeout).build();
        let call = agent
            .post(url)
            .set("authorization", &format!("Bearer {token}"))
            .set("content-type", "application/json")
            .send_string(body);

        match call {
            Ok(response) => Ok(HttpResponse {
                status: response.status(),
                body: response.into_string().unwrap_or_default(),
            }),
            // A 4xx/5xx is an answer, not a transport failure — keep them apart.
            Err(ureq::Error::Status(status, response)) => Ok(HttpResponse {
                status,
                body: response.into_string().unwrap_or_default(),
            }),
            Err(err) => Err(MemnoxError::Transport(err.to_string())),
        }
    }
}
