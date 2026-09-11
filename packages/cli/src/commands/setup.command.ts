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
import { manageable, ONBOARD, onboardAgent, type Manageable } from '../agents/onboard';
import type { EnrolReporter } from '../agents/enrol-agent';
import { readRecord } from '../agents/onboarding';
import {
  displayName,
  readNames,
  setName,
  workspaceShown,
  type AgentNames,
} from '../agents/names';
import { askOnTerminal, type NameAsker } from '../agents/name-prompt';

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
): void {
  program
    .command('setup')
    .description(
      'Log in, see what your agents can reach, and put them to work one by one',
    )
    .option('--url <base>', 'the control plane', DEFAULT_BASE_URL)
    .option('--enforce', 'start in enforce rather than observe')
    .option('--no-open', 'print the code and the URL instead of opening a browser')
    .option('--no-probe', 'do not start any MCP server to ask what it offers')
    .action(
      async (options: {
        url: string;
        enforce?: boolean;
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
          connectSeams,
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
          if (already !== null) {
            results.push({
              name: displayName(names, agent),
              status: STATUS.ALREADY,
              because: 'onboarded earlier',
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

        summarize(context, flow, account, results);
      },
    );
}

/** Enrolled already, or enrolled now. Either way the rest of the run has one. */
async function connectedAccount(
  context: CliContext,
  home: string,
  options: { url: string; enforce?: boolean; open: boolean },
  flow: Flow,
  connect: typeof connectMachine,
  seams: ConnectSeams,
): Promise<Account> {
  const existing = await readAccount(home);
  if (existing !== null) {
    flow.step('Already connected', `${existing.workspaceId} at ${existing.baseUrl}`);
    return existing;
  }
  const connected = await connect(context, home, options, flow, seams);
  /* Said once, here, because it is the promise the rest of the run keeps: a
     person answered a browser for this machine and will not be asked again. */
  flow.aside(context.style.dim('That is the only approval this run needs.'));
  return connected.account;
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

  const stuck = results.filter((each) => each.status === STATUS.CANNOT);
  if (stuck.length > 0) {
    flow.hint(
      `${stuck.length} could not be managed from here. "memnox agents status <name>" says what was found.`,
    );
  }
  if (done.length === 0) return;
  /* Said here because this is the moment somebody wonders whether they have
     just handed something more authority than it had. */
  flow.hint('Authority is unchanged: what each may do is still decided on this machine.');
  flow.hint('Write the rules that decide it with "memnox protect".');
  flow.hint('Take one back out with "memnox agents offboard <name>".');
}

/** Takes the already-padded word, so the colour never changes the column width. */
function mark(context: CliContext, status: Result['status'], padded: string): string {
  const { style } = context;
  if (status === STATUS.ONBOARDED) return style.ok(padded);
  if (status === STATUS.FAILED || status === STATUS.CANNOT) return style.warn(padded);
  return style.dim(padded);
}

/** Yes or no, asked wherever the caller says. Injected, so a test needs no terminal. */
type Confirm = (question: string) => Promise<boolean>;

const confirmOnTerminal: Confirm = async (question) => {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question}  [Y/n] `);
    // Enter means yes: somebody who ran this command came here to say yes.
    return !answer.trim().toLowerCase().startsWith('n');
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
