import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  DEFAULT_LEASE_MINUTES,
  LEASE_OUTCOME,
  LeaseRegistry,
  holderPid,
  describeLease,
  SESSION_VAR,
  normalizeLeasePath,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { minutesFrom } from '../duration';
import { NodeGit } from '../node-git';

/**
 * Who holds what, from a third terminal.
 *
 * This is the first thing here that blocks work for a reason that is not safety, so it
 * says everything: a lease that cannot be listed, waited on or taken is one people
 * route around by forcing every time, and a register nobody trusts is worse than none.
 */
export function registerLockCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
): void {
  program
    .command('lock [path]')
    .description('Hold a path while you work on it, so a second agent waits')
    .option('--list', 'show every lease held on this machine')
    .option('--for <duration>', 'how long, e.g. 30m', String(DEFAULT_LEASE_MINUTES))
    .option('--release <id>', 'let one go early')
    .option('--forget', 'drop the records of leases nobody holds')
    .option('--agent <name>', 'who is taking it', 'you')
    .action(
      async (
        path: string | undefined,
        options: {
          list?: boolean;
          for: string;
          release?: string;
          forget?: boolean;
          agent: string;
        },
      ) => {
        const moment = now().toISOString();
        const registry = new LeaseRegistry(home());
        /* The shell, not this command. A lease is held while somebody works, and
           this process exits the moment it has printed, so holding its own pid
           made every hand-taken lease abandoned before the next command could see
           it, and `lock --list` answered "nothing is held" one line after taking one.
           Never init, though: that owner outlives everything and so can never be
           found dead, which turns a stale lease into a wait nothing can end. */
        const owner = holderPid(process.ppid, process.pid);
        const holder = {
          agent: options.agent,
          /* The session `memnox run` set, so a lease taken by hand and one taken at the
             seam belong to the same run and renew each other instead of colliding. */
          sessionId: process.env[SESSION_VAR] ?? `ses_pid_${owner}`,
          pid: owner,
        };

        const { flow, style } = context;
        flow.open('memnox lock');

        if (options.forget === true) {
          const dropped = await registry.forget(moment);
          flow.close(
            dropped === 0 ? 'Nothing to forget.' : `Forgot ${dropped} finished leases.`,
          );
          return;
        }

        if (options.release !== undefined) {
          const result = await registry.release(options.release, holder, moment);
          if (result.outcome === LEASE_OUTCOME.NOT_FOUND) {
            throw new Error(`No lease ${options.release}.`);
          }
          if (result.outcome === LEASE_OUTCOME.NOT_YOURS) {
            throw new Error(
              `${options.release} belongs to another session. Take it with --agent and a reason, or wait.`,
            );
          }
          flow.close(style.ok(`Released ${options.release}.`));
          return;
        }

        if (options.list === true || path === undefined) {
          const held = await registry.held(moment);
          if (held.length === 0) {
            flow.close('Nothing is held right now.');
            flow.hint('Hold a path with "memnox lock <path>".');
            return;
          }
          flow.list(
            'Held on this machine',
            held.map((lease) => ({
              tone: TONE.WARN,
              text: `${lease.id}  ${describeLease(lease, moment)}`,
              // What the holder has been doing is the half that ends the argument.
              detail: lease.activity.slice(-ACTIVITY_SHOWN),
            })),
          );
          flow.close(
            `${held.length === 1 ? '1 path is' : `${held.length} paths are`} held.`,
          );
          flow.hint('Let one go with "memnox lock --release <id>".');
          return;
        }

        const root = await new NodeGit(process.cwd()).root();
        if (root === null) {
          throw new Error(
            'A lease is repository-relative, and this is not a repository.',
          );
        }

        const wanted = normalizeLeasePath(relative(root, resolve(process.cwd(), path)));
        if (wanted === null) {
          throw new Error(`${path} is outside this repository, so nothing can lease it.`);
        }

        /* Exactly what was named. The directory-scoping rule exists for the seam,
           where ten writes must not become ten leases; a person who types a path has
           already said what they mean, and widening it to the parent — or to the
           repository root, for a path that does not exist yet — is a lock they did
           not ask for and cannot predict. */
        const scope = wanted;
        const result = await registry.take(
          scope,
          holder,
          moment,
          minutesFrom(options.for, '--for'),
          `held by hand from ${process.cwd()}`,
        );

        if (result.outcome === LEASE_OUTCOME.UNUSABLE_PATH) {
          throw new Error(`${path} is not a path a lease can be reasoned about.`);
        }
        if (result.outcome === LEASE_OUTCOME.HELD_BY_ANOTHER) {
          flow.list('Held by somebody else', [
            {
              tone: TONE.WARN,
              text: describeLease(result.holding, moment),
              detail: [
                ...result.holding.activity.slice(-ACTIVITY_SHOWN),
                `it expires at ${result.holding.expiresAt} on its own`,
              ],
            },
          ]);
          throw new Error(`${scope} is held by somebody else.`);
        }

        flow.rows('Holding', [
          { label: 'path', value: result.lease.path === '' ? '.' : result.lease.path },
          { label: 'lease', value: result.lease.id },
          { label: 'until', value: result.lease.expiresAt },
          { label: 'agent', value: options.agent },
        ]);
        flow.close(
          style.ok(`Holding ${result.lease.path === '' ? '.' : result.lease.path}.`),
        );
        // Every lease expires. Saying so here is what stops anybody relying on one.
        flow.hint('It expires on its own; nothing waits for ever on it.');
        flow.hint('Let it go early with "memnox lock --release".');
      },
    );
}

/** Enough of what a holder has been doing to end an argument, and never a log. */
const ACTIVITY_SHOWN = 3;
