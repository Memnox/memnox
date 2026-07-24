package memnox

import (
	"context"
	"net/http"
	"net/url"
)

// RegisterAgent registers an agent. The returned token is shown only once.
func (c *Client) RegisterAgent(ctx context.Context, input AgentRegistrationInput) (AgentRegistration, error) {
	return decode[AgentRegistration](c.request(ctx, http.MethodPost, pathAgents, input, c.adminToken))
}

// ListAgents returns every registered agent with its trust score.
func (c *Client) ListAgents(ctx context.Context) ([]AgentSummary, error) {
	return decode[[]AgentSummary](c.request(ctx, http.MethodGet, pathAgents, nil, c.adminToken))
}

// SetAgentStatus suspends or reactivates an agent.
func (c *Client) SetAgentStatus(ctx context.Context, agentID, status string) (AgentSummary, error) {
	path := pathAgents + "/" + url.PathEscape(agentID) + "/status"
	body := map[string]string{"status": status}
	return decode[AgentSummary](c.request(ctx, http.MethodPost, path, body, c.adminToken))
}

// RecentAudit returns the most recent audit events. A limit of zero uses the
// server default.
func (c *Client) RecentAudit(ctx context.Context, limit int) ([]ActionEvent, error) {
	path := withQuery(pathAudit, limitValues(limit))
	return decode[[]ActionEvent](c.request(ctx, http.MethodGet, path, nil, c.adminToken))
}

// QueryAudit returns the audit timeline filtered by query. Empty fields are omitted.
func (c *Client) QueryAudit(ctx context.Context, query AuditQuery) ([]ActionEvent, error) {
	values := limitValues(query.Limit)
	setIfPresent(values, "session", query.SessionID)
	setIfPresent(values, "agent", query.AgentID)
	setIfPresent(values, "org", query.OrgID)
	setIfPresent(values, "from", query.From)
	setIfPresent(values, "to", query.To)
	path := withQuery(pathAudit, values)
	return decode[[]ActionEvent](c.request(ctx, http.MethodGet, path, nil, c.adminToken))
}

// VerifyAudit walks the audit hash chain server-side and reports the first
// broken link.
func (c *Client) VerifyAudit(ctx context.Context) (AuditChainVerification, error) {
	return decode[AuditChainVerification](c.request(ctx, http.MethodGet, pathAuditVerify, nil, c.adminToken))
}

// ExportAuditCSV returns the audit evidence for the period as CSV text.
func (c *Client) ExportAuditCSV(ctx context.Context, period ReportPeriod) (string, error) {
	return c.requestText(ctx, withQuery(pathAuditCSV, periodValues(period)))
}

// ComplianceReport aggregates governance evidence over the period.
func (c *Client) ComplianceReport(ctx context.Context, period ReportPeriod) (ComplianceReport, error) {
	path := withQuery(pathCompliance, periodValues(period))
	return decode[ComplianceReport](c.request(ctx, http.MethodGet, path, nil, c.adminToken))
}

// Metrics returns this pod's counters in Prometheus text format.
func (c *Client) Metrics(ctx context.Context) (string, error) {
	return c.requestText(ctx, pathMetrics)
}

// AddDecision records a team decision as a machine-checkable constraint.
func (c *Client) AddDecision(ctx context.Context, input DecisionRecordInput) (DecisionRecord, error) {
	return decode[DecisionRecord](c.request(ctx, http.MethodPost, pathDecisions, input, c.adminToken))
}

// ListDecisions returns the whole decision corpus, active and retired.
func (c *Client) ListDecisions(ctx context.Context) ([]DecisionRecord, error) {
	return decode[[]DecisionRecord](c.request(ctx, http.MethodGet, pathDecisions, nil, c.adminToken))
}

// SearchDecisions runs a deterministic keyword search over the active corpus.
func (c *Client) SearchDecisions(ctx context.Context, query string) ([]DecisionSearchHit, error) {
	values := url.Values{}
	values.Set("q", query)
	path := withQuery(pathDecisionSearch, values)
	return decode[[]DecisionSearchHit](c.request(ctx, http.MethodGet, path, nil, c.adminToken))
}

// SetDecisionStatus retires, supersedes, or reactivates a decision.
func (c *Client) SetDecisionStatus(ctx context.Context, decisionID, status string) (DecisionRecord, error) {
	path := pathDecisions + "/" + url.PathEscape(decisionID) + "/status"
	body := map[string]string{"status": status}
	return decode[DecisionRecord](c.request(ctx, http.MethodPost, path, body, c.adminToken))
}

// DecisionDigest returns a prompt-injectable markdown digest of the active
// constraints.
func (c *Client) DecisionDigest(ctx context.Context) (string, error) {
	payload, err := decode[struct {
		Digest string `json:"digest"`
	}](c.request(ctx, http.MethodGet, pathDigest, nil, c.adminToken))
	if err != nil {
		return "", err
	}
	return payload.Digest, nil
}

// DecisionHealth scores the decision corpus from enforcement telemetry.
func (c *Client) DecisionHealth(ctx context.Context) (DecisionHealthReport, error) {
	return decode[DecisionHealthReport](c.request(ctx, http.MethodGet, pathMemoryHealth, nil, c.adminToken))
}

// RemoveDecision deletes a decision outright. Prefer SetDecisionStatus, which
// keeps the record and its history.
func (c *Client) RemoveDecision(ctx context.Context, decisionID string) error {
	path := pathDecisions + "/" + url.PathEscape(decisionID)
	_, err := c.request(ctx, http.MethodDelete, path, nil, c.adminToken)
	return err
}

// PendingApprovals returns the approvals still waiting on a human.
func (c *Client) PendingApprovals(ctx context.Context) ([]Approval, error) {
	return decode[[]Approval](c.request(ctx, http.MethodGet, pathApprovals, nil, c.adminToken))
}

// ResolveApproval approves or denies a pending approval.
func (c *Client) ResolveApproval(ctx context.Context, approvalID string, approved bool, resolvedBy string) (Approval, error) {
	path := pathApprovals + "/" + url.PathEscape(approvalID)
	body := struct {
		Approved   bool   `json:"approved"`
		ResolvedBy string `json:"resolvedBy"`
	}{Approved: approved, ResolvedBy: resolvedBy}
	return decode[Approval](c.request(ctx, http.MethodPost, path, body, c.adminToken))
}

// OverrideApproval break-glasses a pending approval: admin-only, requires a
// reason, audited as critical.
func (c *Client) OverrideApproval(ctx context.Context, approvalID, reason string) (Approval, error) {
	path := pathApprovals + "/" + url.PathEscape(approvalID) + "/override"
	body := map[string]string{"reason": reason}
	return decode[Approval](c.request(ctx, http.MethodPost, path, body, c.adminToken))
}

func periodValues(period ReportPeriod) url.Values {
	values := url.Values{}
	setIfPresent(values, "from", period.From)
	setIfPresent(values, "to", period.To)
	return values
}
