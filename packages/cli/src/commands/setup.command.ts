import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  readAccount,
  SENSITIVITY,
  type Account,
  type DiscoveryReport,
  type EnvironmentSnapshot,
  type SnapshotAgent,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { Flow } from '../flow';
import { underHome } from '../memnox-paths';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';
import { connectMachine, DEFAULT_BASE_URL, type ConnectSeams } from '../sync/connect';
import {
  manageable,
  OFFBOARD,
  ONBOARD,
  offboardAgent,
  onboardAgent,
  type Manageable,
} from '../agents/onboard';
import type { EnrolReporter } from '../agents/enrol-agent';
import { listRecords, onboardedInto, readRecord } from '../agents/onboarding';
import { sameControlPlane } from '../sync/client';
import {
  displayName,
  readNames,
  setName,
  workspaceShown,
  type AgentNames,
} from '../agents/names';
import { askOnTerminal, type NameAsker } from '../agents/name-prompt';
import { onePass } from '../sync/heartbeat';

/**
 * The whole first run, in one command.
 *
 * `login`, `agents discover`, `agents name` and `agents onboard` each do one
 * step, and somebody meeting this product for the first time has to know all
 * four exist and what order they go in. They do not, and there is no reason they
 * should: the four steps are one intention, which is "put my agents under this".
 *
 * Named `setup` rather than `onboard` because `agents onboard <agent>` already
 * exists and does the precise version of the last step. Two commands one word
 * apart, one of which loops over what the other does once, is a pair somebody
 * has to read twice to tell apart. Bare `memnox` still runs `scan`: the first
 * thing this product does is show somebody their own machine, not ask them to
 * sign in.
 *
 * So this asks per agent rather than in bulk. What an agent can already reach is
 * shown before the question, because the answer to "should this one be onboarded"
 * depends on it, and a list of five names with one prompt at the bottom is a
 * screen people say yes to without reading. The name is asked in the same breath
 * for the same reason: it is the identity the workspace will use, and asking for
 * it beside what the agent can reach is the only place a person has the context
 * to choose a useful one.
 *
 * **One rail, and everything on it.** Every line this run prints goes through
 * `Flow`, prompts included. Enrolment used to print its own block to stdout
 * while the rest of the run drew a rail on stderr, so the one step that can
 * block on a person appeared to come from somewhere else, and a pipe received
 * it. A run that looks like two commands taking turns is one nobody can read.
 *
 * **One approval, for the machine.** A person approves this laptop once, and
 * the agents on it are enrolled on its own credential. See `enrol-agent.ts` for
 * why that is the right grant rather than a shortcut past one.
 *
 * Nothing here is new machinery. Every step calls the command that owns it.
 */
