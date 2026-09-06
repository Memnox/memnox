/**
 * Enough YAML to read a config's server block, and deliberately no more. A full parser
 * is a dependency and an attack surface for a file we only ever read four keys out of;
 * a shape this does not understand comes back empty, which is absence rather than a guess.
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
  let quote: string | null = null;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at] as string;
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (at === 0 || line[at - 1] === ' ')) return line.slice(0, at);
  }
  return line;
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

    const colon = keySplit(line.text);
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

function keySplit(text: string): [string, string] | null {
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const key = text.slice(0, at).trim();
  if (key === '') return null;
  return [unquote(key), text.slice(at + 1).trim()];
}

/** `[a, "b", c]` on one line, which is how tool filters are usually written. */
function flowItems(text: string): string[] {
  const inner = text.slice(
    1,
    text.lastIndexOf(']') === -1 ? undefined : text.lastIndexOf(']'),
  );
  return inner
    .split(',')
    .map((each) => unquote(each.trim()))
    .filter((each) => each !== '');
}

function unquote(text: string): string {
  const first = text[0];
  if ((first === '"' || first === "'") && text.endsWith(first) && text.length > 1) {
    return text.slice(1, -1);
  }
  return text;
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
