export type FilterCondition = {
  id?: number;
  column?: string;
  op?: string;
  value?: string;
  value2?: string;
};

const normalizeIdentPart = (ident: string) => {
  let raw = (ident || '').trim();
  if (!raw) return raw;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' && last === '"') || (first === '`' && last === '`')) {
    raw = raw.slice(1, -1).trim();
  }
  raw = raw.replace(/["`]/g, '').trim();
  return raw;
};

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

  if (dbTypeLower === 'mysql') {
    return `\`${raw.replace(/`/g, '``')}\``;
  }

  // 对于 KingBase/PostgreSQL，只在必要时加引号
  if (dbTypeLower === 'kingbase' || dbTypeLower === 'postgres') {
    if (needsQuote(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    // 不加引号，保持原样（数据库会自动转小写处理）
    return raw;
  }

  // 其他数据库默认加双引号
  return `"${raw.replace(/"/g, '""')}"`;
};

export const quoteQualifiedIdent = (dbType: string, ident: string) => {
  const raw = (ident || '').trim();
  if (!raw) return raw;
  const parts = raw.split('.').map(normalizeIdentPart).filter(Boolean);
  if (parts.length <= 1) return quoteIdentPart(dbType, raw);
  return parts.map(p => quoteIdentPart(dbType, p)).join('.');
};

export const escapeLiteral = (val: string) => (val || '').replace(/'/g, "''");

export const parseListValues = (val: string) => {
  const raw = (val || '').trim();
  if (!raw) return [];
  return raw
    .split(/[\n,，]+/)
    .map(s => s.trim())
    .filter(Boolean);
};

export const buildWhereSQL = (dbType: string, conditions: FilterCondition[]) => {
  const whereParts: string[] = [];

  (conditions || []).forEach((cond) => {
    const op = (cond?.op || '').trim();
    const column = (cond?.column || '').trim();
    const value = (cond?.value ?? '').toString();
    const value2 = (cond?.value2 ?? '').toString();

    if (op === 'CUSTOM') {
      const expr = value.trim();
      if (expr) whereParts.push(`(${expr})`);
      return;
    }

    if (!column) return;

    const col = quoteIdentPart(dbType, column);

    switch (op) {
      case 'IS_NULL':
        whereParts.push(`${col} IS NULL`);
        return;
      case 'IS_NOT_NULL':
        whereParts.push(`${col} IS NOT NULL`);
        return;
      case 'IS_EMPTY':
        // 兼容：空值通常理解为 NULL 或空字符串
        whereParts.push(`(${col} IS NULL OR ${col} = '')`);
        return;
      case 'IS_NOT_EMPTY':
        whereParts.push(`(${col} IS NOT NULL AND ${col} <> '')`);
        return;
      case 'BETWEEN': {
        const v1 = value.trim();
        const v2 = value2.trim();
        if (!v1 || !v2) return;
        whereParts.push(`${col} BETWEEN '${escapeLiteral(v1)}' AND '${escapeLiteral(v2)}'`);
        return;
      }
      case 'NOT_BETWEEN': {
        const v1 = value.trim();
        const v2 = value2.trim();
        if (!v1 || !v2) return;
        whereParts.push(`${col} NOT BETWEEN '${escapeLiteral(v1)}' AND '${escapeLiteral(v2)}'`);
        return;
      }
      case 'IN': {
        const items = parseListValues(value);
        if (items.length === 0) return;
        const list = items.map(v => `'${escapeLiteral(v)}'`).join(', ');
        whereParts.push(`${col} IN (${list})`);
        return;
      }
      case 'NOT_IN': {
        const items = parseListValues(value);
        if (items.length === 0) return;
        const list = items.map(v => `'${escapeLiteral(v)}'`).join(', ');
        whereParts.push(`${col} NOT IN (${list})`);
        return;
      }
      case 'CONTAINS': {
        const v = value.trim();
        if (!v) return;
        whereParts.push(`${col} LIKE '%${escapeLiteral(v)}%'`);
        return;
      }
      case 'NOT_CONTAINS': {
        const v = value.trim();
        if (!v) return;
        whereParts.push(`${col} NOT LIKE '%${escapeLiteral(v)}%'`);
        return;
      }
      case 'STARTS_WITH': {
        const v = value.trim();
        if (!v) return;
        whereParts.push(`${col} LIKE '${escapeLiteral(v)}%'`);
        return;
      }
      case 'NOT_STARTS_WITH': {
        const v = value.trim();
        if (!v) return;
        whereParts.push(`${col} NOT LIKE '${escapeLiteral(v)}%'`);
        return;
      }
      case 'ENDS_WITH': {
        const v = value.trim();
        if (!v) return;
        whereParts.push(`${col} LIKE '%${escapeLiteral(v)}'`);
        return;
      }
      case 'NOT_ENDS_WITH': {
        const v = value.trim();
        if (!v) return;
        whereParts.push(`${col} NOT LIKE '%${escapeLiteral(v)}'`);
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
        whereParts.push(`${col} ${op} '${escapeLiteral(v)}'`);
        return;
      }
      default: {
        // 兼容旧值：LIKE
        if (op.toUpperCase() === 'LIKE') {
          const v = value.trim();
          if (!v) return;
          whereParts.push(`${col} LIKE '%${escapeLiteral(v)}%'`);
          return;
        }

        const v = value.trim();
        if (!v) return;
        whereParts.push(`${col} ${op} '${escapeLiteral(v)}'`);
      }
    }
  });

  return whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
};

