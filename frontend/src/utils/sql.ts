import { splitQualifiedNameSegments, stripIdentifierQuotes } from './qualifiedName';

export type FilterCondition = {
  id?: number;
  enabled?: boolean;
  logic?: 'AND' | 'OR';
  column?: string;
  op?: string;
  value?: string;
  value2?: string;
};

const normalizeIdentPart = (ident: string) => stripIdentifierQuotes(ident);

// 检查标识符是否需要引号（包含特殊字符或是保留字）
const needsQuote = (ident: string): boolean => {
  if (!ident) return false;
  // 如果包含特殊字符（非字母、数字、下划线）则需要引号
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) return true;
  // PostgreSQL 会将未加引号的标识符折叠为小写，含大写字母时必须加引号
  if (/[A-Z]/.test(ident)) return true;
  // 常见 SQL 保留字列表（简化版）
  const reserved = ['select', 'from', 'where', 'table', 'index', 'user', 'order', 'group', 'by', 'limit', 'offset', 'and', 'or', 'not', 'null', 'true', 'false', 'key', 'primary', 'foreign', 'references', 'default', 'constraint', 'create', 'drop', 'alter', 'insert', 'update', 'delete', 'set', 'values', 'into', 'join', 'left', 'right', 'inner', 'outer', 'on', 'as', 'is', 'in', 'like', 'between', 'case', 'when', 'then', 'else', 'end', 'having', 'distinct', 'all', 'any', 'exists', 'union', 'except', 'intersect'];
  return reserved.includes(ident.toLowerCase());
};

