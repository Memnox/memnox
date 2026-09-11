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
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';
import { connectMachine, DEFAULT_BASE_URL, type ConnectSeams } from '../sync/connect';
import { manageable, ONBOARD, onboardAgent, type Manageable } from '../agents/onboard';
import { readRecord } from '../agents/onboarding';
import { displayName, readNames, setName, type AgentNames } from '../agents/names';
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
        const { out, style } = context;
        const flow = new Flow(out, style);
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
            describeAgent(context, agent, names, report, snapshot, config);
            results.push({
              name: displayName(names, agent),
              status: STATUS.CANNOT,
              because: config.because,
            });
            continue;
          }
          const outcome = await offerOne(
            context,
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
  const { out, style } = context;
  const current = displayName(names, agent);
  describeAgent(context, agent, names, report, snapshot, config);

  /* No name line: it is in the block above, with what the agent reaches under
     it. Repeating it here read as two agents rather than one question. */
  const wanted = await ask({
    shown: current,
    lines: [`This is the name ${account.workspaceId} will show for it.`],
    because: `Call it something ${account.workspaceId} will recognise`,
  }).catch(() => null);

  let name = current;
  if (wanted !== null && isYesOrNo(wanted)) {
    /* Almost certainly an answer meant for the question below this one. Nobody
       names an agent "y", and taking it would name one "y" and then never ask
       the question the person thought they were answering. */
    out.note(
      style.warn(`  Read "${wanted}" as an answer to the next question, not a name.`),
    );
  } else if (wanted !== null) {
    const written = await setName(home, agent.id, wanted);
    if (written.ok && written.name !== undefined) name = written.name;
    else {
      out.note(
        style.warn(`  Kept "${current}": ${written.because ?? 'that name was refused'}.`),
      );
    }
  }

  const yes = await confirm(`  Put ${name} under Memnox now?`).catch(() => false);
  if (!yes) return { name, status: STATUS.SKIPPED, because: 'you said no' };

  const result = await onboardAgent(
    home,
    process.cwd(),
    account,
    agent.id,
    agent.kind,
    out,
    name,
  );
  if (result.outcome !== ONBOARD.DONE || result.record === undefined) {
    /* Named and carried on rather than thrown. One agent whose config cannot be
       rewritten must not cost somebody the answers they already gave. */
    const because = result.because ?? 'no reason given';
    out.note(style.warn(`  Did not onboard ${name}: ${because}`));
    return { name, status: STATUS.FAILED, because };
  }
  out.note(`  ${style.ok('onboarded')} ${name}`);
  out.note(`    ${style.dim(`config updated: ${result.record.configPath}`)}`);
  out.note(`    ${style.dim(`backup saved:   ${result.record.backupPath}`)}`);
  out.note(`    ${style.dim(`known as:       ${name} in ${account.workspaceId}`)}`);
  return { name, status: STATUS.ONBOARDED };
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
  context: CliContext,
  agent: SnapshotAgent,
  names: AgentNames,
  report: DiscoveryReport,
  snapshot: EnvironmentSnapshot,
  config: Manageable,
): void {
  const { out, style } = context;
  out.note('');
  out.note(
    style.bold(`  ${displayName(names, agent)}`) +
      style.dim(`  ${agent.kind}${version(agent)}`),
  );
  row(context, 'id', agent.id);
  /* The one file onboarding would rewrite, not every file the detector read. A
     detector proves an agent from several and only one of them would change. */
  if (config.path !== undefined) row(context, 'config', config.path);

  const servers = snapshot.servers.filter((server) => server.agentIds.includes(agent.id));
  row(
    context,
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

  for (const line of reachOf(agent, report)) {
    const at = line.indexOf(':');
    row(context, line.slice(0, at), line.slice(at + 1).trim());
  }
  if (config.because !== undefined) {
    out.note(`    ${style.warn(`cannot manage: ${config.because}`)}`);
  }
}

const LABEL_WIDTH = 11;

function row(context: CliContext, label: string, value: string): void {
  context.out.note(`    ${context.style.dim(label.padEnd(LABEL_WIDTH))}${value}`);
}

/**
 * What this agent can already reach, in the words the scan proved.
 *
 * The sensitive resources first and by name, because "filesystem, shell" is a
 * category and `~/.aws/credentials` is the thing somebody reacts to. Names and
 * paths only: nothing here opens a file to describe it.
 */
function reachOf(agent: SnapshotAgent, report: DiscoveryReport): string[] {
  const lines: string[] = [];
  const surfaces = [...new Set(agent.surfaces.map((surface) => surface.kind))];
  if (surfaces.length > 0) lines.push(`can use: ${surfaces.join(', ')}`);

  const sensitive = report.resources
    .filter((resource) => resource.sensitivity !== SENSITIVITY.ORDINARY)
    .filter((resource) => resource.reachableBy.some((ref) => ref.id === agent.id))
    .map((resource) => resource.path ?? resource.id);
  if (sensitive.length > 0) {
    lines.push(`can reach: ${sensitive.slice(0, SHOWN).join(', ')}`);
    if (sensitive.length > SHOWN) {
      lines.push(`and ${sensitive.length - SHOWN} more`);
    }
  }
  if (lines.length === 0) lines.push('nothing this scan could prove');
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

  context.out.note('');
  flow.box(`In ${account.workspaceId}`, [
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
