import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveShellLine } from '../src/intercept/resolve';

async function withFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memnox-sql-'));
  await writeFile(join(dir, 'query.sql'), contents);
  return dir;
}

function classOf(line: string, pwd: string): string {
  return String(resolveShellLine(line, { PWD: pwd }).actions[0]?.class);
}

describe('a file of statements handed to psql', () => {
  it('is read, so a file of selects is a read', async () => {
    const dir = await withFile('SELECT id, status FROM payments WHERE id = 481;\n');
    expect(classOf('psql -f query.sql', dir)).toBe('read');
    expect(classOf('psql --file=query.sql', dir)).toBe('read');
  });

  it('is what it holds, so a file that drops is destructive', async () => {
    const dir = await withFile('SELECT 1;\nDROP TABLE payments;\n');
    expect(classOf('psql -f query.sql', dir)).toBe('destructive');
  });

  it('stays a write when the file will not read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnox-sql-'));
    expect(classOf('psql -f missing.sql', dir)).toBe('write');
  });
});
