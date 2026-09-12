import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  discoverDefinitions,
  fleetBudgets,
  HOLD_ANSWER,
  isEnforcementMode,
  loadOrCreateConfig,
  MEMNOX_HOME,
  NodeFindingsStore,
  NodeMachineReader,
  NodeSnapshotStore,
  PendingApprovals,
  readAcceptedSkills,
  readBudgets,
  reviewSkills,
  saveConfig,
  SqliteEventStore,
  windowHoursOf,
  writeFleetSpend,
  writeAccount,
  type Account,
  type EnforcementMode,
  type HoldAnswer,
  type SkillFinding,
} from '@memnox/core';
import { CLI_VERSION } from '../defaults';
import { readAccount } from '@memnox/core';
import { orgPolicyPath, PULL_OUTCOME, pullBundle, type PullResult } from './bundle';
import { CloudUnreachable } from './client';
import {
  pushCensus,
  pushEvents,
  pushFindings,
  pushSkills,
  PUSH_OUTCOME,
  type PushResult,
} from './push';
import { callCloud } from './client';
import { kindOf, listRecords } from '../agents/onboarding';

/**
 * One pass: pull the rules, send what happened, say you are alive.
 *
 * Pull first, always. A machine that has just been given a stricter rule set
 * should be governed by it before it reports anything it did under the old one.
 */

/** Often enough that a new rule lands in a minute; an unchanged bundle is a 304. */
const HEARTBEAT_MS = 60_000;

/** Where it backs off to while the control plane is unreachable. */
const BACKOFF_MS = 15 * 60_000;

export interface Pass {
  pull?: PullResult;
  push?: PushResult;
  /** What this machine can do, sent once per scan. Absent when no scan is kept. */
  census?: PushResult;
  /** What that scan found wrong. Absent when `doctor` has never run here. */
  findings?: PushResult;
  /** Skills the agents here wrote for themselves. Absent when none changed. */
  skills?: PushResult;
  /** Set when nothing could be reached, which is not an error worth printing. */
  unreachable?: boolean;
  /** True once the credential is gone: stop until somebody logs in again. */
  revoked?: boolean;
}

export async function onePass(home: string): Promise<Pass> {
  const account = await readAccount(home);
  // Not logged in: no call is made at all, which is the whole promise.
  if (account === null) return {};

  try {
    const pull = await pullBundle(home, account, await heldHash(home));
    if (pull.outcome === PULL_OUTCOME.REVOKED) return { pull, revoked: true };

    const ledger = SqliteEventStore.forHome(home);
    let push: PushResult;
    try {
      push = await pushEvents(home, account, ledger);
    } finally {
      ledger.close();
    }
    if (push.outcome === PUSH_OUTCOME.REVOKED) return { pull, push, revoked: true };

    /* After the actions, because the actions are what somebody is waiting on and a
       census is hundreds of rows that will be just as true next minute. */
    const census = await pushCensus(
      home,
      account,
      await new NodeSnapshotStore(join(home, MEMNOX_HOME)).latest(),
    );
    if (census.outcome === PUSH_OUTCOME.REVOKED) {
      return { pull, push, census, revoked: true };
    }

    /* After the census, and last of the three, for the same reason the census
       comes after the actions: this is the least time-critical of them. A
       finding is about how this machine is configured, which is as true in a
       minute as it is now. */
    const findings = await pushFindings(
      home,
      account,
      await new NodeFindingsStore(join(home, MEMNOX_HOME)).latest(),
    );
    if (findings.outcome === PUSH_OUTCOME.REVOKED) {
      return { pull, push, census, findings, revoked: true };
    }

    /* Last, and reviewed here rather than read from something kept.
       Unlike a scan, this is a walk of a few directories and a digest of what
       is in them — cheap enough to take every pass, and it has to be: a skill
       an agent wrote between two runs is the thing this reports, so reading a
       snapshot taken before it would report the machine as it used to be. */
    const skills = await pushSkills(home, account, await skillReview(home));
    if (skills.outcome === PUSH_OUTCOME.REVOKED) {
      return { pull, push, census, findings, skills, revoked: true };
    }

    await beat(home, account, pull);
    return { pull, push, census, findings, skills };
  } catch (err) {
    if (err instanceof CloudUnreachable) return { unreachable: true };
    throw err;
  }
}

