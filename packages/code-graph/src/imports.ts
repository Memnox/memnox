import { LANGUAGE, type Language } from './code-graph.constants';
import { detectLanguage } from './language';

export interface CodeImport {
  /** The specifier exactly as written, e.g. "./payment/checkout" or "express". */
  specifier: string;
  /** Resolvable inside the repo — relative or crate/package-local. */
  internal: boolean;
}

const ES_IMPORT = /^[ \t]*import\s+(?:[\w*{}\n\r\t, ]+\s+from\s+)?['"]([^'"]+)['"]/gm;
const ES_EXPORT_FROM = /^[ \t]*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_CALL = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_FROM = /^[ \t]*from\s+([\w.]+)\s+import\s+/gm;
const PY_IMPORT = /^[ \t]*import\s+([\w.]+)/gm;
const GO_SINGLE = /^[ \t]*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
const GO_BLOCK = /^[ \t]*import\s*\(([\s\S]*?)\)/gm;
const GO_BLOCK_ENTRY = /(?:^|\n)\s*(?:[\w.]+\s+)?"([^"]+)"/g;
const RUBY_REQUIRE = /\brequire(?:_relative)?\s+['"]([^'"]+)['"]/g;
const RUST_USE = /^[ \t]*use\s+((?:crate|super|self)(?:::[\w*{}, ]+)*)\s*;/gm;

const RELATIVE_PREFIXES: readonly string[] = ['./', '../', '/'];
const RUST_INTERNAL_PREFIXES: readonly string[] = ['crate', 'super', 'self'];
const PY_RELATIVE_PREFIX = '.';

function isRelative(specifier: string): boolean {
  return RELATIVE_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

function collect(
  content: string,
  pattern: RegExp,
  internal: (specifier: string) => boolean,
  into: Map<string, CodeImport>,
): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const specifier = match[1];
    if (!specifier || into.has(specifier)) continue;
    into.set(specifier, { specifier, internal: internal(specifier) });
  }
}

function collectGoBlocks(content: string, into: Map<string, CodeImport>): void {
  GO_BLOCK.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = GO_BLOCK.exec(content)) !== null) {
    const body = block[1];
    if (!body) continue;
    collect(body, GO_BLOCK_ENTRY, isRelative, into);
  }
}

/**
 * Import specifiers for one file. Regex-based and intentionally so: the graph is
 * built from whole repositories on every refresh, where a real parser per language
 * would be a dependency tree the trust-critical path cannot carry.
 */
export function extractImports(filePath: string, content: string): CodeImport[] {
  const language: Language = detectLanguage(filePath);
  const found = new Map<string, CodeImport>();

  switch (language) {
    case LANGUAGE.TYPESCRIPT:
    case LANGUAGE.JAVASCRIPT:
      collect(content, ES_IMPORT, isRelative, found);
      collect(content, ES_EXPORT_FROM, isRelative, found);
      collect(content, DYNAMIC_IMPORT, isRelative, found);
      collect(content, REQUIRE_CALL, isRelative, found);
      break;
    case LANGUAGE.PYTHON:
      collect(content, PY_FROM, (s) => s.startsWith(PY_RELATIVE_PREFIX), found);
      collect(content, PY_IMPORT, (s) => s.startsWith(PY_RELATIVE_PREFIX), found);
      break;
    case LANGUAGE.GO:
      collect(content, GO_SINGLE, isRelative, found);
      collectGoBlocks(content, found);
      break;
    case LANGUAGE.RUBY:
      collect(content, RUBY_REQUIRE, isRelative, found);
      break;
    case LANGUAGE.RUST:
      collect(
        content,
        RUST_USE,
        (s) => RUST_INTERNAL_PREFIXES.some((prefix) => s.startsWith(prefix)),
        found,
      );
      break;
    default:
      break;
  }

  return [...found.values()];
}
