import { describe, expect, it } from 'vitest';
import { applyQueryAutoLimit } from './queryAutoLimit';
import { buildOrderBySQL, buildPaginatedSelectSQL, buildWhereSQL } from './sql';
import { buildQueryResultPageSql, createInitialQueryResultPagination } from './queryResultPagination';
import { resolveDataSourceType } from './dataSourceCapabilities';
import { buildDataViewerBaseSelectSQL, resolveDataViewerOrderFallbackColumns } from '../components/dataViewer/dataViewerQuerySql';

const aliases = [
  'iris', 'cache', 'Caché', ' InterSystemsIRIS ', 'intersystems',
  'inter-systems-iris', 'intersystems cache', 'intersystems caché',
  'intersystems-cache', 'intersystems-caché', 'intersystemscache',
  'intersystemscaché', 'inter-systems-cache', 'inter-systems-caché',
  'intersystems-cache-database', 'cache-db', 'cachedb',
];
const base = 'SELECT ID, Name FROM Sample.Person';

const expectLegacyCompatible = (sql: string) => {
  expect(sql).not.toMatch(/\b(?:LIMIT|OFFSET|FETCH|ROW_NUMBER)\b/i);
};

describe('InterSystems SELECT caps', () => {
  it.each(aliases)('resolves %s and custom drivers to TOP', (type) => {
    for (const [dbType, driver] of [[type, ''], ['custom', type]]) {
      expect(applyQueryAutoLimit(base, dbType, 10, driver)).toEqual({
        sql: 'SELECT TOP 10 ID, Name FROM Sample.Person', applied: true, maxRows: 10,
      });
    }
    expect(buildPaginatedSelectSQL(type, base, '', 10, 0)).toContain('SELECT TOP 10');
    const resolved = resolveDataSourceType({ type: 'custom', driver: type });
    expect(buildPaginatedSelectSQL(resolved, base, '', 10, 0)).toContain('SELECT TOP 10');
  });

  it.each([
    ['SELECT DISTINCT Name FROM Sample.Person', 'SELECT DISTINCT TOP 10 Name FROM Sample.Person'],
    ['SELECT ALL Name FROM Sample.Person', 'SELECT ALL TOP 10 Name FROM Sample.Person'],
    ['SELECT /* hint */ DISTINCT Name FROM Sample.Person', 'SELECT /* hint */ DISTINCT TOP 10 Name FROM Sample.Person'],
    ['-- intro\nSELECT Name FROM Sample.Person; -- end', '-- intro\nSELECT TOP 10 Name FROM Sample.Person; -- end'],
    ["SELECT 'TOP' AS label, Name FROM Sample.Person", "SELECT TOP 10 'TOP' AS label, Name FROM Sample.Person"],
    ['SELECT "TOP" FROM Sample.Person', 'SELECT TOP 10 "TOP" FROM Sample.Person'],
    ['SELECT * FROM (SELECT TOP 2 ID FROM Sample.Person) p', 'SELECT TOP 10 * FROM (SELECT TOP 2 ID FROM Sample.Person) p'],
    ['WITH p AS (SELECT TOP 2 ID FROM Sample.Person) SELECT DISTINCT ID FROM p', 'WITH p AS (SELECT TOP 2 ID FROM Sample.Person) SELECT DISTINCT TOP 10 ID FROM p'],
  ])('caps only the outer SELECT: %s', (sql, expected) => {
    expect(applyQueryAutoLimit(sql, 'cache', 10).sql).toBe(expected);
  });

  it.each([
    'SELECT TOP 4 ID FROM Sample.Person',
    'SELECT DISTINCT TOP 4 Name FROM Sample.Person',
    'SELECT /* hint */ DISTINCT /* comment */ TOP ALL Name FROM Sample.Person',
    'WITH p AS (SELECT ID FROM Sample.Person) SELECT TOP 4 ID FROM p',
    'WITH p AS (SELECT ID FROM Sample.Person) DELETE FROM t WHERE ID IN (SELECT ID FROM p)',
  ])('does not override explicit limits or mutate DML: %s', (sql) => {
    expect(applyQueryAutoLimit(sql, 'iris', 10)).toEqual({ sql, applied: false, maxRows: 10 });
  });
});

