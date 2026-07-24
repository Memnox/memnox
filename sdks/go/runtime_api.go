package memnox

import "context"

// Action verbs the Runtime API helpers check on the caller's behalf.
const (
	// ActionAccess is the verb CanAccess checks.
	ActionAccess = "resource.read"
	// ActionDeploy is the verb CanDeploy checks.
	ActionDeploy = "deploy.service"
	// ActionModify is the verb CanModify checks.
	ActionModify = "code.modify"
	// ActionDelete is the verb CanDelete checks.
	ActionDelete = "resource.delete"
)

// Verdict is a boolean answer plus the decision it came from.
type Verdict struct {
	// Allowed is true only when the runtime permitted the action outright.
	Allowed bool
	// Decision is the full verdict, including reason and matched policies.
	Decision Decision
}

// ShouldExecute answers whether one arbitrary action may run right now.
func (c *Client) ShouldExecute(ctx context.Context, request ActionRequest) (Verdict, error) {
	decision, err := c.Check(ctx, request)
	if err != nil {
		return Verdict{}, err
	}
	return Verdict{Allowed: decision.Allowed(), Decision: decision}, nil
}

// CanAccess answers whether the agent may read the given resource.
func (c *Client) CanAccess(ctx context.Context, resource, environment string) (Verdict, error) {
	return c.ShouldExecute(ctx, ActionRequest{Action: ActionAccess, Target: resource, Environment: environment})
}

// CanDeploy answers whether the agent may deploy the given service.
func (c *Client) CanDeploy(ctx context.Context, service, environment string) (Verdict, error) {
	return c.ShouldExecute(ctx, ActionRequest{Action: ActionDeploy, Target: service, Environment: environment})
}

// CanModify answers whether the agent may modify the given file or record.
func (c *Client) CanModify(ctx context.Context, target, environment string) (Verdict, error) {
	return c.ShouldExecute(ctx, ActionRequest{Action: ActionModify, Target: target, Environment: environment})
}

// CanDelete answers whether the agent may delete the given resource.
func (c *Client) CanDelete(ctx context.Context, target, environment string) (Verdict, error) {
	return c.ShouldExecute(ctx, ActionRequest{Action: ActionDelete, Target: target, Environment: environment})
}
