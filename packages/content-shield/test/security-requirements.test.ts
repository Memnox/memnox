import { describe, expect, it } from 'vitest';
import {
  SECURITY_BASELINE_VERSION,
  securityRequirementsFor,
} from '../src/security-requirements';

const ids = (action: string, target?: string): string[] =>
  securityRequirementsFor(action, target).map((requirement) => requirement.id);

describe('securityRequirementsFor', () => {
  it('is deterministic — same input, same requirements in the same order', () => {
    const first = securityRequirementsFor('file.write', 'src/auth/session.ts');
    const second = securityRequirementsFor('file.write', 'src/auth/session.ts');

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it('returns auth requirements for auth code', () => {
    expect(ids('file.write', 'src/auth/session.ts')).toContain('authz-check-per-object');
    expect(ids('code.modify', 'app/(auth)/login/page.tsx')).toContain(
      'session-cookie-flags',
    );
  });

  it('returns upload requirements for upload code', () => {
    const found = ids('file.write', 'src/api/upload.ts');

    expect(found).toContain('upload-validate-type');
    expect(found).toContain('upload-neutralize-name');
  });

  it('returns injection requirements for shell execution', () => {
    expect(ids('shell.execute', 'tar -xzf $ARCHIVE')).toContain('shell-no-interpolation');
  });

  it('returns supply-chain requirements for a new dependency', () => {
    const found = ids('dependency.add', 'left-pad@1.0.0');

    expect(found).toContain('dependency-pin');
    expect(found).toContain('dependency-provenance');
  });

  it('returns query requirements for data-access code', () => {
    expect(ids('code.modify', 'src/db/user-repository.ts')).toContain('sql-parameterize');
  });

  it('always includes the rules that hold whatever the change touches', () => {
    expect(ids('file.write', 'README.md')).toContain('no-hardcoded-secrets');
    expect(ids('deploy.service', 'api')).toContain('no-secrets-in-logs');
  });

  it('stays quiet for an action that changes nothing', () => {
    expect(securityRequirementsFor('file.read', 'src/auth/session.ts')).toEqual([]);
  });

  it('never repeats a requirement when several rules match', () => {
    const found = ids('file.write', 'src/api/auth/upload-avatar.ts');

    expect(new Set(found).size).toBe(found.length);
  });

  it('matches deploy.* by prefix', () => {
    expect(ids('deploy.vercel', 'web')).toContain('deploy-secrets-from-store');
  });

  it('is versioned, so a briefing can be reproduced later', () => {
    expect(SECURITY_BASELINE_VERSION).toMatch(/^\d{4}\.\d{2}\.\d+$/);
  });

  it('gives every requirement a stable id and a reason', () => {
    for (const requirement of securityRequirementsFor(
      'file.write',
      'src/auth/login.ts',
    )) {
      expect(requirement.id).toMatch(/^[a-z0-9-]+$/);
      expect(requirement.why.length).toBeGreaterThan(0);
    }
  });
});
