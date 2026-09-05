import type { MachineReader } from './ports';

/**
 * A browser driver with a persistent profile is the quietest credential on the machine:
 * no file called `credentials`, no token in an env var, and every site the person is
 * still logged into. An agent that can drive it is already inside every one of them.
 */

export interface BrowserFinding {
  /** playwright, puppeteer, or whatever drove it. */
  driver: string;
  /** What proved it — a package directory, never an inference from a name. */
  detectedFrom: string;
  /** A profile that survives between runs, which is what carries the logins. */
  persistentProfile?: string;
  /** How many origins the profile still holds a login for. A count, never the sites. */
  savedLogins?: number;
}

const DRIVERS: readonly { name: string; paths: readonly string[] }[] = [
  {
    name: 'playwright',
    paths: ['node_modules/playwright', 'node_modules/@playwright/test'],
  },
  { name: 'puppeteer', paths: ['node_modules/puppeteer', 'node_modules/puppeteer-core'] },
  { name: 'selenium', paths: ['node_modules/selenium-webdriver'] },
];

/** Where a persistent Chromium profile lives, per platform layout. */
const PROFILE_PATHS: readonly string[] = [
  'Library/Application Support/Google/Chrome/Default',
  'Library/Application Support/Chromium/Default',
  '.config/google-chrome/Default',
  '.config/chromium/Default',
  '.cache/ms-playwright',
];

/**
 * Counted from the profile's own metadata rather than read: the file holding logins is
 * an encrypted store, and opening it would be the one thing this product must not do.
 * What is available is how many origins it has entries for.
 */
export function countLogins(loginDataSize: number): number {
  /* Chromium's Login Data is SQLite. Every stored origin adds roughly this much, so
     the count is an estimate and is presented as one — a precise number here would be
     a claim about a file we deliberately did not parse. */
  const BYTES_PER_LOGIN = 350;
  const HEADER_BYTES = 20_000;
  return Math.max(0, Math.round((loginDataSize - HEADER_BYTES) / BYTES_PER_LOGIN));
}

export async function findBrowserAutomation(
  reader: MachineReader,
  projectDirs: readonly string[],
): Promise<BrowserFinding[]> {
  const found: BrowserFinding[] = [];
  const home = reader.homeDir();

  for (const dir of projectDirs) {
    for (const driver of DRIVERS) {
      for (const relative of driver.paths) {
        const path = `${dir}/${relative}`;
        if (!(await reader.exists(path))) continue;
        if (found.some((each) => each.driver === driver.name)) continue;
        found.push({ driver: driver.name, detectedFrom: path });
      }
    }
  }
  if (found.length === 0) return found;

  // A driver alone drives a clean browser. A driver plus a profile drives yours.
  for (const relative of PROFILE_PATHS) {
    const path = `${home}/${relative}`;
    if (!(await reader.exists(path))) continue;
    for (const finding of found) {
      if (finding.persistentProfile === undefined) finding.persistentProfile = path;
    }
    break;
  }
  return found;
}

export function describeBrowser(finding: BrowserFinding): string {
  if (finding.persistentProfile === undefined) {
    return `${finding.driver} can drive a browser, with no saved profile`;
  }
  const logins =
    finding.savedLogins === undefined
      ? ''
      : ` · about ${finding.savedLogins} saved logins`;
  return `${finding.driver} can act on websites as you (persistent profile)${logins}`;
}

/**
 * One ask per host per session. Asking on every navigation would train somebody to
 * hold the key down, which is worse than not asking.
 */
export class BrowserHosts {
  private readonly answered = new Map<string, Set<string>>();

  /** True when this session has already been asked about this host. */
  seen(sessionId: string, host: string): boolean {
    const hosts = this.answered.get(sessionId);
    if (hosts === undefined) return false;
    return hosts.has(host);
  }

  remember(sessionId: string, host: string): void {
    const hosts = this.answered.get(sessionId) ?? new Set<string>();
    hosts.add(host);
    this.answered.set(sessionId, hosts);
  }

  forget(sessionId: string): void {
    this.answered.delete(sessionId);
  }
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];

/** Null for a local target: driving your own dev server is not the thing worth asking about. */
export function navigationHost(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    // `about:blank` and `data:` parse cleanly and have no host, so there is nothing to rule on.
    if (host === '' || LOCAL_HOSTS.includes(host)) return null;
    return host;
  } catch {
    // Not a URL, so there is no host to rule on.
    return null;
  }
}
