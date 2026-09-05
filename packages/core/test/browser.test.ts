import { describe, expect, it } from 'vitest';
import {
  BrowserHosts,
  countLogins,
  describeBrowser,
  findBrowserAutomation,
  navigationHost,
} from '../src/discovery/browser';
import type { MachineReader } from '../src/discovery/ports';

const HOME = '/home/dev';
const PROJECT = '/srv/app';

function reader(present: string[]): MachineReader {
  return {
    exists: async (path) => present.includes(path),
    read: async () => null,
    list: async () => [],
    homeDir: () => HOME,
    userName: () => 'dev',
  };
}

describe('browser automation', () => {
  it('finds a driver from the package that proves it, never from a name', async () => {
    const found = await findBrowserAutomation(
      reader([`${PROJECT}/node_modules/playwright`]),
      [PROJECT],
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.driver).toBe('playwright');
    expect(found[0]?.detectedFrom).toContain('node_modules/playwright');
  });

  it('finds nothing on a machine that drives no browser', async () => {
    expect(await findBrowserAutomation(reader([]), [PROJECT])).toEqual([]);
  });

  it('separates a clean browser from one carrying your logins', async () => {
    const clean = await findBrowserAutomation(
      reader([`${PROJECT}/node_modules/puppeteer`]),
      [PROJECT],
    );
    expect(clean[0]?.persistentProfile).toBeUndefined();
    expect(describeBrowser(clean[0] as never)).toContain('no saved profile');

    const carrying = await findBrowserAutomation(
      reader([
        `${PROJECT}/node_modules/puppeteer`,
        `${HOME}/Library/Application Support/Google/Chrome/Default`,
      ]),
      [PROJECT],
    );
    expect(carrying[0]?.persistentProfile).toBeDefined();
    expect(describeBrowser(carrying[0] as never)).toContain('act on websites as you');
  });

  it('never claims to have opened the login store', async () => {
    const found = await findBrowserAutomation(
      reader([`${PROJECT}/node_modules/playwright`]),
      [PROJECT],
    );
    // Only a count is ever available, and only when the caller supplies a size.
    expect(found[0]?.savedLogins).toBeUndefined();
    expect(countLogins(20_000)).toBe(0);
    expect(countLogins(23_500)).toBe(10);
  });

  it('lists each driver once, however many packages prove it', async () => {
    const found = await findBrowserAutomation(
      reader([
        `${PROJECT}/node_modules/playwright`,
        `${PROJECT}/node_modules/@playwright/test`,
      ]),
      [PROJECT],
    );
    expect(found).toHaveLength(1);
  });
});

describe('which navigations are worth asking about', () => {
  it('ignores your own dev server', () => {
    expect(navigationHost('http://localhost:3000/admin')).toBeNull();
    expect(navigationHost('http://127.0.0.1:8080')).toBeNull();
  });

  it('names a real host', () => {
    expect(navigationHost('https://admin.acme.com/users')).toBe('admin.acme.com');
  });

  it('is null for something that is not a URL', () => {
    expect(navigationHost('about:blank')).toBeNull();
  });
});

describe('asking once per host per session', () => {
  it('does not ask twice about the same host', () => {
    const hosts = new BrowserHosts();
    expect(hosts.seen('ses_1', 'admin.acme.com')).toBe(false);
    hosts.remember('ses_1', 'admin.acme.com');
    expect(hosts.seen('ses_1', 'admin.acme.com')).toBe(true);
  });

  it('still asks about a different host, and in a different session', () => {
    const hosts = new BrowserHosts();
    hosts.remember('ses_1', 'a.example');
    expect(hosts.seen('ses_1', 'b.example')).toBe(false);
    expect(hosts.seen('ses_2', 'a.example')).toBe(false);
  });

  it('forgets when the session ends', () => {
    const hosts = new BrowserHosts();
    hosts.remember('ses_1', 'a.example');
    hosts.forget('ses_1');
    expect(hosts.seen('ses_1', 'a.example')).toBe(false);
  });
});
