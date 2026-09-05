import { describe, expect, it } from 'vitest';
import type { McpLister } from '@memnox/core';
import { registerScanCommand } from '../src/commands/scan.command';
import { registerDoctorCommand } from '../src/commands/doctor.command';
import { registerProtectCommand } from '../src/commands/protect.command';
import { runCommand } from './cli-harness';
import { fakeSeams, FakeMachine, HOME, PROJECT, StubLister } from './machine-harness';

const MACHINE = {
  [`${HOME}/.claude.json`]: JSON.stringify({
    mcpServers: { github: { command: 'npx', args: ['github-mcp'] } },
  }),
  [`${HOME}/.aws/credentials`]: '[default]\naws_access_key_id = AKIAEXAMPLE',
};

describe('memnox (scan)', () => {
  it('names the agents and what they can reach right now', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) =>
        registerScanCommand(program, context, () => fakeSeams(machine)),
      ['scan'],
    );

    expect(out.text).toContain('AI AGENTS');
    expect(out.text).toContain('claude-code');
    expect(out.text).toContain('.aws/credentials');
    // The gap is the reason anybody keeps reading, so it is the closing line.
    expect(out.text).toContain('can change something outside this laptop');
    expect(out.text).toContain('memnox protect');
  });

  /* Bare `memnox` runs discovery, so commander hands an unrecognised word here as an
     argument. Blaming `discover` named a command the person never typed. */
  it('names the word the person typed, not the default command it landed on', async () => {
    const machine = FakeMachine.from(MACHINE);

    await expect(
      runCommand(
        (program, context) =>
          registerScanCommand(program, context, () => fakeSeams(machine)),
        ['audti'],
      ),
    ).rejects.toThrow(/unknown command "audti"/);
  });

  it('points at the nearest real command when the word is a near miss', async () => {
    const machine = FakeMachine.from(MACHINE);

    await expect(
      runCommand(
        (program, context) => {
          program
            .command('audit')
            .description('the real one')
            .action(() => undefined);
          registerScanCommand(program, context, () => fakeSeams(machine));
        },
        ['audti'],
      ),
    ).rejects.toThrow(/did you mean "audit"/);
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
        registerScanCommand(program, context, () => fakeSeams(machine, { lister })),
      ['scan'],
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
        registerScanCommand(program, context, () => fakeSeams(machine, { lister })),
      ['scan', '--no-probe'],
    );

    expect(started).toBe(0);
  });

  /**
   * discover showed the project's .env and doctor could not rank it, so harden wrote
   * no rule for it — the reader was told about a credential and offered no fix.
   */
  it('doctor and protect cover the same ground scan does', async () => {
    const withProject = FakeMachine.from({
      ...MACHINE,
      [`${PROJECT}/.env`]: 'STRIPE_KEY=sk_live_x',
    });
    const here = (): string => PROJECT;

    const seen = await runCommand(
      (program, context) =>
        registerScanCommand(
          program,
          context,
          () => fakeSeams(withProject, { projectDirs: [PROJECT] }),
          here,
        ),
      ['scan', '--json'],
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
        registerScanCommand(program, context, () => fakeSeams(machine)),
      ['scan', '--json'],
    );

    expect(out.text).not.toContain('AKIAEXAMPLE');
  });

  it('reads as a real answer on a machine with no agent, not a broken page', async () => {
    const machine = FakeMachine.from({});

    const { out } = await runCommand(
      (program, context) =>
        registerScanCommand(program, context, () => fakeSeams(machine)),
      ['scan'],
    );

    expect(out.text).toContain('No AI agents found on this machine.');
    expect(out.text).toContain('Nothing was transmitted.');
  });
});

describe('memnox doctor', () => {
  it('ranks findings, names the evidence, and counts rather than totals', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) => registerDoctorCommand(program, context, () => machine),
      ['doctor'],
    );

    expect(out.text).toContain('CRITICAL');
    expect(out.text).toContain(`${HOME}/.aws/credentials`);
    expect(out.text).toContain('Nothing here compares this machine to another.');
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

describe('memnox protect', () => {
  const registered: string[] = [];
  const seams = (machine: FakeMachine) => () => ({
    reader: machine,
    writer: machine,
    statePath: 'harden-state.json',
    registerPolicy: async (path: string) => {
      registered.push(path);
    },
    absolute: (path: string) => `/home/dev/.memnox/${path}`,
  });

  it('proposes without changing anything, and prints the undo first', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) => registerProtectCommand(program, context, seams(machine)),
      ['protect'],
    );

    expect(out.text).toContain('PROPOSED');
    expect(out.text).toContain('undo: memnox protect --revert');
    expect(out.text).toContain('Nothing was changed.');
    expect(machine.paths).not.toContain('harden-state.json');
  });

  it('applies into Memnox alone, then puts the machine back in one command', async () => {
    const machine = FakeMachine.from(MACHINE);
    const run = (args: string[]) =>
      runCommand(
        (program, context) => registerProtectCommand(program, context, seams(machine)),
        args,
      );

    const applied = await run(['protect', '--apply']);
    expect(applied.out.text).toContain('applied');
    const written = machine.paths.filter((path) => path.startsWith('policies/'));
    expect(written.length).toBeGreaterThan(0);

    const reverted = await run(['protect', '--revert']);
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
        (program, context) => registerProtectCommand(program, context, seams(machine)),
        args,
      );

    await run(['protect', '--apply']);
    const written = machine.paths.filter((path) => path.startsWith('policies/'));
    expect(written.length).toBeGreaterThan(1);

    const state = JSON.parse((await machine.read('harden-state.json')) ?? '[]') as {
      id: string;
    }[];
    const reverted = await run(['protect', '--revert', String(state[0]?.id)]);

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
        (program, context) => registerProtectCommand(program, context, seams(machine)),
        args,
      );

    await run(['protect', '--apply']);
    const before = machine.paths.filter((path) => path.startsWith('policies/')).length;
    const { out } = await run(['protect', '--revert', 'hs_nope']);

    expect(out.text).toContain('No applied step with id hs_nope');
    expect(machine.paths.filter((path) => path.startsWith('policies/')).length).toBe(
      before,
    );
  });

  /**
   * harden wrote its rules into the Memnox home and registered none of them, so every
   * step reported `applied` while the runtime went on answering "no policy matched"
   * for the very file it had just protected.
   */
  it('registers what it writes, or the rule is one nobody loads', async () => {
    const machine = FakeMachine.from(MACHINE);
    registered.length = 0;

    await runCommand(
      (program, context) => registerProtectCommand(program, context, seams(machine)),
      ['protect', '--apply'],
    );

    const written = machine.paths.filter((path) => path.startsWith('policies/'));
    expect(written.length).toBeGreaterThan(0);
    // Every policy file it wrote is one the runtime will read.
    expect(registered).toHaveLength(written.length);
    for (const path of written) {
      expect(registered).toContain(`/home/dev/.memnox/${path}`);
    }
  });

  it('registers nothing when it only proposes', async () => {
    const machine = FakeMachine.from(MACHINE);
    registered.length = 0;

    await runCommand(
      (program, context) => registerProtectCommand(program, context, seams(machine)),
      ['protect'],
    );

    expect(registered).toEqual([]);
  });

  it('says so plainly when there is nothing applied to revert', async () => {
    const machine = FakeMachine.from({});

    const { out } = await runCommand(
      (program, context) => registerProtectCommand(program, context, seams(machine)),
      ['protect', '--revert'],
    );

    expect(out.text).toContain('no harden step has been applied');
  });
});
