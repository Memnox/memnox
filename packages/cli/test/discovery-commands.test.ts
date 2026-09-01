import { describe, expect, it } from 'vitest';
import type {
  HardenWriter,
  MachineReader,
  McpLister,
  McpToolDeclaration,
} from '@memnox/discovery';
import { registerDiscoverCommand } from '../src/commands/discover.command';
import { registerDoctorCommand } from '../src/commands/doctor.command';
import { registerHardenCommand } from '../src/commands/harden.command';
import { runCommand } from './cli-harness';

const HOME = '/home/dev';
/** A directory the reader is standing in, which holds the credentials a repo has. */
const PROJECT = '/srv/checkout';

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

/** Never the real one: the default starts every MCP server this machine declares. */
class StubLister implements McpLister {
  constructor(private readonly tools: McpToolDeclaration[] = []) {}
  async listTools(): Promise<McpToolDeclaration[]> {
    return this.tools;
  }
}

const noTools = (): McpLister => new StubLister();

describe('memnox (discover)', () => {
  it('names the agents and what they can reach right now', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) =>
        registerDiscoverCommand(program, context, () => machine, noTools),
      ['discover'],
    );

    expect(out.text).toContain('AI AGENTS');
    expect(out.text).toContain('claude-code');
    expect(out.text).toContain('.aws/credentials');
    expect(out.text).toContain('memnox doctor');
  });

  /**
   * The finding existed and could never fire, because nothing ever filled in a tool.
   * This is the line the opening screen is built on.
   */
  it('counts the destructive tools nothing is checking', async () => {
    const machine = FakeMachine.from(MACHINE);
    const lister = (): McpLister =>
      new StubLister([
        { name: 'get_issue' },
        { name: 'delete_repo' },
        { name: 'drop_database' },
      ]);

    const { out } = await runCommand(
      (program, context) =>
        registerDiscoverCommand(program, context, () => machine, lister),
      ['discover'],
    );

    expect(out.text).toContain('3 tools');
    expect(out.text).toContain('2 of them destructive');
    expect(out.text).toContain('nothing is checking any of them');
  });

  it('asks nobody when told not to probe', async () => {
    const machine = FakeMachine.from(MACHINE);
    let started = 0;
    const lister = (): McpLister => {
      started += 1;
      return new StubLister();
    };

    await runCommand(
      (program, context) =>
        registerDiscoverCommand(program, context, () => machine, lister),
      ['discover', '--no-probe'],
    );

    expect(started).toBe(0);
  });

  /**
   * discover showed the project's .env and doctor could not rank it, so harden wrote
   * no rule for it — the reader was told about a credential and offered no fix.
   */
  it('doctor and harden cover the same ground discover does', async () => {
    const withProject = FakeMachine.from({
      ...MACHINE,
      [`${PROJECT}/.env`]: 'STRIPE_KEY=sk_live_x',
    });
    const here = (): string => PROJECT;

    const seen = await runCommand(
      (program, context) =>
        registerDiscoverCommand(program, context, () => withProject, noTools, here),
      ['discover', '--json'],
    );
    const ranked = await runCommand(
      (program, context) =>
        registerDoctorCommand(program, context, () => withProject, here),
      ['doctor', '--json'],
    );

    expect(seen.out.text).toContain(`${PROJECT}/.env`);
    // The finding discover surfaced has to be one doctor can name.
    expect(ranked.out.text).toContain(`${PROJECT}/.env`);
  });

  it('never prints a secret value', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) =>
        registerDiscoverCommand(program, context, () => machine, noTools),
      ['discover', '--json'],
    );

    expect(out.text).not.toContain('AKIAEXAMPLE');
  });

  it('reads as a real answer on a machine with no agent, not a broken page', async () => {
    const machine = FakeMachine.from({});

    const { out } = await runCommand(
      (program, context) =>
        registerDiscoverCommand(program, context, () => machine, noTools),
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

  /**
   * The printed undo named one step and reverted every one, so a reader undoing the
   * docker rule silently lost the credentials rule too.
   */
  it('reverting one named step leaves the others applied', async () => {
    // Two reachable credentials, so there are two steps and one can be left alone.
    const machine = FakeMachine.from({
      ...MACHINE,
      [`${HOME}/.ssh/id_ed25519`]: 'PRIVATE KEY',
    });
    const run = (args: string[]) =>
      runCommand(
        (program, context) => registerHardenCommand(program, context, seams(machine)),
        args,
      );

    await run(['harden', '--apply']);
    const written = machine.paths.filter((path) => path.startsWith('policies/'));
    expect(written.length).toBeGreaterThan(1);

    const state = JSON.parse((await machine.read('harden-state.json')) ?? '[]') as {
      id: string;
    }[];
    const reverted = await run(['harden', '--revert', String(state[0]?.id)]);

    expect(reverted.out.text).toContain('reverted');
    // Only the named one goes; the rest of the machine stays hardened.
    const left = machine.paths.filter((path) => path.startsWith('policies/'));
    expect(left.length).toBe(written.length - 1);
  });

  it('names the applied steps when the id matches none, rather than reverting all', async () => {
    const machine = FakeMachine.from({
      ...MACHINE,
      [`${HOME}/.ssh/id_ed25519`]: 'PRIVATE KEY',
    });
    const run = (args: string[]) =>
      runCommand(
        (program, context) => registerHardenCommand(program, context, seams(machine)),
        args,
      );

    await run(['harden', '--apply']);
    const before = machine.paths.filter((path) => path.startsWith('policies/')).length;
    const { out } = await run(['harden', '--revert', 'hs_nope']);

    expect(out.text).toContain('No applied step with id hs_nope');
    expect(machine.paths.filter((path) => path.startsWith('policies/')).length).toBe(
      before,
    );
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
