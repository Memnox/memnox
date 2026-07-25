package memnox

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// Assembled at runtime: literal credential-shaped strings are blocked in this repo.
var (
	agentToken = strings.Join([]string{"mnx_", "agent", "fixture"}, "")
	adminToken = strings.Join([]string{"mnx_", "admin", "fixture"}, "")
)

const (
	approvalID     = "apr-1"
	csvText        = "id,action,effect\nevt-1,repository.read,allow\n"
	metricsText    = "memnox_actions_total{effect=\"allow\"} 3\n"
	csvContentType = "text/csv"

	allowDecisionJSON = `{"eventId":"evt-allow","effect":"allow","riskLevel":"low",
		"reason":"no policy matched","matchedPolicies":[],"advisories":[]}`

	blockDecisionJSON = `{"eventId":"evt-block","effect":"block","riskLevel":"critical",
		"reason":"policy applied",
		"matchedPolicies":[{"name":"no-destruction","effect":"block","reason":"policy"}],
		"advisories":[{"source":"decision-memory","reason":"conflicts with a team decision",
			"signals":["decision-memory:decision:dec-1"],"escalateTo":"block","nonOverridable":true}]}`

	approvalDecisionJSON = `{"eventId":"evt-approval","effect":"require_approval","riskLevel":"high",
		"reason":"human approval required and pending","matchedPolicies":[],"advisories":[],
		"approvalId":"apr-1"}`

	agentJSON = `{"id":"agt-1","name":"claude-code","kind":"claude-code","status":"active",
		"trustScore":98,"stats":{"allowed":12,"blocked":1,"approvalsRequested":2},
		"capabilities":["repository.*"],"createdAt":"2026-01-01T00:00:00.000Z"}`

	auditEventJSON = `{"id":"evt-1","occurredAt":"2026-01-01T00:00:00.000Z","agentId":"agt-1",
		"agentName":"claude-code","action":"repository.read","target":"README.md",
		"environment":"staging","sessionId":"s1","effect":"allow","riskLevel":"low",
		"matchedPolicies":["read-only"],"advisories":[],"reason":"no policy matched",
		"prevHash":"0000","hash":"aaaa"}`

	verificationJSON = `{"valid":false,"checked":4,"brokenAtIndex":4,"brokenEventId":"evt-9",
		"brokenReason":"content-mismatch"}`

	complianceJSON = `{"generatedAt":"2026-02-01T00:00:00.000Z",
		"period":{"from":"2026-01-01","to":"2026-02-01"},
		"totals":{"actions":9,"allowed":6,"blocked":2,"approvalsRequired":1},
		"riskBreakdown":{"low":6,"critical":3},
		"topBlockedActions":[{"action":"database.delete","count":2}],
		"policyActivity":[{"policy":"no-destruction","count":2}],
		"agentActivity":[{"agent":"claude-code","actions":9,"blocked":2}],
		"advisorySignals":[{"signal":"decision-memory:decision:dec-1","count":1}]}`

	decisionRecordJSON = `{"id":"dec-1","title":"No schema migrations before Q4",
		"statement":"Hold all migrations until the Q4 freeze lifts.","owner":"platform-team",
		"decidedAt":"2026-01-01T00:00:00.000Z","actions":["database.migrate"],
		"targets":["production.*"],"environments":["production"],"enforcement":"block",
		"status":"active","reversibilityCost":"high","sourceType":"manual"}`

	decisionHealthJSON = `{"score":80,"activeDecisions":2,"stale":1,"frequentlyViolated":0,
		"neverReferenced":1,
		"entries":[{"id":"dec-1","title":"No schema migrations before Q4","violations":3,
			"stale":true,"neverReferenced":false,"dueForReview":true}]}`

	approvalJSON = `{"id":"apr-1","requestFingerprint":"fp-1","agentId":"agt-1",
		"action":"deploy.service","target":"checkout","environment":"production",
		"approvers":["security-team"],"status":"pending","createdAt":"2026-01-01T00:00:00.000Z",
		"expiresAt":"2026-01-08T00:00:00.000Z"}`
)

type recorded struct {
	method        string
	path          string
	query         url.Values
	authorization string
	contentType   string
	body          map[string]any
}

