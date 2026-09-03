import { describe, expect, it } from 'vitest';
import { registerEvidenceCommand } from '../src/commands/evidence.command';
import { registerExplainCommand } from '../src/commands/explain.command';
import { registerWhoCommand } from '../src/commands/who.command';
import { runCommand } from './cli-harness';
import { fakeSeams, FakeMachine, HOME, PROJECT } from './machine-harness';

const MACHINE = {
  [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: {} }),
  [`${HOME}/.aws/credentials`]: '[default]\naws_access_key_id = AKIAEXAMPLE',
  [`${PROJECT}/.env`]: 'DATABASE_URL=postgres://u:p@db.production.internal/app',
};

describe('memnox explain', () => {
  it('separates what is technically possible from what is permitted', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) =>
        registerExplainCommand(program, context, () => fakeSeams(machine)),
      ['explain', 'can claude deploy production right now?'],
    );

    expect(out.text).toContain('TECHNICALLY');
    expect(out.text).toContain('ORGANIZATIONALLY');
    // The parse is shown, so a wrong reading of the sentence is visible rather than
    // hidden inside a confident answer.
    expect(out.text).toContain('read as: claude-code · deploy · production');
  });

  it('refuses to answer off rules that would not load', async () => {
    const machine = FakeMachine.from({
      ...MACHINE,
      [`${PROJECT}/memnox.policies.yaml`]: 'this: is not a policy set',
    });

    const { out } = await runCommand(
      (program, context) =>
        registerExplainCommand(program, context, () =>
          fakeSeams(machine, { policyFiles: [`${PROJECT}/memnox.policies.yaml`] }),
        ),
      ['explain', 'can claude deploy production right now?'],
    );

    // A broken rule set is not an empty one, and "organizationally yes" off rules
    // that never parsed is the lie this surface exists not to tell.
    expect(out.text).toContain('not answerable here');
    expect(out.text).toContain('NOT ANSWERED');
  });

  it('refuses to guess at a question it could not read', async () => {
    const machine = FakeMachine.from(MACHINE);

    await expect(
      runCommand(
        (program, context) =>
          registerExplainCommand(program, context, () => fakeSeams(machine)),
        ['explain', 'is everything fine?'],
      ),
    ).rejects.toThrow(/could not read/);
  });
});

describe('memnox who', () => {
  it('answers from reachability, and every row carries what proved it', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) =>
        registerWhoCommand(program, context, () => fakeSeams(machine)),
      ['who', '--resource', 'credentials'],
    );

    expect(out.text).toContain('WHO REACHES CREDENTIALS');
    expect(out.text).toContain('claude-code');
    expect(out.text).toContain('.aws/credentials');
  });

  it('states that the answer is this machine and no other', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) =>
        registerWhoCommand(program, context, () => fakeSeams(machine)),
      ['who', '--resource', 'production'],
    );

    expect(out.text).toContain('This machine only');
  });

  it('names the classes it knows rather than answering about one it does not', async () => {
    const machine = FakeMachine.from(MACHINE);

    await expect(
      runCommand(
        (program, context) =>
          registerWhoCommand(program, context, () => fakeSeams(machine)),
        ['who', '--resource', 'everything'],
      ),
    ).rejects.toThrow(/unknown resource class/);
  });
});

describe('memnox evidence', () => {
  const REPOSITORY = {
    ...MACHINE,
    [`${PROJECT}/AGENTS.md`]:
      'Services must reach data through a repository, never directly.',
    [`${PROJECT}/SECURITY.md`]: 'Production changes must carry two approvals.',
  };

  it('prints what the repository states, verbatim and with its line', async () => {
    const machine = FakeMachine.from(REPOSITORY);

    const { out } = await runCommand(
      (program, context) =>
        registerEvidenceCommand(program, context, () => fakeSeams(machine)),
      ['evidence', PROJECT],
    );

    expect(out.text).toContain('Services must reach data through a repository');
    expect(out.text).toContain('AGENTS.md:1');
  });

  it('reports a documented approval requirement nothing here enforces', async () => {
    const machine = FakeMachine.from(REPOSITORY);

    const { out } = await runCommand(
      (program, context) =>
        registerEvidenceCommand(program, context, () => fakeSeams(machine)),
      ['evidence', PROJECT, '--gaps'],
    );

    expect(out.text).toContain('POLICY GAP');
    expect(out.text).toContain('Production changes must carry two approvals.');
    // Branch protection is not on this disk, and implying it was checked would be a
    // lie the reader would act on.
    expect(out.text).toContain('not on this disk');
  });

  it('is honest when a repository states nothing at all', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) =>
        registerEvidenceCommand(program, context, () => fakeSeams(machine)),
      ['evidence', PROJECT],
    );

    expect(out.text).toContain('Nothing here states a rule');
  });
});
