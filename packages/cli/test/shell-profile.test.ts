import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addToProfile,
  blockFor,
  pathLineFor,
  profilesFor,
  removeFromProfile,
} from '../src/protect/shell-profile';

const HOME = '/home/dev';

describe('the shell profile line', () => {
  it('is written the way each shell actually sets PATH', () => {
    // A bash export pasted into fish silently does nothing, which is the worst outcome.
    expect(pathLineFor('/bin/zsh', HOME)).toBe(
      'export PATH="/home/dev/.memnox/bin:$PATH"',
    );
    expect(pathLineFor('/usr/local/bin/fish', HOME)).toBe(
      'fish_add_path --prepend --move /home/dev/.memnox/bin',
    );
  });

  it('goes in the file that shell reads', () => {
    expect(profilesFor('/bin/zsh', HOME)).toEqual(['/home/dev/.zshrc']);
    expect(profilesFor('/bin/bash', HOME)).toEqual([
      '/home/dev/.bashrc',
      '/home/dev/.bash_profile',
    ]);
    expect(profilesFor('/usr/local/bin/fish', HOME)).toEqual([
      '/home/dev/.config/fish/config.fish',
    ]);
  });

  it('leaves everything outside the markers exactly as it was', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnox-profile-'));
    const path = join(dir, '.zshrc');
    const theirs = '# their setup\nexport EDITOR=vim\nalias gs="git status"\n';
    await writeFile(path, theirs, 'utf8');

    await addToProfile(path, blockFor('/bin/zsh', HOME));
    const after = await readFile(path, 'utf8');
    expect(after).toContain('export EDITOR=vim');
    expect(after).toContain('/home/dev/.memnox/bin');

    await removeFromProfile(path);
    // The one that matters: their file comes back, not a reformatted version of it.
    expect(await readFile(path, 'utf8')).toBe(theirs);
  });

  it('adds its line once, however many times it is run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnox-profile-'));
    const path = join(dir, '.zshrc');
    await writeFile(path, 'export EDITOR=vim\n', 'utf8');

    const block = blockFor('/bin/zsh', HOME);
    expect((await addToProfile(path, block)).state).toBe('added');
    expect((await addToProfile(path, block)).state).toBe('unchanged');

    const after = await readFile(path, 'utf8');
    expect(after.split('.memnox/bin').length - 1).toBe(1);
  });

  it('writes a profile that did not exist yet, and takes it back out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnox-profile-'));
    const path = join(dir, '.zshrc');

    expect((await addToProfile(path, blockFor('/bin/zsh', HOME))).state).toBe('added');
    expect((await removeFromProfile(path)).state).toBe('removed');
    expect(await readFile(path, 'utf8')).not.toContain('memnox');
  });

  it('says nothing changed when there is no line of ours to remove', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnox-profile-'));
    const path = join(dir, '.zshrc');
    await writeFile(path, 'export EDITOR=vim\n', 'utf8');

    expect((await removeFromProfile(path)).state).toBe('unchanged');
    expect(await readFile(path, 'utf8')).toBe('export EDITOR=vim\n');
  });
});
