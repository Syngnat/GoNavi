import { describe, expect, it } from 'vitest';

import { isSqlStatementStartBoundary, resolveSqlStatementStartKeywords } from './sqlStatementBoundary';

const boundary = (overrides: Partial<Parameters<typeof isSqlStatementStartBoundary>[0]>) => (
  isSqlStatementStartBoundary({
    token: 'select',
    dbType: 'mysql',
    atLineStart: true,
    parenDepth: 0,
    previousToken: '',
    previousChar: '1',
    pendingHeadToken: 'select',
    ...overrides,
  })
);

describe('resolveSqlStatementStartKeywords', () => {
  it('always exposes the cross dialect statement keywords', () => {
    const keywords = resolveSqlStatementStartKeywords('');

    ['select', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'truncate'].forEach((keyword) => {
      expect(keywords.has(keyword)).toBe(true);
    });
  });

  it('adds dialect specific statement keywords', () => {
    expect(resolveSqlStatementStartKeywords('mysql').has('flush')).toBe(true);
    expect(resolveSqlStatementStartKeywords('postgres').has('vacuum')).toBe(true);
    expect(resolveSqlStatementStartKeywords('sqlite').has('pragma')).toBe(true);
    expect(resolveSqlStatementStartKeywords('clickhouse').has('system')).toBe(true);

    expect(resolveSqlStatementStartKeywords('postgres').has('flush')).toBe(false);
    expect(resolveSqlStatementStartKeywords('mysql').has('pragma')).toBe(false);
  });

  it('keeps COMMENT out of MySQL where it is a table option', () => {
    expect(resolveSqlStatementStartKeywords('mysql').has('comment')).toBe(false);
    expect(resolveSqlStatementStartKeywords('oracle').has('comment')).toBe(true);
    expect(resolveSqlStatementStartKeywords('postgres').has('comment')).toBe(true);
  });

  it('dialect specific START is only available in PG and Oracle', () => {
    // `START TRANSACTION` — `start` is not a universal statement opener.
    expect(resolveSqlStatementStartKeywords('postgres').has('start')).toBe(true);
    expect(resolveSqlStatementStartKeywords('oracle').has('start')).toBe(true);
    expect(resolveSqlStatementStartKeywords('mysql').has('start')).toBe(false);
    expect(resolveSqlStatementStartKeywords('sqlite').has('start')).toBe(false);
  });

  it('does not expose LOCK as a universal statement opener', () => {
    // `LOCK IN SHARE MODE` is a clause, not a standalone statement.
    expect(resolveSqlStatementStartKeywords('mysql').has('lock')).toBe(false);
    expect(resolveSqlStatementStartKeywords('postgres').has('lock')).toBe(false);
    expect(resolveSqlStatementStartKeywords('sqlserver').has('lock')).toBe(false);
  });

  it('caches results for repeated calls with the same dbType', () => {
    const first = resolveSqlStatementStartKeywords('mysql');
    const second = resolveSqlStatementStartKeywords('mysql');
    expect(first).toBe(second);
  });
});

