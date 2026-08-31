package memnox

// ActionRequest is one AI action submitted for a decision.
type ActionRequest struct {
	// Action is a namespaced verb, e.g. "database.delete" or "code.modify".
	Action string `json:"action"`
	// Target is what the action operates on, e.g. "production.users".
	Target string `json:"target,omitempty"`
	// Environment scopes the action, e.g. "production".
	Environment string `json:"environment,omitempty"`
	// SessionID groups actions into one agent session for replay and reporting.
	SessionID string `json:"sessionId,omitempty"`
	// Reason is the agent's stated intent, recorded verbatim in the audit trail.
	Reason string `json:"reason,omitempty"`
	// ApprovalID references a previously granted approval for this same action.
	ApprovalID string `json:"approvalId,omitempty"`
	// Taint reports untrusted sources that influenced the agent's context.
	Taint *TaintAssessment `json:"taint,omitempty"`
	// Metadata carries caller-defined context onto the audit event.
	Metadata map[string]any `json:"metadata,omitempty"`
}

// TaintSourceRef identifies one untrusted source that influenced the agent.
type TaintSourceRef struct {
	// SourceType names the origin, e.g. "github_issue_comment".
	SourceType string `json:"sourceType"`
	// Reference is a permalink or ID of the untrusted content.
	Reference string `json:"reference,omitempty"`
	// Reason explains why the source is untrusted.
	Reason string `json:"reason"`
}

// TaintAssessment reports whether untrusted content reached the agent's context.
type TaintAssessment struct {
	// Tainted is true once any untrusted source contributed to the context.
	Tainted bool `json:"tainted"`
	// Sources lists the untrusted contributions behind Tainted.
	Sources []TaintSourceRef `json:"sources"`
}

// MatchedPolicy is a policy that matched the checked action.
type MatchedPolicy struct {
	// Name of the policy as written in the YAML file.
	Name string `json:"name"`
	// Effect the policy asks for: allow, withhold, or escalate.
	Effect string `json:"effect"`
	// Reason is the policy's human-readable justification.
	Reason string `json:"reason,omitempty"`
	// Approvers named by the policy for escalate effects.
	Approvers []string `json:"approvers,omitempty"`
}

// Advisory is a deterministic escalation or signal contributed by an advisor.
type Advisory struct {
	// Source names the advisor that produced this advisory.
	Source string `json:"source"`
	// EscalateTo tightens the decision; empty means signal-only.
	EscalateTo string `json:"escalateTo,omitempty"`
	// Reason explains the escalation in the team's own words.
	Reason string `json:"reason"`
	// Approvers requested by the advisory, if any.
	Approvers []string `json:"approvers,omitempty"`
	// NonOverridable marks a withhold that no approval can lift.
	NonOverridable bool `json:"nonOverridable,omitempty"`
	// Signals are stable identifiers recorded on the audit event.
	Signals []string `json:"signals"`
}

// Decision is the runtime's verdict for one action request.
type Decision struct {
	// EventID is the audit event appended for this check.
	EventID string `json:"eventId"`
	// Effect is allow, withhold, or escalate.
	Effect string `json:"effect"`
	// RiskLevel is the deterministic classification: low to critical.
	RiskLevel string `json:"riskLevel"`
	// Reason explains the verdict.
	Reason string `json:"reason"`
	// MatchedPolicies lists every policy that matched.
	MatchedPolicies []MatchedPolicy `json:"matchedPolicies"`
	// Advisories lists escalations and signals from advisors.
	Advisories []Advisory `json:"advisories"`
	// ApprovalID is set when Effect is escalate.
	ApprovalID string `json:"approvalId,omitempty"`
}

// Allowed reports whether the runtime permitted the action outright.
func (d Decision) Allowed() bool {
	return d.Effect == EffectAllow
}

