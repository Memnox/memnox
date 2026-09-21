import { indentOf, keyLine, matchesKey, scalarText } from './config-lines';

/**
 * Setting a list under a nested key in a YAML config, in place, so the file keeps its
 * comments and a revert takes back exactly the block that was written.
 */

/** Marks a list this tool wrote, so a hand-maintained one carries no fence and is left alone. */
export const YAML_FENCE =
  '# memnox: managed, remove with "memnox protect --revert-native"';

/** Sets `parent.key` to `items`, and an empty list removes the key and an emptied parent. */
export function setYamlList(
  raw: string,
  parent: string,
  key: string,
  items: readonly string[],
): string {
  const lines = raw.split('\n');
  const block = (indent: string): string[] => [
    `${indent}${key}: ${YAML_FENCE}`,
    ...items.map((item) => `${indent}  - ${scalarText(item, '"')}`),
  ];

  const parentLine = keyLine(lines, parent, 0);
  if (parentLine === -1) {
    if (items.length === 0) return raw;
    const trailing = raw.endsWith('\n') || raw === '' ? '' : '\n';
    return `${raw}${trailing}${parent}:\n${block('  ').join('\n')}\n`;
  }

  const parentIndent = indentOf(lines[parentLine] as string).length;
  const existing = keyLineWithin(lines, key, parentLine + 1, parentIndent);
  if (existing === -1) {
    if (items.length === 0) return raw;
    lines.splice(parentLine + 1, 0, ...block(`${' '.repeat(parentIndent)}  `));
    return lines.join('\n');
  }

  const own = indentOf(lines[existing] as string);
  const replacement = items.length === 0 ? [] : block(own);
  lines.splice(existing, valueEnd(lines, existing) - existing + 1, ...replacement);
  // A revert that leaves a bare `approvals:` behind has not put the file back.
  if (replacement.length === 0 && !hasChildren(lines, parentLine, parentIndent)) {
    lines.splice(parentLine, 1);
  }
  return lines.join('\n');
}

/** Whether the list that is there is ours, so a revert never removes somebody else's. */
export function yamlListIsManaged(raw: string, parent: string, key: string): boolean {
  const lines = raw.split('\n');
  const parentLine = keyLine(lines, parent, 0);
  if (parentLine === -1) return false;
  const at = keyLineWithin(
    lines,
    key,
    parentLine + 1,
    indentOf(lines[parentLine] as string).length,
  );
  return at !== -1 && (lines[at] as string).includes(YAML_FENCE);
}

/** The key's own line plus everything indented under it, up to the first blank line. */
function valueEnd(lines: readonly string[], keyAt: number): number {
  const own = indentOf(lines[keyAt] as string).length;
  let end = keyAt;
  for (let at = keyAt + 1; at < lines.length; at += 1) {
    const line = lines[at] as string;
    if (line.trim() === '' || indentOf(line).length <= own) break;
    end = at;
  }
  return end;
}

/** Any line still indented under the parent, ignoring blanks. */
function hasChildren(
  lines: readonly string[],
  parentLine: number,
  parentIndent: number,
): boolean {
  for (let at = parentLine + 1; at < lines.length; at += 1) {
    const line = lines[at] as string;
    if (line.trim() === '') continue;
    return indentOf(line).length > parentIndent;
  }
  return false;
}

/** A key inside one parent block: deeper than the parent, and before the next sibling. */
function keyLineWithin(
  lines: readonly string[],
  key: string,
  from: number,
  parentIndent: number,
): number {
  for (let at = from; at < lines.length; at += 1) {
    const line = lines[at] as string;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line).length <= parentIndent) return -1;
    if (matchesKey(line.trim(), key)) return at;
  }
  return -1;
}