describe('isSqlStatementStartBoundary', () => {
  it('opens a new statement for a line leading keyword', () => {
    // Default pendingHeadToken is 'select', but a new SELECT after SELECT
    // is a fresh statement, so we override pendingHeadToken to ''.
    expect(boundary({ previousToken: '', pendingHeadToken: '' })).toBe(true);
    expect(boundary({ token: 'alter', previousToken: 'users', previousChar: 's', pendingHeadToken: '' })).toBe(true);
    expect(boundary({ token: 'drop', previousToken: 'users', previousChar: 's', pendingHeadToken: '' })).toBe(true);
  });

  it('ignores keywords that are not at the start of a line', () => {
    expect(boundary({ atLineStart: false })).toBe(false);
  });

  it('ignores keywords nested in parentheses', () => {
    expect(boundary({ parenDepth: 1 })).toBe(false);
  });

  it('only splits on keywords the dialect can start a statement with', () => {
    expect(boundary({ token: 'pragma', dbType: 'mysql', previousToken: 'x', previousChar: 'x' })).toBe(false);
    expect(boundary({ token: 'pragma', dbType: 'sqlite', previousToken: 'x', previousChar: 'x' })).toBe(true);
  });

  // Regression: previously CLAUSE_TRAILER_TOKENS did not include desc/asc.
  // `ORDER BY id DESC\nSELECT 1` must not split on the leading DESC.
  it('keeps DESC attached to an ordering clause', () => {
    expect(boundary({ token: 'desc', pendingHeadToken: 'select', previousChar: 'c' })).toBe(false);
    expect(boundary({ token: 'desc', pendingHeadToken: 'desc', previousChar: 'c' })).toBe(true);
    expect(boundary({ token: 'asc', pendingHeadToken: 'select', previousChar: 'c' })).toBe(false);
  });

  it('keeps the statement open when the previous token cannot end it', () => {
    ['union', 'as', 'from', 'then', 'and', 'by'].forEach((previousToken) => {
      expect(boundary({ previousToken, previousChar: previousToken.slice(-1) })).toBe(false);
    });
  });

  it('keeps the statement open when the previous character cannot end it', () => {
    [',', '(', '=', '+', '.'].forEach((previousChar) => {
      expect(boundary({ previousChar })).toBe(false);
    });
  });

  it('treats a closing parenthesis or quote as a valid statement end', () => {
    expect(boundary({ token: 'insert', previousChar: ')', pendingHeadToken: 'create' })).toBe(true);
    expect(boundary({ token: 'insert', previousChar: "'", pendingHeadToken: 'insert' })).toBe(true);
  });

  it('keeps a query body attached to the statement that consumes it', () => {
    expect(boundary({ pendingHeadToken: 'insert', previousChar: ')' })).toBe(false);
    expect(boundary({ pendingHeadToken: 'with', previousChar: ')' })).toBe(false);
    expect(boundary({ pendingHeadToken: 'explain', previousToken: 'analyze', previousChar: 'e' })).toBe(false);
    expect(boundary({ token: 'values', pendingHeadToken: 'insert', previousChar: 't' })).toBe(false);
  });

  it('keeps SET attached to an assignment statement', () => {
    expect(boundary({ token: 'set', pendingHeadToken: 'update', previousChar: 't' })).toBe(false);
    expect(boundary({ token: 'set', pendingHeadToken: 'alter', previousChar: 't' })).toBe(false);
    expect(boundary({ token: 'set', pendingHeadToken: 'set', previousChar: '1' })).toBe(true);
  });

  it('allows a statement to follow COMMIT or ROLLBACK', () => {
    expect(boundary({ previousToken: 'commit', previousChar: 't', pendingHeadToken: 'commit' })).toBe(true);
    expect(boundary({ previousToken: 'rollback', previousChar: 'k', pendingHeadToken: 'rollback' })).toBe(true);
  });

  // #1 SQL Server WITH (NOLOCK) — `with` after `select` must not split.
  it('keeps WITH attached to a SELECT (SQL Server table hints)', () => {
    expect(boundary({ token: 'with', pendingHeadToken: 'select', previousChar: ')' })).toBe(false);
    expect(boundary({ token: 'with', pendingHeadToken: 'select', previousChar: 'n' })).toBe(false);
    // But `WITH` after a non-blocking previous statement can start a new CTE.
    expect(boundary({ token: 'with', pendingHeadToken: 'rollback', previousChar: 'k' })).toBe(true);
  });

  // #3/#4 Absorption: INSERT/UPDATE/DELETE/MERGE can consume a following SELECT.
  it('keeps DELETE attached to a following SELECT', () => {
    expect(boundary({ token: 'select', pendingHeadToken: 'delete', previousChar: ')' })).toBe(false);
  });

  it('keeps UPDATE attached to a following SELECT', () => {
    expect(boundary({ token: 'select', pendingHeadToken: 'update', previousChar: ')' })).toBe(false);
  });

  it('keeps MERGE attached to a following SELECT', () => {
    expect(boundary({ token: 'select', pendingHeadToken: 'merge', previousChar: ')' })).toBe(false);
  });

  it('keeps INSERT attached to a following SELECT', () => {
    expect(boundary({ token: 'select', pendingHeadToken: 'insert', previousChar: ')' })).toBe(false);
  });

  // #6 LOCK is not a standalone statement — it is part of LOCK IN SHARE MODE.
  it('does not split on LOCK after a complete expression', () => {
    expect(boundary({ token: 'lock', dbType: 'mysql', previousChar: '1' })).toBe(false);
  });

  // #7 START is only a statement starter in PG/Oracle.
  it('only splits on START in PG and Oracle', () => {
    expect(boundary({ token: 'start', dbType: 'postgres', previousChar: '1' })).toBe(true);
    expect(boundary({ token: 'start', dbType: 'oracle', previousChar: '1' })).toBe(true);
    expect(boundary({ token: 'start', dbType: 'mysql', previousChar: '1' })).toBe(false);
  });

  // #9 REPLACE INTO ... SET should keep SET attached.
  it('keeps SET attached to REPLACE', () => {
    expect(boundary({ token: 'set', pendingHeadToken: 'replace', previousChar: 'e' })).toBe(false);
  });

  // #2 Multi-line ALTER — tokens like RENAME/COLUMN should not end a statement.
  it('keeps ALTER ... RENAME on the same statement', () => {
    expect(boundary({ token: 'rename', previousToken: 'column', previousChar: 'n', pendingHeadToken: 'alter' })).toBe(false);
    expect(boundary({ token: 'column', previousToken: 'rename', previousChar: 'n', pendingHeadToken: 'alter' })).toBe(false);
  });

  // #2 Multi-line ALTER — a column identifier before RENAME is a clean break.
  it('splits before ALTER when the previous statement ended', () => {
    expect(boundary({ token: 'alter', previousToken: 'id', previousChar: '1', pendingHeadToken: 'select' })).toBe(true);
  });
});
