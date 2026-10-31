import { describe, expect, it } from 'vitest';
import { resolveHiveResultProjection, rewriteHiveResultOrder } from './hiveResultProjection';
import { buildQueryResultCountSql, buildQueryResultPageSql } from './queryResultPagination';

const page = (baseSql: string, columns: string[]) => buildQueryResultPageSql({ dbType: 'hive', baseSql, columns, page: 2, pageSize: 2 });

describe('HiveServer2 raw result labels and derived-table projection', () => {
  it('maps proven single-table labels to real derived columns and preserves raw output labels', () => {
    const sql = page('SELECT * FROM input_csv ORDER BY id', ['input_csv.id', 'input_csv.note']);
    expect(sql).toMatch(/^SELECT \x60id\x60 AS \x60input_csv.id\x60, \x60note\x60 AS \x60input_csv.note\x60 FROM/);
    expect(sql).toContain('ROW_NUMBER() OVER (ORDER BY id)');
    expect(sql).not.toContain('SELECT \x60input_csv.id\x60,');
    expect(sql).not.toContain('OFFSET');
    const count = buildQueryResultCountSql('SELECT * FROM input_csv ORDER BY id', 'hive', ['input_csv.id', 'input_csv.note']);
    expect(count).toBe('SELECT COUNT(*) AS __gonavi_total__ FROM (SELECT * FROM input_csv) AS __gonavi_hive_count__');
  });

  it('fails closed for JOIN output columns that collapse to the same derived name', () => {
    expect(() => page('SELECT a.id, b.id FROM a JOIN b ON a.id=b.id', ['a.id', 'b.id'])).toThrow();
    expect(() => page('SELECT * FROM a JOIN b ON a.id=b.id', ['a.id', 'b.id'])).toThrow();
    expect(() => buildQueryResultCountSql('SELECT a.id, b.id FROM a JOIN b ON a.id=b.id', 'hive')).toThrow();
  });

  it('does not strip an unknown label qualifier by its longest suffix', () => {
    expect(() => page('SELECT * FROM input_csv', ['unknown.id'])).toThrow();
  });

  it('maps configured table/schema aliases only, never arbitrary suffixes', () => {
    expect(resolveHiveResultProjection('SELECT e.* FROM \x60analytics\x60.\x60input_csv\x60 AS e', ['e.id', 'analytics.input_csv.note'])).toEqual([
      { sourceName: 'id', outputLabel: 'e.id' }, { sourceName: 'note', outputLabel: 'analytics.input_csv.note' },
    ]);
    expect(resolveHiveResultProjection('SELECT input_csv.id FROM input_csv', ['INPUT_CSV.ID'])).toEqual([{ sourceName: 'id', outputLabel: 'INPUT_CSV.ID', sourceReference: ['input_csv', 'id'] }]);
    expect(() => resolveHiveResultProjection('SELECT * FROM input_csv AS \x60input_csv.id\x60', ['input_csv.id.note'])).toThrow();
    expect(() => resolveHiveResultProjection('SELECT id FROM input_csv', ['input_csv.unknown'])).toThrow();
  });

  it('allows proven unique JOIN aliases but rejects derived-name and metadata-label collisions', () => {
    expect(resolveHiveResultProjection('SELECT a.id AS first_id, b.id AS second_id FROM a JOIN b ON a.id=b.id', ['first_id', 'second_id'])).toEqual([
      { sourceName: 'first_id', outputLabel: 'first_id' }, { sourceName: 'second_id', outputLabel: 'second_id' },
    ]);
    expect(() => page('SELECT a.id, b.id FROM a, b', ['a.id', 'b.id'])).toThrow();
    expect(() => page('SELECT id FROM input_csv', ['id', 'ID'])).toThrow();
    expect(() => buildQueryResultCountSql('SELECT id FROM input_csv', 'hive', ['input_csv.id', 'ID'])).toThrow();
    expect(() => buildQueryResultCountSql('SELECT * FROM a JOIN b ON a.id=b.id', 'hive')).toThrow();
  });

  it('rewrites UI raw-label sorts and positional sorts to proven derived names', () => {
    const projection = resolveHiveResultProjection('SELECT * FROM input_csv', ['input_csv.id', 'input_csv.note']);
    expect(rewriteHiveResultOrder(' ORDER BY \x60input_csv.note\x60 DESC NULLS LAST', projection)).toBe(' ORDER BY \x60note\x60 DESC NULLS LAST');
    expect(rewriteHiveResultOrder(' ORDER BY input_csv.id ASC, 2 DESC', projection)).toBe(' ORDER BY \x60id\x60 ASC, \x60note\x60 DESC');
    expect(() => rewriteHiveResultOrder(' ORDER BY unknown.id', projection)).toThrow();
    const sql = buildQueryResultPageSql({ dbType: 'hive', baseSql: 'SELECT * FROM input_csv', columns: projection.map(item => item.outputLabel), page: 2, pageSize: 2,
      sortInfo: [{ columnKey: 'input_csv.note', order: 'descend' }] });
    expect(sql).toContain('ROW_NUMBER() OVER (ORDER BY \x60note\x60 DESC)');
    expect(sql).not.toContain('OVER (ORDER BY \x60input_csv.note\x60');
  });

  it('preserves output labels on first-page resizing and unlimited sorted mode', () => {
    for (const pageSize of [2, 0]) {
      const sql = buildQueryResultPageSql({ dbType: 'hive', baseSql: 'SELECT * FROM input_csv', columns: ['input_csv.id', 'input_csv.note'], page: 1, pageSize,
        sortInfo: [{ columnKey: 'input_csv.id', order: 'ascend' }] });
      expect(sql).toMatch(/^SELECT \x60id\x60 AS \x60input_csv.id\x60, \x60note\x60 AS \x60input_csv.note\x60 FROM/);
      expect(sql).toContain('ORDER BY \x60id\x60 ASC');
      expect(sql).not.toContain('ROW_NUMBER');
    }
  });

  it('keeps CTEs and CAST UNIONTYPE/STRUCT fields distinct from raw result labels', () => {
    const baseSql = "WITH c AS (SELECT id, note FROM input_csv) SELECT CAST(NULL AS UNIONTYPE<INT,STRING>) AS payload, named_struct('x', id, 'y', note) AS obj FROM c";
    const sql = page(baseSql, ['c.payload', 'c.obj']);
    expect(sql).toMatch(/^WITH c AS/);
    expect(sql).toContain('SELECT \x60payload\x60 AS \x60c.payload\x60, \x60obj\x60 AS \x60c.obj\x60 FROM');
    expect(sql).toContain('CAST(NULL AS UNIONTYPE<INT,STRING>) AS payload');
    expect(sql).not.toContain('CAST(\x60c.payload\x60');
    expect(buildQueryResultCountSql(baseSql, 'hive')).toContain('SELECT COUNT(*)');
  });

  it('does not expose the row-number helper or break quoted dotted field aliases', () => {
    const sql = page('SELECT \x60with.dot\x60, id AS \x60tick\x60\x60alias\x60 FROM input_csv', ['input_csv.with.dot', 'tick\x60alias']);
    expect(sql).toMatch(/^SELECT \x60with.dot\x60 AS \x60input_csv.with.dot\x60, \x60tick\x60\x60alias\x60 AS \x60tick\x60\x60alias\x60 FROM/);
    expect(sql.split(' FROM', 1)[0]).not.toContain('__gonavi_hive_rn__');
  });

  it('keeps literal dotted SQL aliases intact rather than treating them as qualifiers', () => {
    const sql = page('SELECT id AS \x60input_csv.id\x60, CAST(note AS STRING) AS note FROM input_csv', ['input_csv.id', 'note']);
    expect(sql).toContain('SELECT \x60input_csv.id\x60 AS \x60input_csv.id\x60, \x60note\x60 AS \x60note\x60 FROM');
  });
});