type fixture struct {
	server *httptest.Server
	client *Client
	mu     sync.Mutex
	last   recorded
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
			return
		}
		rec := recorded{
			method:        r.Method,
			path:          r.URL.Path,
			query:         r.URL.Query(),
			authorization: r.Header.Get("authorization"),
			contentType:   r.Header.Get("content-type"),
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &rec.body); err != nil {
				t.Errorf("decode request body: %v", err)
				return
			}
		}
		f.mu.Lock()
		f.last = rec
		f.mu.Unlock()

		expected := adminToken
		if rec.path == pathCheck {
			expected = agentToken
		}
		if rec.authorization != bearerPrefix+expected {
			reply(w, http.StatusUnauthorized, contentTypeJSON, `{"error":"unauthorized"}`)
			return
		}
		status, contentType, payload := route(rec)
		reply(w, status, contentType, payload)
	}))
	t.Cleanup(f.server.Close)
	f.client = New(Options{BaseURL: f.server.URL, Token: agentToken, AdminToken: adminToken})
	return f
}

func (f *fixture) recorded(t *testing.T) recorded {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.last.method == "" {
		t.Fatal("no request reached the fixture server")
	}
	return f.last
}

func reply(w http.ResponseWriter, status int, contentType, payload string) {
	w.Header().Set("content-type", contentType)
	w.WriteHeader(status)
	_, _ = io.WriteString(w, payload)
}

func route(rec recorded) (int, string, string) {
	switch rec.method + " " + rec.path {
	case http.MethodPost + " " + pathCheck:
		return http.StatusOK, contentTypeJSON, decisionFor(rec)
	case http.MethodPost + " " + pathAgents:
		return http.StatusCreated, contentTypeJSON, `{"agent":` + agentJSON + `,"token":"` + agentToken + `"}`
	case http.MethodGet + " " + pathAgents:
		return http.StatusOK, contentTypeJSON, "[" + agentJSON + "]"
	case http.MethodPost + " " + pathAgents + "/agt-1/status":
		return http.StatusOK, contentTypeJSON, strings.Replace(agentJSON, `"status":"active"`, `"status":"suspended"`, 1)
	case http.MethodGet + " " + pathAudit:
		return http.StatusOK, contentTypeJSON, "[" + auditEventJSON + "]"
	case http.MethodGet + " " + pathAuditVerify:
		return http.StatusOK, contentTypeJSON, verificationJSON
	case http.MethodGet + " " + pathAuditCSV:
		return http.StatusOK, csvContentType, csvText
	case http.MethodGet + " " + pathMetrics:
		return http.StatusOK, "text/plain", metricsText
	case http.MethodGet + " " + pathCompliance:
		return http.StatusOK, contentTypeJSON, complianceJSON
	case http.MethodPost + " " + pathDecisions:
		return http.StatusCreated, contentTypeJSON, decisionRecordJSON
	case http.MethodGet + " " + pathDecisions:
		return http.StatusOK, contentTypeJSON, "[" + decisionRecordJSON + "]"
	case http.MethodGet + " " + pathDecisionSearch:
		return http.StatusOK, contentTypeJSON, `[{"decision":` + decisionRecordJSON + `,"score":4}]`
	case http.MethodPost + " " + pathDecisions + "/dec-1/status":
		return http.StatusOK, contentTypeJSON, strings.Replace(decisionRecordJSON, `"status":"active"`, `"status":"retired"`, 1)
	case http.MethodDelete + " " + pathDecisions + "/dec-1":
		return http.StatusOK, contentTypeJSON, `{"removed":true}`
	case http.MethodGet + " " + pathDigest:
		return http.StatusOK, contentTypeJSON, `{"digest":"# Active constraints"}`
	case http.MethodGet + " " + pathMemoryHealth:
		return http.StatusOK, contentTypeJSON, decisionHealthJSON
	case http.MethodGet + " " + pathApprovals:
		return http.StatusOK, contentTypeJSON, "[" + approvalJSON + "]"
	case http.MethodPost + " " + pathApprovals + "/" + approvalID:
		return http.StatusOK, contentTypeJSON, resolvedApproval(rec)
	case http.MethodPost + " " + pathApprovals + "/" + approvalID + "/override":
		overridden := strings.Replace(approvalJSON, `"status":"pending"`, `"status":"approved","override":true`, 1)
		return http.StatusOK, contentTypeJSON, overridden
	default:
		return http.StatusNotFound, contentTypeJSON, `{"error":"not found"}`
	}
}