export function registerSetupCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  buildSeams: () => ScanSeams = () => defaultScanSeams(),
  connect: typeof connectMachine = connectMachine,
  ask: NameAsker = askOnTerminal,
  confirm: Confirm = confirmOnTerminal,
  interactive: () => boolean = () => process.stdin.isTTY === true,
  connectSeams: ConnectSeams = {},
  /** The one pass that reports a kept scan. Injected so a test needs no ledger. */
  reportScan: (home: string) => Promise<boolean> = reportOnce,
  /** Handing an agent back, for the one case that needs it: a move between planes. */
  offboard: typeof offboardAgent = offboardAgent,
): void {
  program
    .command('setup')
    .description(
      'Log in, see what your agents can reach, and put them to work one by one',
    )
    .option('--url <base>', 'the control plane', DEFAULT_BASE_URL)
    .option('--enforce', 'start in enforce rather than observe')
    /* The question is asked on a terminal, so the flag is for everything
       else. A machine that enrols unnamed is a hex id in the console, which
       is what a fleet of them was before this. */
    .option('--name <name>', 'what your workspace calls this machine')
    .option('--no-open', 'print the code and the URL instead of opening a browser')
    .option('--no-probe', 'do not start any MCP server to ask what it offers')
    .action(
      async (options: {
        url: string;
        enforce?: boolean;
        name?: string;
        open: boolean;
        probe: boolean;
      }) => {
        const { style } = context;
        const flow = new Flow(context.out, style);
        flow.open('memnox setup');

        /* Step one, and skipped when it is already done. Re-running the device
           flow on an enrolled machine would mint a second credential for a
           laptop that already has one, which is a row in the fleet nobody
           added and a second thing to revoke. */
        const account = await connectedAccount(
          context,
          home(),
          options,
          flow,
          connect,
          /* The machine is named on the same rail and by the same asker the
             agents are, because it is the same question about a different
             thing and two prompt styles in one run read as two commands. */
          { askName: ask, interactive, ...connectSeams },
          confirm,
          interactive,
          offboard,
        );

        flow.step('Looking for agents on this machine');
        const { report, snapshot } = await scanMachine(buildSeams(), {
          probe: options.probe !== false,
        });
        if (snapshot.agents.length === 0) {
          flow.close('No agents found on this machine.');
          flow.hint(
            'Memnox governs agents it can see. Install one, then run this again.',
          );
          return;
        }
        const names0 = await readNames(home());
        flow.step(
          `Found ${snapshot.agents.length === 1 ? '1 agent' : `${snapshot.agents.length} agents`}`,
          snapshot.agents.map((agent) => displayName(names0, agent)).join(', '),
        );

        if (!interactive()) {
          /* Every question below waits on a person. Asking them with nothing on
             stdin is a command that hangs, so it stops here and names the
             non-interactive path instead of pretending to offer one. */
          flow.close('Nothing is attached to this terminal, so nobody can be asked.');
          flow.hint(
            'Onboard one at a time instead:  memnox agents onboard <agent> --name "<name>"',
          );
          return;
        }

        const results: Result[] = [];
        let names = await readNames(home());

        for (const agent of snapshot.agents) {
          const already = await readRecord(home(), agent.id);
          if (already !== null && onboardedInto(already, account)) {
            results.push({
              name: displayName(names, agent),
              status: STATUS.ALREADY,
              because: 'onboarded earlier',
            });
            continue;
          }
          if (already !== null) {
            /* Onboarded into a different workspace, and the credential that
               could take it back out is one this machine no longer holds. Said
               rather than onboarded over: the rewrite would back up a config
               that already points at the other plane, which turns the undo into
               a second way to end up pointed there. */
            results.push({
              name: displayName(names, agent),
              status: STATUS.ELSEWHERE,
              because: wherePlane(already),
            });
            continue;
          }
          /* Checked before anybody is asked. Answering two questions about an
             agent and then being told the third step was never going to work is
             the worst version of this screen. */
          const config = await manageable(home(), process.cwd(), agent.kind);
          if (config.because !== undefined) {
            describeAgent(flow, context, home(), agent, names, report, snapshot, config);
            results.push({
              name: displayName(names, agent),
              status: STATUS.CANNOT,
              because: config.because,
            });
            continue;
          }
          const outcome = await offerOne(
            context,
            flow,
            home(),
            agent,
            names,
            report,
            snapshot,
            config,
            account,
            ask,
            confirm,
          );
          names = await readNames(home());
          results.push(outcome);
        }

        /* The last step, and the one that was missing: onboarding writes
           credentials and nothing was telling the workspace what these agents
           are. The console's Agents page reads a census, so a guided run that
           never sent one finished by saying five agents were under Memnox on
           a page that said there were none. Reported through the same pass a
           sync does, so the cursor that stops a scan being sent twice is the
           one that already owns that. */
        const reported = await reportScan(home()).catch(() => false);

        summarize(context, flow, account, results, reported);
      },
    );
}

/** True when the scan actually reached the control plane. Unreachable is not an error. */
async function reportOnce(home: string): Promise<boolean> {
  const pass = await onePass(home);
  if (pass.unreachable === true) return false;
  return pass.census !== undefined;
}

/**
 * Enrolled already, or enrolled now. Either way the rest of the run has one.
 *
 * **Where the run was pointed is part of the question.** A machine enrolled
 * against a control plane on localhost and then run against the real one used to
 * print "Already connected" and carry on talking to localhost, `--url` included:
 * every screen after it named a workspace the person was not trying to reach,
 * and the agents were reported as already done because the records said so. An
 * address that does not match the credential in hand is a different deployment,
 * so it is said out loud and the move is offered rather than assumed either way.
 */
