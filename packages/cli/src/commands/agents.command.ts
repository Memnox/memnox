import { homedir } from 'node:os';
import type { Command } from 'commander';
import { readAccount, type Account, type SnapshotAgent } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';
import { onePass } from '../sync/heartbeat';
import {
  CONTROL_OUTCOME,
  acknowledgeControl,
  drainControl,
  type ControlCommand,
} from '../sync/control';
import { OFFBOARD, ONBOARD, offboardAgent, onboardAgent } from '../agents/onboard';

/**
 * The agents on this machine, and the channel to them.
 *
 * Deliberately about *this machine* rather than about the account. The console
 * answers "what does the whole fleet run", because only something holding every
 * machine's reports can; a laptop can answer what it hosts, and answering the
 * other question from here would mean handing a machine credential the reach to
 * read the whole fleet. That reach is the thing `test/machine-credential.test.ts`
 * exists to keep narrow.
 *
 * So `list` and `status` are local reads, `discover` is a scan this machine
 * takes of itself and reports, and `control` is the one that talks to the
 * control plane, on this machine's own move.
 */
export function registerAgentsCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  seams: () => ScanSeams = () => defaultScanSeams(),
): void {
  const agents = program
    .command('agents')
    .description('The agents on this machine, and what an operator has said to them');

  agents
    .command('discover', { isDefault: true })
    .description('Scan this machine for agents, and report what it found')
    .option('--json', 'machine-readable output')
    .option('--no-probe', 'do not start any MCP server to ask what it offers')
    .action(async (options: { json?: boolean; probe?: boolean }) => {
      const { snapshot } = await scanMachine(seams(), {
        probe: options.probe !== false,
      });

      const account = await readAccount(home());
      /* Reported through the same pass a sync does, rather than a second path
         that sends a census. Two ways to report one scan is one of them
         drifting, and the cursor that stops a scan being sent twice lives
         there. */
      const reported = account === null ? false : await report(home());

      if (options.json === true) {
        context.out.json({ agents: snapshot.agents, reported });
        return;
      }
      describe(context, snapshot.agents);
      if (account === null) {
        context.out.note(
          'Nothing has left this machine. Connect it with "memnox login".',
        );
        return;
      }
      context.out.note(
        reported
          ? 'Reported to the control plane.'
          : 'Could not reach the control plane; the scan is kept here and goes with the next sync.',
      );
    });

  agents
    .command('list')
    .description('What this machine hosts, from the last scan')
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      /* The kept scan, never a fresh one. A scan starts every MCP server it
         finds and takes seconds; listing is the thing somebody runs twice in a
         row, and making it the expensive one is how it stops being run. */
      const snapshot = await seams().snapshots.latest();
      if (snapshot === null) {
        if (options.json === true) {
          context.out.json({ agents: [] });
          return;
        }
        context.out.line('This machine has not been scanned yet.');
        context.out.note('Run "memnox agents discover".');
        return;
      }
      if (options.json === true) {
        context.out.json({ agents: snapshot.agents, takenAt: snapshot.takenAt });
        return;
      }
      describe(context, snapshot.agents);
      context.out.note(`from the scan taken ${snapshot.takenAt}`);
    });

  agents
    .command('status <agent>')
    .description('What is known about one agent on this machine')
    .option('--json', 'machine-readable output')
    .action(async (agent: string, options: { json?: boolean }) => {
      const snapshot = await seams().snapshots.latest();
      const found =
        snapshot === null ? undefined : snapshot.agents.find((each) => each.id === agent);

      if (found === undefined) {
        if (options.json === true) {
          context.out.json({ agent: null });
          return;
        }
        context.out.line(`No agent called "${agent}" was found on this machine.`);
        context.out.note('Run "memnox agents list" to see what is here.');
        return;
      }
      if (options.json === true) {
        context.out.json({ agent: found });
        return;
      }
      context.out.line(`${found.id} (${found.kind}${version(found)})`);
      /* The file that proved each surface, rather than a count of them. A
         number says how much this agent can reach; the path says who granted
         it, which is the half somebody can act on. */
      for (const surface of found.surfaces) {
        context.out.note(`${surface.kind} · ${surface.detectedFrom}`);
      }
    });

  agents
    .command('onboard <agent>')
    .description('Put an agent under Memnox, backing up its config first')
    .option('--json', 'machine-readable output')
    .action(async (agent: string, options: { json?: boolean }) => {
      const account = await readAccount(home());
      if (account === null) {
        context.out.line('Not logged in, so there is nothing to onboard into.');
        context.out.note('Connect this machine with "memnox login".');
        return;
      }
      const found = await hosted(agent, seams);
      if (found === null) {
        context.out.line(`No agent called "${agent}" was found on this machine.`);
        context.out.note('Run "memnox agents list" to see what is here.');
        return;
      }

      const result = await onboardAgent(
        home(),
        process.cwd(),
        account,
        found.id,
        found.kind,
        context.out,
      );
      if (options.json === true) {
        context.out.json(result);
        return;
      }
      if (result.outcome !== ONBOARD.DONE || result.record === undefined) {
        context.out.line(context.style.warn(`Did not onboard ${found.id}.`));
        context.out.note(result.because ?? 'no reason given');
        return;
      }
      const record = result.record;
      context.out.line(
        `${context.style.ok('Onboarded')} ${found.id} (${record.product})`,
      );
      context.out.note(`config updated: ${record.configPath}`);
      context.out.note(`backup saved: ${record.backupPath}`);
      context.out.note(`enrolled as machine ${record.machineId}`);
      /* Said plainly, because onboarding an agent is the moment somebody
         wonders whether it has just been given permission to do more. */
      context.out.note(
        'Authority is unchanged: what this agent may do is still decided on this machine.',
      );
      context.out.note(`to undo: memnox agents offboard ${found.id}`);
    });

  agents
    .command('offboard <agent>')
    .description("Put an agent's config back and take its credential away")
    .option('--json', 'machine-readable output')
    .action(async (agent: string, options: { json?: boolean }) => {
      const account = await readAccount(home());
      if (account === null) {
        context.out.line('Not logged in, so nothing here was onboarded.');
        return;
      }
      const found = await hosted(agent, seams);
      const agentId = found === null ? agent : found.id;

      const result = await offboardAgent(home(), account, agentId);
      if (options.json === true) {
        context.out.json(result);
        return;
      }
      if (result.outcome === OFFBOARD.NOT_ONBOARDED) {
        context.out.line(result.because ?? `${agentId} is not onboarded.`);
        return;
      }
      if (result.outcome === OFFBOARD.FAILED) {
        context.out.line(context.style.warn(`Could not fully offboard ${agentId}.`));
        context.out.note(result.because ?? 'no reason given');
        return;
      }
      context.out.line(`${context.style.ok('Offboarded')} ${agentId}`);
      context.out.note(
        result.restoredFromBackup === true
          ? `config restored from ${result.record?.backupPath ?? 'its backup'}`
          : 'no backup was found, so only the Memnox entry was removed',
      );
      context.out.note(
        result.revoked === true
          ? 'its credential has been revoked'
          : context.style.warn(
              'its credential could not be revoked; revoke the machine in the console',
            ),
      );
    });

  agents
    .command('control [agent]')
    .description('Collect what an operator has said to the agents on this machine')
    .option('--json', 'machine-readable output')
    .action(async (agent: string | undefined, options: { json?: boolean }) => {
      const account = await readAccount(home());
      if (account === null) {
        context.out.line('Not logged in, so nobody can have said anything.');
        context.out.note('Connect this machine with "memnox login".');
        return;
      }

      const wanted = await addressed(agent, seams);
      const collected: ControlCommand[] = [];
      let revoked = false;
      for (const agentId of wanted) {
        const result = await drainControl(account, agentId);
        if (result.outcome === CONTROL_OUTCOME.REVOKED) {
          revoked = true;
          break;
        }
        collected.push(...result.commands);
      }

      if (options.json === true) {
        context.out.json({ commands: collected, revoked });
        return;
      }
      if (revoked) {
        context.out.line(context.style.warn('This machine has been revoked.'));
        context.out.note('Run "memnox login" to enrol it again.');
        return;
      }
      if (collected.length === 0) {
        context.out.line('Nothing has been said to the agents on this machine.');
        return;
      }
      await deliver(context, account, collected);
    });
}

