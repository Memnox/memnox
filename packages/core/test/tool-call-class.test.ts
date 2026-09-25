import { describe, expect, it } from 'vitest';
import { effectOfName } from '../src/discovery/surface';
import { classifyToolCall, environmentOfArguments } from '../src/intercept/tool-call';

describe('an MCP tool named for what it does', () => {
  it.each([
    ['rerun_workflow_run', 'write'],
    ['cancel_workflow_run', 'write'],
    ['redeploy', 'write'],
    ['deployment_redeploy', 'write'],
    ['cancel_subscription', 'write'],
    ['create_refund', 'write'],
    ['refund_payment', 'write'],
    ['approve_pull_request', 'write'],
    ['merge_pull_request', 'write'],
    ['github_merge_pull_request', 'write'],
    ['terminate_instance', 'destructive'],
    ['get_workflow_run', 'read'],
    ['list_workflow_runs', 'read'],
    ['list_deploy_keys', 'read'],
    ['get_merge_status', 'read'],
    ['retrieve_payment_intent', 'read'],
    ['get_or_create_customer', 'write'],
  ])('%s is %s', (name, expected) => {
    expect(effectOfName(name)).toBe(expected);
  });
});

describe('an MCP call read by the statement it was handed', () => {
  it('overrules a read-looking name when the statement changes something', () => {
    expect(classifyToolCall('query', { sql: 'DROP TABLE users' }).class).toBe(
      'destructive',
    );
    expect(classifyToolCall('execute_sql', { query: 'DELETE FROM users' }).class).toBe(
      'destructive',
    );
    expect(classifyToolCall('execute_sql', { query: 'SELECT 1' }).class).toBe('read');
  });

  it('keeps a read-looking name unknown when the statement is not recognised', () => {
    expect(classifyToolCall('run_query', { sql: 'VALUES FROBNICATE' }).class).not.toBe(
      'destructive',
    );
    expect(classifyToolCall('query', { sql: 'EXEC sp_who' }).class).toBe('write');
  });

  it('leaves a search box alone, whatever words its query holds', () => {
    expect(classifyToolCall('search_issues', { query: 'update the docs' }).class).toBe(
      'read',
    );
  });

  it('reads a list of statements as one', () => {
    expect(
      classifyToolCall('pg_execute', { statements: ['SELECT 1', 'TRUNCATE users'] })
        .class,
    ).toBe('destructive');
  });
});

describe('the environment an MCP call names', () => {
  it('is read from the call’s own arguments, as it was named', () => {
    expect(environmentOfArguments({ environment: 'production', service: 'api' })).toBe(
      'production',
    );
    expect(environmentOfArguments({ environmentName: 'staging' })).toBe('staging');
    expect(environmentOfArguments({ service: 'api' })).toBeUndefined();
  });
});
