import { describe, expect, it } from 'vitest';
import { extractImports } from '../src/imports';
import { detectLanguage } from '../src/language';
import { LANGUAGE } from '../src/code-graph.constants';

const specifiers = (path: string, content: string): string[] =>
  extractImports(path, content)
    .map((dependency) => dependency.specifier)
    .sort();

const internalSpecifiers = (path: string, content: string): string[] =>
  extractImports(path, content)
    .filter((dependency) => dependency.internal)
    .map((dependency) => dependency.specifier)
    .sort();

describe('detectLanguage', () => {
  it('maps extensions to languages and gives up on unknown ones', () => {
    expect(detectLanguage('src/a.ts')).toBe(LANGUAGE.TYPESCRIPT);
    expect(detectLanguage('src/a.tsx')).toBe(LANGUAGE.TYPESCRIPT);
    expect(detectLanguage('src/a.py')).toBe(LANGUAGE.PYTHON);
    expect(detectLanguage('src/a.go')).toBe(LANGUAGE.GO);
    expect(detectLanguage('README')).toBe(LANGUAGE.UNKNOWN);
    expect(detectLanguage('data.json')).toBe(LANGUAGE.UNKNOWN);
  });
});

describe('extractImports — TypeScript and JavaScript', () => {
  it('finds every module syntax and marks package specifiers external', () => {
    const source = `
      import { round } from '../utils/money';
      import express from 'express';
      import * as fs from 'node:fs';
      import './side-effect';
      export { helper } from './helper';
      export * from './barrel';
      const lazy = await import('./lazy');
      const legacy = require('./legacy');
    `;
    expect(specifiers('src/payment/checkout.ts', source)).toEqual([
      '../utils/money',
      './barrel',
      './helper',
      './lazy',
      './legacy',
      './side-effect',
      'express',
      'node:fs',
    ]);
    expect(internalSpecifiers('src/payment/checkout.ts', source)).toEqual([
      '../utils/money',
      './barrel',
      './helper',
      './lazy',
      './legacy',
      './side-effect',
    ]);
  });

  it('deduplicates a specifier imported more than once', () => {
    const source = `
      import { a } from './shared';
      import { b } from './shared';
    `;
    expect(specifiers('src/a.ts', source)).toEqual(['./shared']);
  });
});

describe('extractImports — Python', () => {
  it('treats leading-dot specifiers as internal and bare packages as external', () => {
    const source = [
      'from .money import round',
      'from ..core.config import settings',
      'from django.db import models',
      'import os',
    ].join('\n');
    expect(internalSpecifiers('app/payment/checkout.py', source)).toEqual([
      '..core.config',
      '.money',
    ]);
    expect(specifiers('app/payment/checkout.py', source)).toContain('django.db');
  });
});

describe('extractImports — Go', () => {
  it('reads both single imports and parenthesised blocks', () => {
    const source = ['import (', '  "fmt"', '  alias "example.com/app/payment"', ')'].join(
      '\n',
    );
    expect(specifiers('cmd/main.go', source)).toEqual(['example.com/app/payment', 'fmt']);
  });
});

describe('extractImports — Rust', () => {
  it('counts crate/super/self paths as internal only', () => {
    const source = [
      'use crate::payment::checkout;',
      'use std::collections::HashMap;',
    ].join('\n');
    expect(internalSpecifiers('src/main.rs', source)).toEqual([
      'crate::payment::checkout',
    ]);
  });
});

describe('extractImports — unsupported languages', () => {
  it('returns nothing rather than guessing', () => {
    expect(extractImports('config.json', '{"import": "./a"}')).toEqual([]);
  });
});
