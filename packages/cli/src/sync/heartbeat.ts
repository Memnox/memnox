import { join } from 'node:path';

import {
  activitySince,
  discoverDefinitions,
  ENFORCEMENT_MODE,
  fleetBudgets,
  HOLD_ANSWER,
  goesToWorkspace,
  approvalRouteOf,
  isEnforcementMode,
  loadOrCreateConfig,
  MEMNOX_HOME,
  NodeFindingsStore,
  NodeMachineReader,
  NodeSnapshotStore,
  PendingApprovals,
  protectionStopped,
  markRevoked,
  readAccount,
  readAcceptedSkills,
  readBudgets,
  readJsonFile,
  reviewSkills,
  saveConfig,
  secondsToMs,
  SqliteEventStore,
  windowHoursOf,
  writeFleetSpend,
  writeAccount,
  type Account,
  type Budget,
  type EnforcementMode,
  type HoldAnswer,
  type PendingApproval,
  type SkillFinding,
} from '@memnox/core';

import { CLI_VERSION } from '../defaults';
import { kindOf, listRecords, onboardedInto } from '../agents/onboarding';
import { orgPolicyPath, PULL_OUTCOME, pullBundle, type PullResult } from './bundle';
import { callCloud, CloudUnreachable } from './client';
import {
  pushCensus,
  pushEvents,
  pushFindings,
  pushSkills,
  pushDecisions,
  pushProtection,
  PUSH_OUTCOME,
  type PushResult,
} from './push';

/**
 * One pass: pull the rules, send what happened, say you are alive. Pull first, so a
 * machine given a stricter rule set is governed by it before it reports anything.
 */

/** Often enough that a new rule lands in a minute; an unchanged bundle is a 304. */
const HEARTBEAT_MS = secondsToMs(60);

/** Where it backs off to while the control plane is unreachable. */
const BACKOFF_MS = secondsToMs(15 * 60);

/**
 * How often this looks while an agent is stopped on a question. The heartbeat carries a
 * held call both ways, so a minute between passes would spend the whole hold window.
 */
const HELD_POLL_MS = secondsToMs(2);

const ANSWERS: readonly string[] = Object.values(HOLD_ANSWER);

export interface Pass {
  pull?: PullResult;
  push?: PushResult;
  /** What this machine can do, sent once per scan. Absent when no scan is kept. */
  census?: PushResult;
  /** What that scan found wrong. Absent when `doctor` has never run here. */
  findings?: PushResult;
  /** Skills the agents here wrote for themselves. Absent when none changed. */
  skills?: PushResult;
  /** Rules a person decided here, offered to the team as proposals. */
  decisions?: PushResult;
  /** Somebody stopping or starting protection here, which the team has to see. */
  protection?: PushResult;
  /** Set when nothing could be reached, which is not an error worth printing. */
  unreachable?: boolean;
  /** True once the credential is gone: stop until somebody logs in again. */
  revoked?: boolean;
}

type SendKey = 'push' | 'census' | 'findings' | 'skills' | 'decisions' | 'protection';

interface Send {
  key: SendKey;
  run: () => Promise<PushResult>;
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
  /** Where the workspace wants questions to go: `session`, `dm` or `both`. Likewise. */
  approvals?: string;
}

/** What one beat reports, gathered before the call so the call is only the call. */
interface BeatState {
  running: EnforcementMode;
  applied: string | undefined;
  holding: PendingApproval[];
  /** Budgets counted across the workspace; a machine budget needs no round trip. */
  asking: Budget[];
}

interface LoopSeams {
  sleep?: (ms: number) => Promise<void>;
  pass?: (home: string) => Promise<Pass>;
  log?: (message: string) => void;
  /** Injected so a test states what is held rather than writing files to say it. */
  holding?: (home: string) => Promise<number>;
  /** Whether an agent here did something since then, so it is sent at once. */
  active?: (home: string, since: number) => Promise<boolean>;
}

interface WaitInput {
  home: string;
  idleMs: number;
  /** When the pass began, so activity after it wakes the loop. */
  since: number;
  sleep: (ms: number) => Promise<void>;
  holding: (home: string) => Promise<number>;
  active: (home: string, since: number) => Promise<boolean>;
}

export async function onePass(home: string): Promise<Pass> {
  const account = await readAccount(home);
  // Not logged in: no call is made at all, which is the whole promise.
  if (account === null) return {};
  // Removed from its workspace: a revoked machine is never restored, so nothing is sent.
  if (account.revokedAt !== undefined) return { revoked: true };

  try {
    const pass = await passFor(home, account);
    if (pass.revoked === true) await markRevoked(home, new Date());
    return pass;
  } catch (err) {
    if (err instanceof CloudUnreachable) return { unreachable: true };
    throw err;
  }
}

