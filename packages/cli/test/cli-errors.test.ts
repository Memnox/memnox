import { describe, expect, it } from 'vitest';
import { MemnoxApiError } from '@memnox/sdk';
import { explain } from '../src/cli-errors';

describe('what a person sees when the runtime refuses', () => {
  it('says what the runtime said, without the request that carried it', () => {
    const err = new MemnoxApiError(
      404,
      'GET /v1/agents/levels/readiness failed: {"error":"no such agent"}',
    );
    expect(explain(err)).toBe('no such agent');
  });

  it('keeps a plain-text answer as it is', () => {
    const err = new MemnoxApiError(500, 'POST /v1/actions/check failed: upstream down');
    expect(explain(err)).toBe('upstream down');
  });

  it('leaves an ordinary error alone', () => {
    expect(explain(new Error('policy file is not valid'))).toBe(
      'policy file is not valid',
    );
  });
});
