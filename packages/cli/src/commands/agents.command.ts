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
import type { EnrolReporter } from '../agents/enrol-agent';
import { readRecord } from '../agents/onboarding';
import {
  clearName,
  displayName,
  isDefaultName,
  readNames,
  resolveAgent,
  setName,
  workspaceShown,
  type AgentNames,
} from '../agents/names';
import {
  askForNames,
  askForOneName,
  askOnTerminal,
  parseNameFlag,
  type NameAsker,
} from '../agents/name-prompt';

/**
 * The agents on this machine: find them, name them, put them to work.
 *
 * Deliberately about *this machine* rather than about the account. The console
 * answers "what does the whole fleet run", because only something holding every
 * machine's reports can; a laptop can answer what it hosts, and answering the
 * other question from here would mean handing a machine credential the reach to
 * read the whole fleet. That reach is the thing `test/machine-credential.test.ts`
 * exists to keep narrow.
 *
 * So `list`, `status` and `name` are local reads and writes, `discover` is a
 * scan this machine takes of itself and reports, and `control` is the one that
 * talks to the control plane, on this machine's own move.
 */
export function registerAgentsCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  seams: () => ScanSeams = () => defaultScanSeams(),
  ask: NameAsker = askOnTerminal,
  interactive: () => boolean = () => process.stdin.isTTY === true,
): void {
  const agents = program
    .command('agents')
    .description('The agents on this machine: find them, name them, put them to work');

  agents
    .command('discover', { isDefault: true })
    .description('Scan this machine for agents, and name what it found')
    .option('--json', 'machine-readable output')
    .option('--no-ask', 'do not ask what to call them')
    .option(
      '--name <agent=name>',
      'name one without being asked, repeatable',
      collect,
      [] as string[],
    )
    .option('--no-probe', 'do not start any MCP server to ask what it offers')
    .action(
      async (options: {
        json?: boolean;
        ask?: boolean;
        name?: string[];
        probe?: boolean;
      }) => {
        const { snapshot } = await scanMachine(seams(), {
          probe: options.probe !== false,
        });
        const given = options.name ?? [];
        /* Never when the answer is being piped: a prompt on a machine with no
           person at it is a scan that hangs until somebody kills it. */
        const asking = options.ask !== false && options.json !== true && interactive();

        let names = await readNames(home());
        names = await applyNameFlags(context, home(), snapshot.agents, names, given);

        if (options.json !== true) {
          heading(context, `Found ${count(snapshot.agents)} on this machine.`);
          describe(context, snapshot.agents, names);
        }

        if (asking && snapshot.agents.length > 0) {
          const renamed = await askForNames(
            context,
            home(),
            snapshot.agents,
            names,
            (agent) => surfacesOf(agent),
            ask,
          );
          if (renamed.length > 0) {
            names = await readNames(home());
            context.out.line('');
            for (const each of renamed) {
              context.out.line(
                `  ${context.style.ok('named')} ${each.from} is now "${each.to}"`,
              );
            }
          }
        }

        const account = await readAccount(home());
        /* Reported through the same pass a sync does, rather than a second path
           that sends a census. Two ways to report one scan is one of them
           drifting, and the cursor that stops a scan being sent twice lives
           there. */
        const reported = account === null ? false : await report(home());

        if (options.json === true) {
          context.out.json({ agents: withNames(snapshot.agents, names), reported });
          return;
        }
        if (snapshot.agents.length > 0) {
          context.out.line('');
          context.out.line(
            `  ${context.style.dim('rename one')}   memnox agents name <agent> <name>`,
          );
          context.out.line(
            `  ${context.style.dim('put to work')}  memnox agents onboard <agent>`,
          );
        }
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
      },
    );

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
      const names = await readNames(home());
      if (options.json === true) {
        context.out.json({
          agents: withNames(snapshot.agents, names),
          takenAt: snapshot.takenAt,
        });
        return;
      }
      heading(context, `${count(snapshot.agents)} on this machine.`);
      await describeWithWork(context, home(), snapshot.agents, names);
      context.out.note(`from the scan taken ${snapshot.takenAt}`);
    });

  agents
    .command('name <agent> [name]')
    .description('Call an agent whatever you call it, and see that name everywhere')
    .option('--clear', 'go back to the name the detector gave it')
    .option('--json', 'machine-readable output')
    .action(
      async (
        agent: string,
        wanted: string | undefined,
        options: { clear?: boolean; json?: boolean },
      ) => {
        const found = await hosted(agent, seams, home);
        if (found === null) {
          notFound(context, agent, options.json === true);
          return;
        }
        const names = await readNames(home());
        const before = displayName(names, found);

        if (options.clear === true) {
          const cleared = await clearName(home(), found.id);
          const after = displayName(await readNames(home()), found);
          if (options.json === true) {
            context.out.json({ agent: found.id, name: after, cleared });
            return;
          }
          context.out.line(
            cleared
              ? `${context.style.ok('cleared')} ${found.id} is "${after}" again`
              : `${found.id} was never renamed, so it is still "${after}".`,
          );
          return;
        }

        if (wanted === undefined) {
          if (options.json === true) {
            context.out.json({
              agent: found.id,
              name: before,
              chosen: !isDefaultName(names, found),
            });
            return;
          }
          context.out.line(`${found.id} is called "${before}"`);
          context.out.note(
            isDefaultName(names, found)
              ? 'That is what the detector called it. Give it your own name by typing one after this command.'
              : 'That is the name you gave it. "--clear" puts the detected one back.',
          );
          return;
        }

        const written = await setName(home(), found.id, wanted);
        if (!written.ok || written.name === undefined) {
          if (options.json === true) {
            context.out.json({ agent: found.id, name: before, refused: written.refused });
            return;
          }
          context.out.line(context.style.warn(`Did not rename ${before}.`));
          context.out.note(written.because ?? 'that name was refused');
          process.exitCode = 1;
          return;
        }
        if (options.json === true) {
          context.out.json({ agent: found.id, name: written.name, was: before });
          return;
        }
        context.out.line(
          `${context.style.ok('named')} ${before} is now "${written.name}"`,
        );
      },
    );

  agents
    .command('status <agent>')
    .description('What is known about one agent on this machine')
    .option('--json', 'machine-readable output')
    .action(async (agent: string, options: { json?: boolean }) => {
      const snapshot = await seams().snapshots.latest();
      const names = await readNames(home());
      const found =
        snapshot === null ? null : resolveAgent(snapshot.agents, names, agent);

      if (found === null) {
        if (options.json === true) {
          context.out.json({ agent: null });
          return;
        }
        notFound(context, agent, false);
        return;
      }
      const record = await readRecord(home(), found.id);
      if (options.json === true) {
        context.out.json({
          agent: { ...found, name: displayName(names, found) },
          onboarded: record !== null,
        });
        return;
      }
      const { out, style } = context;
      out.line('');
      out.line(style.bold(displayName(names, found).toUpperCase()));
      out.line(`  ${style.dim('id')}        ${found.id}`);
      out.line(`  ${style.dim('product')}   ${found.kind}${version(found)}`);
      out.line(
        `  ${style.dim('working')}   ${
          record === null ? 'not onboarded' : `onboarded ${record.onboardedAt}`
        }`,
      );
      out.line('');
      out.line(style.bold('  WHAT IT CAN REACH, AND WHO GRANTED IT'));
      if (found.surfaces.length === 0) {
        out.line(`  ${style.dim('nothing this scan could prove')}`);
      }
      /* The file that proved each surface, rather than a count of them. A
         number says how much this agent can reach; the path says who granted
         it, which is the half somebody can act on. */
      const kindWidth = Math.max(
        ...found.surfaces.map((surface) => surface.kind.length),
        0,
      );
      for (const surface of found.surfaces) {
        out.line(
          `  ${surface.kind.padEnd(kindWidth)}  ${style.dim(surface.detectedFrom)}`,
        );
      }
      out.line('');
      out.line(
        `  ${style.dim(
          record === null
            ? `memnox agents onboard ${quoted(displayName(names, found))}`
            : `memnox agents offboard ${quoted(displayName(names, found))}`,
        )}`,
      );
    });

  agents
    .command('onboard [agent]')
    .description('Put an agent under Memnox, backing up its config first')
    .option('--name <name>', 'what the workspace should call it, rather than being asked')
    .option('--json', 'machine-readable output')
    .action(
      async (agent: string | undefined, options: { json?: boolean; name?: string }) => {
        let names = await readNames(home());
        if (agent === undefined) {
          await offerCandidates(context, home(), seams, names, options.json === true);
          return;
        }
        const account = await readAccount(home());
        if (account === null) {
          if (options.json === true) {
            context.out.json({ outcome: ONBOARD.NO_ACCOUNT });
            return;
          }
          context.out.line('Not logged in, so there is nothing to onboard into.');
          context.out.note('Connect this machine with "memnox login".');
          return;
        }
        const found = await hosted(agent, seams, home);
        if (found === null) {
          notFound(context, agent, options.json === true);
          return;
        }
        let shown = displayName(names, found);

        if (options.json !== true) sayWhatWillHappen(context, shown, found.kind, account);

        /* Asked here rather than only at discovery, because this is the moment the
         name stops being local: it is sent as the enrolment label and it is what
         the console shows afterwards. Somebody who never ran `discover` would
         otherwise enrol an agent under a name they were never offered. */
        const chosen = await chooseCloudName(
          context,
          home(),
          found,
          names,
          account,
          options,
          interactive(),
          ask,
        );
        shown = chosen.name;
        names = await readNames(home());

        const result = await onboardAgent(
          home(),
          process.cwd(),
          account,
          found.id,
          found.kind,
          reportOn(context),
          shown,
        );
        if (options.json === true) {
          context.out.json({ ...result, name: shown });
          return;
        }
        if (result.outcome !== ONBOARD.DONE || result.record === undefined) {
          context.out.line('');
          context.out.line(context.style.warn(`Did not onboard ${shown}.`));
          context.out.note(result.because ?? 'no reason given');
          context.out.note('Nothing on this machine was changed.');
          process.exitCode = 1;
          return;
        }
        const record = result.record;
        const { out, style } = context;
        out.line('');
        out.line(`${style.ok('Onboarded')} ${shown} (${record.product})`);
        out.line(
          `  ${style.dim('known as')}  ${shown} in ${workspaceShown(account.workspaceId)}`,
        );
        out.line(`  ${style.dim('config')}    ${record.configPath}`);
        out.line(`  ${style.dim('backup')}    ${record.backupPath}`);
        out.line(`  ${style.dim('machine')}   ${record.machineId}`);
        out.line(
          `  ${style.dim('enrolled')}  ${
            result.approvedInBrowser === true
              ? 'approved in your browser'
              : "on this machine's own credential"
          }`,
        );
        out.line(`  ${style.dim('undo')}      memnox agents offboard ${quoted(shown)}`);
        /* Said plainly, because onboarding an agent is the moment somebody
         wonders whether it has just been given permission to do more. */
        out.note(
          'Authority is unchanged: what this agent may do is still decided on this machine.',
        );
      },
    );

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
      const names = await readNames(home());
      const found = await hosted(agent, seams, home);
      const agentId = found === null ? agent : found.id;
      const shown = found === null ? agent : displayName(names, found);

      const result = await offboardAgent(home(), account, agentId);
      if (options.json === true) {
        context.out.json({ ...result, name: shown });
        return;
      }
      if (result.outcome === OFFBOARD.NOT_ONBOARDED) {
        context.out.line(result.because ?? `${shown} is not onboarded.`);
        return;
      }
      if (result.outcome === OFFBOARD.FAILED) {
        context.out.line(context.style.warn(`Could not fully offboard ${shown}.`));
        context.out.note(result.because ?? 'no reason given');
        process.exitCode = 1;
        return;
      }
      context.out.line(`${context.style.ok('Offboarded')} ${shown}`);
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

      const wanted = await addressed(agent, seams, home);
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
 * What onboarding is about to do, before it does any of it.
 *
 * The device code arrives seconds later and it is the first thing most people
 * see, which makes "why is Memnox asking me to approve something" the question
 * the screen has to answer before it asks. Saying that authority does not
 * change is the other half: the fear at this moment is that agreeing to this
 * hands the agent more reach.
 */