/**
 * Shown, then acknowledged, and in that order.
 *
 * A turn is handed over once, so acknowledging before it has reached a person
 * would lose it on any failure between the two. Printing first means the worst
 * case is a receipt nobody recorded rather than an instruction nobody saw.
 */
async function deliver(
  context: CliContext,
  account: Account,
  commands: readonly ControlCommand[],
): Promise<void> {
  for (const command of commands) {
    context.out.line(
      `${context.style.ok(command.issuedBy)} to ${command.agentId}: ${command.message}`,
    );
    context.out.note(`${command.issuedAt} · ${command.id}`);
    /* Received, which is all this can honestly claim. Acting on it is whoever
       is at the agent, and a receipt saying otherwise would put a word in the
       record that nothing here did. */
    await acknowledgeControl(account, command.agentId, command.id, { ok: true });
  }
}

/** One agent this machine hosts, by id or by kind, or null. */
async function hosted(
  agent: string,
  seams: () => ScanSeams,
): Promise<{ id: string; kind: string } | null> {
  const snapshot = await seams().snapshots.latest();
  if (snapshot === null) return null;
  const wanted = agent.toLowerCase();
  const found = snapshot.agents.find(
    (each) => each.id.toLowerCase() === wanted || each.kind.toLowerCase() === wanted,
  );
  return found === undefined ? null : { id: found.id, kind: found.kind };
}

/** One agent by name, or every agent this machine hosts. */
async function addressed(
  agent: string | undefined,
  seams: () => ScanSeams,
): Promise<string[]> {
  if (agent !== undefined) return [agent];
  const snapshot = await seams().snapshots.latest();
  if (snapshot === null) return [];
  return snapshot.agents.map((each) => each.id);
}

/** True when the pass actually sent the scan; false is unreachable, not an error. */
async function report(home: string): Promise<boolean> {
  const pass = await onePass(home);
  if (pass.unreachable === true) return false;
  return pass.census !== undefined;
}

function describe(context: CliContext, agents: readonly SnapshotAgent[]): void {
  if (agents.length === 0) {
    context.out.line('No agents found on this machine.');
    return;
  }
  for (const agent of agents) {
    context.out.line(`${agent.id} (${agent.kind}${version(agent)})`);
  }
}

function version(agent: SnapshotAgent): string {
  return agent.version === undefined ? '' : ` ${agent.version}`;
}
