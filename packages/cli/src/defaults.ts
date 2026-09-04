import { DEFAULT_HOST, DEFAULT_PORT } from '@memnox/core';

/** Must equal this package's version; a test asserts it so a release cannot drift. */
export const CLI_VERSION = '0.6.1';
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
      effect: deny
      reason: No AI-initiated destructive database operations in production.
      alternative:
        action: database.query
        note: Read the rows first and hand a human the list to delete.

  - name: production-deploy-approval
    description: Production deployments need a human sign-off.
    match:
      actions: ["deploy.*"]
      environments: ["production"]
    decision:
      effect: ask
      approvers: ["eng-lead"]

  - name: payment-code-approval
    description: Payment logic changes need security review.
    match:
      actions: ["code.modify", "code.delete"]
      targets: ["payment/*"]
    decision:
      effect: ask
      approvers: ["security-team"]

  - name: destructive-shell-protection
    description: Obviously destructive shell commands need a human at the keyboard.
    match:
      actions: ["shell.execute"]
      targets: ["*drop table*", "*drop database*", "*truncate table*", "*rm -rf /*"]
    decision:
      effect: deny
      reason: Destructive shell commands are denied for AI agents.
      alternative:
        action: shell.execute
        note: Name the paths to remove and let a person run the delete.
`;
