import { describe, expect, it } from 'vitest';

import {
  buildQueryResultCountSql,
  buildQueryResultPageSql,
  createInitialQueryResultPagination,
  parseQueryResultTotalCount,
  resolveQueryResultPaginationTotal,
} from './queryResultPagination';

describe('queryResultPagination', () => {
  it('treats MySQL LIMIT offset,count as editor pagination and exports the base query', () => {
    const page = createInitialQueryResultPagination({
      executedSql: 'SELECT id, name FROM users LIMIT 0,500',
      exportSql: 'SELECT id, name FROM users LIMIT 0,500',
      dbType: 'mysql',
      returnedRowCount: 500,
      fallbackPageSize: 5000,
    });

    expect(page).toMatchObject({
      current: 1,
      pageSize: 500,
      total: 1000,
      totalKnown: false,
      baseSql: 'SELECT id, name FROM users',
      exportAllSql: 'SELECT id, name FROM users',
    });
  });

  it('keeps query-editor injected LIMIT pageable instead of treating the cap as the total', () => {
    const page = createInitialQueryResultPagination({
      executedSql: 'SELECT id, name FROM users LIMIT 500',
      exportSql: 'SELECT id, name FROM users',
      dbType: 'mysql',
      returnedRowCount: 500,
      fallbackPageSize: 500,
    });

    expect(page).toMatchObject({
      current: 1,
      pageSize: 500,
      total: 1000,
      totalKnown: false,
      baseSql: 'SELECT id, name FROM users',
      exportAllSql: 'SELECT id, name FROM users',
    });
  });

  it('keeps query-editor injected Oracle ROWNUM wrapper pageable', () => {
    const page = createInitialQueryResultPagination({
      executedSql: 'SELECT * FROM (SELECT id, name FROM users ORDER BY created_at DESC) WHERE ROWNUM <= 500',
      exportSql: 'SELECT id, name FROM users ORDER BY created_at DESC',
      dbType: 'oracle',
      returnedRowCount: 500,
      fallbackPageSize: 500,
    });

    expect(page).toMatchObject({
      current: 1,
      pageSize: 500,
      total: 1000,
      totalKnown: false,
      baseSql: 'SELECT id, name FROM users ORDER BY created_at DESC',
      exportAllSql: 'SELECT id, name FROM users ORDER BY created_at DESC',
    });
  });

  it('builds the next page SQL with one lookahead row', () => {
    expect(buildQueryResultPageSql({
      baseSql: 'SELECT id FROM users',
      dbType: 'mysql',
      page: 2,
      pageSize: 500,
      lookahead: true,
    })).toBe('SELECT * FROM (SELECT id FROM users) AS __gonavi_query_page__ LIMIT 501 OFFSET 500');
  });

  it('keeps sorting but omits LIMIT and OFFSET for an unlimited result page', () => {
    expect(buildQueryResultPageSql({
      baseSql: 'SELECT id, display_name FROM users',
      dbType: 'mysql',
      page: 1,
      pageSize: 0,
      lookahead: true,
      sortInfo: [{ columnKey: 'display_name', order: 'ascend', enabled: true }],
    })).toBe(
      'SELECT * FROM (SELECT id, display_name FROM users) AS __gonavi_query_page__ ORDER BY `display_name` ASC',
    );
  });

  it('sorts the wrapped MySQL result before applying pagination', () => {
    expect(buildQueryResultPageSql({
      baseSql: 'SELECT id, display_name FROM users',
      dbType: 'mysql',
      page: 2,
      pageSize: 100,
      lookahead: true,
      sortInfo: [
        { columnKey: 'display_name', order: 'ascend', enabled: true },
        { columnKey: 'id', order: 'descend', enabled: true },
      ],
    })).toBe(
      'SELECT * FROM (SELECT id, display_name FROM users) AS __gonavi_query_page__ ORDER BY `display_name` ASC, `id` DESC LIMIT 101 OFFSET 100',
    );
  });

  it('uses Oracle pagination and outer sorting for OceanBase Oracle protocol', () => {
    expect(buildQueryResultPageSql({
      baseSql: 'SELECT id, DISPLAY_NAME FROM users',
      dbType: 'oceanbase',
      oceanBaseProtocol: 'oracle',
      page: 2,
      pageSize: 50,
      lookahead: true,
      sortInfo: [{ columnKey: 'DISPLAY_NAME', order: 'ascend', enabled: true }],
    })).toBe(
      'SELECT * FROM (SELECT "__gonavi_page__".*, ROWNUM "__gonavi_rn__" FROM (SELECT * FROM (SELECT id, DISPLAY_NAME FROM users) "__gonavi_query_page__" ORDER BY "DISPLAY_NAME" ASC) "__gonavi_page__" WHERE ROWNUM <= 101) WHERE "__gonavi_rn__" > 50',
    );
  });

  it('marks the last full lookahead page as an exact total', () => {
    expect(resolveQueryResultPaginationTotal({
      current: 2,
      pageSize: 500,
      rowCount: 500,
      hasNext: false,
    })).toEqual({ total: 1000, totalKnown: true });
  });

  it('builds a portable total-count query and removes only the top-level ordering', () => {
    expect(buildQueryResultCountSql(
      'SELECT id FROM (SELECT id FROM users ORDER BY created_at) nested ORDER BY id DESC;',
    )).toBe(
      'SELECT COUNT(*) AS __gonavi_total__ FROM (SELECT id FROM (SELECT id FROM users ORDER BY created_at) nested) __gonavi_query_count__',
    );
  });

  it('parses total counts case-insensitively without losing large safe integers', () => {
    expect(parseQueryResultTotalCount({ __GONAVI_TOTAL__: '1234' })).toBe(1234);
    expect(parseQueryResultTotalCount({ count: BigInt(42) })).toBe(42);
    expect(parseQueryResultTotalCount({ total: '-1' })).toBeNull();
  });
});
