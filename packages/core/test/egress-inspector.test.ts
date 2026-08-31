import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_SHAPE,
  describeEgress,
  inspectEgress,
} from '../src/domain/egress-inspector';

/** Assembled at runtime: a secret shape never appears as a literal in a test file. */
const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NSJ9', 'c2lnbmF0dXJl'].join('.');
const PRIVATE_KEY = ['-----BEGIN', ' OPENSSH ', 'PRIVATE KEY', '-----'].join('');
const CONNECTION = ['postgres://user', 'hunter2@db.internal:5432/app'].join(':');

describe('inspectEgress', () => {
  it('finds a credential in a payload bound for an allowed host', () => {
    const inspection = inspectEgress({
      destination: 'https://api.partner.example/ingest',
      fields: { note: 'quarterly upload', config: `key=${AWS_KEY}` },
    });

    expect(inspection.findings).toEqual([
      { field: 'config', shape: CREDENTIAL_SHAPE.AWS_ACCESS_KEY },
    ]);
  });

  it.each([
    ['aws', AWS_KEY, CREDENTIAL_SHAPE.AWS_ACCESS_KEY],
    ['github', GITHUB, CREDENTIAL_SHAPE.GITHUB_TOKEN],
    ['jwt', JWT, CREDENTIAL_SHAPE.JWT],
    ['private key', PRIVATE_KEY, CREDENTIAL_SHAPE.PRIVATE_KEY],
    ['connection string', CONNECTION, CREDENTIAL_SHAPE.CONNECTION_STRING],
  ])('recognises a %s by shape', (_label, value, shape) => {
    expect(inspectEgress({ fields: { body: value } }).findings[0]?.shape).toBe(shape);
  });

  it('takes a marked field at its word, whatever the value looks like', () => {
    const inspection = inspectEgress({ fields: { password: 'correcthorse' } });
    expect(inspection.findings).toEqual([{ field: 'password', shape: 'marked field' }]);
  });

  it('says nothing about an ordinary payload', () => {
    const inspection = inspectEgress({
      destination: 'https://example.com',
      fields: { title: 'Release notes', body: 'We shipped the thing.', count: '42' },
    });
    expect(inspection.findings).toEqual([]);
  });

  it('ignores an empty field rather than calling it a finding', () => {
    expect(inspectEgress({ fields: { token: '' } }).findings).toEqual([]);
  });

  /** The refusal names the field so somebody can decide whether the rule is wrong. */
  it('names the field and the destination, and never the value', () => {
    const inspection = inspectEgress({
      destination: 'https://paste.example',
      fields: { attachment: PRIVATE_KEY },
    });
    const described = describeEgress(inspection);

    expect(described).toContain('attachment');
    expect(described).toContain('private key');
    expect(described).toContain('https://paste.example');
    expect(described).not.toContain(PRIVATE_KEY);
  });

  it('describes a payload with no destination without inventing one', () => {
    const described = describeEgress(inspectEgress({ fields: { token: 'x' } }));
    expect(described).not.toContain('undefined');
  });
});
