import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  HARDEN_TARGET,
  MEMNOX_HOME,
  NodeHardenWriter,
  NodeMachineReader,
  type HardenStep,
  type HardenWriter,
  type MachineReader,
} from '@memnox/core';
import { registerPolicyFile } from '../policy-registry';

/**
 * Where `protect` reads the machine and writes to it. Injected as one object so a test
 * of any mode reaches a fixture rather than the developer's own home directory.
 */
export interface HardenSeams {
  reader: MachineReader;
  writer: HardenWriter;
  /** Where applied steps are recorded, so a later revert knows what to undo. */
  statePath: string;
  /** A written rule the runtime never reads is not a rule; this is what makes it one. */
  registerPolicy: (absolutePath: string) => Promise<void>;
  /** The writer roots its paths, and the registry needs the path from anywhere. */
  absolute: (path: string) => string;
}

export type HardenSeamsFactory = () => HardenSeams;

export function defaultSeams(): HardenSeams {
  const home = homedir();
  const root = join(home, MEMNOX_HOME);
  return {
    reader: new NodeMachineReader(home),
    writer: new NodeHardenWriter(root),
    statePath: 'harden-state.json',
    registerPolicy: async (path) => {
      await registerPolicyFile(home, path);
    },
    absolute: (path) => join(root, path),
  };
}

/**
 * Every policy file a step wrote, added to the set the runtime reads. Absolute, because
 * the registry is resolved from the runtime's own directory and not from this one.
 */
export async function registerApplied(
  seams: HardenSeams,
  applied: readonly HardenStep[],
): Promise<void> {
  for (const step of applied) {
    if (step.target !== HARDEN_TARGET.POLICY) continue;
    await seams.registerPolicy(seams.absolute(step.apply.path));
  }
}

export async function readState(seams: HardenSeams): Promise<HardenStep[]> {
  const raw = await seams.writer.read(seams.statePath);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HardenStep[]) : [];
  } catch {
    // A corrupt state file must not stop a revert of what is still on disk.
    return [];
  }
}

export async function writeState(
  seams: HardenSeams,
  steps: readonly HardenStep[],
): Promise<void> {
  await seams.writer.write(seams.statePath, JSON.stringify(steps, null, 2));
}
