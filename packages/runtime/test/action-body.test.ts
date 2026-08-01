import { describe, expect, it } from 'vitest';
import { readActionRequest } from '../src/routes/action-body';

describe('readActionRequest', () => {
  it('keeps the fields a decision is made from', () => {
    const request = readActionRequest({
      action: 'file.write',
      target: 'payment/checkout.ts',
      environment: 'production',
      workingDirectory: '/srv/checkout',
      branch: 'main',
    });

    expect(request).toEqual({
      action: 'file.write',
      target: 'payment/checkout.ts',
      environment: 'production',
      workingDirectory: '/srv/checkout',
      branch: 'main',
    });
  });

  it('drops arguments — the raw payload has no business crossing the network', () => {
    const request = readActionRequest({
      action: 'mcp.run_shell',
      arguments: { command: 'rm -rf /srv' },
    });

    expect(request?.arguments).toBeUndefined();
  });

  it('accepts the local gate’s signals', () => {
    const request = readActionRequest({
      action: 'file.write',
      signals: ['shield:aws-access-key', 'policy:no-env-writes'],
    });

    expect(request?.signals).toEqual(['shield:aws-access-key', 'policy:no-env-writes']);
  });

  it('bounds signals so a caller cannot write the audit log by the megabyte', () => {
    const request = readActionRequest({
      action: 'file.write',
      signals: [...Array(100).keys()].map(() => 'x'.repeat(500)),
    });

    expect(request?.signals).toHaveLength(32);
    expect(request?.signals?.[0]).toHaveLength(120);
  });

  it('ignores signals that are not strings rather than rejecting the call', () => {
    const request = readActionRequest({
      action: 'file.write',
      signals: ['shield:aws-access-key', 42, null],
    });

    expect(request?.signals).toEqual(['shield:aws-access-key']);
  });

  it('rejects a body that is not an action request', () => {
    expect(readActionRequest(undefined)).toBeNull();
    expect(readActionRequest({})).toBeNull();
    expect(readActionRequest({ action: 7 })).toBeNull();
  });
});
