import { DEFAULT_HOST, DEFAULT_PORT } from '@memnox/runtime';

export const CLI_VERSION = '0.1.0';
export const DEFAULT_BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
export const DEFAULT_POLICY_FILE = 'memnox.policies.yaml';
export const DEFAULT_CODE_GRAPH_FILE = '.memnox/code-graph.json';
export const DEFAULT_CLI_AUDIT_LIMIT = 20;

export const STARTER_POLICY_FILE = `version: 1
policies:
  - name: production-database-protection
    description: AI agents may never destroy production data.
    match:
      actions: ["database.delete", "database.drop", "database.truncate"]
      environments: ["production"]
    decision:
      effect: block
      reason: No AI-initiated destructive database operations in production.

  - name: production-deploy-approval
    description: Production deployments need a human sign-off.
    match:
      actions: ["deploy.*"]
      environments: ["production"]
    decision:
      effect: require_approval
      approvers: ["eng-lead"]

  - name: payment-code-approval
    description: Payment logic changes need security review.
    match:
      actions: ["code.modify", "code.delete"]
      targets: ["payment/*"]
    decision:
      effect: require_approval
      approvers: ["security-team"]

  - name: destructive-shell-protection
    description: Obviously destructive shell commands need a human at the keyboard.
    match:
      actions: ["shell.execute"]
      targets: ["*drop table*", "*drop database*", "*truncate table*", "*rm -rf /*"]
    decision:
      effect: block
      reason: Destructive shell commands are blocked for AI agents.
`;
