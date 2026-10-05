import { getDataSourceSpec } from './index';

// 表统计（侧栏表状态、右键统计、对象概览）里与数据源相关的部分，全部由描述表声明：
// - ui.tableStats：PostgreSQL 系查询里的行数 / 总大小 / 索引大小表达式。CockroachDB / KWDB 没有
//   pg_total_relation_size，行数来自 crdb_internal；TimescaleDB 超表的数据在 chunk 里，根表的 reltuples
//   与大小恒为 0，要用扩展函数，且 1.x / 2.x 的函数不同。
// - ui.metadataQueries.tableStatus：没有借用方言的数据源（QuestDB）整条表状态查询。
// 两者的条目都按服务端版本区间取第一条匹配项；带区间的条目只在版本已知时匹配。

type VersionedEntry = { minServer?: string; maxServer?: string };

export type PgTableStatsSql = { rows: string; size: string; indexSize: string };

const PG_DEFAULT_TABLE_STATS: PgTableStatsSql = {
  rows: '{{reltuples}}',
  size: 'pg_total_relation_size({{oid}})',
  indexSize: 'pg_indexes_size({{oid}})',
};

const versionParts = (value: string): number[] =>
  (String(value).match(/\d+(?:\.\d+)*/)?.[0] || '').split('.').filter(Boolean).map(Number);

const compareVersions = (left: string, right: string): number => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const isBounded = (entry: VersionedEntry): boolean => Boolean(entry.minServer || entry.maxServer);

const pickVersionedEntry = <T extends VersionedEntry>(entries: T[] | undefined, serverVersion?: string | null): T | undefined => {
  const version = String(serverVersion || '').trim();
  return entries?.find((entry) => {
    if (!isBounded(entry)) return true;
    if (!version) return false;
    return (!entry.minServer || compareVersions(version, entry.minServer) >= 0)
      && (!entry.maxServer || compareVersions(version, entry.maxServer) < 0);
  });
};

/** 描述里有按服务端版本区分的表统计条目时，生成统计 SQL 前需要先取服务端版本。 */
export const needsServerVersionForTableStats = (type: unknown): boolean => {
  const ui = getDataSourceSpec(type)?.ui;
  return Boolean(ui?.tableStats?.some(isBounded) || ui?.metadataQueries?.tableStatus?.some(isBounded));
};

/** PostgreSQL 系表统计用的行数 / 总大小 / 索引大小表达式；没有匹配条目时用 PostgreSQL 默认表达式。alias 是 pg_class 的别名。 */
export const resolvePgTableStatsSql = (type: unknown, serverVersion?: string | null, alias = 'c'): PgTableStatsSql => {
  const entry = pickVersionedEntry(getDataSourceSpec(type)?.ui?.tableStats, serverVersion);
  const fill = (template: string) => template
    .replace(/\{\{oid\}\}/g, `${alias}.oid`)
    .replace(/\{\{reltuples\}\}/g, `${alias}.reltuples::bigint`);
  return {
    rows: fill(entry?.rows || PG_DEFAULT_TABLE_STATS.rows),
    size: fill(entry?.size || PG_DEFAULT_TABLE_STATS.size),
    indexSize: fill(entry?.indexSize || PG_DEFAULT_TABLE_STATS.indexSize),
  };
};

/**
 * 描述表声明的整条表状态查询（返回 table_name、table_comment、table_rows、data_length、index_length 等列），
 * {{database}} 替换为转义后的库名；没有声明或版本不匹配时返回空串。
 */
export const resolveRegistryTableStatusSql = (type: unknown, dbName: string, serverVersion?: string | null): string => {
  const entry = pickVersionedEntry(getDataSourceSpec(type)?.ui?.metadataQueries?.tableStatus, serverVersion);
  return entry ? entry.sql.replace(/\{\{database\}\}/g, String(dbName || '').replace(/'/g, "''")) : '';
};