async function connectedAccount(
  context: CliContext,
  home: string,
  options: { url: string; enforce?: boolean; name?: string; open: boolean },
  flow: Flow,
  connect: typeof connectMachine,
  seams: ConnectSeams,
  confirm: Confirm,
  interactive: () => boolean,
  offboard: typeof offboardAgent,
): Promise<Account> {
  const existing = await readAccount(home);
  if (existing === null) {
    const connected = await connect(context, home, options, flow, seams);
    /* Said once, here, because it is the promise the rest of the run keeps: a
       person answered a browser for this machine and will not be asked again. */
    flow.aside(context.style.dim('That is the only approval this run needs.'));
    return connected.account;
  }
  if (sameControlPlane(existing.baseUrl, options.url)) {
    flow.step('Already connected', `${existing.workspaceId} at ${existing.baseUrl}`);
    return existing;
  }
  return moveOrStay(context, home, options, flow, connect, seams, {
    existing,
    confirm,
    interactive,
    offboard,
  });
}

/**
 * The machine is enrolled somewhere else than this run was pointed at.
 *
 * Nobody is moved without being asked, and the question defaults to no: a
 * mistyped Enter must not take somebody's laptop off the control plane it is
 * governed by. Where there is nobody to ask, the enrolment it has wins and the
 * command that moves it is named, because a script that silently re-enrolled a
 * fleet every night is the worse failure of the two.
 */
async function moveOrStay(
  context: CliContext,
  home: string,
  options: { url: string; enforce?: boolean; name?: string; open: boolean },
  flow: Flow,
  connect: typeof connectMachine,
  seams: ConnectSeams,
  from: {
    existing: Account;
    confirm: Confirm;
    interactive: () => boolean;
    offboard: typeof offboardAgent;
  },
): Promise<Account> {
  const { existing } = from;
  flow.step(
    'Connected to a different control plane',
    `${existing.workspaceId} at ${existing.baseUrl}`,
  );
  flow.aside(`This run was pointed at ${options.url}.`);

  if (!from.interactive()) {
    flow.aside(`Staying on ${existing.baseUrl}, because nobody can be asked.`);
    flow.hint(`Move it with "memnox login --url ${options.url}".`);
    return existing;
  }

  const move = await from
    .confirm(`${flow.prompt}Move this machine to ${options.url}?`, false)
    .catch(() => false);
  if (!move) {
    flow.aside(`Staying on ${existing.baseUrl}.`);
    return existing;
  }

  /* Before the new credential is minted, while the old one is still on disk:
     revoking an agent takes the account that sponsored it, and enrolling first
     would replace that account with one that cannot. A move that left five live
     credentials in the workspace somebody thought they had left is the failure
     this ordering exists to prevent. */
  const handed = await handBack(context, flow, home, existing, from.offboard);

  try {
    const connected = await connect(context, home, options, flow, seams);
    flow.aside(context.style.dim('That is the only approval this run needs.'));
    return connected.account;
  } catch (err) {
    /* Said rather than left to be worked out from a stack trace. The agents are
       back to their own configs and the credential on disk is still the old
       one, so the machine is where it started with nothing governing the agents
       that were handed back. Running this again is the whole recovery, and
       somebody has to be told that rather than discovering it tomorrow. */
    if (handed > 0) {
      flow.aside(
        context.style.warn(
          `${handed === 1 ? '1 agent is' : `${handed} agents are`} back to their own configs and are not under Memnox. Run this again to finish the move.`,
        ),
      );
    }
    flow.aside(`This machine is still enrolled in ${existing.workspaceId}.`);
    throw err;
  }
}

/**
 * Every agent the plane being left was holding, handed back to it.
 *
 * Each config goes back to what it said before Memnox touched it, so the
 * onboarding below takes its backup from a file that points at nothing of ours.
 * Onboarding straight over the old entry would have backed up a config already
 * pointed at the other plane, and `offboard` would then put somebody back there
 * rather than where they started.
 *
 * A revocation the old plane did not answer is named rather than treated as
 * done: the config is restored either way, and a credential nobody could take
 * back is a row in a workspace somebody has to go and revoke by hand.
 */
