import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLlmProvider } from '../src/llm-provider-option';

const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'];

describe('buildLlmProvider', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const name of KEY_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of KEY_VARS) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('names the variable to set instead of letting the SDK fail mid-call', () => {
    // The provider SDK defers this to the first request, where it surfaces as
    // "Could not resolve authentication method" — naming neither var nor command.
    expect(() => buildLlmProvider('anthropic')).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('says the command is optional, so a missing key does not read as a broken runtime', () => {
    expect(() => buildLlmProvider('anthropic')).toThrow(/never decides anything/);
  });

  it('accepts an auth token in place of an api key', () => {
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'token-value';

    expect(() => buildLlmProvider('anthropic')).not.toThrow();
  });

  it('names the openai variable for the openai provider', () => {
    expect(() => buildLlmProvider('openai')).toThrow(/OPENAI_API_KEY/);
  });

  it('builds a provider once the key is present', () => {
    process.env['ANTHROPIC_API_KEY'] = 'key-value';

    expect(buildLlmProvider('anthropic').name).toBe('anthropic');
  });
});
