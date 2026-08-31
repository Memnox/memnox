// Package memnox is a dependency-free client for the Memnox runtime —
// check every AI action before it executes.
package memnox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the address the runtime listens on out of the box.
const DefaultBaseURL = "http://127.0.0.1:7466"

// DefaultTimeout bounds every request when Options.Timeout is zero.
const DefaultTimeout = 10 * time.Second

// Decision effects the runtime can return.
const (
	// EffectAllow permits the action.
	EffectAllow = "allow"
	// EffectWithhold refuses the action outright.
	EffectWithhold = "withhold"
	// EffectEscalate defers the action to a human.
	EffectEscalate = "escalate"
)

// Risk levels the runtime classifies actions into.
const (
	// RiskLow is a read-only or otherwise harmless action.
	RiskLow = "low"
	// RiskMedium is a reversible state change.
	RiskMedium = "medium"
	// RiskHigh is a state change in a sensitive place.
	RiskHigh = "high"
	// RiskCritical is destructive or exfiltrating.
	RiskCritical = "critical"
)

// Agent lifecycle states.
const (
	// AgentStatusActive lets the agent act.
	AgentStatusActive = "active"
	// AgentStatusSuspended withholds every action from the agent.
	AgentStatusSuspended = "suspended"
)

// Approval lifecycle states.
const (
	// ApprovalStatusPending is waiting on a human.
	ApprovalStatusPending = "pending"
	// ApprovalStatusApproved was granted.
	ApprovalStatusApproved = "approved"
	// ApprovalStatusDenied was refused.
	ApprovalStatusDenied = "denied"
	// ApprovalStatusExpired lapsed before anyone answered.
	ApprovalStatusExpired = "expired"
)

// Decision-memory record states.
const (
	// DecisionStatusActive enforces.
	DecisionStatusActive = "active"
	// DecisionStatusSuperseded was replaced by a newer decision.
	DecisionStatusSuperseded = "superseded"
	// DecisionStatusRetired no longer enforces.
	DecisionStatusRetired = "retired"
)

// Decision-memory enforcement levels.
const (
	// EnforcementWarn records the conflict in the advisory trail only.
	EnforcementWarn = "warn"
	// EnforcementEscalate escalates conflicting actions to a human.
	EnforcementEscalate = "escalate"
	// EnforcementWithhold refuses conflicting actions.
	EnforcementWithhold = "withhold"
)

const (
	pathCheck          = "/v1/actions/check"
	pathAgents         = "/v1/agents"
	pathAudit          = "/v1/audit"
	pathAuditVerify    = "/v1/audit/verify"
	pathAuditCSV       = "/v1/audit/export.csv"
	pathCompliance     = "/v1/reports/compliance"
	pathMetrics        = "/v1/metrics"
	pathDecisions      = "/v1/memory/decisions"
	pathDecisionSearch = "/v1/memory/decisions/search"
	pathDigest         = "/v1/memory/digest"
	pathMemoryHealth   = "/v1/memory/health"
	pathApprovals      = "/v1/approvals"

	contentTypeJSON = "application/json"
	bearerPrefix    = "Bearer "
)

// APIError is a non-2xx response from the runtime.
type APIError struct {
	// Status is the HTTP status code.
	Status int
	// Method of the failed request.
	Method string
	// Path of the failed request.
	Path string
	// Body is the raw response payload.
	Body string
}

// Error implements the error interface.
func (e *APIError) Error() string {
	return fmt.Sprintf("memnox: %s %s failed with status %d: %s", e.Method, e.Path, e.Status, e.Body)
}

// WithheldError is returned by Guard when the runtime withholds the action.
type WithheldError struct {
	// Decision carries the full verdict, including matched policies.
	Decision Decision
}

// Error implements the error interface.
func (e *WithheldError) Error() string {
	return fmt.Sprintf("action withheld by Memnox: %s", e.Decision.Reason)
}

// EscalationRequiredError is returned by Guard when a human must approve first.
type EscalationRequiredError struct {
	// Decision carries the full verdict, including the pending approval ID.
	Decision Decision
}

