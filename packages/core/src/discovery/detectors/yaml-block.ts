import { findOutsideQuotes, flowItems, splitKey, unquote } from '../scalar-text';

/**
 * Enough YAML to read a config's server block, because a full parser is a dependency
 * and an attack surface for four keys. A shape this does not understand comes back empty.
 */
export interface YamlBlock {
  /** The scalar on the key's own line, when it had one. */
  value?: string;
  children: Map<string, YamlBlock>;
  /** Sequence entries, from either `- item` lines or an inline `[a, b]`. */
  items: string[];
}

interface Line {
  indent: number;
  text: string;
}

export function parseYamlBlocks(raw: string | null): YamlBlock {
  const root: YamlBlock = { children: new Map(), items: [] };
  if (raw === null) return root;
  const lines = readable(raw);
  build(root, lines, 0, 0);
  return root;
}

/** Comments and blank lines carry nothing here, and tabs are not YAML indentation. */
function readable(raw: string): Line[] {
  const lines: Line[] = [];
  for (const line of raw.split('\n')) {
    if (line.includes('\t')) continue;
    const stripped = withoutComment(line);
    const text = stripped.trim();
    if (text === '' || text === '---') continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text });
  }
  return lines;
}

/** A `#` inside quotes is data. Anywhere else on the line it starts a comment. */
function withoutComment(line: string): string {
  const at = findOutsideQuotes(
    line,
    (char, index) => char === '#' && (index === 0 || line[index - 1] === ' '),
  );
  return at === -1 ? line : line.slice(0, at);
}

/** Consumes every line indented deeper than the parent, and returns where it stopped. */
function build(
  parent: YamlBlock,
  lines: readonly Line[],
  from: number,
  at: number,
): number {
  let index = from;
  while (index < lines.length) {
    const line = lines[index] as Line;
    if (line.indent < at) return index;

    if (line.text.startsWith('- ')) {
      parent.items.push(unquote(line.text.slice(2).trim()));
      index += 1;
      continue;
    }

    const colon = splitKey(line.text);
    if (colon === null) {
      index += 1;
      continue;
    }
    const [key, rest] = colon;
    const child: YamlBlock = { children: new Map(), items: [] };
    if (rest !== '') {
      if (rest.startsWith('[')) child.items.push(...flowItems(rest));
      else child.value = unquote(rest);
    }
    parent.children.set(key, child);
    index += 1;
    // A block child is whatever follows at a deeper indent, sequence entries included.
    if (index < lines.length && (lines[index] as Line).indent > line.indent) {
      index = build(child, lines, index, (lines[index] as Line).indent);
    }
  }
  return index;
}

export function blockAt(root: YamlBlock, ...path: readonly string[]): YamlBlock | null {
  let node = root;
  for (const key of path) {
    const next = node.children.get(key);
    if (next === undefined) return null;
    node = next;
  }
  return node;
}

/** A list written either way, so the caller never has to care which the author used. */
export function listIn(block: YamlBlock | null): string[] {
  if (block === null) return [];
  if (block.items.length > 0) return [...block.items];
  return block.value === undefined ? [] : [block.value];
}