export const quoteIdentPart = (dbType: string, ident: string) => {
  const raw = normalizeIdentPart(ident);
  if (!raw) return raw;
  const dbTypeLower = (dbType || '').toLowerCase();

  if (dbTypeLower === 'mysql' || dbTypeLower === 'goldendb' || dbTypeLower === 'mariadb' || dbTypeLower === 'oceanbase' || dbTypeLower === 'diros' || dbTypeLower === 'starrocks' || dbTypeLower === 'sphinx' || dbTypeLower === 'tdengine' || dbTypeLower === 'iotdb' || dbTypeLower === 'clickhouse') {
    return `\`${raw.replace(/`/g, '``')}\``;
  }

  // 对于 KingBase/PostgreSQL，只在必要时加引号
  if (dbTypeLower === 'kingbase' || dbTypeLower === 'postgres' || dbTypeLower === 'opengauss' || dbTypeLower === 'gaussdb') {
    if (needsQuote(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    // 不加引号，保持原样（数据库会自动转小写处理）
    return raw;
  }

  // SQL Server 使用 [bracket] 标识符
  if (dbTypeLower === 'sqlserver' || dbTypeLower === 'mssql') {
    return `[${raw.replace(/]/g, ']]')}]`;
  }

  // 其他数据库默认加双引号
  return `"${raw.replace(/"/g, '""')}"`;
};

export const quoteQualifiedIdent = (dbType: string, ident: string) => {
  const raw = (ident || '').trim();
  if (!raw) return raw;
  if (['rocketmq', 'mqtt', 'kafka', 'rabbitmq'].includes((dbType || '').trim().toLowerCase())) {
    return quoteIdentPart(dbType, raw);
  }
  const parts = splitQualifiedNameSegments(raw).filter(Boolean);
  if (parts.length === 0) return quoteIdentPart(dbType, raw);
  if (parts.length === 1 && parts[0] === normalizeIdentPart(raw)) return quoteIdentPart(dbType, raw);
  return parts.map((part) => quoteIdentPart(dbType, part)).join('.');
};

export const escapeLiteral = (val: string) => (val || '').replace(/'/g, "''");

type SortInfoItem = {
  columnKey?: string;
  order?: string;
  enabled?: boolean;
};

type SortInfo = SortInfoItem | SortInfoItem[] | null | undefined;

// 为排序查询按库类型注入 sort_buffer 提升参数（仅影响当前语句）。
// MySQL: 使用 Optimizer Hint `SET_VAR`。
// MariaDB: 使用 `SET STATEMENT ... FOR` 包装当前查询。
export const withSortBufferTuningSQL = (
  dbType: string,
  sql: string,
  sortBufferBytes: number,
) => {
  const rawSql = String(sql || '');
  const trimmed = rawSql.trim();
  if (!trimmed) return rawSql;
  if (!/^select\b/i.test(trimmed)) return rawSql;

  const normalizedType = String(dbType || '').trim().toLowerCase();
  const bytes = Math.max(256 * 1024, Math.floor(Number(sortBufferBytes) || 0));
  if (normalizedType === 'mysql') {
    return rawSql.replace(
      /^\s*select\b/i,
      (matched) => `${matched} /*+ SET_VAR(sort_buffer_size=${bytes}) */`,
    );
  }
  if (normalizedType === 'mariadb') {
    return `SET STATEMENT sort_buffer_size=${bytes} FOR ${rawSql}`;
  }
  return rawSql;
};

/** 将 SortInfo（单字段或多字段）标准化为 SortInfoItem 数组 */
const normalizeSortInfoItems = (sortInfo: SortInfo): SortInfoItem[] => {
  if (!sortInfo) return [];
  if (Array.isArray(sortInfo)) return sortInfo;
  return [sortInfo];
};

/** 判断 SortInfo 中是否存在至少一个有效排序 */
export const hasExplicitSort = (sortInfo: SortInfo): boolean => {
  const items = normalizeSortInfoItems(sortInfo);
  return items.some(item => {
    if (item?.enabled === false) return false;
    const col = String(item?.columnKey || '').trim();
    const order = String(item?.order || '');
    return !!col && (order === 'ascend' || order === 'descend');
  });
};

export const buildOrderBySQL = (
  dbType: string,
  sortInfo: SortInfo,
  fallbackColumns: string[] = [],
) => {
  const dbTypeLower = String(dbType || '').trim().toLowerCase();
  const items = normalizeSortInfoItems(sortInfo);
  const seen = new Set<string>();
  const sortParts: string[] = [];

  for (const item of items) {
    if (item?.enabled === false) continue;
    const sortColumn = normalizeIdentPart(String(item?.columnKey || ''));
    const sortOrder = String(item?.order || '');
    const direction = sortOrder === 'ascend' ? 'ASC' : sortOrder === 'descend' ? 'DESC' : '';
    if (sortColumn && direction) {
      const key = sortColumn.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        sortParts.push(`${quoteIdentPart(dbType, sortColumn)} ${direction}`);
      }
    }
  }

  if (sortParts.length > 0) {
    return ` ORDER BY ${sortParts.join(', ')}`;
  }

  // 部分数据源在无显式排序需求时强制 ORDER BY（即使按主键）会显著放大大表预览成本：
  // MySQL/MariaDB 可能触发 filesort 和 sort memory 错误，DuckDB 大文件可能被排序拖到连接超时。
  // 因此仅在用户主动点击排序时下发 ORDER BY，默认分页查询不加兜底排序。
  if (dbTypeLower === 'mysql' || dbTypeLower === 'goldendb' || dbTypeLower === 'mariadb' || dbTypeLower === 'oceanbase' || dbTypeLower === 'diros' || dbTypeLower === 'starrocks' || dbTypeLower === 'duckdb') {
    return '';
  }

  const stableColumns = (fallbackColumns || [])
    .map((col) => normalizeIdentPart(String(col || '')))
    .filter((col) => {
      if (!col) return false;
      const key = col.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (stableColumns.length > 0) {
    const parts = stableColumns.map((col) => `${quoteIdentPart(dbType, col)} ASC`);
    return ` ORDER BY ${parts.join(', ')}`;
  }

  return '';
};

const splitOrderByParts = (body: string): string[] => {
  const text = String(body || '');
  const parts: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBracket = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (inSingle) {
      if (ch === "'" && next === "'") {
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"' && next === '"') {
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inBracket) {
      if (ch === ']' && next === ']') {
        i++;
      } else if (ch === ']') {
        inBracket = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '[') {
      inBracket = true;
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
      continue;
    }
    if (ch === ',' && parenDepth === 0) {
      const part = text.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }

  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
};

export const reverseOrderBySQL = (orderBySQL: string): string => {
  const raw = String(orderBySQL || '').trim();
  if (!raw) return '';
  const body = raw.replace(/^order\s+by\s+/i, '').trim();
  if (!body) return '';

  const parts = splitOrderByParts(body)
    .map((part) => {
      if (/\s+asc$/i.test(part)) return part.replace(/\s+asc$/i, ' DESC');
      if (/\s+desc$/i.test(part)) return part.replace(/\s+desc$/i, ' ASC');
      return `${part} DESC`;
    })
    .filter(Boolean);
  if (parts.length === 0) return '';
  return ` ORDER BY ${parts.join(', ')}`;
};

const addSqlServerTopLimit = (sql: string, limit: number): string => {
  const text = String(sql || '').trim();
  if (!text) return text;
  if (/^\s*select\s+(?:distinct\s+)?top\b/i.test(text)) {
    return text;
  }
  return text.replace(
    /^(\s*select\b)(\s+distinct\b)?/i,
    (_match, selectKeyword: string, distinctKeyword = '') => `${selectKeyword}${distinctKeyword} TOP ${limit}`,
  );
};

const buildSqlServerPaginatedSelectSQL = (
  base: string,
  orderBy: string,
  limit: number,
  offset: number,
): string => {
  if (offset <= 0) {
    return `${addSqlServerTopLimit(base, limit)}${orderBy}`;
  }

  const effectiveOrderBy = orderBy.trim();
  if (effectiveOrderBy) {
    const reverseOrderBy = reverseOrderBySQL(effectiveOrderBy);
    if (reverseOrderBy) {
      const upperBound = offset + limit;
      return `SELECT * FROM (SELECT TOP ${limit} * FROM (SELECT TOP ${upperBound} * FROM (${base}) AS [__gonavi_page_base__] ${effectiveOrderBy}) AS [__gonavi_page_window__] ${reverseOrderBy}) AS [__gonavi_page_slice__] ${effectiveOrderBy}`;
    }
  }

  const rowNumberOrderBy = effectiveOrderBy || 'ORDER BY (SELECT NULL)';
  const upperBound = offset + limit;
  return `SELECT * FROM (SELECT [__gonavi_page__].*, ROW_NUMBER() OVER (${rowNumberOrderBy}) AS [__gonavi_rn__] FROM (${base}) AS [__gonavi_page__]) AS [__gonavi_page_result__] WHERE [__gonavi_rn__] > ${offset} AND [__gonavi_rn__] <= ${upperBound} ORDER BY [__gonavi_rn__]`;
};

export const buildPaginatedSelectSQL = (
  dbType: string,
  baseSql: string,
  orderBySQL: string,
  limit: number,
  offset: number,
  oceanBaseOracle = false,
) => {
  const normalizedType = String(dbType || '').trim().toLowerCase();
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const base = String(baseSql || '').trim();
  const orderBy = String(orderBySQL || '');

  if (!base || safeLimit <= 0) {
    return `${base}${orderBy}`;
  }

  switch (normalizedType) {
    case 'oracle':
    case 'dameng': {
      const orderedSql = `${base}${orderBy}`;
      const upperBound = safeOffset + safeLimit;
      if (oceanBaseOracle && safeOffset <= 0) {
        return `${orderedSql} FETCH FIRST ${upperBound} ROWS ONLY`;
      }
      if (safeOffset <= 0) {
        return `SELECT * FROM (${orderedSql}) WHERE ROWNUM <= ${upperBound}`;
      }
      return `SELECT * FROM (SELECT "__gonavi_page__".*, ROWNUM "__gonavi_rn__" FROM (${orderedSql}) "__gonavi_page__" WHERE ROWNUM <= ${upperBound}) WHERE "__gonavi_rn__" > ${safeOffset}`;
    }
    case 'sqlserver':
    case 'mssql': {
      return buildSqlServerPaginatedSelectSQL(base, orderBy, safeLimit, safeOffset);
    }
    default:
      return `${base}${orderBy} LIMIT ${safeLimit} OFFSET ${safeOffset}`;
  }
};

export const parseListValues = (val: string) => {
  const raw = (val || '').trim();
  if (!raw) return [];
  return raw
    .split(/[\n,，]+/)
    .map(s => s.trim())
    .filter(Boolean);
};

const normalizeConditionLogic = (logic: unknown): 'AND' | 'OR' => {
  return String(logic || '').trim().toUpperCase() === 'OR' ? 'OR' : 'AND';
};

export const buildWhereSQL = (dbType: string, conditions: FilterCondition[]) => {
  const whereParts: Array<{ expr: string; logic: 'AND' | 'OR' }> = [];

  (conditions || []).forEach((cond) => {
    if (cond?.enabled === false) return;

    const op = (cond?.op || '').trim();
    const column = (cond?.column || '').trim();
    const value = (cond?.value ?? '').toString();
    const value2 = (cond?.value2 ?? '').toString();
    const logic = normalizeConditionLogic(cond?.logic);

    const appendWherePart = (expr: string) => {
      const normalizedExpr = String(expr || '').trim();
      if (!normalizedExpr) return;
      whereParts.push({ expr: normalizedExpr, logic });
    };

    if (op === 'CUSTOM') {
      const expr = value.trim();
      if (expr) appendWherePart(`(${expr})`);
      return;
    }

    if (!column) return;

    const col = quoteIdentPart(dbType, column);

    switch (op) {
      case 'IS_NULL':
        appendWherePart(`${col} IS NULL`);
        return;
      case 'IS_NOT_NULL':
        appendWherePart(`${col} IS NOT NULL`);
        return;
      case 'IS_EMPTY':
        // 兼容：空值通常理解为 NULL 或空字符串
        appendWherePart(`(${col} IS NULL OR ${col} = '')`);
        return;
      case 'IS_NOT_EMPTY':
        appendWherePart(`(${col} IS NOT NULL AND ${col} <> '')`);
        return;
      case 'BETWEEN': {
        const v1 = value.trim();
        const v2 = value2.trim();
        if (!v1 || !v2) return;
        appendWherePart(`${col} BETWEEN '${escapeLiteral(v1)}' AND '${escapeLiteral(v2)}'`);
        return;
      }
      case 'NOT_BETWEEN': {
        const v1 = value.trim();
        const v2 = value2.trim();
        if (!v1 || !v2) return;
        appendWherePart(`${col} NOT BETWEEN '${escapeLiteral(v1)}' AND '${escapeLiteral(v2)}'`);
        return;
      }
      case 'IN': {
        const items = parseListValues(value);
        if (items.length === 0) return;
        const list = items.map(v => `'${escapeLiteral(v)}'`).join(', ');
        appendWherePart(`${col} IN (${list})`);
        return;
      }
      case 'NOT_IN': {
        const items = parseListValues(value);
        if (items.length === 0) return;
        const list = items.map(v => `'${escapeLiteral(v)}'`).join(', ');
        appendWherePart(`${col} NOT IN (${list})`);
        return;
      }
      case 'CONTAINS': {
        const v = value.trim();
        if (!v) return;
        appendWherePart(`${col} LIKE '%${escapeLiteral(v)}%'`);
        return;
      }
      case 'NOT_CONTAINS': {
        const v = value.trim();
        if (!v) return;
        appendWherePart(`${col} NOT LIKE '%${escapeLiteral(v)}%'`);
        return;
      }
      case 'STARTS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendWherePart(`${col} LIKE '${escapeLiteral(v)}%'`);
        return;
      }
      case 'NOT_STARTS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendWherePart(`${col} NOT LIKE '${escapeLiteral(v)}%'`);
        return;
      }
      case 'ENDS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendWherePart(`${col} LIKE '%${escapeLiteral(v)}'`);
        return;
      }
      case 'NOT_ENDS_WITH': {
        const v = value.trim();
        if (!v) return;
        appendWherePart(`${col} NOT LIKE '%${escapeLiteral(v)}'`);
        return;
      }
      case '=':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const v = value.trim();
        if (!v) return;
        appendWherePart(`${col} ${op} '${escapeLiteral(v)}'`);
        return;
      }
      default: {
        // 兼容旧值：LIKE
        if (op.toUpperCase() === 'LIKE') {
          const v = value.trim();
          if (!v) return;
          appendWherePart(`${col} LIKE '%${escapeLiteral(v)}%'`);
          return;
        }

        const v = value.trim();
        if (!v) return;
        appendWherePart(`${col} ${op} '${escapeLiteral(v)}'`);
      }
    }
  });

  if (whereParts.length === 0) return '';

  let whereExpr = `(${whereParts[0].expr})`;
  for (let i = 1; i < whereParts.length; i++) {
    const part = whereParts[i];
    whereExpr = `(${whereExpr} ${part.logic} (${part.expr}))`;
  }
  return `WHERE ${whereExpr}`;
};
