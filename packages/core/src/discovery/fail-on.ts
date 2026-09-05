import { CHANGE_DIRECTION, CHANGE_SUBJECT, TOOL_EFFECT } from './discovery.constants';
import type { EnvironmentChange } from './snapshot';

/**
 * What a CI run should fail on. Narrowing never trips a gate: a build that broke
 * because somebody removed a permission would teach the team to stop running it.
 */
export const FAIL_ON = {
  /** Anything that widened authority. The strictest setting a pipeline can hold. */
  ANY: 'any',
  /** A new tool that can change external state, which is the usual regression. */
  WRITE_CAPABLE: 'write-capable',
  /** A credential newly visible to something here. The one people page about. */
  CREDENTIAL: 'credential',
} as const;

export type FailOn = (typeof FAIL_ON)[keyof typeof FAIL_ON];

export function isFailOn(value: string): value is FailOn {
  return (Object.values(FAIL_ON) as readonly string[]).includes(value);
}

export function failOnValues(): readonly FailOn[] {
  return Object.values(FAIL_ON);
}

const WRITE_EFFECTS: readonly string[] = [TOOL_EFFECT.WRITE, TOOL_EFFECT.DESTRUCTIVE];

function widens(change: EnvironmentChange): boolean {
  return change.direction === CHANGE_DIRECTION.WIDENS;
}

/** True when a tool arrived that can change something outside this machine. */
function isWriteCapable(change: EnvironmentChange): boolean {
  if (change.subject !== CHANGE_SUBJECT.TOOL) return false;
  return WRITE_EFFECTS.some((effect) => change.detail.includes(effect));
}

function isCredential(change: EnvironmentChange): boolean {
  return (
    change.subject === CHANGE_SUBJECT.RESOURCE &&
    (change.detail.includes('secret') || change.detail.includes('credential'))
  );
}

/**
 * The changes a given gate would fail on. Returned rather than counted, because a
 * pipeline that says only "failed" sends somebody back to the diff to find out why.
 */
export function changesFailing(
  changes: readonly EnvironmentChange[],
  gate: FailOn,
): EnvironmentChange[] {
  const widening = changes.filter(widens);
  if (gate === FAIL_ON.ANY) return widening;
  if (gate === FAIL_ON.WRITE_CAPABLE) return widening.filter(isWriteCapable);
  return widening.filter(isCredential);
}
