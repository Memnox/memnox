import type { Finding, HardenChange, HardenStep } from './finding';
import type { HardenWriter } from './ports';

export interface HardenPlan {
  steps: HardenStep[];
  /** Printed before anything runs: the undo is visible first, always. */
  undo: string[];
}

/** Propose, apply, revert. A step whose inverse cannot be stated is not proposed. */
export function planHardening(steps: readonly HardenStep[]): HardenPlan {
  const usable = steps.filter((step) => step.revert.command.length > 0);
  return { steps: [...usable], undo: usable.map((step) => step.revert.command) };
}

export interface HardenResult {
  step: HardenStep;
  changed: boolean;
  error?: string;
}

/**
 * Changes land in Memnox policy and seam config, never in a file the reader's team
 * reviews. One failed step does not abandon the rest, and each records when it ran.
 */
export async function applyHardening(
  writer: HardenWriter,
  steps: readonly HardenStep[],
  now: string,
): Promise<HardenResult[]> {
  const results: HardenResult[] = [];
  for (const step of steps) {
    if (step.appliedAt !== undefined && step.revertedAt === undefined) {
      results.push({ step, changed: false });
      continue;
    }
    try {
      await runChange(writer, step.apply);
      results.push({
        step: { ...step, appliedAt: now, revertedAt: undefined },
        changed: true,
      });
    } catch (err) {
      results.push({ step, changed: false, error: String(err) });
    }
  }
  return results;
}

/** A single command puts the machine back, so revert is the same walk in reverse. */
export async function revertHardening(
  writer: HardenWriter,
  steps: readonly HardenStep[],
  now: string,
): Promise<HardenResult[]> {
  const results: HardenResult[] = [];
  for (const step of [...steps].reverse()) {
    if (step.appliedAt === undefined || step.revertedAt !== undefined) {
      results.push({ step, changed: false });
      continue;
    }
    try {
      await runChange(writer, step.revert);
      results.push({ step: { ...step, revertedAt: now }, changed: true });
    } catch (err) {
      results.push({ step, changed: false, error: String(err) });
    }
  }
  return results;
}

/** A change with no contents removes the file; that is what makes revert expressible. */
async function runChange(writer: HardenWriter, change: HardenChange): Promise<void> {
  if (change.contents === undefined) {
    await writer.remove(change.path);
    return;
  }
  await writer.write(change.path, change.contents);
}

export interface HardenDelta {
  closed: Finding[];
  remaining: Finding[];
}

/** Re-run the doctor and show the delta: which closed, which remain, and why. */
export function compareFindings(
  before: readonly Finding[],
  after: readonly Finding[],
): HardenDelta {
  const stillOpen = new Set(after.map((finding) => finding.evidence));
  return {
    closed: before.filter((finding) => !stillOpen.has(finding.evidence)),
    remaining: [...after],
  };
}