/**
 * The loop the daemon runs. Stops on a revocation and on nothing else, because an
 * unreachable control plane is usually a closed laptop lid and is waited out.
 */
export async function syncLoop(
  home: string,
  running: () => boolean,
  seams: LoopSeams = {},
): Promise<void> {
  const sleep = seams.sleep ?? sleepFor;
  const pass = seams.pass ?? onePass;

  while (running()) {
    const passStarted = Date.now();
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
    // Waited out whole, because polling fast for an answer with nowhere to come from changes nothing.
    if (result.unreachable === true) {
      await sleep(BACKOFF_MS);
      continue;
    }
    await waitUntilDue({
      home,
      idleMs: HEARTBEAT_MS,
      since: passStarted,
      sleep,
      holding: seams.holding ?? heldHere,
      active: seams.active ?? activitySince,
    });
  }
}

async function passFor(home: string, account: Account): Promise<Pass> {
  const pull = await pullBundle(home, account, await heldHash(home));
  if (pull.outcome === PULL_OUTCOME.REVOKED) return { pull, revoked: true };

  const pass: Pass = { pull };
  for (const send of sendsFor(home, account)) {
    const result = await send.run();
    pass[send.key] = result;
    if (result.outcome === PUSH_OUTCOME.REVOKED) return { ...pass, revoked: true };
  }
  await beat(home, account, pull);
  return pass;
}

/** Most time-critical first: the actions somebody is waiting on, then what is as true in a minute. */
function sendsFor(home: string, account: Account): Send[] {
  const kept = join(home, MEMNOX_HOME);
  return [
    { key: 'push', run: () => pushLedger(home, account) },
    {
      key: 'census',
      run: async () =>
        pushCensus(home, account, await new NodeSnapshotStore(kept).latest()),
    },
    {
      key: 'findings',
      run: async () =>
        pushFindings(home, account, await new NodeFindingsStore(kept).latest()),
    },
    // Reviewed every pass rather than read from a snapshot, because it is cheap and must be current.
    {
      key: 'skills',
      run: async () => pushSkills(home, account, await skillReview(home)),
    },
    { key: 'decisions', run: () => pushDecisions(home, account) },
    { key: 'protection', run: () => pushProtection(home, account) },
  ];
}

async function pushLedger(home: string, account: Account): Promise<PushResult> {
  const ledger = SqliteEventStore.forHome(home);
  try {
    return await pushEvents(home, account, ledger);
  } finally {
    ledger.close();
  }
}

/**
 * What the agents here taught themselves and what somebody installed, against what
 * anybody accepted. A failure reports nothing, so the heartbeat still beats.
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
 * What this machine runs, which bundle it applied, and the calls it is holding, with
 * whatever came back. The only per-machine round trip, so remote answers ride on it.
 */
async function beat(home: string, account: Account, pull: PullResult): Promise<void> {
  const approvals = new PendingApprovals(home);
  const moment = new Date().toISOString();
  const state = await readBeatState({ home, pull, approvals, moment });

  const response = await callCloud<HeartbeatReply>({
    baseUrl: account.baseUrl,
    path: `/v1/workspaces/${account.workspaceId}/machines/${account.machineId}/heartbeat`,
    method: 'POST',
    token: account.token,
    body: await heartbeatBody(home, account, state),
  });

  await applyAnswers(approvals, response.body?.answers ?? [], moment);
  await applyMode({ home, account, running: state.running, told: response.body?.mode });
  await applyApprovalRoute(home, response.body?.approvals);

  // Written even when the reply is empty, so a fleet count nobody can confirm falls back to this machine's.
  if (state.asking.length > 0) {
    await writeFleetSpend(
      home,
      (response.body?.fleetSpend ?? []).map((each) => ({ ...each, at: moment })),
    );
  }
}

/** Off while `memnox stop` holds, since that is what every seam here is running. */
async function runningMode(home: string): Promise<EnforcementMode> {
  if (await protectionStopped(home)) return ENFORCEMENT_MODE.OFF;
  return (await loadOrCreateConfig(home)).mode;
}

async function readBeatState(input: {
  home: string;
  pull: PullResult;
  approvals: PendingApprovals;
  moment: string;
}): Promise<BeatState> {
  const { home, pull } = input;
  return {
    running: await runningMode(home),
    applied: pull.outcome === PULL_OUTCOME.APPLIED ? pull.hash : await heldHash(home),
    // A question somebody asked to keep in the session never leaves the machine.
    holding: (await input.approvals.list(input.moment)).filter(goesToWorkspace),
    asking: fleetBudgets(await readBudgets(home)).filter(
      (budget) => windowHoursOf(budget) > 0,
    ),
  };
}