// Error implements the error interface.
func (e *EscalationRequiredError) Error() string {
	return fmt.Sprintf("action requires approval (%s): %s", e.Decision.ApprovalID, e.Decision.Reason)
}

// Options configures a Client.
type Options struct {
	// BaseURL of the runtime; DefaultBaseURL when empty.
	BaseURL string
	// Token is the agent credential used for action checks.
	Token string
	// AdminToken authorizes the management routes: agents, audit, memory, approvals.
	AdminToken string
	// Timeout bounds every request; DefaultTimeout when zero.
	Timeout time.Duration
	// HTTPClient replaces the default client, e.g. for proxies or mTLS.
	HTTPClient *http.Client
}

// Client talks to one Memnox runtime. It is safe for concurrent use.
type Client struct {
	baseURL    string
	token      string
	adminToken string
	httpClient *http.Client
}

// New builds a Client from opts, filling in the documented defaults.
func New(opts Options) *Client {
	baseURL := opts.BaseURL
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		timeout := opts.Timeout
		if timeout == 0 {
			timeout = DefaultTimeout
		}
		httpClient = &http.Client{Timeout: timeout}
	}
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		token:      opts.Token,
		adminToken: opts.AdminToken,
		httpClient: httpClient,
	}
}

// Check asks the runtime for a decision. It never returns an error on a withhold —
// inspect Decision.Effect.
func (c *Client) Check(ctx context.Context, request ActionRequest) (Decision, error) {
	return decode[Decision](c.request(ctx, http.MethodPost, pathCheck, request, c.token))
}

// Guard runs execute only if the runtime allows the action. A refusal comes back
// as *WithheldError or *EscalationRequiredError, both matchable with errors.As.
func (c *Client) Guard(ctx context.Context, request ActionRequest, execute func() error) error {
	decision, err := c.Check(ctx, request)
	if err != nil {
		return err
	}
	switch decision.Effect {
	case EffectWithhold:
		return &WithheldError{Decision: decision}
	case EffectEscalate:
		return &EscalationRequiredError{Decision: decision}
	default:
		return execute()
	}
}

func (c *Client) request(ctx context.Context, method, path string, body any, bearer string) ([]byte, error) {
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("memnox: encode %s %s: %w", method, path, err)
		}
		payload = bytes.NewReader(encoded)
	}
	httpRequest, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, payload)
	if err != nil {
		return nil, fmt.Errorf("memnox: build %s %s: %w", method, path, err)
	}
	httpRequest.Header.Set("content-type", contentTypeJSON)
	if bearer != "" {
		httpRequest.Header.Set("authorization", bearerPrefix+bearer)
	}

	response, err := c.httpClient.Do(httpRequest)
	if err != nil {
		return nil, fmt.Errorf("memnox: %s %s: %w", method, path, err)
	}
	defer func() { _ = response.Body.Close() }()

	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("memnox: read %s %s: %w", method, path, err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, &APIError{Status: response.StatusCode, Method: method, Path: path, Body: string(data)}
	}
	return data, nil
}

func (c *Client) requestText(ctx context.Context, path string) (string, error) {
	data, err := c.request(ctx, http.MethodGet, path, nil, c.adminToken)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func decode[T any](payload []byte, err error) (T, error) {
	var out T
	if err != nil {
		return out, err
	}
	if unmarshalErr := json.Unmarshal(payload, &out); unmarshalErr != nil {
		return out, fmt.Errorf("memnox: decode response: %w", unmarshalErr)
	}
	return out, nil
}

func setIfPresent(values url.Values, key, value string) {
	if value != "" {
		values.Set(key, value)
	}
}

func withQuery(path string, values url.Values) string {
	if len(values) == 0 {
		return path
	}
	return path + "?" + values.Encode()
}

func limitValues(limit int) url.Values {
	values := url.Values{}
	if limit > 0 {
		values.Set("limit", strconv.Itoa(limit))
	}
	return values
}
