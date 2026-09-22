import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  AGENT_FLAG,
  CloudLeases,
  CloudNotes,
  desktopNotice,
  digest,
  NOTE_KIND,
  LeaseRegistry,
  MEMNOX_HOME,
  markActivity,
  renderNotes,
  SqliteEventStore,
  SESSION_VAR,
  upcomingRegion,
  WHOLE_FILE,
  type SessionNote,
  type WrittenRegion,
} from '@memnox/core';
import {
  afterEdit,
  canAskPerson,
  claimEditDetailed,
  EDIT_HOOK_EVENT,
  EDIT_HOOK_WAIT_MS,
  EDIT_IDLE_MINUTES,
  EDIT_TOOLS,
  editAsk,
  editOf,
  type EditIntent,
  type EditRefusal,
} from './edit-hook';
import {
  agentDenial,
  agentEditsOf,
  type AgentEdits,
  beforeEdit,
  EDIT_HOST,
  endedSessionOf,
} from './agent-edits';
import { buildLeases, log, readStdin } from './seam-runtime';
import {
  activityOf,
  SESSION_MOMENT,
  sessionAnswer,
  sessionEventOf,
  type SessionEvent,
} from './session-events';
import { DEFAULT_AGENT_NAME, ENV_AGENT_NAME } from './tool-hook.constants';

/**
 * The hook an editor runs before it writes a file and when a session ends.
 *
 * Silent and exit zero means go ahead, which is also what anything unreadable
 * gets: a hook that failed has ruled on nothing, and refusing every write because
 * a register could not be read would be the collision it exists to prevent, only
 * on every file at once.
 */
async function main(): Promise<void> {
  /* Which agent this hook was installed for, written into its command line, so
     a refusal on another machine names Cursor or Codex rather than a guess. The
     environment wins, which is what `memnox run` sets. */
  const named = agentFlag(process.argv.slice(2));
  if (named !== null && process.env[ENV_AGENT_NAME] === undefined) {
    process.env[ENV_AGENT_NAME] = named;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    // Not a payload this hook was written for, so it says nothing about it.
    return;
  }

  const ended = endedSessionOf(payload);
  if (ended !== null) {
    /* Everything the session held, on this machine and in the workspace, let go
       at once, so the next agent does not wait out a window nobody is using. */
    await new LeaseRegistry(homedir()).releaseSession(ended, new Date().toISOString());
    await new CloudLeases(homedir()).releaseSession({
      agent: process.env[ENV_AGENT_NAME] ?? DEFAULT_AGENT_NAME,
      sessionId: process.env[SESSION_VAR] ?? ended,
      pid: process.pid,
    });
    return;
  }

  /* Both can be true of one payload: Windsurf's `post_write_code` is an edit
     already written, to be claimed, and a tool that just returned, to be
     recorded. The claim goes first. */
  const found = agentEditsOf(payload);
  const pause = sessionEventOf(payload);
  if (found !== null) {
    const refusal = await claimAll(found, canAskPerson(payload));
    if (refusal !== null) {
      /* Windsurf reads a refusal from stderr on exit code 2; every other host
         reads it from stdout. */
      if (found.host === EDIT_HOST.WINDSURF) {
        process.stderr.write(`${refusal}\n`);
        process.exitCode = WINDSURF_BLOCK;
      } else {
        process.stdout.write(`${refusal}\n`);
      }
      return;
    }
    /* Cursor reads a permission hook's reply that is not JSON as one that
       blocks, so allowing says so in an empty object rather than in silence. */
    if (found.host === EDIT_HOST.CURSOR && found.moment === 'before') {
      process.stdout.write('{}\n');
    }
  }
  if (pause !== null) process.stdout.write(await atPause(pause));
}

/** The exit code Windsurf reads as "blocked", with the reason on stderr. */
const WINDSURF_BLOCK = 2;

/**
 * Claims every file a write touches, and answers with the refusal to give, in the
 * host's own words, or null where the write may go ahead.
 */
