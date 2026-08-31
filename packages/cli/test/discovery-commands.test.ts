import { describe, expect, it } from 'vitest';
import type { HardenWriter, MachineReader } from '@memnox/discovery';
import { registerDiscoverCommand } from '../src/commands/discover.command';
import { registerDoctorCommand } from '../src/commands/doctor.command';
import { registerHardenCommand } from '../src/commands/harden.command';
import { runCommand } from './cli-harness';

const HOME = '/home/dev';

/** No fixtures anywhere else: this stands in for the reader's own machine in tests. */
class FakeMachine implements MachineReader, HardenWriter {
  constructor(private readonly files: Map<string, string>) {}

  static from(files: Record<string, string>): FakeMachine {
    return new FakeMachine(new Map(Object.entries(files)));
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async list(): Promise<string[]> {
    return [];
  }
  homeDir(): string {
    return HOME;
  }
  userName(): string {
    return 'dev';
  }
  async write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  get paths(): string[] {
    return [...this.files.keys()];
  }
}

const MACHINE = {
  [`${HOME}/.claude.json`]: JSON.stringify({
    mcpServers: { github: { command: 'npx', args: ['github-mcp'] } },
  }),
  [`${HOME}/.aws/credentials`]: '[default]\naws_access_key_id = AKIAEXAMPLE',
};

describe('memnox (discover)', () => {
  it('names the agents and what they can reach right now', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) => registerDiscoverCommand(program, context, () => machine),
      ['discover'],
    );

    expect(out.text).toContain('AI AGENTS');
    expect(out.text).toContain('claude-code');
    expect(out.text).toContain('.aws/credentials');
    expect(out.text).toContain('memnox doctor');
  });

  it('never prints a secret value', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) => registerDiscoverCommand(program, context, () => machine),
      ['discover', '--json'],
    );

    expect(out.text).not.toContain('AKIAEXAMPLE');
  });

  it('reads as a real answer on a machine with no agent, not a broken page', async () => {
    const machine = FakeMachine.from({});

    const { out } = await runCommand(
      (program, context) => registerDiscoverCommand(program, context, () => machine),
      ['discover'],
    );

    expect(out.text).toContain('No AI agents found on this machine.');
    expect(out.text).toContain('Nothing was transmitted.');
  });
});

describe('memnox doctor', () => {
  it('ranks findings, names the evidence, and says the score grants nothing', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) => registerDoctorCommand(program, context, () => machine),
      ['doctor'],
    );

    expect(out.text).toContain('CRITICAL');
    expect(out.text).toContain(`${HOME}/.aws/credentials`);
    expect(out.text).toContain(
      'It grants nothing and compares this machine to no other.',
    );
  });

  it('says nothing rather than inventing a finding on a clean machine', async () => {
    const machine = FakeMachine.from({});

    const { out } = await runCommand(
      (program, context) => registerDoctorCommand(program, context, () => machine),
      ['doctor'],
    );

    expect(out.text).toContain(
      'Nothing on this machine is reachable that should not be.',
    );
  });
});

describe('memnox harden', () => {
  const seams = (machine: FakeMachine) => () => ({
    reader: machine,
    writer: machine,
    statePath: 'harden-state.json',
  });

  it('proposes without changing anything, and prints the undo first', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) => registerHardenCommand(program, context, seams(machine)),
      ['harden'],
    );

    expect(out.text).toContain('PROPOSED');
    expect(out.text).toContain('undo: memnox harden --revert');
    expect(out.text).toContain('Nothing was changed.');
    expect(machine.paths).not.toContain('harden-state.json');
  });

  it('applies into Memnox alone, then puts the machine back in one command', async () => {
    const machine = FakeMachine.from(MACHINE);
    const run = (args: string[]) =>
      runCommand(
        (program, context) => registerHardenCommand(program, context, seams(machine)),
        args,
      );

    const applied = await run(['harden', '--apply']);
    expect(applied.out.text).toContain('applied');
    const written = machine.paths.filter((path) => path.startsWith('policies/'));
    expect(written.length).toBeGreaterThan(0);

    const reverted = await run(['harden', '--revert']);
    expect(reverted.out.text).toContain('reverted');
    expect(machine.paths.filter((path) => path.startsWith('policies/'))).toEqual([]);
  });

  it('says so plainly when there is nothing applied to revert', async () => {
    const machine = FakeMachine.from({});

    const { out } = await runCommand(
      (program, context) => registerHardenCommand(program, context, seams(machine)),
      ['harden', '--revert'],
    );

    expect(out.text).toContain('no harden step has been applied');
  });
});
