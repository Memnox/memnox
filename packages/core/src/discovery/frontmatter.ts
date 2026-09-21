import { flowItems, splitKey, unquote } from './scalar-text';

/**
 * Enough YAML to read a definition's leading `---` block. An absent key is not a key
 * set to nothing here, because an absent `tools` inherits everything.
 */
export interface Frontmatter {
  /** Scalar values by key, in the order they were written. */
  fields: Map<string, string>;
  /** Keys written as a list, either `[a, b]` or `- a` lines. */
  lists: Map<string, string[]>;
  /** Everything after the closing delimiter, or the whole text when there was no block. */
  body: string;
}

const FENCE = '---';
/** A block may also be closed with `...`, which some writers emit. */
const END = '...';

export function parseFrontmatter(raw: string): Frontmatter {
  const empty: Frontmatter = { fields: new Map(), lists: new Map(), body: raw };
  const lines = raw.split('\n');
  if ((lines[0] ?? '').trim() !== FENCE) return empty;

  const closes = lines.findIndex(
    (line, at) => at > 0 && (line.trim() === FENCE || line.trim() === END),
  );
  // Never closed means a horizontal rule rather than a block, and guessing where it
  // ended would invent keys out of prose.
  if (closes === -1) return empty;

  const matter: Frontmatter = { fields: new Map(), lists: new Map(), body: '' };
  readBlock(matter, lines.slice(1, closes));
  return { ...matter, body: lines.slice(closes + 1).join('\n') };
}

/** Fills `matter` from the lines between the fences. */
function readBlock(matter: Frontmatter, lines: readonly string[]): void {
  let last: string | null = null;
  for (const line of lines) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;

    if (text.startsWith('- ')) {
      // An indented sequence entry belongs to the key above it, or to nothing.
      if (last !== null) appendTo(matter.lists, last, unquote(text.slice(2).trim()));
      continue;
    }

    const split = splitKey(text);
    if (split === null) continue;
    const [key, rest] = split;
    last = key;
    // Declared with nothing on its line: a list is what follows, or it is empty.
    if (rest === '') matter.lists.set(key, []);
    else if (rest.startsWith('[')) matter.lists.set(key, flowItems(rest));
    else matter.fields.set(key, unquote(rest));
  }
}

function appendTo(lists: Map<string, string[]>, key: string, item: string): void {
  const held = lists.get(key) ?? [];
  if (item !== '') held.push(item);
  lists.set(key, held);
}

/**
 * A key read as a list however it was written, and `null` when it was never written,
 * because an absent `tools` inherits every tool and `[]` grants none.
 */
export function declaredList(matter: Frontmatter, key: string): string[] | null {
  const list = matter.lists.get(key);
  if (list !== undefined) return [...list];
  const scalar = matter.fields.get(key);
  if (scalar === undefined) return null;
  // `tools: Read, Write` is how most are written, so a scalar is a comma list.
  return scalar
    .split(',')
    .map((each) => each.trim())
    .filter((each) => each !== '');
}