async function claimAll(found: AgentEdits, personThere: boolean): Promise<string | null> {
  /* Only Claude Code shows its person a prompt a hook asks for; Codex, Cursor,
     Gemini CLI and Windsurf are refused flat and name the command instead. */
  const agent = process.env[ENV_AGENT_NAME] ?? DEFAULT_AGENT_NAME;
  const asking =
    personThere && found.host === EDIT_HOST.PRE_TOOL_USE && agent === DEFAULT_AGENT_NAME;
  for (const edit of found.edits) {
    /* A Cursor write whose input says nothing about what it changes would be a
       claim on the whole file, which stops every other machine on every line of
       it. Nothing is taken then, and `afterFileEdit` claims the exact lines the
       moment they are written. */
    if (
      found.host === EDIT_HOST.CURSOR &&
      found.moment === 'before' &&
      edit.change === undefined
    ) {
      continue;
    }
    const refused = await claimOne(edit, found.moment === 'after');
    /* An edit already written cannot be refused. It is still claimed, so its
       lines are held against every other machine and a collision still reaches
       the people running both agents. */
    if (refused !== null && found.moment === 'before') {
      const leaseId = refused.leaseId;
      /* The person is right there: ask them, in their own prompt, rather than
         refuse and name a command. A yes lets the edit through, and the lines
         are taken over when it lands. */
      if (asking && leaseId !== undefined) {
        await rememberTakeover(homedir(), edit, leaseId);
        return editAsk(refused.asked ?? refused.reason);
      }
      return agentDenial(found.host, refused.reason);
    }
  }
  return null;
}

/** How long a person's yes stays good for the edit it was asked about. */
const TAKEOVER_WINDOW_MS = 10 * 60_000;

function takeoverMark(home: string, sessionId: string, file: string): string {
  return join(
    home,
    MEMNOX_HOME,
    'takeover',
    digest(`${sessionId}\u0000${file}`).slice(0, RENEW_MARK_CHARS),
  );
}

/** Which lease the person was asked about, for when the edit they allowed lands. */
async function rememberTakeover(
  home: string,
  edit: EditIntent,
  leaseId: string,
): Promise<void> {
  const mark = takeoverMark(home, edit.sessionId, fileOf(edit));
  try {
    await mkdir(dirname(mark), { recursive: true });
    await writeFile(mark, JSON.stringify({ leaseId }), 'utf8');
  } catch {
    // Without the mark the edit still lands; the lines are simply not taken over.
  }
}

/**
 * An edit the person allowed has landed: take the other agent's lines over, on the
 * record with why, and claim them for this session. The agent that held them is
 * told by the workspace. Nothing happens for an edit nobody was asked about.
 */
async function takeOverIfAllowed(
  home: string,
  pause: SessionEvent,
  agent: string,
): Promise<void> {
  if (pause.tool === undefined || !EDIT_TOOLS.includes(pause.tool)) return;
  const intent = editOf({
    hook_event_name: EDIT_HOOK_EVENT.PRE_TOOL_USE,
    tool_name: pause.tool,
    session_id: pause.sessionId,
    ...(pause.cwd === undefined ? {} : { cwd: pause.cwd }),
    tool_input: pause.input ?? {},
  });
  if (intent === null) return;
  const mark = takeoverMark(home, intent.sessionId, fileOf(intent));
  let leaseId: unknown;
  try {
    if (Date.now() - (await stat(mark)).mtimeMs > TAKEOVER_WINDOW_MS) return;
    leaseId = (JSON.parse(await readFile(mark, 'utf8')) as { leaseId?: unknown }).leaseId;
    await rm(mark, { force: true });
  } catch {
    // Nobody was asked about this edit.
    return;
  }
  if (typeof leaseId !== 'string') return;
  await new CloudLeases(home)
    .free(
      leaseId,
      {
        agent,
        sessionId: process.env[SESSION_VAR] ?? intent.sessionId,
        pid: process.pid,
      },
      `the person at ${agent} on ${hostname()} chose to take these lines over`,
    )
    .catch(() => undefined);
  await claimOne(intent, true);
}

