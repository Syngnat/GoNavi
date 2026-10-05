import { getDataSourceSpec } from './index';
import type { DataSourceUISpec } from './types';

// 描述表数据源在通用 SQL 拼装里的方言行为：标识符引号与数据浏览分页。

export type RegistryQuoting = NonNullable<DataSourceUISpec['quoting']>;

/** 描述表类型的标识符引号风格；不是描述表类型时返回 undefined，交给历史分支处理。 */
export const resolveRegistryQuoting = (type: unknown): RegistryQuoting | undefined => {
  const spec = getDataSourceSpec(type);
  if (!spec) return undefined;
  if (spec.ui?.quoting) return spec.ui.quoting;
  if (spec.family === 'mysql') return 'backtick';
  if (spec.family === 'postgres') return 'pg';
  return 'double';
};

/** 对象名整体是一个标识符的描述表类型（ui.flatObjectNames，如 etcd 键路径）：引用时不按点拆分。 */
export const usesRegistryFlatObjectNames = (type: unknown): boolean => Boolean(getDataSourceSpec(type)?.ui?.flatObjectNames);

/** Presto / Trino 的分页：OFFSET 必须写在 LIMIT 之前，LIMIT n OFFSET m 在它们的语法里是错误。 */
export const buildOffsetLimitSelectSQL = (base: string, orderBy: string, limit: number, offset: number): string =>
  offset > 0 ? `${base}${orderBy} OFFSET ${offset} LIMIT ${limit}` : `${base}${orderBy} LIMIT ${limit}`;

/**
 * 按描述表声明的分页语法拼装数据浏览 SQL；不是描述表类型或声明为默认 LIMIT/OFFSET 时返回 undefined。
 * base 已含 WHERE，orderBy 以空格开头或为空。
 */
export const buildRegistryPaginatedSelectSQL = (
  type: unknown,
  base: string,
  orderBy: string,
  limit: number,
  offset: number,
): string | undefined => {
  const style = getDataSourceSpec(type)?.ui?.pagination;
  if (!style || style === 'limit-offset') return undefined;
  switch (style) {
    case 'limit-range':
      // QuestDB：LIMIT lo, hi 返回第 lo+1 到第 hi 行。
      return `${base}${orderBy} LIMIT ${offset}, ${offset + limit}`;
    case 'offset-limit':
      return buildOffsetLimitSelectSQL(base, orderBy, limit, offset);
    case 'limit-start':
      // SurrealDB：LIMIT n START m。
      return `${base}${orderBy} LIMIT ${limit} START ${offset}`;
    case 'rows-to':
      // Firebird：ROWS m TO n（从 1 开始，含两端）。
      return `${base}${orderBy} ROWS ${offset + 1} TO ${offset + limit}`;
    case 'offset-fetch':
      return `${base}${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
    case 'skip-first': {
      // Informix / GBase 8s：SELECT SKIP m FIRST n ...，紧跟在首个 SELECT 之后。
      const match = /^\s*select\b/i.exec(base);
      if (!match) return undefined;
      const prefix = base.slice(0, match.index + match[0].length);
      return `${prefix} SKIP ${offset} FIRST ${limit}${base.slice(prefix.length)}${orderBy}`;
    }
    default:
      return undefined;
  }
};
