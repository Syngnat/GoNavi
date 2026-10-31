import { describe, expect, it } from 'vitest';
import { buildHivePageSQL, hivePaginationNeedsOrder } from './hivePagination';
import { buildPaginatedSelectSQL } from './sql';
import { buildQueryResultCountSql, buildQueryResultPageSql, createInitialQueryResultPagination } from './queryResultPagination';

describe('Hive pagination without generic OFFSET', () => {
  it('uses LIMIT on the first page and ROW_NUMBER on later pages', () => {
    expect(buildPaginatedSelectSQL('hive', 'SELECT * FROM t', '', 21, 0)).toBe('SELECT * FROM t LIMIT 21');
    const sql = buildPaginatedSelectSQL('hive', 'SELECT * FROM t', ' ORDER BY \x60id\x60', 21, 40, ['id', 'value']);
    expect(sql).toContain('ROW_NUMBER() OVER (ORDER BY \x60id\x60)');
    expect(sql).toContain('> 40 AND \x60__gonavi_hive_rn__\x60 <= 61');
    expect(sql).toMatch(/^SELECT \x60id\x60, \x60value\x60 FROM/);
    expect(sql).not.toMatch(/\bOFFSET\b/i);
    expect(() => buildHivePageSQL('SELECT * FROM t', '', 10, Number.MAX_SAFE_INTEGER, ['id'])).toThrow();
  });

  it('does not leak the pagination helper or collide with a real column', () => {
    const sql = buildHivePageSQL('SELECT * FROM t', '', 10, 10, ['__gonavi_hive_rn__', 'with\x60tick']);
    expect(sql).toMatch(/^SELECT \x60__gonavi_hive_rn__\x60, \x60with\x60\x60tick\x60 FROM/);
    expect(sql).toContain('AS \x60__gonavi_hive_rn___\x60');
    expect(() => buildHivePageSQL('SELECT * FROM t', '', 10, 10)).toThrow();
    expect(() => buildHivePageSQL('SELECT * FROM t', '', 10, 10, ['Name', 'name'])).toThrow();
  });

  it('retains top-level query ordering in the window, including lookahead', () => {
    const sql = buildQueryResultPageSql({ dbType: 'hive', baseSql: 'SELECT id, value FROM t ORDER BY id DESC', page: 3, pageSize: 20, lookahead: true, columns: ['id', 'value'] });
    expect(sql).toContain('ROW_NUMBER() OVER (ORDER BY id DESC)');
    expect(sql).toContain('<= 61');
    expect(sql).not.toContain('OFFSET');
    expect(sql).not.toContain('FROM (SELECT id, value FROM t ORDER BY');
  });

  it('does not strip ORDER BY from an explicitly limited query', () => {
    const sql = buildQueryResultPageSql({ dbType: 'hive', baseSql: 'SELECT id FROM t ORDER BY id LIMIT 100', page: 2, pageSize: 20, columns: ['id'] });
    expect(sql).toContain('FROM (SELECT id FROM t ORDER BY id LIMIT 100)');
  });

  it('keeps Hive CTEs at the top level in page and count queries', () => {
    const baseSql = 'WITH c AS (SELECT id FROM t) SELECT id FROM c ORDER BY id';
    const page = buildQueryResultPageSql({ dbType: 'hive', baseSql, page: 2, pageSize: 20, columns: ['id'] });
    expect(page).toMatch(/^WITH c AS \(SELECT id FROM t\) SELECT/);
    expect(page).not.toContain('FROM (WITH');
    expect(page).toContain('ROW_NUMBER() OVER (ORDER BY id)');
    const count = buildQueryResultCountSql(baseSql, 'hive');
    expect(count).toMatch(/^WITH c AS \(SELECT id FROM t\) SELECT COUNT/);
    expect(count).not.toContain('ORDER BY');
    expect(buildQueryResultCountSql(baseSql + ' LIMIT 100', 'hive')).toContain('ORDER BY id LIMIT 100');
  });

  it('recognizes editor-applied LIMIT and requires stable sorting without inventing keys', () => {
    expect(createInitialQueryResultPagination({ dbType: 'hive', executedSql: 'SELECT id FROM t LIMIT 20', exportSql: 'SELECT id FROM t', returnedRowCount: 20, fallbackPageSize: 20 })?.baseSql).toBe('SELECT id FROM t');
    expect(hivePaginationNeedsOrder('SELECT * FROM t', '', 10)).toBe(true);
    expect(hivePaginationNeedsOrder('SELECT * FROM t ORDER BY id', '', 10)).toBe(false);
    expect(hivePaginationNeedsOrder('SELECT * FROM t', ' ORDER BY id', 10)).toBe(false);
    expect(hivePaginationNeedsOrder('SELECT * FROM t', '', 0)).toBe(false);
  });
});