// ActionEvent is one append-only audit record.
type ActionEvent struct {
	// ID of the audit event.
	ID string `json:"id"`
	// OccurredAt is the RFC 3339 timestamp of the decision.
	OccurredAt string `json:"occurredAt"`
	// AgentID of the acting agent.
	AgentID string `json:"agentId"`
	// AgentName of the acting agent.
	AgentName string `json:"agentName"`
	// Action that was checked.
	Action string `json:"action"`
	// Target the action operated on.
	Target string `json:"target,omitempty"`
	// Environment the action ran against.
	Environment string `json:"environment,omitempty"`
	// SessionID grouping this event with the rest of the session.
	SessionID string `json:"sessionId,omitempty"`
	// Taint recorded with the request.
	Taint *TaintAssessment `json:"taint,omitempty"`
	// Effect the runtime applied.
	Effect string `json:"effect"`
	// RiskLevel classified for the action.
	RiskLevel string `json:"riskLevel"`
	// MatchedPolicies names the policies that matched.
	MatchedPolicies []string `json:"matchedPolicies"`
	// Advisories names the advisors that escalated or flagged this action.
	Advisories []string `json:"advisories"`
	// Reason explains the verdict.
	Reason string `json:"reason"`
	// OrgID is the owning org/workspace; empty in single-tenant deployments.
	OrgID string `json:"orgId,omitempty"`
	// PrevHash links this event to the previous one.
	PrevHash string `json:"prevHash,omitempty"`
	// Hash is this event's tamper-evidence digest.
	Hash string `json:"hash,omitempty"`
}

// AuditQuery filters the audit timeline. Zero-valued fields are omitted.
type AuditQuery struct {
	// SessionID restricts results to one agent session.
	SessionID string
	// AgentID restricts results to one agent.
	AgentID string
	// OrgID restricts results to one org/workspace.
	OrgID string
	// From is an inclusive RFC 3339 lower bound.
	From string
	// To is an inclusive RFC 3339 upper bound.
	To string
	// Limit caps the number of events returned; zero uses the server default.
	Limit int
}

// ReportPeriod bounds a compliance report or CSV export.
type ReportPeriod struct {
	// From is an inclusive RFC 3339 lower bound.
	From string
	// To is an inclusive RFC 3339 upper bound.
	To string
}

// AuditChainVerification is the result of walking the audit hash chain.
type AuditChainVerification struct {
	// Valid is true when every inspected link held.
	Valid bool `json:"valid"`
	// Checked counts the events inspected before the verdict.
	Checked int `json:"checked"`
	// BrokenAtIndex is the position of the first broken link, or -1.
	BrokenAtIndex int `json:"brokenAtIndex"`
	// BrokenEventID identifies the first broken event.
	BrokenEventID string `json:"brokenEventId,omitempty"`
	// BrokenReason is missing-hash, prev-hash-mismatch, or content-mismatch.
	BrokenReason string `json:"brokenReason,omitempty"`
}

// AgentStats are the lifetime counters recorded against an agent.
type AgentStats struct {
	// Allowed counts actions the runtime permitted.
	Allowed int `json:"allowed"`
	// Withheld counts actions the runtime refused.
	Withheld int `json:"withheld"`
	// ApprovalsRequested counts actions that needed a human.
	ApprovalsRequested int `json:"approvalsRequested"`
}

// AgentSummary is a registered agent as returned by the management routes.
type AgentSummary struct {
	// ID of the agent.
	ID string `json:"id"`
	// Name of the agent.
	Name string `json:"name"`
	// Kind of agent, e.g. "claude-code" or "mcp".
	Kind string `json:"kind"`
	// Status is active or suspended.
	Status string `json:"status"`
	// AutonomyLevel is the named level a person granted, when one has been granted.
	AutonomyLevel *int `json:"autonomyLevel,omitempty"`
	// Stats are the lifetime counters, which grant nothing on their own.
	Stats AgentStats `json:"stats"`
	// Capabilities are the action patterns this agent may attempt.
	Capabilities []string `json:"capabilities,omitempty"`
	// CreatedAt is the RFC 3339 registration timestamp.
	CreatedAt string `json:"createdAt,omitempty"`
	// OrgID is the owning org/workspace.
	OrgID string `json:"orgId,omitempty"`
}

// AgentRegistrationInput describes an agent to register.
type AgentRegistrationInput struct {
	// Name of the agent; required.
	Name string `json:"name"`
	// Kind of agent; defaults to "custom" server-side when unknown.
	Kind string `json:"kind,omitempty"`
	// Capabilities are wildcard action patterns this agent may attempt.
	Capabilities []string `json:"capabilities,omitempty"`
	// OrgID scopes the agent to one org/workspace.
	OrgID string `json:"orgId,omitempty"`
}