function sayWhatWillHappen(
  context: CliContext,
  shown: string,
  kind: string,
  account: Account,
): void {
  const { out, style } = context;
  out.line('');
  out.line(`${style.bold('ONBOARD')}  ${shown} ${style.dim(`(${kind})`)}`);
  out.line('');
  out.line('  Four things happen, in this order:');
  out.line(
    `    1. you say what ${workspaceShown(account.workspaceId)} should call this agent`,
  );
  out.line('    2. you approve a credential for it in your browser');
  out.line("    3. this machine copies the agent's config somewhere safe");
  out.line('    4. one server entry, called memnox, is added to it');
  out.line('');
  out.line(
    `  ${style.dim('It does not change what this agent is allowed to do, and it is reversible.')}`,
  );
}

/**
 * The name this agent will be known by in the workspace.
 *
 * Asked rather than assumed, because the control plane hashes the hostname and
 * never stores it: whatever is chosen here is the only human thing on the row,
 * and an unnamed fleet is a list of hex ids nobody can tell apart. `--name`
 * answers it for a setup script, and a machine with nobody at it keeps whatever
 * the agent is already called rather than hanging on a prompt.
 *
 * It is written locally too. One name in two places is one of them going stale,
 * and the one that goes stale is whichever a person is not looking at.
 */
