/**
 * Pure string builders. Nothing here touches a stream, a terminal width or a colour,
 * so a renderer can be snapshot-tested without a process and reused off the CLI.
 */

export interface Column {
  header: string;
  /** Right alignment is for digits, which read wrong ragged. */
  align?: 'left' | 'right';
}

const GAP = '  ';

function pad(text: string, width: number, align: 'left' | 'right'): string {
  return align === 'right' ? text.padStart(width) : text.padEnd(width);
}

/** Columns sized to their widest cell, header included. */
export function renderTable(
  columns: readonly Column[],
  rows: readonly string[][],
): string {
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) =>
        pad(cell, widths[index] ?? 0, columns[index]?.align ?? 'left'),
      )
      .join(GAP)
      .trimEnd();

  return [
    line(columns.map((column) => column.header)),
    line(widths.map((width) => '─'.repeat(width))),
    ...rows.map((row) => line(row)),
  ].join('\n');
}

export interface TreeNode {
  label: string;
  children?: readonly TreeNode[];
}

const BRANCH = '├─ ';
const LAST_BRANCH = '└─ ';
const TRUNK = '│  ';
const CLEAR = '   ';

function renderBranch(nodes: readonly TreeNode[], prefix: string): string[] {
  return nodes.flatMap((node, index) => {
    const last = index === nodes.length - 1;
    const head = `${prefix}${last ? LAST_BRANCH : BRANCH}${node.label}`;
    const children = node.children ?? [];
    if (children.length === 0) return [head];
    return [head, ...renderBranch(children, `${prefix}${last ? CLEAR : TRUNK}`)];
  });
}

export function renderTree(roots: readonly TreeNode[]): string {
  return roots
    .flatMap((root) => [root.label, ...renderBranch(root.children ?? [], '')])
    .join('\n');
}

export interface Field {
  label: string;
  value: string;
}

/** Label-and-value pairs on one aligned gutter, for a page read rather than scanned. */
export function renderFields(fields: readonly Field[], indent = '  '): string {
  const width = Math.max(0, ...fields.map((field) => field.label.length));
  return fields
    .map((field) => `${indent}${field.label.padEnd(width)}${GAP}${field.value}`)
    .join('\n');
}

/** One count per line, aligned on the number, so a column of digits reads down. */
export function renderCounts(counts: readonly Field[]): string {
  const width = Math.max(0, ...counts.map((count) => count.value.length));
  return counts
    .map((count) => `  ${count.value.padStart(width)}  ${count.label}`)
    .join('\n');
}
