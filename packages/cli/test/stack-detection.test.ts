import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validatePolicyDocument } from '@memnox/policy-engine';
import { parse } from 'yaml';
import { detectStack } from '../src/stack-detection';
import { composePolicyDocument } from '../src/project-setup';

describe('stack detection', () => {
  let dir: string;

  const manifest = (deps: Record<string, string>): Promise<void> =>
    writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: deps }), 'utf8');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-stack-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('always scaffolds the universal baseline', () => {
    expect(detectStack(dir).packs).toEqual(['production-safety', 'terminal-safety']);
  });

  it('picks the payments pack off a payment dependency', async () => {
    await manifest({ stripe: '^14.0.0' });

    const detected = detectStack(dir);

    expect(detected.signals).toContain('payments');
    expect(detected.packs).toContain('payments');
  });

  it('picks it off a payment directory too', async () => {
    await mkdir(join(dir, 'payments'), { recursive: true });

    expect(detectStack(dir).packs).toContain('payments');
  });

  it('recognises migrations from an ORM dependency', async () => {
    await manifest({ prisma: '^5.0.0' });

    expect(detectStack(dir).packs).toContain('data-privacy');
  });

  it('recognises CI and infrastructure from their files', async () => {
    await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
    await writeFile(join(dir, 'Dockerfile'), 'FROM node:20\n', 'utf8');

    const detected = detectStack(dir);

    expect(detected.packs).toContain('supply-chain');
    expect(detected.packs).toContain('infrastructure');
  });

  it('survives an unreadable manifest rather than failing setup', async () => {
    await writeFile(join(dir, 'package.json'), '{ not json', 'utf8');

    expect(() => detectStack(dir)).not.toThrow();
    expect(detectStack(dir).packs).toContain('production-safety');
  });

  it('composes detected packs into a document the validator accepts', () => {
    const yaml = composePolicyDocument('acme-checkout', detectStack(dir).packs);
    const document = validatePolicyDocument(parse(yaml));

    expect(document.project).toBe('acme-checkout');
    expect(document.policies.length).toBeGreaterThan(0);
  });

  it('collapses a rule two packs both define', () => {
    const yaml = composePolicyDocument(undefined, ['payments', 'payments']);
    const names = validatePolicyDocument(parse(yaml)).policies.map((p) => p.name);

    expect(new Set(names).size).toBe(names.length);
  });
});