// AgentRegistration is a freshly registered agent and its token.
type AgentRegistration struct {
	// Agent as stored by the runtime.
	Agent AgentSummary `json:"agent"`
	// Token is the agent credential — shown once, never retrievable again.
	Token string `json:"token"`
}

// Approval is a human approval bound to one exact action fingerprint.
type Approval struct {
	// ID of the approval.
	ID string `json:"id"`
	// RequestFingerprint binds the approval to one agent, action, target, environment.
	RequestFingerprint string `json:"requestFingerprint"`
	// AgentID that requested the approval.
	AgentID string `json:"agentId"`
	// Action awaiting approval.
	Action string `json:"action"`
	// Target the action operates on.
	Target string `json:"target,omitempty"`
	// Environment the action runs against.
	Environment string `json:"environment,omitempty"`
	// Approvers named by the matching policy.
	Approvers []string `json:"approvers"`
	// Status is pending, approved, denied, or expired.
	Status string `json:"status"`
	// CreatedAt is the RFC 3339 request timestamp.
	CreatedAt string `json:"createdAt"`
	// ExpiresAt is when a pending approval lapses.
	ExpiresAt string `json:"expiresAt,omitempty"`
	// ResolvedAt is when a human answered.
	ResolvedAt string `json:"resolvedAt,omitempty"`
	// ResolvedBy names the human who answered.
	ResolvedBy string `json:"resolvedBy,omitempty"`
	// Override is true when an admin break-glassed this approval.
	Override bool `json:"override,omitempty"`
	// OrgID is the owning org/workspace.
	OrgID string `json:"orgId,omitempty"`
}

// DecisionRecordInput describes a team decision to record.
type DecisionRecordInput struct {
	// Title of the decision; required.
	Title string `json:"title"`
	// Statement is the decision in the team's own words; required.
	Statement string `json:"statement"`
	// Owner accountable for the decision; required.
	Owner string `json:"owner"`
	// Actions are wildcard patterns the decision constrains; required.
	Actions []string `json:"actions"`
	// Targets narrow the constraint to matching targets.
	Targets []string `json:"targets,omitempty"`
	// Environments narrow the constraint to matching environments.
	Environments []string `json:"environments,omitempty"`
	// Enforcement is warn, escalate, or withhold.
	Enforcement string `json:"enforcement,omitempty"`
	// ReversibilityCost is low, medium, or high.
	ReversibilityCost string `json:"reversibilityCost,omitempty"`
	// SourceType records where the decision came from.
	SourceType string `json:"sourceType,omitempty"`
	// SourceRef is a permalink to the evidence.
	SourceRef string `json:"sourceRef,omitempty"`
	// ReviewAfter flags the decision as due for review after this date.
	ReviewAfter string `json:"reviewAfter,omitempty"`
	// Supersedes is the ID of an existing decision this one replaces.
	Supersedes string `json:"supersedes,omitempty"`
}

// DecisionRecord is a team decision stored as a machine-checkable constraint.
type DecisionRecord struct {
	// ID of the decision.
	ID string `json:"id"`
	// Title of the decision.
	Title string `json:"title"`
	// Statement shown when the constraint fires.
	Statement string `json:"statement"`
	// Owner accountable for the decision.
	Owner string `json:"owner"`
	// DecidedAt is the RFC 3339 timestamp the decision was recorded.
	DecidedAt string `json:"decidedAt"`
	// Actions constrained by the decision.
	Actions []string `json:"actions"`
	// Targets the constraint applies to.
	Targets []string `json:"targets,omitempty"`
	// Environments the constraint applies to.
	Environments []string `json:"environments,omitempty"`
	// Enforcement is warn, escalate, or withhold.
	Enforcement string `json:"enforcement"`
	// Status is active, superseded, or retired.
	Status string `json:"status,omitempty"`
	// SupersededByID names the newer decision that replaced this one.
	SupersededByID string `json:"supersededById,omitempty"`
	// ReversibilityCost is how expensive the decided course is to reverse.
	ReversibilityCost string `json:"reversibilityCost,omitempty"`
	// SourceType records where the decision came from.
	SourceType string `json:"sourceType,omitempty"`
	// SourceRef is a permalink to the evidence.
	SourceRef string `json:"sourceRef,omitempty"`
	// ReviewAfter is when the decision becomes due for review.
	ReviewAfter string `json:"reviewAfter,omitempty"`
	// OrgID is the owning org/workspace.
	OrgID string `json:"orgId,omitempty"`
}