export async function chooseCloudName(
  context: CliContext,
  home: string,
  agent: SnapshotAgent,
  names: AgentNames,
  account: Account,
  options: { json?: boolean; name?: string },
  interactive: boolean,
  ask: NameAsker,
): Promise<{ name: string }> {
  const current = displayName(names, agent);

  if (options.name !== undefined) {
    const written = await setName(home, agent.id, options.name);
    if (written.ok && written.name !== undefined) return { name: written.name };
    context.out.note(
      context.style.warn(
        `Kept "${current}": ${written.because ?? 'that name was refused'}.`,
      ),
    );
    return { name: current };
  }
  if (options.json === true || !interactive) return { name: current };

  const chosen = await askForOneName(
    home,
    agent,
    names,
    `Call it something ${workspaceShown(account.workspaceId)} will recognise`,
    [
      current,
      `This is the name ${workspaceShown(account.workspaceId)} will show for it from now on.`,
    ],
    ask,
  );
  if (chosen.because !== undefined) {
    context.out.note(context.style.warn(`Kept "${current}": ${chosen.because}.`));
  }
  return { name: chosen.name };
}

/** Shown, then acknowledged, and in that order. */
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

/** One agent this machine hosts, by name, id, bare id or product. */
async function hosted(
  agent: string,
  seams: () => ScanSeams,
  home: () => string,
): Promise<SnapshotAgent | null> {
  const snapshot = await seams().snapshots.latest();
  if (snapshot === null) return null;
  return resolveAgent(snapshot.agents, await readNames(home()), agent);
}