/**
 * What the agents here have taught themselves and what somebody installed into them,
 * against what anybody accepted.
 *
 * A failure is nothing to report rather than a failed pass: an unreadable
 * skills directory must not cost the heartbeat, which is what says this machine
 * is alive and carries the answers to calls it is holding.
 */
async function skillReview(
  home: string,
): Promise<{ findings: SkillFinding[]; takenAt: string } | null> {
  try {
    const found = await discoverDefinitions(new NodeMachineReader());
    const accepted = await readAcceptedSkills(home);
    return {
      findings: reviewSkills(found, accepted),
      takenAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * What this machine is running and which bundle it has applied.
 *
 * Reported after the bundle is in place rather than after it arrives: the
 * console's "which machines are behind" is only true if this says applied.
 */
/**
 * What this machine is holding, and what came back.
 *
 * The heartbeat is the only per-machine round trip there is, which makes it the only
 * place an answer can reach a machine nobody can walk over to. A held call on a VPS
 * at three in the morning is written to disk by the seam and named here; whatever the
 * control plane has decided about one comes back in the same exchange and is written
 * into the same file the seam is polling.
 *
 * Everything here is best effort. A control plane that cannot be reached must leave
 * the machine exactly as it was — still holding, still waiting, still able to be
 * answered from a terminal.
 */
async function beat(
  home: string,
  account: Awaited<ReturnType<typeof readAccount>>,
  pull: PullResult,
): Promise<void> {
  if (account === null) return;
  const running = (await loadOrCreateConfig(home)).mode;
  const applied =
    pull.outcome === PULL_OUTCOME.APPLIED ? pull.hash : await heldHash(home);

  const approvals = new PendingApprovals(home);
  const moment = new Date().toISOString();
  const holding = await approvals.list(moment);
  /* Only the ones counted across the workspace. A machine budget needs no round
     trip and must not pay for one. */
  const asking = fleetBudgets(await readBudgets(home)).filter(
    (budget) => windowHoursOf(budget) > 0,
  );

  const response = await callCloud<HeartbeatReply>({
    baseUrl: account.baseUrl,
    path: `/v1/workspaces/${account.workspaceId}/machines/${account.machineId}/heartbeat`,
    method: 'POST',
    token: account.token,
    body: {
      /* Every beat, not only at enrolment. The fleet page reads this column, so
         reporting it once meant it showed the version a machine was installed
         with for the rest of its life — a page about what is running that
         answered what used to be. */
      runtimeVersion: CLI_VERSION,
      ...(applied === undefined ? {} : { bundleHashApplied: applied }),
      /* What this machine is actually doing with a verdict, which is not always
         what the workspace set: the mode is applied here, and somebody at this
         box may have changed it. Reported so the fleet page can show the two
         apart instead of showing the request and calling it the state. */
      mode: running,
      /* Names only: the operation and what it is about. Never the arguments, which
         is the same rule the ledger follows and for the same reason. */
      budgets: asking.map((budget) => ({
        name: budget.name,
        actions: budget.actions,
        windowHours: windowHoursOf(budget),
      })),
      /* Which agent each principal this machine enrolled is for.
         The control plane hashes the hostname those were keyed on, so an
         agent onboarded before the enrolment door carried an id is a
         credential the console cannot join to anything the ledger recorded:
         the same agent shows up twice, once as a name somebody typed and
         once as an id nothing governs. This machine wrote both halves into
         its own onboarding records, so it says so rather than anybody
         re-enrolling to fix a missing word. Ignored where the link is
         already set. */
      agents: (await listRecords(home)).map((record) => ({
        machineId: record.machineId,
        agentId: record.agentId,
        agentKind: kindOf(record),
      })),
      holding: holding.map((each: (typeof holding)[number]) => ({
        id: each.id,
        agent: each.request.agent,
        operation: each.request.operation,
        reason: each.request.reason,
        askedAt: each.askedAt,
        expiresAt: each.expiresAt,
        ...(each.request.target === undefined ? {} : { target: each.request.target }),
      })),
    },
  });

  await applyAnswers(approvals, response.body?.answers ?? [], moment);
  await applyMode(home, account, running, response.body?.mode);

  /* Written even when empty, so a budget that was fleet-counted yesterday and
     cannot be today falls back to this machine's own count rather than to a
     figure nobody has checked since. */
  if (asking.length > 0) {
    await writeFleetSpend(
      home,
      (response.body?.fleetSpend ?? []).map((each) => ({ ...each, at: moment })),
    );
  }
}

/** What the control plane may say back about a call this machine is holding. */
interface HeartbeatAnswer {
  id: string;
  answer: string;
  by?: string;
}

interface HeartbeatReply {
  answers?: HeartbeatAnswer[];
  fleetSpend?: { name: string; spent: number }[];
  /** What the workspace has this machine set to. Applied only when it changes. */
  mode?: string;
}

/**
 * Moving this machine along the ramp, when the control plane says to.
 *
 * A *change*, never an assertion. The reply carries the workspace's mode on
 * every pass, so writing it each time would revert an edit somebody made to
 * `config.toml` on purpose, within a minute, for ever — and the file says
 * "yours to edit" at the top. What was last heard is kept on the account, so a
 * repetition is silent and only a graduation lands. Same shape as the bundle,
 * which applies on a changed hash and costs a 304 otherwise.
 *
 * Both directions, deliberately. Going up is the point; going back down is the
 * valve somebody needs when a rule set breaks the build at two in the morning,
 * and making that the one thing you have to SSH to every box for is how it gets
 * done by uninstalling instead.
 *
 * Best effort and last, like everything else here. A machine that cannot write
 * its own config is still holding, still reporting, still governed by whatever
 * it already had.
 */
async function applyMode(
  home: string,
  account: Account,
  running: EnforcementMode,
  told: string | undefined,
): Promise<void> {
  // A word from a newer control plane is not a mode the gate here can read.
  if (told === undefined || !isEnforcementMode(told)) return;
  if (told === account.cloudMode) return;

  try {
    /* The account first. If the config write fails, the next pass sees no
       change and leaves this machine alone rather than fighting the file every
       minute — and `mode` on the next beat still reports the truth, so the
       drift is visible in the console rather than silent. */
    await writeAccount(home, { ...account, cloudMode: told });
    if (told === running) return;
    const config = await loadOrCreateConfig(home);
    await saveConfig(home, { ...config, mode: told });
  } catch {
    /* Deliberately silent: this runs inside the heartbeat, and a machine that
       cannot be graduated must still beat. The console shows what it reports
       running, which is what it is. */
  }
}

/**
 * Written into the file the seam is already polling, so a remote answer and a
 * second terminal arrive by exactly the same route.
 *
 * An answer this machine does not recognise is dropped rather than acted on: the
 * only ids that mean anything here are the ones this machine raised.
 */
async function applyAnswers(
  approvals: PendingApprovals,
  answers: readonly HeartbeatAnswer[],
  at: string,
): Promise<void> {
  for (const answer of answers) {
    if (!ANSWERS.includes(answer.answer)) continue;
    await approvals.answer(
      answer.id,
      answer.answer as HoldAnswer,
      answer.by ?? 'the workspace',
      at,
    );
  }
}

const ANSWERS: readonly string[] = Object.values(HOLD_ANSWER);

/** The hash of what is already on disk, so an unchanged bundle costs one 304. */
async function heldHash(home: string): Promise<string | undefined> {
  try {
    const document = JSON.parse(await readFile(orgPolicyPath(home), 'utf8')) as {
      bundleHash?: string;
    };
    return document.bundleHash;
  } catch {
    return undefined; // Nothing pulled yet.
  }
}

interface LoopSeams {
  sleep?: (ms: number) => Promise<void>;
  pass?: (home: string) => Promise<Pass>;
  log?: (message: string) => void;
}

/**
 * The loop the daemon runs. Stops on a revocation and on nothing else — an
 * unreachable control plane backs off and keeps trying, because the ordinary
 * reason for one is a closed laptop lid.
 */
export async function syncLoop(
  home: string,
  running: () => boolean,
  seams: LoopSeams = {},
): Promise<void> {
  const sleep = seams.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pass = seams.pass ?? onePass;

  while (running()) {
    let result: Pass;
    try {
      result = await pass(home);
    } catch (err) {
      // A pass that throws must not end the daemon; the gate is what matters.
      seams.log?.(err instanceof Error ? err.message : String(err));
      await sleep(BACKOFF_MS);
      continue;
    }
    if (result.revoked === true) {
      seams.log?.('this machine has been revoked; the rules it holds still apply');
      return;
    }
    await sleep(result.unreachable === true ? BACKOFF_MS : HEARTBEAT_MS);
  }
}