describe('InterSystems table data pagination', () => {
  it.each(['iris', 'cache'])('uses the DataViewer base/filter/sort path for %s', (dbType) => {
    const where = buildWhereSQL(dbType, [{ column: 'ID', op: '>', value: '190' }]);
    const tableSql = buildDataViewerBaseSelectSQL(dbType, 'Sample.Person', where);
    const order = buildOrderBySQL(dbType, [{ columnKey: 'ID', order: 'descend' }], ['ID']);
    const first = buildPaginatedSelectSQL(dbType, tableSql, order, 8, 0);
    // IRIS/Caché 只在 DelimitedIds 打开时把双引号当定界符；裸名在开/关两种服务端配置下都能
    // 解析，所以这里不加引号（加了反而在关闭 DelimitedIds 的服务端报 LITERAL found）。
    expect(first).toBe('SELECT TOP 8 * FROM Sample.Person WHERE (ID > \'190\') ORDER BY ID DESC');
    const second = buildPaginatedSelectSQL(dbType, tableSql, order, 8, 7);
    expect(second).toContain('SELECT TOP ALL * FROM Sample.Person WHERE (ID > \'190\') ORDER BY ID DESC');
    expect(second).toContain('WHERE __gonavi_page__.%VID > 7 AND __gonavi_page__.%VID <= 15');
    expect(second).toMatch(/ORDER BY __gonavi_page__.%VID$/);
    expectLegacyCompatible(first);
    expectLegacyCompatible(second);
    // Selecting alias.* leaves %VID virtual: no auxiliary result field to strip.
    expect(second).toMatch(/^SELECT TOP 8 __gonavi_page__\.\* FROM/);
    expect(second).not.toContain('AS __gonavi_rn__');
  });

  it('does not require a primary key or reverse the last page', () => {
    const fallback = resolveDataViewerOrderFallbackColumns(undefined, [], 'cache');
    const order = buildOrderBySQL('cache', [], fallback);
    expect(order).toBe('');
    const sql = buildPaginatedSelectSQL('cache', 'SELECT Name FROM Sample.Person', order, 8, 196);
    expect(sql).toContain('SELECT TOP ALL Name FROM Sample.Person');
    expect(sql).toContain('%VID > 196 AND __gonavi_page__.%VID <= 204');
    expect(sql).not.toContain(' DESC');
  });

  it('preserves duplicate projections and aliases without rewriting columns', () => {
    const sql = buildPaginatedSelectSQL('cache', 'SELECT p.ID AS x, p.ID AS x FROM Sample.Person p', ' ORDER BY p.ID', 8, 7);
    expect(sql).toContain('SELECT TOP ALL p.ID AS x, p.ID AS x FROM Sample.Person p ORDER BY p.ID');
    expectLegacyCompatible(sql);
  });
});

describe('InterSystems query result pagination', () => {
  it('recognizes the editor TOP as an automatic cap and pages the original query', () => {
    const original = `${base} ORDER BY ID DESC`;
    const executed = applyQueryAutoLimit(original, 'cache', 7).sql;
    const state = createInitialQueryResultPagination({
      executedSql: executed, exportSql: original, dbType: 'cache', returnedRowCount: 7, fallbackPageSize: 7,
    });
    expect(state?.baseSql).toBe(original);
    const next = buildQueryResultPageSql({ baseSql: state!.baseSql, dbType: 'cache', page: 2, pageSize: 7, lookahead: true });
    expect(next).toContain('SELECT TOP ALL ID, Name FROM Sample.Person ORDER BY ID DESC');
    expect(next).toContain('SELECT TOP 8 __gonavi_page__.*');
    expect(next).toContain('%VID > 7 AND __gonavi_page__.%VID <= 15');
  });

  it('retains explicit TOP and applies grid sorting outside that boundary', () => {
    const sql = buildQueryResultPageSql({
      baseSql: `${base.replace('SELECT', 'SELECT TOP 10')} ORDER BY ID DESC`,
      dbType: 'custom', driver: 'intersystems-cache', page: 2, pageSize: 7,
      sortInfo: [{ columnKey: 'Name', order: 'ascend' }],
    });
    expect(sql).toContain('SELECT TOP 10 ID, Name FROM Sample.Person ORDER BY ID DESC');
    expect(sql).toContain(') __gonavi_query_page__ ORDER BY Name ASC');
    expect(sql).toContain('%VID > 7 AND __gonavi_page__.%VID <= 14');
    expectLegacyCompatible(sql);
  });

  it('keeps CTE prefixes outside materialization for engines that support WITH', () => {
    const sql = buildQueryResultPageSql({
      baseSql: 'WITH p AS (SELECT ID FROM Sample.Person) SELECT ID FROM p ORDER BY ID',
      dbType: 'iris', page: 2, pageSize: 7,
    });
    expect(sql).toMatch(/^WITH p AS \(SELECT ID FROM Sample.Person\) SELECT TOP 7/);
    expect(sql).toContain('(SELECT TOP ALL ID FROM p ORDER BY ID');
  });

  it('caps a UNION result, not just its first branch, and lifts compound ordering', () => {
    const baseSql = 'SELECT ID FROM Sample.Person WHERE ID < 4 UNION ALL SELECT ID FROM Sample.Person WHERE ID > 197 ORDER BY ID DESC';
    const capped = applyQueryAutoLimit(baseSql, 'cache', 2).sql;
    expect(capped).toBe('SELECT TOP 2 * FROM (SELECT ID FROM Sample.Person WHERE ID < 4 UNION ALL SELECT ID FROM Sample.Person WHERE ID > 197\n) __gonavi_compound__ ORDER BY ID DESC');
    const second = buildQueryResultPageSql({ baseSql, dbType: 'cache', page: 2, pageSize: 2 });
    expect(second).toContain('SELECT TOP ALL * FROM (SELECT ID FROM Sample.Person WHERE ID < 4 UNION ALL');
    expect(second).toContain(') __gonavi_compound__ ORDER BY ID DESC');
    expect(second).toContain('%VID > 2 AND __gonavi_page__.%VID <= 4');
  });

  it('keeps semicolons and trailing comments outside derived tables', () => {
    const sql = buildQueryResultPageSql({ baseSql: `${base}; -- end`, dbType: 'cache', page: 2, pageSize: 7 });
    expect(sql).toMatch(/ORDER BY __gonavi_page__.%VID; -- end$/);
    expectLegacyCompatible(sql);
  });
});
