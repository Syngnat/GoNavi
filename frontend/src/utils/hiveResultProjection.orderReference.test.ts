import { describe, expect, it } from 'vitest';
import { buildHiveQueryPageSQL } from './hivePagination';
import { buildQueryResultPageSql } from './queryResultPagination';
import { resolveHiveResultProjection, rewriteHiveResultOrder } from './hiveResultProjection';

describe('Hive original qualified SELECT references in page sorting', () => {
  it('paginates bare HS2 labels using the proven original SELECT reference', () => {
    const sql = buildHiveQueryPageSQL('SELECT t.id FROM t ORDER BY t.id', '', 20, 20, ['id']);
    expect(sql).toContain('ROW_NUMBER() OVER (ORDER BY \x60id\x60)');
    expect(sql).toMatch(/^SELECT \x60id\x60 AS \x60id\x60 FROM/);
    expect(sql).toContain('> 20 AND \x60__gonavi_hive_rn__\x60 <= 40');
    expect(sql).not.toContain('OFFSET');
  });

  it.each(['id', 't.id'])('keeps original t.id for bare or qualified metadata label %s', outputLabel => {
    const projection = resolveHiveResultProjection('SELECT t.id FROM t', [outputLabel]);
    expect(projection[0]).toMatchObject({ sourceName: 'id', outputLabel, sourceReference: ['t', 'id'] });
    expect(rewriteHiveResultOrder(' ORDER BY t.id DESC NULLS LAST', projection)).toBe(' ORDER BY \x60id\x60 DESC NULLS LAST');
  });

  it('handles quoted original scope names through the real result-page builder', () => {
    const sql = buildQueryResultPageSql({ dbType: 'hive', baseSql: 'SELECT \x60t\x60.\x60id\x60 FROM source_table AS t ORDER BY \x60t\x60.\x60id\x60 DESC', columns: ['id'], page: 2, pageSize: 20 });
    expect(sql).toContain('ROW_NUMBER() OVER (ORDER BY \x60id\x60 DESC)');
  });

  it('does not invent a qualified reference for a literal dotted column name', () => {
    const projection = resolveHiveResultProjection('SELECT \x60t.id\x60 FROM t', ['t.id']);
    expect(projection[0].sourceReference).toBeUndefined();
  });

  it('preserves quoted identifier boundaries instead of flattening a scope into dotted suffixes', () => {
    const sql = buildHiveQueryPageSQL('SELECT \x60a.b\x60.id FROM t AS \x60a.b\x60 ORDER BY \x60a.b\x60.id', '', 20, 20, ['id']);
    expect(sql).toContain('ROW_NUMBER() OVER (ORDER BY \x60id\x60)');
    expect(() => buildHiveQueryPageSQL('SELECT \x60a.b\x60.id FROM t AS \x60a.b\x60 ORDER BY a.b.id', '', 20, 20, ['id'])).toThrow();
  });

  it('still rejects unknown scopes, non-projected JOIN columns and duplicate JOIN names', () => {
    expect(() => buildHiveQueryPageSQL('SELECT t.id FROM t ORDER BY unknown.id', '', 20, 20, ['id'])).toThrow();
    expect(() => buildHiveQueryPageSQL('SELECT a.id, b.note FROM a JOIN b ON a.id=b.id ORDER BY b.id', '', 20, 20, ['id', 'note'])).toThrow();
    expect(() => buildHiveQueryPageSQL('SELECT a.id, b.id FROM a JOIN b ON a.id=b.id ORDER BY a.id', '', 20, 20, ['id', 'id'])).toThrow();
  });
});
