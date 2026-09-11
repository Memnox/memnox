import { spawn } from 'node:child_process';

/**
 * Opening the approval page, and saying whether it opened.
 *
 * The answer is the point. The caller shows the eight-character code only when
 * this returns false, so somebody with a browser approves what the link already
 * carries rather than reading a code off one screen and typing it into another.
 * A server over SSH has no opener, gets false, and gets the code, which is the
 * case the device flow exists for.
 */
export async function openBrowser(url: string): Promise<boolean> {
  /* Nobody is at the keyboard when this runs from a script, a CI job or a test,
     and a window opened there lands on nobody's screen while the run reports it
     as done. Those get the code, which is what the device flow is for. */
  if (process.stdin.isTTY !== true) return false;

  const [opener, args] = command(url);
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
      /* A handler that stays in the foreground would otherwise hold the login
         here forever. It launched, so treat it as launched and stop waiting. */
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

const OPENER_PATIENCE_MS = 4000;

function command(url: string): [string, string[]] {
  if (process.platform === 'darwin') return ['open', [url]];
  // The empty string is the window title `start` would otherwise take the URL for.
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}
