import { describe, expect, it } from 'vitest';
import {
  describeNetwork,
  OUTBOUND_STATE,
  probeNetwork,
  proxyIsBypassedEntirely,
  SANDBOX_PATHS,
} from '../src/discovery/network';

const probe = (env: NodeJS.ProcessEnv, present: string[] = []) =>
  probeNetwork({ env, present });

describe('the network probe', () => {
  it('reports unknown rather than open when nothing says either way', () => {
    const result = probe({});
    expect(result.outbound).toBe(OUTBOUND_STATE.UNKNOWN);
    expect(describeNetwork(result)).toContain('nothing here proves it is open');
  });

  it('names the proxy variable without carrying its value, which can hold a password', () => {
    const result = probe({ HTTPS_PROXY: 'http://user:hunter2@proxy.internal:3128' });
    expect(result.outbound).toBe(OUTBOUND_STATE.RESTRICTED);
    expect(result.proxyVars).toEqual(['HTTPS_PROXY']);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('treats a container marker on disk as a restriction', () => {
    const result = probe({}, [SANDBOX_PATHS[0]]);
    expect(result.outbound).toBe(OUTBOUND_STATE.RESTRICTED);
    expect(result.sandbox).toContain('/.dockerenv');
  });

  it('collects the hosts a proxy already exempts, because that is the real hole', () => {
    const result = probe({ HTTP_PROXY: 'http://p:3128', NO_PROXY: 'localhost, .internal' });
    expect(result.noProxy).toEqual(['localhost', '.internal']);
  });

  it('says plainly when a proxy exempts everything, rather than calling it restricted', () => {
    const result = probe({ HTTP_PROXY: 'http://p:3128', NO_PROXY: '*' });
    expect(proxyIsBypassedEntirely(result)).toBe(true);
    expect(describeNetwork(result)).toContain('restricts nothing');
  });

  it('records what it read, so the probe is itself inspectable', () => {
    const result = probe({});
    expect(result.read).toContain('env:HTTPS_PROXY');
    expect(result.read).toContain('/.dockerenv');
  });

  it('never dials out — the probe is a pure function of what it was given', () => {
    // A second identical call must produce an identical answer, with no IO between.
    expect(probe({ ALL_PROXY: 'socks5://x' })).toEqual(probe({ ALL_PROXY: 'socks5://x' }));
  });
});
