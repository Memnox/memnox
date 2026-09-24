import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every command draws on the rail, and the next one added cannot forget.
 *
 * This is the wiring test the projection and provider lists get elsewhere: the
 * thing no other test covers is that a new command reaches for `context.flow`
 * at all, because one that prints with `out.line` still works, still passes its
 * own tests, and simply looks like a different product from the thirty beside
 * it.
 *
 * Read off the source rather than by running each command, since a command that
 * returns early on this machine would otherwise read as one that draws nothing.
 *
 * A command split into `commands/<name>/` is read together with that directory, so
 * moving a handler out of the registration file cannot move it out of this check.
 */

const COMMANDS = join(import.meta.dirname, '..', 'src', 'commands');

/**
 * The files that print something a caller pipes, and the line that does it.
 *
 * Asserted exactly rather than allowed generally, so a thirty-first command
 * cannot quietly join the list: a payload on stdout is a decision somebody
 * makes about that command, not a habit the next one inherits.
 */
const PAYLOADS: Readonly<Record<string, number>> = {
  // The machine id, so a script enrolling a fleet can read it back.
  'login.command.ts': 1,
  // One setting, so `memnox config get mode` is usable in a shell.
  'config.command.ts': 1,
  // The share card, meant to be pasted somewhere else whole.
  'scan.command.ts': 1,
  // jsonl and a signed bundle, both read by a tool rather than a person.
  'timeline.command.ts': 2,
  // Shell exports, a unit file block and a Dockerfile block.
  'env.command.ts': 3,
  // One JSON object per cycle, which is what `--json` means here.
  'watch.command.ts': 2,
  /* The daemon's own log, which writes for as long as the process lives: a
     rail that grew a step per connection would never reach its closing line. */
  'daemon.command.ts': 2,
  // The leases a crashed agent left, said after the rail has already closed.
  'run.command.ts': 1,
};

const sources = readdirSync(COMMANDS).filter((name) => name.endsWith('.command.ts'));

/** A command's own file plus the directory it delegates to, as one string. */
function sourceOf(name: string): string {
  const own = readFileSync(join(COMMANDS, name), 'utf8');
  const split = join(COMMANDS, name.replace('.command.ts', ''));
  if (!existsSync(split)) return own;
  const parts = readdirSync(split)
    .filter((each) => each.endsWith('.ts'))
    .map((each) => readFileSync(join(split, each), 'utf8'));
  return [own, ...parts].join('\n');
}

describe('one rail, and every command on it', () => {
  it('finds the commands to check', () => {
    expect(sources.length).toBeGreaterThan(25);
  });

  it.each(sources)('%s draws on the rail', (name) => {
    expect(sourceOf(name)).toContain('flow');
  });

  it.each(sources)('%s prints only the payload it declared', (name) => {
    const source = sourceOf(name);
    /* `json()` is the machine answer every command may give and the one case
       that deliberately bypasses the rail, so it is not a payload line. */
    const direct = source
      .split('\n')
      .filter((line) => /\bout\.(line|note)\(/.test(line)).length;

    expect(direct, `${name} writes past the rail`).toBe(PAYLOADS[name] ?? 0);
  });
});