async function handBack(
  context: CliContext,
  flow: Flow,
  home: string,
  leaving: Account,
  offboard: typeof offboardAgent,
): Promise<number> {
  const held = (await listRecords(home)).filter((record) =>
    onboardedInto(record, leaving),
  );
  if (held.length === 0) return 0;

  flow.step(
    `Handing ${held.length === 1 ? '1 agent' : `${held.length} agents`} back to ${workspaceShown(leaving.workspaceId)}`,
  );
  let handed = 0;
  for (const record of held) {
    const result = await offboard(home, leaving, record.agentId).catch(() => null);
    if (result === null || result.outcome !== OFFBOARD.DONE) {
      flow.aside(
        context.style.warn(
          `${record.product} could not be handed back: ${result?.because ?? 'the attempt failed'}`,
        ),
      );
      continue;
    }
    handed += 1;
    flow.aside(
      result.revoked === true
        ? `${record.product} is back to its own config, and its credential is revoked.`
        : context.style.warn(
            `${record.product} is back to its own config. ${workspaceShown(leaving.workspaceId)} did not answer, so revoke ${record.machineId} there.`,
          ),
    );
  }
  return handed;
}

/**
 * One agent: what it reaches, what to call it, and whether to put it to work.
 *
 * In that order, because each answer needs the one above it. Somebody deciding
 * whether to onboard an agent that can read `~/.aws/credentials` is making a
 * different decision from one that can only read this checkout, and a name
 * chosen before seeing either is a name that says nothing.
 */
async function offerOne(
  context: CliContext,
  flow: Flow,
  home: string,
  agent: SnapshotAgent,
  names: AgentNames,
  report: DiscoveryReport,
  snapshot: EnvironmentSnapshot,
  config: Manageable,
  account: Account,
  ask: NameAsker,
  confirm: Confirm,
): Promise<Result> {
  const { style } = context;
  const current = displayName(names, agent);
  describeAgent(flow, context, home, agent, names, report, snapshot, config);

  /* No name line in the question: it is in the block above, with what the agent
     reaches under it. Repeating it here read as two agents rather than one. */
  const wanted = await ask({
    shown: current,
    lines: [],
    gutter: flow.prompt,
    because: `Call it something ${workspaceShown(account.workspaceId)} will recognise`,
  }).catch(() => null);

  let name = current;
  if (wanted !== null && isYesOrNo(wanted)) {
    /* Almost certainly an answer meant for the question below this one. Nobody
       names an agent "y", and taking it would name one "y" and then never ask
       the question the person thought they were answering. */
    flow.aside(
      style.warn(`Read "${wanted}" as an answer to the next question, not a name.`),
    );
  } else if (wanted !== null) {
    const written = await setName(home, agent.id, wanted);
    if (written.ok && written.name !== undefined) name = written.name;
    else {
      flow.aside(
        style.warn(`Kept "${current}": ${written.because ?? 'that name was refused'}.`),
      );
    }
  }

  const yes = await confirm(`${flow.prompt}Put ${name} under Memnox now?`).catch(
    () => false,
  );
  if (!yes) {
    flow.aside(style.dim(`${name} was left alone.`));
    return { name, status: STATUS.SKIPPED, because: 'you said no' };
  }

  const result = await onboardAgent(
    home,
    process.cwd(),
    account,
    agent.id,
    agent.kind,
    reportOn(flow),
    name,
  );
  if (result.outcome !== ONBOARD.DONE || result.record === undefined) {
    /* Named and carried on rather than thrown. One agent whose config cannot be
       rewritten must not cost somebody the answers they already gave. */
    const because = result.because ?? 'no reason given';
    flow.aside(style.warn(`Did not onboard ${name}: ${because}`));
    return { name, status: STATUS.FAILED, because };
  }
  flow.box(`${name} is under Memnox`, [
    `${style.dim('known as'.padEnd(LABEL_WIDTH))}${name} in ${workspaceShown(account.workspaceId)}`,
    /* Said per agent rather than once at the top, because this is the line that
       makes the run's promise checkable: nobody had to answer anything. */
    `${style.dim('enrolled'.padEnd(LABEL_WIDTH))}${
      result.approvedInBrowser === true
        ? 'approved in your browser'
        : "on this machine's own credential, no browser"
    }`,
    `${style.dim('config'.padEnd(LABEL_WIDTH))}${underHome(result.record.configPath, home)}`,
    `${style.dim('backup'.padEnd(LABEL_WIDTH))}${underHome(result.record.backupPath, home)}`,
  ]);
  return { name, status: STATUS.ONBOARDED };
}