func decisionFor(rec recorded) string {
	action, _ := rec.body["action"].(string)
	switch action {
	case "database.delete", ActionDelete:
		return blockDecisionJSON
	case ActionDeploy:
		return approvalDecisionJSON
	default:
		return allowDecisionJSON
	}
}

func resolvedApproval(rec recorded) string {
	status := "denied"
	if approved, ok := rec.body["approved"].(bool); ok && approved {
		status = "approved"
	}
	return strings.Replace(approvalJSON, `"status":"pending"`, `"status":"`+status+`"`, 1)
}

func TestCheckSendsTheFullRequestAndParsesTheDecision(t *testing.T) {
	f := newFixture(t)
	decision, err := f.client.Check(context.Background(), ActionRequest{
		Action:      "repository.read",
		Target:      "README.md",
		Environment: "staging",
		SessionID:   "s1",
		Reason:      "reading docs",
		ApprovalID:  "apr-0",
		Metadata:    map[string]any{"pr": 42},
		Taint: &TaintAssessment{
			Tainted: true,
			Sources: []TaintSourceRef{{SourceType: "github_issue_comment", Reason: "third-party author"}},
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if decision.Effect != EffectAllow || decision.EventID != "evt-allow" || !decision.Allowed() {
		t.Fatalf("unexpected decision: %+v", decision)
	}
	rec := f.recorded(t)
	if rec.method != http.MethodPost || rec.path != pathCheck {
		t.Fatalf("unexpected route: %s %s", rec.method, rec.path)
	}
	if rec.authorization != bearerPrefix+agentToken {
		t.Fatalf("unexpected authorization: %q", rec.authorization)
	}
	if rec.contentType != contentTypeJSON {
		t.Fatalf("unexpected content type: %q", rec.contentType)
	}
	for key, want := range map[string]any{
		"action":      "repository.read",
		"target":      "README.md",
		"environment": "staging",
		"sessionId":   "s1",
		"reason":      "reading docs",
		"approvalId":  "apr-0",
	} {
		if rec.body[key] != want {
			t.Errorf("body[%q] = %v, want %v", key, rec.body[key], want)
		}
	}
	taint, ok := rec.body["taint"].(map[string]any)
	if !ok || taint["tainted"] != true {
		t.Fatalf("taint not forwarded: %v", rec.body["taint"])
	}
}

func TestCheckParsesMatchedPoliciesAndAdvisories(t *testing.T) {
	f := newFixture(t)
	decision, err := f.client.Check(context.Background(), ActionRequest{Action: "database.delete"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if decision.MatchedPolicies[0].Name != "no-destruction" {
		t.Fatalf("unexpected policies: %+v", decision.MatchedPolicies)
	}
	advisory := decision.Advisories[0]
	if advisory.Source != "decision-memory" || !advisory.NonOverridable || advisory.EscalateTo != EffectBlock {
		t.Fatalf("unexpected advisory: %+v", advisory)
	}
	if len(advisory.Signals) != 1 {
		t.Fatalf("unexpected signals: %v", advisory.Signals)
	}
}

func TestGuardRunsAllowedWork(t *testing.T) {
	f := newFixture(t)
	ran := false
	err := f.client.Guard(context.Background(), ActionRequest{Action: "repository.read"}, func() error {
		ran = true
		return nil
	})
	if err != nil || !ran {
		t.Fatalf("allowed work should run: err=%v ran=%v", err, ran)
	}
}

func TestGuardReturnsBlockedError(t *testing.T) {
	f := newFixture(t)
	err := f.client.Guard(context.Background(), ActionRequest{Action: "database.delete"}, func() error {
		t.Error("blocked work must not run")
		return nil
	})
	var blocked *BlockedError
	if !errors.As(err, &blocked) || blocked.Decision.Effect != EffectBlock {
		t.Fatalf("expected *BlockedError, got %v", err)
	}
}

func TestGuardReturnsApprovalRequiredError(t *testing.T) {
	f := newFixture(t)
	err := f.client.Guard(context.Background(), ActionRequest{Action: ActionDeploy}, func() error {
		t.Error("pending work must not run")
		return nil
	})
	var pending *ApprovalRequiredError
	if !errors.As(err, &pending) || pending.Decision.ApprovalID != approvalID {
		t.Fatalf("expected *ApprovalRequiredError, got %v", err)
	}
}

func TestBadTokenReturnsAPIError(t *testing.T) {
	f := newFixture(t)
	client := New(Options{BaseURL: f.server.URL, Token: "wrong"})
	_, err := client.Check(context.Background(), ActionRequest{Action: "repository.read"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("expected *APIError with 401, got %v", err)
	}
}

func TestShouldExecuteReturnsVerdict(t *testing.T) {
	f := newFixture(t)
	verdict, err := f.client.ShouldExecute(context.Background(), ActionRequest{Action: "repository.read"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !verdict.Allowed || verdict.Decision.EventID != "evt-allow" {
		t.Fatalf("unexpected verdict: %+v", verdict)
	}
}

func TestCanAccess(t *testing.T) {
	f := newFixture(t)
	verdict, err := f.client.CanAccess(context.Background(), "production.users", "production")
	if err != nil || !verdict.Allowed {
		t.Fatalf("expected an allowed verdict: err=%v verdict=%+v", err, verdict)
	}
	rec := f.recorded(t)
	if rec.body["action"] != ActionAccess || rec.body["target"] != "production.users" {
		t.Fatalf("unexpected request body: %v", rec.body)
	}
}

func TestCanDeployIsFalseWhenApprovalIsRequired(t *testing.T) {
	f := newFixture(t)
	verdict, err := f.client.CanDeploy(context.Background(), "checkout", "production")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if verdict.Allowed || verdict.Decision.Effect != EffectRequireApproval {
		t.Fatalf("unexpected verdict: %+v", verdict)
	}
	if f.recorded(t).body["action"] != ActionDeploy {
		t.Fatalf("unexpected action: %v", f.recorded(t).body["action"])
	}
}

func TestCanModify(t *testing.T) {
	f := newFixture(t)
	verdict, err := f.client.CanModify(context.Background(), "payment/checkout.ts", "")
	if err != nil || !verdict.Allowed {
		t.Fatalf("expected an allowed verdict: err=%v verdict=%+v", err, verdict)
	}
	rec := f.recorded(t)
	if rec.body["action"] != ActionModify {
		t.Fatalf("unexpected action: %v", rec.body["action"])
	}
	if _, present := rec.body["environment"]; present {
		t.Fatalf("empty environment must be omitted: %v", rec.body)
	}
}

func TestCanDeleteIsFalseWhenBlocked(t *testing.T) {
	f := newFixture(t)
	verdict, err := f.client.CanDelete(context.Background(), "production.users", "production")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if verdict.Allowed || verdict.Decision.Effect != EffectBlock {
		t.Fatalf("unexpected verdict: %+v", verdict)
	}
	if f.recorded(t).body["action"] != ActionDelete {
		t.Fatalf("unexpected action: %v", f.recorded(t).body["action"])
	}
}

func TestRegisterAgent(t *testing.T) {
	f := newFixture(t)
	registration, err := f.client.RegisterAgent(context.Background(), AgentRegistrationInput{
		Name:         "claude-code",
		Kind:         "claude-code",
		Capabilities: []string{"repository.*"},
		OrgID:        "acme",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if registration.Token != agentToken || registration.Agent.ID != "agt-1" {
		t.Fatalf("unexpected registration: %+v", registration)
	}
	rec := f.recorded(t)
	if rec.authorization != bearerPrefix+adminToken {
		t.Fatalf("management routes must use the admin token: %q", rec.authorization)
	}
	if rec.body["name"] != "claude-code" || rec.body["orgId"] != "acme" {
		t.Fatalf("unexpected body: %v", rec.body)
	}
}

func TestListAgents(t *testing.T) {
	f := newFixture(t)
	agents, err := f.client.ListAgents(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agents) != 1 || agents[0].TrustScore != 98 || agents[0].Stats.ApprovalsRequested != 2 {
		t.Fatalf("unexpected agents: %+v", agents)
	}
	if len(agents[0].Capabilities) != 1 {
		t.Fatalf("unexpected capabilities: %v", agents[0].Capabilities)
	}
}

func TestSetAgentStatus(t *testing.T) {
	f := newFixture(t)
	agent, err := f.client.SetAgentStatus(context.Background(), "agt-1", AgentStatusSuspended)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if agent.Status != AgentStatusSuspended {
		t.Fatalf("unexpected status: %q", agent.Status)
	}
	if f.recorded(t).body["status"] != AgentStatusSuspended {
		t.Fatalf("unexpected body: %v", f.recorded(t).body)
	}
}

func TestRecentAudit(t *testing.T) {
	f := newFixture(t)
	events, err := f.client.RecentAudit(context.Background(), 25)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 || events[0].ID != "evt-1" || events[0].MatchedPolicies[0] != "read-only" {
		t.Fatalf("unexpected events: %+v", events)
	}
	if f.recorded(t).query.Get("limit") != "25" {
		t.Fatalf("unexpected query: %v", f.recorded(t).query)
	}
}

func TestRecentAuditWithoutLimitSendsNoQuery(t *testing.T) {
	f := newFixture(t)
	if _, err := f.client.RecentAudit(context.Background(), 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(f.recorded(t).query) != 0 {
		t.Fatalf("expected no query parameters, got %v", f.recorded(t).query)
	}
}

func TestQueryAuditMapsEveryFilter(t *testing.T) {
	f := newFixture(t)
	_, err := f.client.QueryAudit(context.Background(), AuditQuery{
		SessionID: "s1",
		AgentID:   "agt-1",
		OrgID:     "acme",
		From:      "2026-01-01",
		To:        "2026-02-01",
		Limit:     10,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	query := f.recorded(t).query
	for key, want := range map[string]string{
		"session": "s1",
		"agent":   "agt-1",
		"org":     "acme",
		"from":    "2026-01-01",
		"to":      "2026-02-01",
		"limit":   "10",
	} {
		if query.Get(key) != want {
			t.Errorf("query[%q] = %q, want %q", key, query.Get(key), want)
		}
	}
}

func TestVerifyAudit(t *testing.T) {
	f := newFixture(t)
	verification, err := f.client.VerifyAudit(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if verification.Valid || verification.BrokenAtIndex != 4 || verification.BrokenReason != "content-mismatch" {
		t.Fatalf("unexpected verification: %+v", verification)
	}
}

func TestExportAuditCSV(t *testing.T) {
	f := newFixture(t)
	csv, err := f.client.ExportAuditCSV(context.Background(), ReportPeriod{From: "2026-01-01", To: "2026-02-01"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if csv != csvText {
		t.Fatalf("unexpected csv: %q", csv)
	}
	if f.recorded(t).query.Get("from") != "2026-01-01" {
		t.Fatalf("unexpected query: %v", f.recorded(t).query)
	}
}

func TestComplianceReport(t *testing.T) {
	f := newFixture(t)
	report, err := f.client.ComplianceReport(context.Background(), ReportPeriod{From: "2026-01-01"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if report.Totals.Actions != 9 || report.RiskBreakdown["critical"] != 3 {
		t.Fatalf("unexpected totals: %+v", report)
	}
	if report.TopBlockedActions[0].Action != "database.delete" ||
		report.PolicyActivity[0].Policy != "no-destruction" ||
		report.AgentActivity[0].Agent != "claude-code" ||
		report.AdvisorySignals[0].Count != 1 {
		t.Fatalf("unexpected breakdowns: %+v", report)
	}
	if report.Period.From != "2026-01-01" {
		t.Fatalf("unexpected period: %+v", report.Period)
	}
}

func TestMetrics(t *testing.T) {
	f := newFixture(t)
	metrics, err := f.client.Metrics(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if metrics != metricsText {
		t.Fatalf("unexpected metrics: %q", metrics)
	}
	if f.recorded(t).path != pathMetrics {
		t.Fatalf("unexpected path: %q", f.recorded(t).path)
	}
}

func TestAddDecision(t *testing.T) {
	f := newFixture(t)
	record, err := f.client.AddDecision(context.Background(), DecisionRecordInput{
		Title:             "No schema migrations before Q4",
		Statement:         "Hold all migrations until the Q4 freeze lifts.",
		Owner:             "platform-team",
		Actions:           []string{"database.migrate"},
		Targets:           []string{"production.*"},
		Environments:      []string{"production"},
		Enforcement:       EnforcementBlock,
		ReversibilityCost: "high",
		SourceType:        "manual",
		Supersedes:        "dec-0",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if record.ID != "dec-1" || record.Enforcement != EnforcementBlock {
		t.Fatalf("unexpected record: %+v", record)
	}
	rec := f.recorded(t)
	if rec.body["title"] != "No schema migrations before Q4" || rec.body["supersedes"] != "dec-0" {
		t.Fatalf("unexpected body: %v", rec.body)
	}
	if _, present := rec.body["reviewAfter"]; present {
		t.Fatalf("empty optional fields must be omitted: %v", rec.body)
	}
}

func TestListDecisions(t *testing.T) {
	f := newFixture(t)
	decisions, err := f.client.ListDecisions(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(decisions) != 1 || decisions[0].Targets[0] != "production.*" || decisions[0].ReversibilityCost != "high" {
		t.Fatalf("unexpected decisions: %+v", decisions)
	}
}

func TestSearchDecisions(t *testing.T) {
	f := newFixture(t)
	hits, err := f.client.SearchDecisions(context.Background(), "migration freeze")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(hits) != 1 || hits[0].Score != 4 || hits[0].Decision.ID != "dec-1" {
		t.Fatalf("unexpected hits: %+v", hits)
	}
	if f.recorded(t).query.Get("q") != "migration freeze" {
		t.Fatalf("unexpected query: %v", f.recorded(t).query)
	}
}

func TestSetDecisionStatus(t *testing.T) {
	f := newFixture(t)
	record, err := f.client.SetDecisionStatus(context.Background(), "dec-1", DecisionStatusRetired)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if record.Status != DecisionStatusRetired {
		t.Fatalf("unexpected status: %q", record.Status)
	}
	if f.recorded(t).body["status"] != DecisionStatusRetired {
		t.Fatalf("unexpected body: %v", f.recorded(t).body)
	}
}

func TestDecisionDigest(t *testing.T) {
	f := newFixture(t)
	digest, err := f.client.DecisionDigest(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if digest != "# Active constraints" {
		t.Fatalf("unexpected digest: %q", digest)
	}
}

func TestDecisionHealth(t *testing.T) {
	f := newFixture(t)
	health, err := f.client.DecisionHealth(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if health.Score != 80 || len(health.Entries) != 1 || health.Entries[0].Violations != 3 {
		t.Fatalf("unexpected health: %+v", health)
	}
	if !health.Entries[0].DueForReview {
		t.Fatalf("expected the entry to be due for review: %+v", health.Entries[0])
	}
}

func TestRemoveDecision(t *testing.T) {
	f := newFixture(t)
	if err := f.client.RemoveDecision(context.Background(), "dec-1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	rec := f.recorded(t)
	if rec.method != http.MethodDelete || rec.path != pathDecisions+"/dec-1" {
		t.Fatalf("unexpected route: %s %s", rec.method, rec.path)
	}
}

func TestPendingApprovals(t *testing.T) {
	f := newFixture(t)
	approvals, err := f.client.PendingApprovals(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(approvals) != 1 || approvals[0].ID != approvalID || approvals[0].Status != ApprovalStatusPending {
		t.Fatalf("unexpected approvals: %+v", approvals)
	}
	if approvals[0].Approvers[0] != "security-team" {
		t.Fatalf("unexpected approvers: %v", approvals[0].Approvers)
	}
}

func TestResolveApproval(t *testing.T) {
	f := newFixture(t)
	approval, err := f.client.ResolveApproval(context.Background(), approvalID, true, "alice")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.Status != ApprovalStatusApproved {
		t.Fatalf("unexpected status: %q", approval.Status)
	}
	rec := f.recorded(t)
	if rec.body["approved"] != true || rec.body["resolvedBy"] != "alice" {
		t.Fatalf("unexpected body: %v", rec.body)
	}
}

func TestOverrideApproval(t *testing.T) {
	f := newFixture(t)
	approval, err := f.client.OverrideApproval(context.Background(), approvalID, "incident 412")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !approval.Override || approval.Status != ApprovalStatusApproved {
		t.Fatalf("unexpected approval: %+v", approval)
	}
	rec := f.recorded(t)
	if rec.path != pathApprovals+"/"+approvalID+"/override" || rec.body["reason"] != "incident 412" {
		t.Fatalf("unexpected request: %s %v", rec.path, rec.body)
	}
}
