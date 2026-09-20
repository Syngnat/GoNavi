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
});

describe('isSqlStatementStartBoundary', () => {
  it('opens a new statement for a line leading keyword', () => {
    expect(boundary({})).toBe(true);
    expect(boundary({ token: 'alter', previousToken: 'int', previousChar: 't' })).toBe(true);
    expect(boundary({ token: 'drop', previousToken: 'users', previousChar: 's' })).toBe(true);
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

  it('keeps DESC attached to an ordering clause', () => {
    expect(boundary({ token: 'desc', pendingHeadToken: 'select', previousChar: 'a' })).toBe(false);
    expect(boundary({ token: 'desc', pendingHeadToken: 'desc', previousChar: 'a' })).toBe(true);
  });

  it('allows a statement to follow COMMIT or ROLLBACK', () => {
    expect(boundary({ previousToken: 'commit', previousChar: 't', pendingHeadToken: 'commit' })).toBe(true);
    expect(boundary({ previousToken: 'rollback', previousChar: 'k', pendingHeadToken: 'rollback' })).toBe(true);
  });
});
