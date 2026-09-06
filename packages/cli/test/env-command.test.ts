import { describe, expect, it } from 'vitest';
import { registerEnvCommand } from '../src/commands/env.command';
import { runCommand } from './cli-harness';

const HOME = '/home/dev';
const env = (args: string[]) =>
  runCommand(
    (program, context) => registerEnvCommand(program, context, () => HOME),
    args,
  );

describe('the environment a service manager has to set itself', () => {
  it('puts the interceptors in front of the real binaries', async () => {
    const { out } = await env(['env']);
    expect(out.text).toContain('export PATH="/home/dev/.memnox/bin:$PATH"');
  });

  it('points SHELL at the governed shell, and keeps the real one', async () => {
    const { out } = await env(['env']);
    expect(out.text).toContain('export SHELL="memnox-shell"');
    expect(out.text).toContain('MEMNOX_REAL_SHELL');
  });

  it('carries a session, so one run reads as one timeline', async () => {
    const { out } = await env(['env', '--session', 'ses_night']);
    expect(out.text).toContain('ses_night');
  });

  /* systemd does not run a shell, so `$PATH` in a unit file is four literal
     characters — and the interceptors would be the entire path, which is an agent
     that can run nothing at all. */
  it('expands PATH for systemd, which has no shell to expand it', async () => {
    const { out } = await env(['env', '--format', 'systemd']);
    expect(out.text).toContain('Environment="PATH=/home/dev/.memnox/bin:');
    expect(out.text).not.toContain('$PATH');
  });

  it('expands it for docker too, and says the home has to be there', async () => {
    const { out } = await env(['env', '--format', 'docker']);
    expect(out.text).toContain('ENV PATH=/home/dev/.memnox/bin:');
    expect(out.text).not.toContain('$PATH');
    expect(out.notes.join(' ')).toContain('~/.memnox');
  });

  it('tells a systemd user what to do next', async () => {
    const { out } = await env(['env', '--format', 'systemd']);
    expect(out.notes.join(' ')).toContain('daemon-reload');
  });

  it('refuses a format it does not know rather than printing nothing', async () => {
    await expect(env(['env', '--format', 'nix'])).rejects.toThrow('--format takes');
  });
});

/* Generated on a laptop and pasted onto a server, the expanded PATH names binaries
   that are not there. The screen has to say where to run it. */
describe('where the printed environment is true', () => {
  it('says the expansion belongs to this shell, for systemd', async () => {
    const { out } = await env(['env', '--format', 'systemd']);
    expect(out.notes.join(' ')).toContain('as the user the agent runs as');
  });

  it('says it for docker too, where the image may have different binaries', async () => {
    const { out } = await env(['env', '--format', 'docker']);
    expect(out.notes.join(' ')).toContain('binaries the image actually has');
  });
});
