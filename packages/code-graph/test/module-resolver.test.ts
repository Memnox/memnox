import { describe, expect, it } from 'vitest';
import { resolveSpecifier } from '../src/module-resolver';

const repo = (...paths: string[]): ReadonlySet<string> => new Set(paths);

describe('resolveSpecifier — TypeScript', () => {
  it('adds the extension a specifier omits', () => {
    const known = repo('src/utils/money.ts');
    expect(resolveSpecifier('src/payment/checkout.ts', '../utils/money', known)).toBe(
      'src/utils/money.ts',
    );
  });

  it('walks .. segments correctly', () => {
    const known = repo('src/core/config.ts');
    expect(
      resolveSpecifier('src/modules/billing/service.ts', '../../core/config', known),
    ).toBe('src/core/config.ts');
  });

  it('falls back to a directory index file', () => {
    const known = repo('src/utils/index.ts');
    expect(resolveSpecifier('src/payment/checkout.ts', '../utils', known)).toBe(
      'src/utils/index.ts',
    );
  });

  it('returns null for package specifiers — they are outside the repo', () => {
    expect(resolveSpecifier('src/a.ts', 'express', repo('src/a.ts'))).toBeNull();
    expect(resolveSpecifier('src/a.ts', 'node:fs', repo('src/a.ts'))).toBeNull();
  });

  it('returns null when nothing in the repo matches', () => {
    expect(resolveSpecifier('src/a.ts', './missing', repo('src/a.ts'))).toBeNull();
  });
});

describe('resolveSpecifier — Python', () => {
  it('resolves a single leading dot against the importing directory', () => {
    const known = repo('app/payment/money.py');
    expect(resolveSpecifier('app/payment/checkout.py', '.money', known)).toBe(
      'app/payment/money.py',
    );
  });

  it('resolves a double leading dot one directory up', () => {
    const known = repo('app/core/config.py');
    expect(resolveSpecifier('app/payment/checkout.py', '..core.config', known)).toBe(
      'app/core/config.py',
    );
  });

  it('finds a package via its __init__ file', () => {
    const known = repo('app/core/__init__.py');
    expect(resolveSpecifier('app/payment/checkout.py', '..core', known)).toBe(
      'app/core/__init__.py',
    );
  });
});

describe('resolveSpecifier — Rust', () => {
  it('treats crate:: as repository-root relative', () => {
    const known = repo('payment/checkout.rs');
    expect(resolveSpecifier('src/main.rs', 'crate::payment::checkout', known)).toBe(
      'payment/checkout.rs',
    );
  });

  it('treats super:: as one directory up', () => {
    const known = repo('src/config.rs');
    expect(resolveSpecifier('src/payment/checkout.rs', 'super::config', known)).toBe(
      'src/config.rs',
    );
  });
});