/** The one question enrolment can ask, drawn on the same rail as the rest. */
function reportOn(flow: Flow): EnrolReporter {
  return {
    approve: ({ what, url, code, because, deadline }) => {
      flow.step(`Approve ${what} in your browser`, url);
      if (code !== undefined) flow.value('Your code', code);
      /* The reason first. This run said it would not need a browser, so one
         opening without a sentence in front of it reads as a broken promise. */
      flow.aside(because);
      flow.aside(
        `Waiting for you to answer it, for ${deadline}. Ctrl+C stops, and nothing will change.`,
      );
    },
  };
}

/** A prompt meant for the next question, typed one question early. */
function isYesOrNo(answer: string): boolean {
  return ['y', 'n', 'yes', 'no'].includes(answer.trim().toLowerCase());
}

/**
 * What this agent is, what governs it, and what it can already reach.
 *
 * Everything here was proved by the scan and none of it is a claim about what
 * Memnox will do: the id is what a ledger row will say, the config path is the
 * file that would be rewritten, and the servers are the ones already in it. A
 * person deciding whether to onboard something needs the facts about it more
 * than a summary of them.
 */
function describeAgent(
  flow: Flow,
  context: CliContext,
  home: string,
  agent: SnapshotAgent,
  names: AgentNames,
  report: DiscoveryReport,
  snapshot: EnvironmentSnapshot,
  config: Manageable,
): void {
  const { style } = context;
  const rows: string[] = [style.dim(`${agent.kind}${version(agent)}`)];
  const put = (label: string, value: string): void => {
    rows.push(`${style.dim(label.padEnd(LABEL_WIDTH))}${value}`);
  };

  put('id', agent.id);
  /* The one file onboarding would rewrite, not every file the detector read. A
     detector proves an agent from several and only one of them would change. */
  if (config.path !== undefined) put('config', underHome(config.path, home));

  const servers = snapshot.servers.filter((server) => server.agentIds.includes(agent.id));
  put(
    'mcp',
    servers.length === 0
      ? 'no servers configured'
      : /* The tool count only where something counted them: `--no-probe` leaves
           it at zero, and "github (0)" reads as a server with no tools. */
        servers
          .map((server) =>
            server.tools.length === 0
              ? server.name
              : `${server.name} (${server.tools.length})`,
          )
          .join(', '),
  );

  for (const line of reachOf(agent, report, home)) put(line.label, line.value);
  if (config.because !== undefined) {
    rows.push(style.warn(`cannot manage: ${config.because}`));
  }
  flow.box(displayName(names, agent), rows);
}

const LABEL_WIDTH = 12;

/**
 * What this agent can already reach, in the words the scan proved.
 *
 * The sensitive resources first and by name, because "filesystem, shell" is a
 * category and `~/.aws/credentials` is the thing somebody reacts to. Names and
 * paths only: nothing here opens a file to describe it.
 */
function reachOf(
  agent: SnapshotAgent,
  report: DiscoveryReport,
  home: string,
): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  const surfaces = [...new Set(agent.surfaces.map((surface) => surface.kind))];
  if (surfaces.length > 0) lines.push({ label: 'can use', value: surfaces.join(', ') });

  const sensitive = report.resources
    .filter((resource) => resource.sensitivity !== SENSITIVITY.ORDINARY)
    .filter((resource) => resource.reachableBy.some((ref) => ref.id === agent.id))
    .map((resource) => underHome(resource.path ?? resource.id, home));
  if (sensitive.length > 0) {
    const more = sensitive.length > SHOWN ? ` and ${sensitive.length - SHOWN} more` : '';
    lines.push({
      label: 'can reach',
      value: `${sensitive.slice(0, SHOWN).join(', ')}${more}`,
    });
  }
  if (lines.length === 0) {
    lines.push({ label: 'can reach', value: 'nothing this scan could prove' });
  }
  return lines;
}

/** Enough to make the point without the block becoming the screen. */
const SHOWN = 4;

/**
 * Every agent that was offered, and what became of it.
 *
 * One row each, including the ones nothing happened to. A summary that listed
 * only the successes would let an agent somebody answered a question about
 * vanish from the screen, which is how a person ends a run believing five
 * agents are governed when two are.
 */
const STATUS = {
  ONBOARDED: 'onboarded',
  SKIPPED: 'skipped',
  ALREADY: 'already',
  /** Onboarded into a control plane that is not the one this run is pointed at. */
  ELSEWHERE: 'elsewhere',
  CANNOT: 'cannot',
  FAILED: 'failed',
} as const;

