import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/**
 * A notice on the person's own screen, where the platform has one.
 *
 * Memnox lives where people work, and the desktop is where a person is when their
 * agent is busy in another window: an email about a collision is read an hour
 * later, a notice is read now. Best effort and never awaited: a desktop with no
 * notifications, or a server with no desktop, simply shows nothing.
 */

/** The longest notice shown; the rest is in the agent's session and the record. */
const MOST_CHARS = 240;

export function desktopNotice(message: string, title = 'Memnox'): void {
  const said = message.slice(0, MOST_CHARS);
  try {
    if (platform() === 'darwin') {
      execFile(
        'osascript',
        [
          '-e',
          `display notification ${JSON.stringify(said)} with title ${JSON.stringify(title)}`,
        ],
        () => undefined,
      );
      return;
    }
    if (platform() === 'linux') {
      execFile('notify-send', [title, said], () => undefined);
    }
  } catch {
    // No notifier on this machine: the session and the record still carry it.
  }
}
