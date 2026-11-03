import {
  normalizeCompareDialect,
  quoteCompareIdent,
} from './compareRepairSqlQuote';
import type { DataSyncColumnDefinitionView } from './model';

/**
 * DEFAULT 值的渲染。
 *
 * 后端给的是驱动原始值：可能是 `CURRENT_TIMESTAMP`、`0`，也可能是已经带引号的
 * `''`。再套一层引号就会出现 `DEFAULT ''''` 这种四引号语法错误，所以先判断
 * 「是否已带引号 / 是否为数值或函数」，都不匹配才当作裸字符串转义包裹。
 */
export const sqlDefaultLiteral = (value: string): string => {
  const raw = value;
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw;
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  if (upper === 'NULL') return 'NULL';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  if (/^[A-Z_][A-Z0-9_]*\s*\(\s*\)$/.test(upper)) return upper;
  // 只把已知的时间/常量函数原样输出。像 hello 这种裸词是字符串值，
  // 大写成 HELLO 会变成未定义标识符，MySQL 直接报错。
  if (BARE_DEFAULT_FUNCTIONS.has(upper)) return upper;
  return `'${raw.replace(/'/g, "''")}'`;
};

/** 生成列定义子句：type + NOT NULL + DEFAULT + AUTO_INCREMENT + COMMENT。 */
export const columnDefinitionClause = (
  column: DataSyncColumnDefinitionView,
  dialect: string,
): string => {
  const parts: string[] = [column.type.trim() || 'TEXT'];
  if (!column.nullable) parts.push('NOT NULL');
  if (column.hasDefault) parts.push(`DEFAULT ${sqlDefaultLiteral(column.default ?? '')}`);
  if (/auto_increment/i.test(column.extra || '')) parts.push('AUTO_INCREMENT');
  if (column.comment) parts.push(`COMMENT '${column.comment.replace(/'/g, "''")}'`);
  void dialect;
  return parts.join(' ');
};

/** ADD COLUMN 语句；有结构化定义时用它，否则退回纯类型文本。 */
export const addColumnStatement = (
  tableSql: string,
  column: string,
  fallbackType: string,
  definition: DataSyncColumnDefinitionView | undefined,
  dialect: string,
): string => {
  const col = quoteCompareIdent(column, dialect);
  const clause = definition
    ? columnDefinitionClause(definition, dialect)
    : (fallbackType.trim() || 'TEXT');
  return `ALTER TABLE ${tableSql} ADD COLUMN ${col} ${clause};`;
};

/**
 * MODIFY COLUMN 语句。
 *
 * 结构化定义优先：只改类型却丢掉 DEFAULT/COMMENT，会让目标列在修复后与源端
 * 仍然不一致——那正是「修了一半」的来源。
 */
export const modifyColumnStatement = (
  tableSql: string,
  column: string,
  fallbackType: string,
  definition: DataSyncColumnDefinitionView | undefined,
  dialect: string,
): string => {
  const col = quoteCompareIdent(column, dialect);
  const sqlserver = normalizeSqlServer(dialect);
  if (definition) {
    const clause = columnDefinitionClause(
      { ...definition, name: column },
      dialect,
    );
    return sqlserver
      ? `ALTER TABLE ${tableSql} ALTER COLUMN ${col} ${clause};`
      : `ALTER TABLE ${tableSql} MODIFY COLUMN ${col} ${clause};`;
  }
  const columnType = fallbackType.trim() || 'TEXT';
  if (sqlserver) {
    return `ALTER TABLE ${tableSql} ALTER COLUMN ${col} ${columnType} NULL;`;
  }
  // PostgreSQL 系用 ALTER COLUMN ... TYPE；MySQL 系用 MODIFY COLUMN。
  if (PG_LIKE.has(normalizeCompareDialect(dialect))) {
    return `ALTER TABLE ${tableSql} ALTER COLUMN ${col} TYPE ${columnType};`;
  }
  return `ALTER TABLE ${tableSql} MODIFY COLUMN ${col} ${columnType};`;
};

const BARE_DEFAULT_FUNCTIONS = new Set([
  'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'LOCALTIME',
  'LOCALTIMESTAMP', 'NOW',
]);

const PG_LIKE = new Set(['postgres', 'kingbase', 'highgo', 'opengauss', 'gaussdb', 'vastbase']);

const normalizeSqlServer = (dialect: string): boolean =>
  String(dialect || '').trim().toLowerCase() === 'sqlserver';