/** One agent by name, or every agent this machine hosts. */
async function addressed(
  agent: string | undefined,
  seams: () => ScanSeams,
  home: () => string,
): Promise<string[]> {
  if (agent !== undefined) {
    const found = await hosted(agent, seams, home);
    return [found === null ? agent : found.id];
  }
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

/** `--name claude-code="Backend Coder"`, applied before anything is printed. */
async function applyNameFlags(
  context: CliContext,
  home: string,
  agents: readonly SnapshotAgent[],
  names: AgentNames,
  given: readonly string[],
): Promise<AgentNames> {
  let current = names;
  for (const raw of given) {
    const parsed = parseNameFlag(raw);
    if (parsed === null) {
      context.out.note(
        context.style.warn(`Ignored --name ${raw}: it has to read agent=name.`),
      );
      continue;
    }
    const found = resolveAgent(agents, current, parsed.query);
    if (found === null) {
      context.out.note(
        context.style.warn(`Ignored --name ${raw}: no agent called "${parsed.query}".`),
      );
      continue;
    }
    const written = await setName(home, found.id, parsed.name);
    if (!written.ok || written.name === undefined) {
      context.out.note(
        context.style.warn(`Ignored --name ${raw}: ${written.because ?? 'refused'}.`),
      );
      continue;
    }
    current = { ...current, [found.id]: written.name };
  }
  return current;
}

/** Every agent that could be onboarded, when somebody typed the verb with no subject. */
async function offerCandidates(
  context: CliContext,
  home: string,
  seams: () => ScanSeams,
  names: AgentNames,
  asJson: boolean,
): Promise<void> {
  const snapshot = await seams().snapshots.latest();
  if (snapshot === null || snapshot.agents.length === 0) {
    if (asJson) {
      context.out.json({ agents: [] });
      return;
    }
    context.out.line('This machine has not been scanned yet.');
    context.out.note('Run "memnox agents discover".');
    return;
  }
  const rows = [];
  for (const agent of snapshot.agents) {
    rows.push({
      id: agent.id,
      name: displayName(names, agent),
      onboarded: (await readRecord(home, agent.id)) !== null,
    });
  }
  if (asJson) {
    context.out.json({ agents: rows });
    return;
  }
  const waiting = rows.filter((row) => !row.onboarded);
  if (waiting.length === 0) {
    context.out.line('Every agent on this machine is already onboarded.');
    return;
  }
  heading(context, 'Name one of these:');
  for (const row of waiting)
    context.out.line(`  ${row.name}  ${context.style.dim(row.id)}`);
  context.out.line('');
  context.out.line(
    `  ${context.style.dim(`memnox agents onboard ${quoted(waiting[0]?.name ?? '<agent>')}`)}`,
  );
}

function notFound(context: CliContext, agent: string, asJson: boolean): void {
  if (asJson) {
    context.out.json({ agent: null });
    return;
  }
  context.out.line(`No agent called "${agent}" was found on this machine.`);
  context.out.note('Run "memnox agents list" to see what is here.');
}

function heading(context: CliContext, text: string): void {
  context.out.line('');
  context.out.line(context.style.bold(text));
  context.out.line('');
}

function count(agents: readonly SnapshotAgent[]): string {
  return agents.length === 1 ? '1 agent' : `${agents.length} agents`;
}

function describe(
  context: CliContext,
  agents: readonly SnapshotAgent[],
  names: AgentNames,
): void {
  if (agents.length === 0) {
    context.out.line('No agents found on this machine.');
    return;
  }
  const width = columnWidth(agents, names);
  for (const agent of agents) {
    const shown = displayName(names, agent).padEnd(width);
    context.out.line(`  ${shown}  ${context.style.dim(surfacesOf(agent))}`);
  }
}

/** The widest reach column, so the state beside it lines up down the page. */
function reachWidth(agents: readonly SnapshotAgent[]): number {
  return Math.max(...agents.map((agent) => surfacesOf(agent).length), 0);
}

/** The same rows, plus whether each is actually working under Memnox yet. */
async function describeWithWork(
  context: CliContext,
  home: string,
  agents: readonly SnapshotAgent[],
  names: AgentNames,
): Promise<void> {
  if (agents.length === 0) {
    context.out.line('No agents found on this machine.');
    return;
  }
  const width = columnWidth(agents, names);
  const reach = reachWidth(agents);
  for (const agent of agents) {
    const onboarded = (await readRecord(home, agent.id)) !== null;
    const shown = displayName(names, agent).padEnd(width);
    // Padded before styling: an escape sequence has width nobody can see but padEnd can.
    const surfaces = surfacesOf(agent).padEnd(reach);
    context.out.line(
      `  ${shown}  ${context.style.dim(surfaces)}` +
        `  ${onboarded ? context.style.ok('onboarded') : context.style.dim('not onboarded')}`,
    );
  }
}

/** Padded before styling: an escape sequence has width nobody can see but padEnd can. */
function columnWidth(agents: readonly SnapshotAgent[], names: AgentNames): number {
  return Math.max(...agents.map((agent) => displayName(names, agent).length), 0);
}

/**
 * What this agent reaches, in the words the scan proved rather than a count.
 *
 * Falls back to the product, because an agent whose surfaces nothing proved is
 * still a real agent and a blank column reads as a bug.
 */
function surfacesOf(agent: SnapshotAgent): string {
  if (agent.surfaces.length === 0) return `${agent.kind}, no surface proved`;
  return [...new Set(agent.surfaces.map((surface) => surface.kind))].join(', ');
}

function withNames(
  agents: readonly SnapshotAgent[],
  names: AgentNames,
): (SnapshotAgent & { name: string })[] {
  return agents.map((agent) => ({ ...agent, name: displayName(names, agent) }));
}

/** A name with a space in it has to be typed back with quotes around it. */
function quoted(name: string): string {
  return /\s/.test(name) ? `"${name}"` : name;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function version(agent: SnapshotAgent): string {
  return agent.version === undefined ? '' : ` ${agent.version}`;
}

/**
 * What enrolment says while it runs, as plain lines.
 *
 * Commentary rather than payload: a person reads it, and `--json` callers and
 * pipes must receive the result and nothing else. It used to go to stdout,
 * which put an approval prompt in the middle of whatever was being piped.
 */
function reportOn(context: CliContext): EnrolReporter {
  const { out, style } = context;
  return {
    approve: ({ what, url, code, because, deadline }) => {
      out.note('');
      out.note(`Approve ${what} in your browser`);
      out.note(`  ${url}`);
      if (code !== undefined) out.note(`  Code ${style.accent(code)}`);
      out.note(`  ${style.dim(because)}`);
      out.note(
        style.dim(
          `  Waiting for you to answer it, for ${deadline}. Ctrl+C stops, and nothing will change.`,
        ),
      );
    },
  };
}