interface Result {
  name: string;
  status: (typeof STATUS)[keyof typeof STATUS];
  because?: string;
}

const STATUS_WIDTH = 11;

function summarize(
  context: CliContext,
  flow: Flow,
  account: Account,
  results: readonly Result[],
  reported: boolean,
): void {
  const { style } = context;
  const done = results.filter((each) => each.status === STATUS.ONBOARDED);
  const width = Math.max(...results.map((each) => each.name.length), 'Agent'.length);

  flow.box(`In ${workspaceShown(account.workspaceId)}`, [
    style.dim(`${'Agent'.padEnd(width)}  ${'Status'.padEnd(STATUS_WIDTH)}Reason`),
    /* Padded before styling: an escape sequence has width nobody can see but
       padEnd can, and padding after colouring left every column joined up. */
    ...results.map(
      (each) =>
        `${each.name.padEnd(width)}  ` +
        `${mark(context, each.status, each.status.padEnd(STATUS_WIDTH))}` +
        style.dim(each.because ?? ''),
    ),
  ]);

  flow.close(
    done.length === 0
      ? 'Nothing was onboarded, and nothing on this machine changed.'
      : style.ok(
          `${done.length === 1 ? '1 agent is' : `${done.length} agents are`} under Memnox.`,
        ),
  );

  const elsewhere = results.filter((each) => each.status === STATUS.ELSEWHERE);
  if (elsewhere.length > 0) {
    flow.hint(
      `${elsewhere.length} belong to another workspace. Hand one back with "memnox agents offboard <name>", then run this again.`,
    );
  }
  const stuck = results.filter((each) => each.status === STATUS.CANNOT);
  if (stuck.length > 0) {
    flow.hint(
      `${stuck.length} could not be managed from here. "memnox agents status <name>" says what was found.`,
    );
  }
  if (done.length === 0) return;
  /* Named rather than assumed. An agent this run onboarded reaches the console
     through the scan it just sent, so a run that could not send one has to say
     the page will be empty for now instead of leaving somebody to find out. */
  if (!reported) {
    flow.hint(
      'This scan did not reach the control plane, so the Agents page will fill on the next sync.',
    );
  }
  /* Said here because this is the moment somebody wonders whether they have
     just handed something more authority than it had. */
  flow.hint('Authority is unchanged: what each may do is still decided on this machine.');
  flow.hint('Write the rules that decide it with "memnox protect".');
  flow.hint('Take one back out with "memnox agents offboard <name>".');
}

/** Which control plane a record was written against, for the row that says so. */
function wherePlane(record: { workspaceId?: string; baseUrl?: string }): string {
  const which =
    record.workspaceId === undefined
      ? 'another workspace'
      : workspaceShown(record.workspaceId);
  return record.baseUrl === undefined
    ? `under ${which}`
    : `under ${which} at ${record.baseUrl}`;
}

/** Takes the already-padded word, so the colour never changes the column width. */
function mark(context: CliContext, status: Result['status'], padded: string): string {
  const { style } = context;
  if (status === STATUS.ONBOARDED) return style.ok(padded);
  if (status === STATUS.FAILED || status === STATUS.CANNOT) return style.warn(padded);
  if (status === STATUS.ELSEWHERE) return style.warn(padded);
  return style.dim(padded);
}

/**
 * Yes or no, asked wherever the caller says. Injected, so a test needs no terminal.
 *
 * The default is the caller's, because the two questions here are not the same
 * shape. "Put this agent under Memnox" is what somebody ran the command to do,
 * so Enter is yes; "move this machine to another control plane" undoes an
 * enrolment and offboards what it was holding, so Enter is no.
 */
type Confirm = (question: string, fallback?: boolean) => Promise<boolean>;

const confirmOnTerminal: Confirm = async (question, fallback = true) => {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question}  ${fallback ? '[Y/n]' : '[y/N]'} `);
    const said = answer.trim().toLowerCase();
    if (said === '') return fallback;
    return said.startsWith('y');
  } catch {
    // Ctrl+D, or a stdin that closed. Neither is consent.
    return false;
  } finally {
    rl.close();
  }
};

function version(agent: SnapshotAgent): string {
  return agent.version === undefined ? '' : ` ${agent.version}`;
}
