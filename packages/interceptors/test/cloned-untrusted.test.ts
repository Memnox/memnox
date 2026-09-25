import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cloneTargetOf,
  LocalGate,
  ProbationRegister,
  PROBATION_KIND,
} from '@memnox/core';
import { containmentFor } from '../src/containment-loader';
import { HookAuthorizer } from '../src/hook-authorizer';
import { ShellSeam } from '../src/shell-seam';

const NOW = new Date('2026-09-25T10:00:00.000Z');

describe('where a clone lands', () => {
  it.each([
    ['git clone https://github.com/someone/project.git', '/w/project'],
    ['git clone git@github.com:someone/project', '/w/project'],
    ['git clone --depth 1 -b main https://x.test/a/b.git code', '/w/code'],
    ['git clone https://x.test/a/b /tmp/elsewhere', '/tmp/elsewhere'],
  ])('%s lands in %s', (line, directory) => {
    expect(cloneTargetOf(line.split(' '), '/w')?.directory).toBe(directory);
  });

  it('is nothing for another git command', () => {
    expect(cloneTargetOf(['git', 'pull'], '/w')).toBeNull();
  });
});

describe('a repository an agent cloned', () => {
  it('starts on probation, and the work inside it is contained until trusted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-clone-'));
    const seam = new ShellSeam({
      authorizer: new HookAuthorizer({ gate: new LocalGate([], { agentName: 'agent' }) }),
      workingDirectory: '/w',
      home,
      now: () => NOW,
    });
    await seam.gate(['git clone https://github.com/someone/project.git']);

    const inside = await containmentFor({
      home,
      env: {},
      cwd: '/w/project',
      now: NOW,
      rootOf: () => '/w/project',
    });
    expect(inside?.untrusted).toBe(true);

    await new ProbationRegister(home).trust(PROBATION_KIND.REPOSITORY, '/w/project', NOW);
    const trusted = await containmentFor({
      home,
      env: {},
      cwd: '/w/project',
      now: NOW,
      rootOf: () => '/w/project',
    });
    expect(trusted?.untrusted).toBe(false);
  });

  it('leaves a repository nobody cloned as it was', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-clone-'));
    const here = await containmentFor({
      home,
      env: {},
      cwd: '/w/mine',
      now: NOW,
      rootOf: () => '/w/mine',
    });
    expect(here?.untrusted).toBe(false);
  });
});
