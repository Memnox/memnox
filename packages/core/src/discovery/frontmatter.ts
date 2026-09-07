/**
 * Enough YAML to read a definition's leading `---` block, and deliberately no more.
 *
 * The same trade as the two readers beside it: a full parser is a dependency and an
 * attack surface for a file we take three keys out of. `yaml-block.ts` cannot be
 * reused here — it exists to read nested config blocks and discards the `---`
 * delimiter this depends on, which is the one line that says where the block ends.
 *
 * The distinction the whole module is for: a key that is *absent* is not a key set to
 * nothing. On the harnesses this reads, an absent `tools` means inherit everything.
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
  /* A file that opens a block and never closes it has no frontmatter — it has a
     horizontal rule on its first line, and guessing where the block ended would
     invent keys out of prose. */
  if (closes === -1) return empty;

  const fields = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let last: string | null = null;

  for (const line of lines.slice(1, closes)) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;

    if (text.startsWith('- ')) {
      // An indented sequence entry belongs to the key above it, or to nothing.
      if (last === null) continue;
      appendTo(lists, last, unquote(text.slice(2).trim()));
      continue;
    }

    const split = keySplit(text);
    if (split === null) continue;
    const [key, rest] = split;
    last = key;
    if (rest === '') {
      // Declared with nothing on its line: a list is what follows, or it is empty.
      lists.set(key, []);
      continue;
    }
    if (rest.startsWith('[')) {
      lists.set(key, flowItems(rest));
      continue;
    }
    fields.set(key, unquote(rest));
  }

  return { fields, lists, body: lines.slice(closes + 1).join('\n') };
}

/** `key: rest`, where an empty key or a leading colon is not a key at all. */
function keySplit(text: string): [string, string] | null {
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const key = text.slice(0, at).trim();
  if (key === '') return null;
  return [unquote(key), text.slice(at + 1).trim()];
}

function appendTo(lists: Map<string, string[]>, key: string, item: string): void {
  const held = lists.get(key) ?? [];
  if (item !== '') held.push(item);
  lists.set(key, held);
}

function flowItems(text: string): string[] {
  const close = text.lastIndexOf(']');
  return text
    .slice(1, close === -1 ? undefined : close)
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

/**
 * A key read as a list however it was written, and `null` when it was never written.
 *
 * `null` and `[]` are different answers and the caller must be able to tell them
 * apart: on a Claude Code subagent an absent `tools` inherits every tool in the
 * session, so collapsing the two would report the widest grant there is as the
 * narrowest one.
 */
export function declaredList(matter: Frontmatter, key: string): string[] | null {
  const list = matter.lists.get(key);
  if (list !== undefined) return [...list];
  const scalar = matter.fields.get(key);
  if (scalar === undefined) return null;
  /* `tools: Read, Write` is how most of them are written, and a single unquoted
     scalar is a one-item list rather than a sentence. */
  return scalar
    .split(',')
    .map((each) => each.trim())
    .filter((each) => each !== '');
}