/**
 * A tool call returned or a turn ended: write down what the agent did, and hand it
 * whatever is waiting for its session. What it answers is what the host reads.
 */
async function atPause(pause: SessionEvent): Promise<string> {
  const home = homedir();
  const agent = process.env[ENV_AGENT_NAME] ?? DEFAULT_AGENT_NAME;
  const rows = activityOf(pause, agent, undefined, new Date().toISOString());
  if (rows.length > 0) {
    try {
      const ledger = SqliteEventStore.forHome(home);
      try {
        for (const row of rows) await ledger.append(row);
      } finally {
        ledger.close();
      }
      await markActivity(home);
    } catch {
      // A lost row is a lost row; the agent's tool call already happened.
    }
  }
  if (pause.moment === SESSION_MOMENT.AFTER_TOOL) {
    await takeOverIfAllowed(home, pause, agent);
  }
  const notes = await notesAt(pause, home, agent);
  /* A note about a collision is also put on the person's screen: their agent
     reads it now, and they are usually in another window. */
  const collided = notes.filter((note) => note.kind === NOTE_KIND.COORDINATION);
  if (collided.length > 0 && pause.host !== EDIT_HOST.WINDSURF) {
    desktopNotice(collided.map((note) => note.message).join(' '));
  }
  const answer = sessionAnswer(pause, notes.length === 0 ? null : renderNotes(notes));
  return answer === '' ? '' : `${answer}\n`;
}

/** Takes the lease for one write, narrowed to the lines it changes. */
async function claimOne(edit: EditIntent, written: boolean): Promise<EditRefusal | null> {
  const leases = buildLeases(edit.cwd ?? process.cwd(), {
    sessionId: edit.sessionId,
    waitMs: EDIT_HOOK_WAIT_MS,
    /* The lines and function this edit is about to change, read from the edit
       itself: two agents on different machines in one file only meet where
       their edits do. */
    region: () => (written ? regionWritten(edit) : regionOfEdit(edit)),
  });
  if (leases === undefined) return null;
  return claimEditDetailed(edit, leases);
}

/** How often a session asks for notes after a tool call, at most. */
const NOTES_EVERY_MS = 10_000;

/**
 * What to hand this session at this pause.
 *
 * After a tool call, at most every ten seconds and alongside the renewal rather
 * than after it, because an agent runs tools in bursts and a request on each one
 * would make every call feel slower. At the end of a turn, only a person's words:
 * a note handed over then makes the agent carry on, and Memnox's own notes are
 * not worth waking a finished agent for, so they wait for its next call or the
 * person's next prompt. When the person asks for something, everything waiting.
 */
async function notesAt(
  pause: SessionEvent,
  home: string,
  agent: string,
): Promise<SessionNote[]> {
  const inbox = new CloudNotes(home);
  /* Windsurf reads nothing back from its hooks, so a note collected here would
     be marked delivered and never seen. It is left for the MCP proxy. */
  const deliverable = pause.host !== EDIT_HOST.WINDSURF;
  if (!deliverable) {
    await keepHoldsAlive(home, agent, process.env[SESSION_VAR] ?? pause.sessionId);
    return [];
  }
  if (pause.moment === SESSION_MOMENT.TURN_END) {
    return inbox.collect(agent, pause.sessionId, [NOTE_KIND.OPERATOR]);
  }
  if (pause.moment === SESSION_MOMENT.PROMPT) {
    return inbox.collect(agent, pause.sessionId);
  }
  /* Under the name the holds were taken under: the session `memnox run` set
     where there is one, which is what the edit hook files them by too. */
  const holder = process.env[SESSION_VAR] ?? pause.sessionId;
  const [, notes] = await Promise.all([
    keepHoldsAlive(home, agent, holder),
    due(home, 'notes', pause.sessionId, NOTES_EVERY_MS).then((ask) =>
      ask ? inbox.collect(agent, pause.sessionId) : [],
    ),
  ]);
  return notes;
}

