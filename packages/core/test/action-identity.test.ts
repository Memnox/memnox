import { describe, expect, it } from 'vitest';
import { normalizeActionField, normalizeActionRequest } from '../src/index';

const ZERO_WIDTH = '​';
const RIGHT_TO_LEFT_OVERRIDE = '‮';

/** A character that survives here but means nothing to a reader is a bypass. */
describe('canonicalizing what policy is matched on', () => {
  it('strips the whitespace an executor would have trimmed anyway', () => {
    expect(normalizeActionField('database.delete ')).toBe('database.delete');
    expect(normalizeActionField(' database.delete')).toBe('database.delete');
    expect(normalizeActionField('database.delete\n')).toBe('database.delete');
    expect(normalizeActionField('database.delete\t')).toBe('database.delete');
  });

  it('strips what a reader cannot see at all', () => {
    expect(normalizeActionField(`database.delete${ZERO_WIDTH}`)).toBe('database.delete');
    expect(normalizeActionField(`data${ZERO_WIDTH}base.delete`)).toBe('database.delete');
    expect(normalizeActionField(`${RIGHT_TO_LEFT_OVERRIDE}database.delete`)).toBe(
      'database.delete',
    );
  });

  it('leaves a name that is already canonical alone', () => {
    expect(normalizeActionField('database.delete')).toBe('database.delete');
    expect(normalizeActionField('payment/checkout.ts')).toBe('payment/checkout.ts');
    // Interior spacing is part of the name, not padding around it.
    expect(normalizeActionField('deploy the service')).toBe('deploy the service');
  });

  it('canonicalizes every field a policy matches on', () => {
    const normalized = normalizeActionRequest({
      action: 'database.delete ',
      target: ' users',
      environment: 'production\n',
      branch: ' main ',
    });

    expect(normalized.action).toBe('database.delete');
    expect(normalized.target).toBe('users');
    expect(normalized.environment).toBe('production');
    expect(normalized.branch).toBe('main');
  });

  /** Rewriting `arguments` would rule on a string nobody will run. */
  it('leaves the payload it does not own untouched', () => {
    const normalized = normalizeActionRequest({
      action: 'shell.execute',
      arguments: { command: '  rm -rf /tmp/x  ' },
    });

    expect(normalized.arguments).toEqual({ command: '  rm -rf /tmp/x  ' });
  });

  it('keeps an absent field absent rather than inventing an empty one', () => {
    const normalized = normalizeActionRequest({ action: 'repository.read' });

    expect('target' in normalized).toBe(false);
    expect('environment' in normalized).toBe(false);
  });
});
