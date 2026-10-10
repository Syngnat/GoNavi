import type { SavedConnection } from '../types';
import { getDataSourceCapabilities } from './dataSourceCapabilities';
import { getSchemaVisibilityRule } from './schemaVisibility';
import { isPgLikeDialect } from './sqlDialect';

export type MetadataSchemaScope = {
  mode: 'include' | 'exclude';
  names: string[];
  caseSensitive: boolean;
};

export type MetadataDiscoveryScope = {
  schemas?: MetadataSchemaScope;
};

/**
 * 只把模式可见性下推到目录查询：库列表仍走各驱动原生实现（保留 current_database()、
 * SHOW DATABASES 兜底和内部库隐藏），库可见性由导航树拿到列表后再筛。
 * 范围只约束目录读取，不改变连接的数据库、search_path 或执行权限。
 */
export const buildMetadataDiscoveryScope = (
  conn: SavedConnection,
  dbName: string,
): MetadataDiscoveryScope | undefined => {
  const caseSensitive = getDataSourceCapabilities(conn.config).schemaIdentifierCaseSensitive;
  const rule = getSchemaVisibilityRule(conn, dbName, { caseSensitive });
  return rule ? { schemas: { mode: rule.mode, names: rule.schemas, caseSensitive } } : undefined;
};

export const buildMetadataSchemaPredicate = (column: string, scope?: MetadataSchemaScope, dialect = ''): string => {
  if (!scope?.names.length) return '';
  const values = scope.names.map((name) => scope.caseSensitive ? name : name.toLocaleLowerCase());
  const literals = values.map((name) => {
    const escaped = name.replace(/'/g, "''");
    if (isPgLikeDialect(dialect) && name.includes('\\')) return `E'${escaped.replace(/\\/g, '\\\\')}'`;
    return `${dialect === 'sqlserver' ? 'N' : ''}'${escaped}'`;
  }).join(', ');
  return `${scope.caseSensitive ? column : `LOWER(${column})`} ${scope.mode === 'exclude' ? 'NOT IN' : 'IN'} (${literals})`;
};

/** 只用于已声明 schema 列的内置目录 SELECT；用户 SQL 不经过这里。 */
export const scopeMetadataQuery = (sql: string, column?: string, scope?: MetadataSchemaScope, dialect = ''): string => {
  if (!column || !scope?.names.length) return sql;
  // 内置目录查询的最后一个 ORDER BY 属于顶层，子查询的排序位于它之前。
  const orderOffset = sql.toUpperCase().lastIndexOf('ORDER BY');
  const select = orderOffset < 0 ? sql : sql.slice(0, orderOffset);
  const order = orderOffset < 0 ? '' : sql.slice(orderOffset);
  const conjunction = /\bWHERE\b/i.test(select) ? ' AND ' : ' WHERE ';
  return `${select.trimEnd()}${conjunction}${buildMetadataSchemaPredicate(column, scope, dialect)} ${order}`.trimEnd();
};
