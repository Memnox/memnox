import { describe, expect, it } from 'vitest';
import {
  inspectSql,
  isDatabaseClient,
  nonLocalHost,
  SQL_RISK,
  statementIn,
} from '../src/intercept/sql';

describe('reading the statement, not the tool', () => {
  it.each([
    ['DROP TABLE users', SQL_RISK.DROPS],
    ['drop database app', SQL_RISK.DROPS],
    ['TRUNCATE TABLE sessions', SQL_RISK.DROPS],
    ['DELETE FROM users', SQL_RISK.UNBOUNDED],
    ['UPDATE users SET admin = true', SQL_RISK.UNBOUNDED],
    ['DELETE FROM users WHERE id = 1', SQL_RISK.WRITES],
    ['UPDATE users SET name = $1 WHERE id = 2', SQL_RISK.WRITES],
    ['INSERT INTO logs VALUES (1)', SQL_RISK.WRITES],
    ['ALTER TABLE users ADD COLUMN x int', SQL_RISK.WRITES],
    ['GRANT ALL ON users TO app', SQL_RISK.WRITES],
    ['SELECT * FROM users', SQL_RISK.READS],
    ['show tables', SQL_RISK.READS],
    ['EXPLAIN SELECT 1', SQL_RISK.READS],
    ['VACUUM', SQL_RISK.UNKNOWN],
  ])('reads %s as %s', (sql, risk) => {
    expect(inspectSql(sql).risk).toBe(risk);
  });

  it('calls a bounded delete a write and an unbounded one destructive', () => {
    expect(inspectSql('DELETE FROM users WHERE id = 1').class).toBe('write');
    expect(inspectSql('DELETE FROM users').class).toBe('destructive');
    expect(inspectSql('DELETE FROM users').because).toContain('every row');
  });

  it('does not accept a WHERE hidden in a literal or a comment as a real clause', () => {
    /* Both of these delete every row. Counting the WHERE would be the dangerous
       direction to be wrong in, so the literal and the comment are scrubbed first. */
    expect(inspectSql("DELETE FROM notes WHERE body = 'x' OR 1=1").risk).toBe(
      SQL_RISK.WRITES,
    );
    expect(inspectSql('DELETE FROM notes -- WHERE id = 1').risk).toBe(SQL_RISK.UNBOUNDED);
    expect(inspectSql('DELETE FROM notes /* WHERE id = 1 */').risk).toBe(
      SQL_RISK.UNBOUNDED,
    );
  });

  it('is not fooled by a keyword inside a value', () => {
    const finding = inspectSql("INSERT INTO notes (body) VALUES ('DROP TABLE users')");
    expect(finding.risk).toBe(SQL_RISK.WRITES);
  });

  it('keeps the leading keyword and never the whole statement', () => {
    const finding = inspectSql("UPDATE cards SET pan = '4111111111111111' WHERE id = 1");
    expect(finding.statement).toBe('UPDATE');
    expect(JSON.stringify(finding)).not.toContain('4111111111111111');
  });

  it('says unknown rather than assuming a statement it does not recognise is safe', () => {
    expect(inspectSql('CALL do_the_thing()').class).toBe('unknown');
  });
});

describe('finding the statement on the command line', () => {
  it('knows which binaries take one', () => {
    expect(isDatabaseClient('psql')).toBe(true);
    expect(isDatabaseClient('mongosh')).toBe(true);
    expect(isDatabaseClient('git')).toBe(false);
  });

  it.each([
    ['psql', ['-c', 'DROP TABLE t'], 'DROP TABLE t'],
    ['psql', ['--command', 'SELECT 1'], 'SELECT 1'],
    ['psql', ['-cSELECT 1'], 'SELECT 1'],
    ['mysql', ['-e', 'SHOW TABLES'], 'SHOW TABLES'],
    ['mongosh', ['--eval=db.x.drop()'], 'db.x.drop()'],
  ])('%s %s', (binary, args, expected) => {
    expect(statementIn(binary, args as string[])).toBe(expected);
  });

  it('is null for an interactive session, which carries no statement', () => {
    expect(statementIn('psql', ['mydb'])).toBeNull();
    expect(statementIn('git', ['-c', 'DROP TABLE t'])).toBeNull();
  });
});

describe('which database it is pointed at', () => {
  it('ignores localhost, because your own dev database is not the worry', () => {
    expect(
      nonLocalHost([], { DATABASE_URL: 'postgres://u:p@localhost:5432/app' }),
    ).toBeNull();
    expect(nonLocalHost(['-h', '127.0.0.1'], {})).toBeNull();
  });

  it('names a host that is somebody else’s data', () => {
    expect(
      nonLocalHost([], { DATABASE_URL: 'postgres://u:p@db.prod.internal/app' }),
    ).toBe('db.prod.internal');
    expect(nonLocalHost(['-h', 'db.prod.internal'], {})).toBe('db.prod.internal');
  });

  it('never carries the password out of the URL', () => {
    const host = nonLocalHost([], {
      DATABASE_URL: 'postgres://u:hunter2@db.example/app',
    });
    expect(host).toBe('db.example');
    expect(host).not.toContain('hunter2');
  });
});
