import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The house style, asserted rather than remembered.
 *
 * `CONTRIBUTING.md` states these; this is what stops the thirty-second command being
 * written in a shape nobody else uses. Every rule here was a real divergence at some
 * point, and each one costs a reader time rather than correctness, which is exactly the
 * kind of thing a review waves through and a test does not.
 *
 * It lives in the CLI's suite and reads all four packages, because the style is one
 * style: a rule that held in three of them and not the fourth would be the divergence
 * it exists to prevent.
 */

const REPO = join(import.meta.dirname, '..', '..', '..');
const PACKAGES = ['core', 'cli', 'proxy', 'interceptors'];
const COMMANDS = join(REPO, 'packages', 'cli', 'src', 'commands');

/** Long enough for a delegating call written across several lines, short enough to catch logic. */
const LONGEST_ACTION_BODY = 12;

/** Below this a module is a constant or two, and a header would say less than the code. */
const TRIVIAL_MODULE_LINES = 25;

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Every source file in the workspace, because the style is one style across all four. */
function everySource(): string[] {
  return PACKAGES.flatMap((name) => tsFilesUnder(join(REPO, 'packages', name, 'src')));
}

const commandFiles = readdirSync(COMMANDS).filter((name) => name.endsWith('.command.ts'));

describe('every command is registration and nothing else', () => {
  it.each(commandFiles)('%s keeps its logic out of .action()', (name) => {
    const lines = readFileSync(join(COMMANDS, name), 'utf8').split('\n');

    for (const [index, line] of lines.entries()) {
      if (!line.includes('.action(')) continue;
      let depth = 0;
      let end = index;
      while (end < lines.length) {
        const at = lines[end] ?? '';
        depth += at.split('(').length - at.split(')').length;
        if (depth <= 0) break;
        end += 1;
      }
      const span = end - index + 1;
      expect(
        span,
        `${name}: an .action() body of ${span} lines. Move it to a run* function, the way every other command does.`,
      ).toBeLessThanOrEqual(LONGEST_ACTION_BODY);
    }
  });
});

describe('every module says what it is', () => {
  const modules = everySource().filter(
    (file) => readFileSync(file, 'utf8').split('\n').length >= TRIVIAL_MODULE_LINES,
  );

  it('finds the modules to check', () => {
    expect(modules.length).toBeGreaterThan(200);
  });

  it.each(modules)('%s opens with a doc comment', (file) => {
    const source = readFileSync(file, 'utf8');
    const declaration =
      /^(export )?(async )?(abstract )?(function|class|const|interface|type|enum) /m.exec(
        source,
      );
    if (declaration === null) return;

    expect(
      source.slice(0, declaration.index),
      `${file}: nothing above the first declaration says what this module is for.`,
    ).toContain('/**');
  });
});

describe('one name per job', () => {
  /* `say*` and `render*` were two names for writing to the rail. One of them had to go,
     and `render*` had thirty-four functions to `say*`'s five. */
  it('has no say* functions, because render* is the name for that', () => {
    const offenders = everySource().filter((file) =>
      /(?:^|\s)(?:export )?(?:async )?function say[A-Z]/m.test(
        readFileSync(file, 'utf8'),
      ),
    );

    expect(offenders).toEqual([]);
  });
});

describe('imports are grouped the same way everywhere', () => {
  /** node built-ins, then packages, then our own packages, then relative paths. */
  const ORDER = ['node:', 'package', '@memnox/', './'] as const;

  function groupOf(specifier: string): number {
    if (specifier.startsWith('node:')) return 0;
    if (specifier.startsWith('@memnox/')) return 2;
    if (specifier.startsWith('.')) return 3;
    return 1;
  }

  const modules = everySource().filter(
    (file) => !/^import '/m.test(readFileSync(file, 'utf8')),
  );

  it.each(modules)('%s imports in order', (file) => {
    const source = readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/^import\s[^;]*?from '([^']+)';/gms)].map(
      (match) => match[1] ?? '',
    );
    const groups = specifiers.map(groupOf);

    expect(
      groups,
      `${file}: imports jump back a group. The order is ${ORDER.join(' then ')}.`,
    ).toEqual([...groups].sort((a, b) => a - b));
  });
});

describe('one way to write a function', () => {
  /* 1293 function declarations against 12 arrow consts, so the declaration is the
     house style and the arrows were the accident. */
  it('declares functions rather than assigning arrows to consts', () => {
    const offenders = everySource().filter((file) =>
      /^(?:export )?const \w+ = (?:async )?\([^)]*\)(?:\s*:\s*[^=]+)? =>/m.test(
        readFileSync(file, 'utf8'),
      ),
    );

    expect(offenders).toEqual([]);
  });

  /* `import type { X }` when everything from that module is a type, `import { type X }`
     only when the same statement also brings in a value. */
  it('writes an all-type import as `import type`', () => {
    const offenders = everySource().filter((file) =>
      [...readFileSync(file, 'utf8').matchAll(/^import \{([^}]*)\} from/gms)].some(
        (match) => {
          const names = (match[1] ?? '')
            .split(',')
            .map((each) => each.trim())
            .filter((each) => each !== '');
          return names.length > 0 && names.every((each) => each.startsWith('type '));
        },
      ),
    );

    expect(offenders).toEqual([]);
  });
});

