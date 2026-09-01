import { DEFAULT_HOST, DEFAULT_PORT } from '@memnox/runtime';

export const CLI_VERSION = '0.5.2';
export const DEFAULT_BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
export const DEFAULT_POLICY_FILE = 'memnox.policies.yaml';
export const DEFAULT_CLI_AUDIT_LIMIT = 20;

export const STARTER_POLICY_FILE = `version: 1
policies:
  - name: production-database-protection
    description: AI agents may never destroy production data.
    match:
      actions: ["database.delete", "database.drop", "database.truncate"]
      environments: ["production"]
    decision:
      effect: withhold
      reason: No AI-initiated destructive database operations in production.

  - name: production-deploy-approval
    description: Production deployments need a human sign-off.
    match:
      actions: ["deploy.*"]
      environments: ["production"]
    decision:
      effect: escalate
      approvers: ["eng-lead"]

  - name: payment-code-approval
    description: Payment logic changes need security review.
    match:
      actions: ["code.modify", "code.delete"]
      targets: ["payment/*"]
    decision:
      effect: escalate
      approvers: ["security-team"]

  - name: destructive-shell-protection
    description: Obviously destructive shell commands need a human at the keyboard.
    match:
      actions: ["shell.execute"]
      targets: ["*drop table*", "*drop database*", "*truncate table*", "*rm -rf /*"]
    decision:
      effect: withhold
      reason: Destructive shell commands are withheld for AI agents.
`;
export const DEFAULT_CLOUD_URL = 'https://cloud.memnox.dev';