/**
 * Whether this session's `what` is due again, marking it done when it is.
 *
 * A file per session, because each hook is its own short process and has nowhere
 * else to remember when it last asked. A mark that cannot be read or written only
 * means asking again.
 */
async function due(
  home: string,
  what: string,
  sessionId: string,
  everyMs: number,
): Promise<boolean> {
  const mark = join(
    home,
    MEMNOX_HOME,
    what,
    digest(sessionId).slice(0, RENEW_MARK_CHARS),
  );
  try {
    if (Date.now() - (await stat(mark)).mtimeMs < everyMs) return false;
  } catch {
    // Never marked, which is the first time this session asks.
  }
  try {
    await mkdir(dirname(mark), { recursive: true });
    await writeFile(mark, new Date().toISOString(), 'utf8');
  } catch {
    // Without the mark this simply asks again next time.
  }
  return true;
}

/** How often a working session renews what it holds, at most. */
const RENEW_EVERY_MS = 60_000;

/**
 * The session is still working, so what it holds lasts another few minutes.
 *
 * At most once a minute, marked in a file per session, because this runs after
 * every tool call and a renewal each time would be a request each time. Best
 * effort in both directions: a renewal that does not land is a hold that lapses a
 * few minutes early, which is the cost the short window already accepts.
 */
async function keepHoldsAlive(
  home: string,
  agent: string,
  sessionId: string,
): Promise<void> {
  if (!(await due(home, 'renewed', sessionId, RENEW_EVERY_MS))) return;
  const now = new Date().toISOString();
  await new LeaseRegistry(home)
    .renewSession(sessionId, now, EDIT_IDLE_MINUTES)
    .catch(() => 0);
  await new CloudLeases(home)
    .renewSession({ agent, sessionId, pid: process.pid }, EDIT_IDLE_MINUTES)
    .catch(() => undefined);
}

/** Enough of a session's digest to name its mark without naming the session. */
const RENEW_MARK_CHARS = 16;

/** `--agent cursor`, where the installed command names one. */
function agentFlag(args: readonly string[]): string | null {
  const at = args.indexOf(AGENT_FLAG);
  if (at === -1) return null;
  const value = args[at + 1];
  return value === undefined || value.startsWith('-') ? null : value;
}

/** What an edit already on disk changed, found by taking it back out. */
async function regionWritten(edit: EditIntent): Promise<WrittenRegion> {
  const change = edit.change;
  if (change === undefined) return WHOLE_FILE;
  let after: string;
  try {
    after = await readFile(fileOf(edit), 'utf8');
  } catch {
    return WHOLE_FILE;
  }
  const before = beforeEdit(after, change);
  if (before === null) return WHOLE_FILE;
  return upcomingRegion(fileOf(edit), before, after);
}

function fileOf(edit: EditIntent): string {
  return isAbsolute(edit.path)
    ? edit.path
    : resolve(edit.cwd ?? process.cwd(), edit.path);
}

/** What this edit touches, or the whole file wherever that cannot be told. */
async function regionOfEdit(edit: EditIntent): Promise<WrittenRegion> {
  const change = edit.change;
  if (change === undefined) return WHOLE_FILE;
  const file = isAbsolute(edit.path)
    ? edit.path
    : resolve(edit.cwd ?? process.cwd(), edit.path);
  let before: string;
  try {
    before = await readFile(file, 'utf8');
  } catch {
    // A new file has nothing to be narrower than: all of it is being written.
    return WHOLE_FILE;
  }
  const after = afterEdit(before, change);
  if (after === null) return WHOLE_FILE;
  return upcomingRegion(file, before, after);
}

main().catch((err: unknown) => {
  // A hook that throws must not read as a refusal; it ruled on nothing and says so.
  log(`edit hook failed, ruling on nothing: ${String(err)}`);
});
