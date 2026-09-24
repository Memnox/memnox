import { spawn } from 'node:child_process';

import { secondsToMs } from '@memnox/core';

/**
 * Opening the approval page, and saying whether it opened, because the caller shows the
 * code only on false: a laptop approves the link and a server over SSH gets the code.
 */

const OPENER_PATIENCE_MS = secondsToMs(4);

export async function openBrowser(url: string): Promise<boolean> {
  // Nobody is at the keyboard for a script, a CI job or a test, so those get the code.
  if (process.stdin.isTTY !== true) return false;

  const [opener, args] = openerFor(url);
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };
    try {
      const child = spawn(opener, args, { stdio: 'ignore', detached: true });
      child.on('error', () => done(false));
      child.on('exit', (code) => done(code === 0));
      // A handler that stays in the foreground launched, so stop waiting on it.
      const giveUp = setTimeout(() => {
        child.unref();
        done(true);
      }, OPENER_PATIENCE_MS);
      giveUp.unref();
    } catch {
      done(false);
    }
  });
}

function openerFor(url: string): [string, string[]] {
  if (process.platform === 'darwin') return ['open', [url]];
  // The empty string is the window title `start` would otherwise take the URL for.
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}
