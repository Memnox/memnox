import { describe, expect, it } from 'vitest';
import { ToolFilter } from '../src/tool-filter';

describe('ToolFilter', () => {
  it('allows everything when no patterns are set', () => {
    expect(new ToolFilter().isAllowed('anything')).toBe(true);
  });

  it('applies deny after allow', () => {
    const filter = new ToolFilter('^repo_', 'delete');
    expect(filter.isAllowed('repo_read')).toBe(true);
    expect(filter.isAllowed('repo_delete')).toBe(false);
    expect(filter.isAllowed('issues_read')).toBe(false);
  });

  it('ignores an invalid pattern instead of crashing', () => {
    const warnings: string[] = [];
    const filter = new ToolFilter('([', undefined, (msg) => warnings.push(msg));
    expect(filter.isAllowed('anything')).toBe(true);
    expect(warnings).toHaveLength(1);
  });
});
