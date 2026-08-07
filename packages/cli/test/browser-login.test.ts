import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  loginThroughBrowser,
  pkcePair,
  statesMatch,
  timedOut,
  type BrowserOpener,
} from '../src/browser-login';

const CLOUD = 'https://cloud.acme.test';

/** Plays the control plane: reads the CLI's own callback URL out of the browse. */
function browserThat(
  respond: (params: URLSearchParams, redirectUri: string) => URLSearchParams,
): { open: BrowserOpener; opened: string[] } {
  const opened: string[] = [];
  const open: BrowserOpener = async (url) => {
    opened.push(url);
    const params = new URL(url).searchParams;
    const redirectUri = params.get('redirect_uri') ?? '';
    const back = respond(params, redirectUri);
    await fetch(`${redirectUri}?${back.toString()}`).catch(() => undefined);
  };
  return { open, opened };
}

const echoState = (params: URLSearchParams): URLSearchParams =>
  new URLSearchParams({ code: 'auth-code-1', state: params.get('state') ?? '' });

describe('pkcePair', () => {
  it('sends only the hash of the verifier', () => {
    const { verifier, challenge } = pkcePair();

    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(challenge).not.toBe(verifier);
  });

  it('is different every time', () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });
});

describe('statesMatch', () => {
  it('accepts the state it issued', () => {
    expect(statesMatch('abc123', 'abc123')).toBe(true);
  });

  it('rejects a different or absent state', () => {
    expect(statesMatch('abc123', 'abc124')).toBe(false);
    expect(statesMatch('abc123', null)).toBe(false);
    // Length mismatch must be a rejection, never a throw out of the callback.
    expect(statesMatch('abc123', 'abc')).toBe(false);
  });
});

describe('authorizeUrl', () => {
  it('asks for S256 and carries the callback the CLI is listening on', () => {
    const url = new URL(authorizeUrl(CLOUD, 'http://127.0.0.1:5000/callback', 's', 'c'));

    expect(url.pathname).toBe('/v1/auth/cli');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5000/callback');
  });
});

describe('loginThroughBrowser', () => {
  it('returns the code the control plane redirected back with', async () => {
    const { open, opened } = browserThat(echoState);

    const outcome = await loginThroughBrowser({ cloudUrl: CLOUD, open });

    expect(timedOut(outcome)).toBe(false);
    if (timedOut(outcome)) return;
    expect(outcome.code).toBe('auth-code-1');
    expect(opened[0]).toContain('/v1/auth/cli');
  });

  it('listens on loopback only, so nothing off the machine can answer', async () => {
    const { open, opened } = browserThat(echoState);

    await loginThroughBrowser({ cloudUrl: CLOUD, open });

    const redirect = new URL(opened[0] ?? '').searchParams.get('redirect_uri') ?? '';
    expect(new URL(redirect).hostname).toBe('127.0.0.1');
  });

  it('keeps the verifier local — only its challenge is sent', async () => {
    const { open, opened } = browserThat(echoState);

    const outcome = await loginThroughBrowser({ cloudUrl: CLOUD, open });

    if (timedOut(outcome)) throw new Error('expected a code');
    const sent = new URL(opened[0] ?? '').searchParams.get('code_challenge');
    expect(sent).not.toBe(outcome.verifier);
    expect(sent).toBe(createHash('sha256').update(outcome.verifier).digest('base64url'));
  });

  it('ignores a callback carrying somebody else’s state', async () => {
    // A local page could otherwise post a code of its own choosing to the port.
    const { open } = browserThat(
      () => new URLSearchParams({ code: 'planted', state: 'not-the-issued-state' }),
    );

    const outcome = await loginThroughBrowser({ cloudUrl: CLOUD, open, timeoutMs: 300 });

    expect(outcome).toBe('login_timed_out');
  });

  it('stops waiting when the control plane refuses', async () => {
    const { open } = browserThat(
      (params) =>
        new URLSearchParams({ error: 'access_denied', state: params.get('state') ?? '' }),
    );

    const outcome = await loginThroughBrowser({ cloudUrl: CLOUD, open, timeoutMs: 5000 });

    expect(timedOut(outcome)).toBe(true);
  });

  it('gives up rather than hanging a terminal forever', async () => {
    const silent: BrowserOpener = async () => undefined;

    const outcome = await loginThroughBrowser({
      cloudUrl: CLOUD,
      open: silent,
      timeoutMs: 200,
    });

    expect(outcome).toBe('login_timed_out');
  });
});
