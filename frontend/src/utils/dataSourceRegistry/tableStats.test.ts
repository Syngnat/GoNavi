import { describe, expect, it } from 'vitest';

import { buildSidebarTableStatusSQL } from '../../components/sidebar/sidebarMetadataNames';
import { resolveObjectMetadataDialect } from '../objectMetadataDialect';
import { needsServerVersionForTableStats, resolvePgTableStatsSql, resolveRegistryTableStatusSql } from './tableStats';

const conn = (type: string) => ({ config: { type } }) as never;

describe('PostgreSQL-family table statistics', () => {
  it('keeps the PostgreSQL defaults for built-in types', () => {
    expect(resolvePgTableStatsSql('postgres')).toEqual({
      rows: 'c.reltuples::bigint',
      size: 'pg_total_relation_size(c.oid)',
      indexSize: 'pg_indexes_size(c.oid)',
    });
    expect(needsServerVersionForTableStats('postgres')).toBe(false);
  });

  it('reads CockroachDB row estimates from crdb_internal and leaves sizes empty', () => {
    const stats = resolvePgTableStatsSql('cockroachdb', '', 't');
    expect(stats.rows).toContain('crdb_internal.table_row_statistics s WHERE s.table_id = t.oid::INT8');
    expect(stats.size).toBe('NULL::INT8');
    const sql = buildSidebarTableStatusSQL(conn('kwdb'), 'shop');
    expect(sql).not.toContain('pg_total_relation_size');
    expect(sql).toContain('crdb_internal.table_row_statistics');
  });

  it('picks TimescaleDB 2.x or 1.x hypertable functions by extension version', () => {
    expect(needsServerVersionForTableStats('timescaledb')).toBe(true);
    expect(resolvePgTableStatsSql('timescaledb', '2.30.2').rows).toBe('approximate_row_count(c.oid)');
    expect(resolvePgTableStatsSql('timescaledb', '2.0.0').size).toBe('COALESCE(hypertable_size(c.oid), pg_total_relation_size(c.oid))');
    const legacy = resolvePgTableStatsSql('timescaledb', '1.7.5');
    expect(legacy.rows).toBe('COALESCE((SELECT row_estimate FROM hypertable_approximate_row_count(c.oid)), c.reltuples::bigint)');
    expect(legacy.indexSize).toBe('COALESCE((hypertable_relation_size(c.oid)).index_bytes, pg_indexes_size(c.oid))');
    // 版本未知时不能猜：两套函数互不兼容，回落到 PostgreSQL 默认表达式。
    expect(resolvePgTableStatsSql('timescaledb', '')).toEqual(resolvePgTableStatsSql('postgres'));
    expect(buildSidebarTableStatusSQL(conn('timescaledb'), 'tsdb', '2.17.2')).toContain(
      "CASE WHEN c.relkind = 'p' THEN NULL ELSE approximate_row_count(c.oid) END AS table_rows",
    );
  });
});

describe('registry table status queries', () => {
  it('lists QuestDB tables with storage stats from 8.3 and names only before that', () => {
    expect(needsServerVersionForTableStats('questdb')).toBe(true);
    // 10.x 起 tables() 也列出普通视图（table_type = 'V'）与物化视图（'M'），只留表。
    expect(resolveRegistryTableStatusSql('questdb', 'qdb', 'Build Information: QuestDB 10.0.1, JDK 17')).toContain("WHERE t.table_type = 'T'");
    expect(resolveRegistryTableStatusSql('questdb', 'qdb', '8.3.3')).toContain('WHERE NOT t.matView');
    const legacy = resolveRegistryTableStatusSql('questdb', 'qdb', '7.4.2');
    expect(legacy).toContain('FROM tables()');
    expect(legacy).not.toContain('table_storage');
    expect(resolveRegistryTableStatusSql('questdb', 'qdb', '')).toBe(legacy);
    expect(buildSidebarTableStatusSQL(conn('questdb'), 'qdb', '10.0.1')).toContain('s.rowCount AS table_rows');
  });

  it('returns nothing for data sources without a declared query', () => {
    expect(resolveRegistryTableStatusSql('tidb', 'shop', '8.5.0')).toBe('');
    expect(resolveRegistryTableStatusSql('postgres', 'app', '')).toBe('');
  });
});

describe('object metadata dialect', () => {
  it('maps registry data sources to their borrowed dialect or compatibility family', () => {
    expect(resolveObjectMetadataDialect('timescaledb')).toBe('postgres');
    expect(resolveObjectMetadataDialect('cockroachdb')).toBe('postgres');
    expect(resolveObjectMetadataDialect('tidb')).toBe('mysql');
    expect(resolveObjectMetadataDialect('greptimedb')).toBe('mysql');
    expect(resolveObjectMetadataDialect('questdb')).toBe('questdb');
  });

  it('keeps the historical mapping for built-in and custom connections', () => {
    expect(resolveObjectMetadataDialect('mariadb')).toBe('mysql');
    expect(resolveObjectMetadataDialect('dameng')).toBe('dm');
    expect(resolveObjectMetadataDialect('oceanbase', '', 'oracle')).toBe('oracle');
    expect(resolveObjectMetadataDialect('custom', 'open-gauss')).toBe('opengauss');
    expect(resolveObjectMetadataDialect('postgres')).toBe('postgres');
  });
});
