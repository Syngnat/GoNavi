import { describe, expect, it } from 'vitest';
import { applyQueryAutoLimit } from './queryAutoLimit';
import { buildPaginatedSelectSQL } from './sql';
import { buildQueryResultCountSql, buildQueryResultPageSql, createInitialQueryResultPagination } from './queryResultPagination';

const base = 'SELECT ID, Name FROM Sample.Person';
const compound = 'SELECT ID FROM Sample.Person WHERE ID < 4 UNION ALL SELECT ID FROM Sample.Person WHERE ID > 197';

const assertLegacySyntax = (sql: string) => {
  expect(sql).not.toMatch(/\b(?:LIMIT|OFFSET|FETCH|ROW_NUMBER)\b/i);
  expect(sql).not.toContain('AS __gonavi_rn__');
};

describe('InterSystems pagination result boundaries', () => {
  it.each(['TOP 3', 'TOP ALL', 'DISTINCT TOP 3'])('caps page one outside the user %s boundary', (modifier) => {
    const sql = buildPaginatedSelectSQL('cache', `SELECT ${modifier} ID FROM Sample.Person`, ' ORDER BY ID DESC', 8, 0);
    expect(sql).toBe(`SELECT TOP 8 __gonavi_page__.* FROM (SELECT ${modifier} ID FROM Sample.Person ORDER BY ID DESC\n) __gonavi_page__ ORDER BY __gonavi_page__.%VID`);
    assertLegacySyntax(sql);
  });

  it.each([7, 196, 203])('uses exact ordinal bounds at offset %i without last-page backfill', (offset) => {
    const sql = buildPaginatedSelectSQL('cache', `${base} WHERE ID > 190`, ' ORDER BY ID DESC', 8, offset);
    expect(sql).toContain('SELECT TOP ALL ID, Name FROM Sample.Person WHERE ID > 190 ORDER BY ID DESC');
    expect(sql).toContain(`WHERE __gonavi_page__.%VID > ${offset} AND __gonavi_page__.%VID <= ${offset + 8}`);
    expect(sql).toMatch(/ORDER BY __gonavi_page__.%VID$/);
    assertLegacySyntax(sql);
  });

  it('recovers a compound automatic cap when creating editor pagination', () => {
    const original = `${compound} ORDER BY ID DESC`;
    const executed = applyQueryAutoLimit(original, 'cache', 2).sql;
    expect(createInitialQueryResultPagination({
      executedSql: executed, exportSql: original, dbType: 'cache', returnedRowCount: 2, fallbackPageSize: 2,
    })).toMatchObject({ baseSql: original, exportAllSql: original, pageSize: 2, totalKnown: false });
  });

  it.each(['; -- tail', '; /* tail */', ' -- tail'])('recovers the original query behind an automatic TOP with tail %s', (tail) => {
    const original = `${base} ORDER BY ID DESC${tail}`;
    const executed = applyQueryAutoLimit(original, 'cache', 7).sql;
    expect(createInitialQueryResultPagination({
      executedSql: executed, exportSql: original, dbType: 'cache', returnedRowCount: 7, fallbackPageSize: 7,
    })).toMatchObject({ baseSql: `${base} ORDER BY ID DESC`, pageSize: 7 });
  });

  it.each(['ORDER\nBY', 'ORDER /* sort */ BY', 'ORDER -- sort\nBY'])('lifts compound %s outside the derived table', (order) => {
    const original = `${compound} ${order} ID DESC`;
    const capped = applyQueryAutoLimit(original, 'cache', 2).sql;
    expect(capped).toBe(`SELECT TOP 2 * FROM (${compound}\n) __gonavi_compound__ ${order} ID DESC`);
    const page = buildQueryResultPageSql({ baseSql: original, dbType: 'cache', page: 2, pageSize: 2 });
    expect(page).toContain(`) __gonavi_compound__ ${order} ID DESC\n) __gonavi_page__`);
    expect(page).toContain('%VID > 2 AND __gonavi_page__.%VID <= 4');
    assertLegacySyntax(page);
  });

  it('keeps unlimited grid sorting valid with TOP ALL, a bare alias and terminal comments', () => {
    const sql = buildQueryResultPageSql({
      baseSql: `${base} ORDER BY ID DESC; -- tail`, dbType: 'custom', driver: 'intersystems-cache',
      page: 2, pageSize: 0, sortInfo: [{ columnKey: 'Name', order: 'ascend' }],
    });
    expect(sql).toBe(`SELECT * FROM (SELECT TOP ALL ID, Name FROM Sample.Person ORDER BY ID DESC\n) __gonavi_query_page__ ORDER BY Name ASC; -- tail`);
    assertLegacySyntax(sql);
  });

  it('keeps an explicit TOP and CTE outside unlimited grid sorting', () => {
    const sql = buildQueryResultPageSql({
      baseSql: 'WITH p AS (SELECT ID, Name FROM Sample.Person) SELECT TOP 10 ID, Name FROM p ORDER BY ID DESC;',
      dbType: 'iris', page: 1, pageSize: 0, sortInfo: [{ columnKey: 'Name', order: 'ascend' }],
    });
    expect(sql).toBe('WITH p AS (SELECT ID, Name FROM Sample.Person) SELECT * FROM (SELECT TOP 10 ID, Name FROM p ORDER BY ID DESC\n) __gonavi_query_page__ ORDER BY Name ASC;');
  });

  it('removes multiline ordering before counting and retains an explicit TOP boundary', () => {
    expect(buildQueryResultCountSql('SELECT TOP 10 ID FROM Sample.Person ORDER\nBY ID DESC;', 'cache'))
      .toBe('SELECT COUNT(*) AS __gonavi_total__ FROM (SELECT TOP 10 ID FROM Sample.Person\n) __gonavi_query_count__');
  });

  it('keeps CTE prefixes outside the count wrapper for supporting engines', () => {
    expect(buildQueryResultCountSql('WITH p AS (SELECT ID FROM Sample.Person) SELECT TOP 10 ID FROM p ORDER BY ID DESC;', 'iris'))
      .toBe('WITH p AS (SELECT ID FROM Sample.Person) SELECT COUNT(*) AS __gonavi_total__ FROM (SELECT TOP 10 ID FROM p\n) __gonavi_query_count__');
  });

  it('terminates inline comments before closing the count wrapper', () => {
    expect(buildQueryResultCountSql('SELECT ID FROM Sample.Person -- note\nWHERE ID > 190', 'cache'))
      .toBe('SELECT COUNT(*) AS __gonavi_total__ FROM (SELECT ID FROM Sample.Person -- note\nWHERE ID > 190\n) __gonavi_query_count__');
  });
});