// DecisionSearchHit is one decision matched by keyword search.
type DecisionSearchHit struct {
	// Decision that matched.
	Decision DecisionRecord `json:"decision"`
	// Score is the deterministic relevance weight; higher is better.
	Score int `json:"score"`
}

// DecisionHealthEntry carries the health signals of one active decision.
type DecisionHealthEntry struct {
	// ID of the decision.
	ID string `json:"id"`
	// Title of the decision.
	Title string `json:"title"`
	// Violations counts how often the decision fired against an action.
	Violations int `json:"violations"`
	// Stale marks a decision aged past the review window.
	Stale bool `json:"stale"`
	// NeverReferenced marks a decision nothing has ever cited or broken.
	NeverReferenced bool `json:"neverReferenced"`
	// DueForReview marks a decision past its ReviewAfter date.
	DueForReview bool `json:"dueForReview"`
}

// DecisionHealthReport scores the quality of the decision corpus.
type DecisionHealthReport struct {
	// Score is 0-100; stale, violated, and unreferenced decisions cost points.
	Score int `json:"score"`
	// ActiveDecisions counts decisions currently enforcing.
	ActiveDecisions int `json:"activeDecisions"`
	// Stale counts decisions aged past the review window.
	Stale int `json:"stale"`
	// FrequentlyViolated counts decisions repeatedly fired against.
	FrequentlyViolated int `json:"frequentlyViolated"`
	// NeverReferenced counts decisions nothing has ever cited.
	NeverReferenced int `json:"neverReferenced"`
	// Entries carries the per-decision detail.
	Entries []DecisionHealthEntry `json:"entries"`
}

// ComplianceTotals are the headline counters for a reporting period.
type ComplianceTotals struct {
	// Actions checked in the period.
	Actions int `json:"actions"`
	// Allowed actions in the period.
	Allowed int `json:"allowed"`
	// Withheld actions in the period.
	Withheld int `json:"withheld"`
	// ApprovalsRequired actions in the period.
	ApprovalsRequired int `json:"approvalsRequired"`
}

// ActionCount is how often one action was withheld in the period.
type ActionCount struct {
	// Action name.
	Action string `json:"action"`
	// Count of occurrences.
	Count int `json:"count"`
}

// PolicyCount is how often one policy matched in the period.
type PolicyCount struct {
	// Policy name.
	Policy string `json:"policy"`
	// Count of matches.
	Count int `json:"count"`
}

// AgentActivity is one agent's action volume in the period.
type AgentActivity struct {
	// Agent name.
	Agent string `json:"agent"`
	// Actions checked by this agent.
	Actions int `json:"actions"`
	// Withheld actions for this agent.
	Withheld int `json:"withheld"`
}

// SignalCount is how often one advisory signal fired in the period.
type SignalCount struct {
	// Signal identifier.
	Signal string `json:"signal"`
	// Count of occurrences.
	Count int `json:"count"`
}

// ComplianceReport is governance evidence aggregated from the audit log.
type ComplianceReport struct {
	// GeneratedAt is the RFC 3339 timestamp the report was built.
	GeneratedAt string `json:"generatedAt"`
	// Period the report covers.
	Period struct {
		// From is the inclusive lower bound.
		From string `json:"from,omitempty"`
		// To is the inclusive upper bound.
		To string `json:"to,omitempty"`
	} `json:"period"`
	// Totals are the headline counters.
	Totals ComplianceTotals `json:"totals"`
	// RiskBreakdown counts actions by risk level.
	RiskBreakdown map[string]int `json:"riskBreakdown"`
	// TopWithheldActions ranks the most-withheld actions.
	TopWithheldActions []ActionCount `json:"topWithheldActions"`
	// PolicyActivity ranks the busiest policies.
	PolicyActivity []PolicyCount `json:"policyActivity"`
	// AgentActivity ranks the busiest agents.
	AgentActivity []AgentActivity `json:"agentActivity"`
	// AdvisorySignals ranks the most frequent advisory signals.
	AdvisorySignals []SignalCount `json:"advisorySignals"`
}
