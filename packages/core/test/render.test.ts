import { describe, expect, it } from 'vitest';
import { renderCounts, renderFields, renderTable, renderTree } from '../src/render/index';

describe('renderTable', () => {
  it('sizes each column to its widest cell, header included', () => {
    const table = renderTable(
      [{ header: 'AGENT' }, { header: 'TOOLS', align: 'right' }],
      [
        ['claude-code', '17'],
        ['cursor', '4'],
      ],
    );
    expect(table.split('\n')).toEqual([
      'AGENT        TOOLS',
      '───────────  ─────',
      'claude-code     17',
      'cursor           4',
    ]);
  });

  it('leaves no trailing whitespace, so a diff of output is readable', () => {
    const table = renderTable([{ header: 'A' }, { header: 'B' }], [['x', '']]);
    for (const line of table.split('\n')) expect(line).toBe(line.trimEnd());
  });

  it('renders headers alone when there are no rows', () => {
    expect(renderTable([{ header: 'NAME' }], []).split('\n')).toHaveLength(2);
  });
});

describe('renderTree', () => {
  it('marks the last child differently, so depth is unambiguous', () => {
    const tree = renderTree([
      {
        label: 'claude-code',
        children: [
          { label: 'github', children: [{ label: 'merge_pull_request' }] },
          { label: 'filesystem' },
        ],
      },
    ]);
    expect(tree.split('\n')).toEqual([
      'claude-code',
      '├─ github',
      '│  └─ merge_pull_request',
      '└─ filesystem',
    ]);
  });

  it('renders a leaf root as just its label', () => {
    expect(renderTree([{ label: 'nothing here' }])).toBe('nothing here');
  });
});

describe('renderFields and renderCounts', () => {
  it('aligns values on one gutter', () => {
    expect(
      renderFields([
        { label: 'server', value: 'github' },
        { label: 'declared', value: '.claude.json' },
      ]).split('\n'),
    ).toEqual(['  server    github', '  declared  .claude.json']);
  });

  it('right-aligns counts so a column of digits reads down', () => {
    expect(
      renderCounts([
        { label: 'tools', value: '7' },
        { label: 'can change external state', value: '12' },
      ]).split('\n'),
    ).toEqual(['   7  tools', '  12  can change external state']);
  });
});