describe('comments stay short enough to be read', () => {
  const sources = everySource();

  // Prose longer than this belongs in docs/, where it is read on purpose.
  const LONGEST_DOC_COMMENT = 5;
  const LONGEST_LINE_COMMENT_RUN = 2;

  it.each(sources)('%s writes comments as // or /** */, never /* */', (file) => {
    const blocks = readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) => (/^\s*\/\*(?!\*)/.test(line) ? [index + 1] : []));
    expect(blocks, `${file}: a /* */ comment at lines ${blocks.join(', ')}. Use //.`).toEqual(
      [],
    );
  });

  it.each(sources)('%s keeps every doc comment to three lines of text', (file) => {
    const source = readFileSync(file, 'utf8');
    const long = [...source.matchAll(/\/\*\*[\s\S]*?\*\//g)]
      .filter((match) => match[0].split('\n').length > LONGEST_DOC_COMMENT)
      .map((match) => source.slice(0, match.index).split('\n').length);
    expect(long, `${file}: doc comments over three lines at lines ${long.join(', ')}.`).toEqual(
      [],
    );
  });

  it.each(sources)('%s keeps every // comment to two lines', (file) => {
    const long: number[] = [];
    let run = 0;
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      run = line.trim().startsWith('//') ? run + 1 : 0;
      if (run === LONGEST_LINE_COMMENT_RUN + 1) long.push(index + 1);
    }
    expect(long, `${file}: a // comment runs past two lines at ${long.join(', ')}.`).toEqual(
      [],
    );
  });

  it.each(sources)('%s gives each symbol one doc comment', (file) => {
    const source = readFileSync(file, 'utf8');
    const stacked = [...source.matchAll(/\*\/[ \t]*\n[ \t]*\/\*\*/g)].map(
      (match) => source.slice(0, match.index).split('\n').length,
    );
    expect(stacked, `${file}: two doc comments in a row at ${stacked.join(', ')}.`).toEqual(
      [],
    );
  });
});

describe('functions and modules stay small enough to hold in your head', () => {
  const sources = everySource();

  // Past four, a call site is a row of values nobody can match to names: take an object.
  const MOST_PARAMETERS = 4;
  const LONGEST_MODULE = 500;

  function parametersOf(list: string): number {
    let depth = 0;
    let count = list.trim() === '' ? 0 : 1;
    for (const char of list) {
      if ('<({['.includes(char)) depth += 1;
      else if ('>)}]'.includes(char)) depth -= 1;
      else if (char === ',' && depth === 0) count += 1;
    }
    return list.trim().endsWith(',') ? count - 1 : count;
  }

  it.each(sources)('%s takes an options object past four parameters', (file) => {
    const source = readFileSync(file, 'utf8');
    const wide = [...source.matchAll(/function (\w+)\s*(?:<[^>]*>)?\(([^)]*)\)\s*:/g)]
      .filter((match) => parametersOf(match[2] ?? '') > MOST_PARAMETERS)
      .map((match) => match[1]);
    expect(wide, `${file}: more than four parameters in ${wide.join(', ')}.`).toEqual([]);
  });

  const LONGEST_FUNCTION = 40;
  const FUNCTION_START =
    /^\s*(?:export )?(?:async )?function \w+|^\s+(?:(?:public|private|protected|static|async|get|set) )*\w+\s*(?:<[^>]*>)?\(.*\)\s*(?::\s*[^{]+)?\{\s*$/;
  const NOT_A_METHOD = /^\s+(?:if|for|while|switch|catch|return|else|do)\b/;

  // Brace depth from where the function opens to where it closes, strings aside.
  function lengthFrom(lines: readonly string[], start: number): number {
    let depth = 0;
    let opened = false;
    for (let at = start; at < lines.length; at += 1) {
      const code = (lines[at] ?? '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '');
      for (const char of code) {
        if (char === '{') {
          depth += 1;
          opened = true;
        } else if (char === '}') depth -= 1;
      }
      if (opened && depth <= 0) return at - start + 1;
    }
    return lines.length - start;
  }

  it.each(sources)('%s keeps every function under forty lines', (file) => {
    const lines = readFileSync(file, 'utf8').split('\n');
    const long = lines.flatMap((line, index) => {
      if (!FUNCTION_START.test(line) || NOT_A_METHOD.test(line)) return [];
      const span = lengthFrom(lines, index);
      return span > LONGEST_FUNCTION ? [`${line.trim().slice(0, 40)} (${span})`] : [];
    });
    expect(long, `${file}: functions over forty lines: ${long.join('; ')}`).toEqual([]);
  });

  it.each(sources)('%s stays under five hundred lines', (file) => {
    const lines = readFileSync(file, 'utf8').split('\n').length;
    expect(lines, `${file}: ${lines} lines. Split it by job.`).toBeLessThanOrEqual(
      LONGEST_MODULE,
    );
  });

  it.each(sources)('%s names locals in camelCase', (file) => {
    const snake = [
      ...readFileSync(file, 'utf8').matchAll(/\b(?:const|let|function) ([a-z]+_[a-z_]+)\b/g),
    ].map((match) => match[1]);
    expect(snake, `${file}: snake_case names ${snake.join(', ')}.`).toEqual([]);
  });
});
