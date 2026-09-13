import { delimiter } from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import { SESSION_VAR } from '@memnox/core';
import { interceptorDirFor, REAL_SHELL_VAR } from '@memnox/interceptors';
import type { CliContext } from '../cli-context';

/**
 * The environment a service manager has to set for itself.
 *
 * `memnox run` puts the seams in front of an agent it starts. Nothing starts an agent
 * running under systemd, in a container, or from a cron line — those inherit their
 * environment from a unit file or an image, and neither reads a shell profile. So the
 * PATH line `memnox protect --path` writes reaches a terminal and never reaches the
 * VPS the agent is actually on, which is the deployment this is most useful for.
 *
 * Printing it is the honest fix. Nothing here edits a unit file: a tool that rewrote
 * somebody's systemd configuration would be a tool people do not install on a server.
 */

const FORMATS = ['sh', 'systemd', 'docker'] as const;
type Format = (typeof FORMATS)[number];

export function registerEnvCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  program
    .command('env')
    .description('The environment an agent needs when something else starts it')
    .option('--format <format>', `one of: ${FORMATS.join(', ')}`, 'sh')
    .option('--shell <path>', 'shell the agent should use', 'memnox-shell')
    .option('--session <id>', 'group this run in the timeline under one session')
    .action(async (options: { format: string; shell: string; session?: string }) => {
      if (!FORMATS.includes(options.format as Format)) {
        throw new Error(`--format takes one of: ${FORMATS.join(', ')}`);
      }
      /* The lines themselves are the answer and go to stdout, because this is
         the one command whose output is meant to be pasted into a unit file or
         run through `eval`. So the rail moves out of the way rather than being
         dropped: what to do with the lines is worth saying, and it must not
         end up inside what somebody sources. */
      context.flow.commentary();
      context.flow.open('memnox env');

      const directory = interceptorDirFor(home());
      const pairs: [string, string][] = [
        ['PATH', `${directory}${delimiter}$PATH`],
        ['SHELL', options.shell],
        [REAL_SHELL_VAR, process.env['SHELL'] ?? '/bin/sh'],
      ];
      if (options.session !== undefined) {
        pairs.push([SESSION_VAR, options.session]);
      }

      render(context, options.format as Format, pairs);
    });
}

function render(
  context: CliContext,
  format: Format,
  pairs: readonly [string, string][],
): void {
  const { out, flow } = context;

  if (format === 'systemd') {
    flow.step('For a systemd unit', `${pairs.length} variables, below`);
    /* PATH is expanded by hand: systemd does not run a shell, so `$PATH` in a unit
       file is the literal four characters and the interceptors would be the whole
       path — which is an agent that can run nothing at all. */
    for (const [key, value] of pairs) {
      out.line(`Environment="${key}=${expand(key, value)}"`);
    }
    flow.close('Put these in the [Service] section.');
    flow.hint('Then: systemctl daemon-reload');
    flow.hint('The interceptors must be readable by the user the unit runs as.');
    /* The expansion is this shell's PATH. Generated on a laptop and pasted onto a
       server, it names binaries that are not there — so say where to run it. */
    flow.hint(
      "Run this on the machine and as the user the agent runs as; PATH is this shell's.",
    );
    return;
  }

  if (format === 'docker') {
    flow.step('For a Dockerfile', `${pairs.length} variables, below`);
    for (const [key, value] of pairs) out.line(`ENV ${key}=${expand(key, value)}`);
    // The directory lives in the home the interceptors were installed into.
    flow.close('Add these to the image.');
    flow.hint('It also needs ~/.memnox: mount it, or install inside the image.');
    flow.hint(
      "PATH here is this shell's; check it names binaries the image actually has.",
    );
    return;
  }

  flow.step('For a shell', `${pairs.length} variables, below`);
  for (const [key, value] of pairs) out.line(`export ${key}="${value}"`);
  flow.close('Source this before starting the agent.');
  flow.hint('Or use "memnox run", which sets all of it for one command.');
}

/** `$PATH` means nothing outside a shell, so it is resolved before it is printed. */
function expand(key: string, value: string): string {
  if (key !== 'PATH') return value;
  return value.replace('$PATH', process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin');
}