async function heartbeatBody(
  home: string,
  account: Account,
  state: BeatState,
): Promise<Record<string, unknown>> {
  return {
    // Every beat, so the fleet page shows what runs now rather than what was installed.
    runtimeVersion: CLI_VERSION,
    ...(state.applied === undefined ? {} : { bundleHashApplied: state.applied }),
    // The mode applied here, which somebody at this box may have changed from the workspace's.
    mode: state.running,
    budgets: state.asking.map((budget) => ({
      name: budget.name,
      actions: budget.actions,
      windowHours: windowHoursOf(budget),
    })),
    agents: await enrolledAgents(home, account),
    holding: state.holding.map(describeHeld),
  };
}

/**
 * Which agent each enrolled principal is for, so the control plane can join a typed
 * name to its id. This workspace's own records only, since a moved machine keeps the old.
 */
async function enrolledAgents(
  home: string,
  account: Account,
): Promise<Record<string, unknown>[]> {
  return (await listRecords(home))
    .filter((record) => onboardedInto(record, account))
    .map((record) => ({
      machineId: record.machineId,
      agentId: record.agentId,
      agentKind: kindOf(record),
    }));
}

/** Names only: the operation and what it is about, never the arguments. */
function describeHeld(each: PendingApproval): Record<string, unknown> {
  return {
    id: each.id,
    agent: each.request.agent,
    operation: each.request.operation,
    reason: each.request.reason,
    askedAt: each.askedAt,
    expiresAt: each.expiresAt,
    ...(each.request.target === undefined ? {} : { target: each.request.target }),
  };
}

/**
 * Moving this machine along the ramp when the control plane says to, in either direction.
 * Applied on a change only, so a deliberate edit to `config.toml` is not reverted a minute later.
 */
async function applyMode(input: {
  home: string;
  account: Account;
  running: EnforcementMode;
  told: string | undefined;
}): Promise<void> {
  const { home, account, running, told } = input;
  // A word from a newer control plane is not a mode the gate here can read.
  if (told === undefined || !isEnforcementMode(told)) return;
  if (told === account.cloudMode) return;

  try {
    // The account first, so a failed config write is not retried every minute.
    await writeAccount(home, { ...account, cloudMode: told });
    if (told === running) return;
    const config = await loadOrCreateConfig(home);
    await saveConfig(home, { ...config, mode: told });
  } catch {
    // Silent, because a machine that cannot be graduated must still beat.
  }
}

/**
 * Where questions go, when the workspace sets it. Set here or there, whichever changed
 * last: applied on a change only, so an edit to `config.toml` holds until the workspace
 * says something different. Read afresh, since `applyMode` may have just written the account.
 */
async function applyApprovalRoute(home: string, told: string | undefined): Promise<void> {
  const route = told === undefined ? null : approvalRouteOf(told);
  if (route === null) return;
  try {
    const account = await readAccount(home);
    if (account === null || route === account.cloudApprovals) return;
    await writeAccount(home, { ...account, cloudApprovals: route });
    const config = await loadOrCreateConfig(home);
    if (config.approvals !== route)
      await saveConfig(home, { ...config, approvals: route });
  } catch {
    // Silent, for the reason a mode is: a machine that cannot be told must still beat.
  }
}

/**
 * Written into the file the seam is already polling, so a remote answer and a second
 * terminal arrive by the same route. An id this machine did not raise is dropped.
 */
async function applyAnswers(
  approvals: PendingApprovals,
  answers: readonly HeartbeatAnswer[],
  at: string,
): Promise<void> {
  for (const answer of answers) {
    if (!ANSWERS.includes(answer.answer)) continue;
    // Checked against HOLD_ANSWER on the line above.
    const said = answer.answer as HoldAnswer;
    await approvals.answer(answer.id, said, answer.by ?? 'the workspace', at);
  }
}

/** The hash of what is already on disk, so an unchanged bundle costs one 304. */
async function heldHash(home: string): Promise<string | undefined> {
  const document = await readJsonFile<{ bundleHash?: string }>(orgPolicyPath(home));
  return document?.bundleHash;
}

/** How many calls this machine is stopped on. Local, so it costs no request to ask. */
async function heldHere(home: string): Promise<number> {
  try {
    return (await new PendingApprovals(home).list(new Date().toISOString())).length;
  } catch {
    // No queue is the same answer as an empty one, and neither is worth a fast loop.
    return 0;
  }
}

/**
 * Waits until the next pass is due, leaving early when an agent here stops on a question
 * or does something, so the workspace sees it in seconds rather than at the next beat.
 */
async function waitUntilDue(input: WaitInput): Promise<void> {
  for (let left = input.idleMs; left > 0; left -= HELD_POLL_MS) {
    await input.sleep(Math.min(HELD_POLL_MS, left));
    if ((await input.holding(input.home)) > 0) return;
    if (await input.active(input.home, input.since)) return;
  }
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
