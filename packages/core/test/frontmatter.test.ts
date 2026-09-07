import { describe, expect, it } from 'vitest';
import { declaredList, parseFrontmatter } from '../src/discovery/frontmatter';

/**
 * The header on a definition file, and the one distinction the whole reader is for:
 * a key nobody wrote is not a key set to nothing.
 */

describe('reading a leading block', () => {
  it('takes the scalars and hands back the body', () => {
    const matter = parseFrontmatter(
      ['---', 'name: DevOps Automator', 'color: orange', '---', '', '# Body'].join('\n'),
    );
    expect(matter.fields.get('name')).toBe('DevOps Automator');
    expect(matter.fields.get('color')).toBe('orange');
    expect(matter.body.trim()).toBe('# Body');
  });

  it('unquotes a value written with quotes', () => {
    const matter = parseFrontmatter(['---', 'color: "#dc2626"', '---'].join('\n'));
    expect(matter.fields.get('color')).toBe('#dc2626');
  });

  it('reads a flow list', () => {
    const matter = parseFrontmatter(['---', 'tools: [Read, "Bash"]', '---'].join('\n'));
    expect(declaredList(matter, 'tools')).toEqual(['Read', 'Bash']);
  });

  it('reads a block list under its key', () => {
    const matter = parseFrontmatter(
      ['---', 'tools:', '  - Read', '  - Bash', '---'].join('\n'),
    );
    expect(declaredList(matter, 'tools')).toEqual(['Read', 'Bash']);
  });

  it('reads a comma-separated scalar as the list it is', () => {
    const matter = parseFrontmatter(
      ['---', 'tools: WebFetch, WebSearch, Read', '---'].join('\n'),
    );
    expect(declaredList(matter, 'tools')).toEqual(['WebFetch', 'WebSearch', 'Read']);
  });

  it('finds the key wherever in the block it was written', () => {
    // Both orderings occur in the same public roster, so neither may be assumed.
    const first = parseFrontmatter(
      ['---', 'tools: Read', 'name: One', 'color: blue', '---'].join('\n'),
    );
    const last = parseFrontmatter(
      ['---', 'name: One', 'color: blue', 'tools: Read', '---'].join('\n'),
    );
    expect(declaredList(first, 'tools')).toEqual(['Read']);
    expect(declaredList(last, 'tools')).toEqual(['Read']);
  });

  it('closes on the terminator some writers use instead', () => {
    const matter = parseFrontmatter(['---', 'name: One', '...', 'body'].join('\n'));
    expect(matter.fields.get('name')).toBe('One');
    expect(matter.body.trim()).toBe('body');
  });
});

describe('what is absent', () => {
  it('reports an absent key as absent, never as an empty list', () => {
    const matter = parseFrontmatter(['---', 'name: One', '---', 'prose'].join('\n'));
    expect(declaredList(matter, 'tools')).toBeNull();
  });

  it('reports a key declared with nothing as an empty list', () => {
    const matter = parseFrontmatter(['---', 'tools:', '---'].join('\n'));
    expect(declaredList(matter, 'tools')).toEqual([]);
  });

  it('has no frontmatter when a file merely opens with a rule', () => {
    /* A block that never closes is a horizontal rule, and guessing where it ended
       would invent keys out of prose. */
    const matter = parseFrontmatter(['---', 'name: One', 'and then prose'].join('\n'));
    expect(matter.fields.size).toBe(0);
    expect(matter.body).toContain('and then prose');
  });

  it('has no frontmatter when the file does not open with one', () => {
    const matter = parseFrontmatter('# Title\n\n---\nname: One\n---\n');
    expect(matter.fields.size).toBe(0);
  });
});
