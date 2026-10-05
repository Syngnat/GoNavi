import {
  unquoteSqlIdentifierPart,
  quoteSqlIdentifierPart,
  quoteSqlIdentifierPath,
  isSqlServerDialect,
  isOracleLikeDialect,
  isPgLikeDialect,
} from '../utils/sqlDialect';
import { splitQualifiedNameLast } from '../utils/qualifiedName';
import { type I18nParams, t as translateCatalog } from '../i18n';

export type SchemaSqlTranslator = (key: string, params?: I18nParams) => string;

export interface EditableColumnSnapshot {
  _key: string;
  name: string;
  type: string;
  nullable: string;
  default?: string | null;
  hasDefault?: boolean;
  extra?: string;
  comment?: string;
  key?: string;
  charset?: string;
  collation?: string;
  isAutoIncrement?: boolean;
}

export interface BuildAlterTablePreviewInput {
  dbType: string;
  tableName: string;
  originalColumns: EditableColumnSnapshot[];
  columns: EditableColumnSnapshot[];
  translate?: SchemaSqlTranslator;
}

export interface BuildCreateTablePreviewInput {
  dbType: string;
  tableName: string;
  columns: EditableColumnSnapshot[];
  charset?: string;
  collation?: string;
  starRocksOptions?: StarRocksCreateTableOptions;
  tdengineOptions?: TDengineCreateTableOptions;
  translate?: SchemaSqlTranslator;
}

export type TDengineTableKind = 'normal' | 'stable' | 'child';

export interface TDengineTagDefinition {
  name: string;
  type: string;
}

export interface TDengineCreateTableOptions {
  tableKind?: TDengineTableKind;
  stableName?: string;
  tagDefinitions?: TDengineTagDefinition[];
  tagValues?: string;
}

export type StarRocksTableKind = 'olap' | 'external';
export type StarRocksKeyModel = 'DUPLICATE' | 'PRIMARY' | 'UNIQUE' | 'AGGREGATE';
export type StarRocksDistributionType = 'HASH' | 'RANDOM' | 'NONE';

export interface StarRocksRollupOption {
  name: string;
  columnNames: string[];
  fromIndexName?: string;
  properties?: string;
}

export interface StarRocksCreateTableOptions {
  tableKind?: StarRocksTableKind;
  keyModel?: StarRocksKeyModel;
  keyColumnNames?: string[];
  partitionClause?: string;
  distributionType?: StarRocksDistributionType;
  distributionColumnNames?: string[];
  bucketMode?: 'AUTO' | 'NUMBER';
  bucketCount?: number;
  properties?: string;
  rollups?: StarRocksRollupOption[];
  externalEngine?: string;
  externalProperties?: string;
}

export interface BuildStarRocksMaterializedViewPreviewInput {
  name: string;
  query: string;
  async?: boolean;
  comment?: string;
  distributionColumnNames?: string[];
  bucketCount?: number;
  refreshClause?: string;
  partitionClause?: string;
  orderByColumnNames?: string[];
  properties?: string;
}

export const collectPrimaryKeyColumnKeys = (columns: EditableColumnSnapshot[]): string[] => (
  columns
    .filter((col) => col.key === 'PRI')
    .map((col) => col._key)
);

// Columns in the longest common subsequence of both orders keep their relative
// position, so only the remaining survivors need an explicit AFTER/FIRST move.
const longestCommonSubsequenceKeys = (originalSeq: string[], currentSeq: string[]): Set<string> => {
  const n = originalSeq.length;
  const m = currentSeq.length;
  if (n === 0 || m === 0) return new Set();
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = originalSeq[i] === currentSeq[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (originalSeq[i] === currentSeq[j]) {
      kept.add(originalSeq[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return kept;
};

export const collectPositionChangedColumnKeys = (input: BuildAlterTablePreviewInput): Set<string> => {
  const currentKeys = new Set(input.columns.map((col) => col._key));
  const originalKeys = new Set(input.originalColumns.map((col) => col._key));
  const originalSeq = input.originalColumns.filter((col) => currentKeys.has(col._key)).map((col) => col._key);
  const currentSeq = input.columns.filter((col) => originalKeys.has(col._key)).map((col) => col._key);
  const keptKeys = longestCommonSubsequenceKeys(originalSeq, currentSeq);
  return new Set(currentSeq.filter((key) => !keptKeys.has(key)));
};

export const escapeSqlString = (value: string) => String(value || '').replace(/'/g, "''");

export const translateSchemaSqlComment = (
  translate: SchemaSqlTranslator | undefined,
  key: string,
  params?: I18nParams,
): string => {
  const resolved = (translate || translateCatalog)(key, params);
  return resolved && resolved !== key ? resolved : key;
};

export const stripIdentifierQuotes = unquoteSqlIdentifierPart;

export const splitQualifiedName = (qualifiedName: string): { schemaName: string; objectName: string } => {
  const parsed = splitQualifiedNameLast(qualifiedName);
  return {
    schemaName: parsed.parentPath,
    objectName: parsed.objectName,
  };
};

export const quoteIdentifierPart = (part: string, dbType: string): string => quoteSqlIdentifierPart(dbType, part);

export const quoteIdentifierPath = (path: string, dbType: string): string => quoteSqlIdentifierPath(dbType, path);

export const normalizeDefaultText = (value: unknown): string => String(value ?? '').trim();

export const hasDefaultValue = (column: EditableColumnSnapshot): boolean => (
  typeof column.hasDefault === 'boolean'
    ? column.hasDefault
    : column.default !== undefined && column.default !== null && normalizeDefaultText(column.default).length > 0
);

export const defaultDefinitionChanged = (curr: EditableColumnSnapshot, orig: EditableColumnSnapshot): boolean => (
  hasDefaultValue(curr) !== hasDefaultValue(orig) ||
  (hasDefaultValue(curr) && normalizeDefaultText(curr.default) !== normalizeDefaultText(orig.default))
);

const isMySqlCharacterColumnType = (columnType: string): boolean => (
  /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set|nchar|nvarchar)\b/i.test(String(columnType || '').trim())
);

const isKnownDefaultExpression = (trimmed: string, dbType: string): boolean => {
  if (!trimmed) return false;
  if (/^N?'.*'$/i.test(trimmed)) return true;
  if (dbType === 'mysql' && /^(?:b'[01]+'|0b[01]+|x'[0-9a-f]+'|0x[0-9a-f]+)$/i.test(trimmed)) return true;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return true;
  if (/^(true|false|null)$/i.test(trimmed)) return true;
  if (/^(current_timestamp|current_date|current_time|localtimestamp|sysdate|systimestamp)(?:\s*\(\s*\d+\s*\))?$/i.test(trimmed)) return true;
  if (/^(now|uuid|newid|sysdatetime)\s*\(\s*\)$/i.test(trimmed)) return true;
  if (dbType === 'mysql' && /^\([\s\S]+\)$/.test(trimmed)) return true;
  if (/^nextval\s*\(/i.test(trimmed) || /::/.test(trimmed)) return true;
  return false;
};

const formatDefaultExpression = (value: unknown, dbType: string): string => {
  const trimmed = normalizeDefaultText(value);
  if (!trimmed) return '';
  if (isKnownDefaultExpression(trimmed, dbType)) {
    if (/^(true|false|null)$/i.test(trimmed)) return trimmed.toUpperCase();
    if (/^(current_timestamp|current_date|current_time|localtimestamp|sysdate|systimestamp)(?:\s*\(\s*\d+\s*\))?$/i.test(trimmed)) {
      return trimmed.toUpperCase().replace(/\s+/g, '');
    }
    return trimmed;
  }
  const prefix = isSqlServerDialect(dbType) ? 'N' : '';
  return `${prefix}'${escapeSqlString(trimmed)}'`;
};

export const formatEnabledDefaultExpression = (column: EditableColumnSnapshot, dbType: string): string => {
  const defaultValue = normalizeDefaultText(column.default);
  return defaultValue ? formatDefaultExpression(defaultValue, dbType) : "''";
};

const buildDefaultSql = (column: EditableColumnSnapshot, dbType: string): string => {
  if (!hasDefaultValue(column)) return '';
  const defaultValue = normalizeDefaultText(column.default);
  if (!defaultValue) {
    return dbType !== 'mysql' || isMySqlCharacterColumnType(column.type) ? "DEFAULT ''" : '';
  }
  return `DEFAULT ${formatDefaultExpression(defaultValue, dbType)}`;
};

export const definitionChanged = (
  curr: EditableColumnSnapshot,
  orig: EditableColumnSnapshot,
  includeCharacterOptions = false,
): boolean => (
  curr.type !== orig.type ||
  curr.nullable !== orig.nullable ||
  defaultDefinitionChanged(curr, orig) ||
  (curr.comment || '') !== (orig.comment || '') ||
  (includeCharacterOptions && (curr.charset || '') !== (orig.charset || '')) ||
  (includeCharacterOptions && (curr.collation || '') !== (orig.collation || '')) ||
  Boolean(curr.isAutoIncrement) !== Boolean(orig.isAutoIncrement)
);

export const physicalDefinitionChanged = (curr: EditableColumnSnapshot, orig: EditableColumnSnapshot): boolean => (
  curr.type !== orig.type ||
  curr.nullable !== orig.nullable ||
  defaultDefinitionChanged(curr, orig) ||
  Boolean(curr.isAutoIncrement) !== Boolean(orig.isAutoIncrement)
);

export const buildMySqlColumnDefinition = (column: EditableColumnSnapshot, dbType: string): string => {
  let extra = String(column.extra || '').replace(/\bDEFAULT_GENERATED\b/gi, '').replace(/\s+/g, ' ').trim();
  if (column.isAutoIncrement) {
    if (!extra.toLowerCase().includes('auto_increment')) {
      extra = `${extra} AUTO_INCREMENT`.trim();
    }
  } else {
    extra = extra.replace(/auto_increment/gi, '').replace(/\s+/g, ' ').trim();
  }
  const defaultSql = buildDefaultSql(column, dbType);
  const characterOptionsSql = dbType === 'mysql' && isMySqlCharacterColumnType(column.type)
    ? [
        column.charset ? `CHARACTER SET ${column.charset}` : '',
        column.collation ? `COLLATE ${column.collation}` : '',
      ].filter(Boolean).join(' ')
    : '';
  return [
    quoteIdentifierPart(column.name, dbType),
    String(column.type || '').trim(),
    characterOptionsSql,
    column.nullable === 'NO' ? 'NOT NULL' : 'NULL',
    defaultSql,
    extra,
    `COMMENT '${escapeSqlString(column.comment || '')}'`,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
};

const DORIS_AGG_TYPES = new Set([
  'SUM',
  'MIN',
  'MAX',
  'REPLACE',
  'REPLACE_IF_NOT_NULL',
  'HLL_UNION',
  'BITMAP_UNION',
  'QUANTILE_UNION',
  'GENERIC',
]);

export const buildDorisColumnDefinition = (column: EditableColumnSnapshot, dbType: string): string => {
  const defaultSql = buildDefaultSql(column, dbType);
  const autoIncrementSql = column.isAutoIncrement ? 'AUTO_INCREMENT' : '';
  const keyText = String(column.key || '').trim().toUpperCase();
  const extraText = String(column.extra || '').trim().toUpperCase();
  const keyOrAggSql = ['PRI', 'KEY', 'TRUE'].includes(keyText)
    ? 'KEY'
    : (DORIS_AGG_TYPES.has(extraText) ? extraText : '');
  return [
    quoteIdentifierPart(column.name, dbType),
    String(column.type || '').trim(),
    keyOrAggSql,
    column.nullable === 'NO' ? 'NOT NULL' : 'NULL',
    defaultSql,
    autoIncrementSql,
    `COMMENT '${escapeSqlString(column.comment || '')}'`,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
};

export const buildStarRocksColumnDefinition = (column: EditableColumnSnapshot): string => {
  const defaultSql = buildDefaultSql(column, 'starrocks');
  const extraText = String(column.extra || '').trim().toUpperCase();
  const aggregateSql = DORIS_AGG_TYPES.has(extraText) ? extraText : '';
  return [
    quoteIdentifierPart(column.name, 'starrocks'),
    String(column.type || '').trim(),
    aggregateSql,
    column.nullable === 'NO' ? 'NOT NULL' : 'NULL',
    defaultSql,
    `COMMENT '${escapeSqlString(column.comment || '')}'`,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
};

export const buildStandardColumnDefinition = (
  column: EditableColumnSnapshot,
  dbType: string,
  options: { includeNull?: boolean; includeIdentity?: boolean } = {},
): string => {
  const parts = [quoteIdentifierPart(column.name, dbType), String(column.type || '').trim()];
  if (options.includeIdentity && column.isAutoIncrement) {
    if (isSqlServerDialect(dbType)) {
      parts.push('IDENTITY(1,1)');
    } else if (isOracleLikeDialect(dbType)) {
      parts.push('GENERATED BY DEFAULT AS IDENTITY');
    }
  }
  const defaultSql = buildDefaultSql(column, dbType);
  if (defaultSql) parts.push(defaultSql);
  if (column.nullable === 'NO') {
    parts.push('NOT NULL');
  } else if (options.includeNull) {
    parts.push('NULL');
  }
  return parts.filter(Boolean).join(' ').trim();
};

export const buildPgLikeColumnDefinition = (column: EditableColumnSnapshot, dbType: string): string => {
  const parts = [quoteIdentifierPart(column.name, dbType), String(column.type || '').trim()];
  const defaultSql = buildDefaultSql(column, dbType);
  if (defaultSql) parts.push(defaultSql);
  if (column.nullable === 'NO') parts.push('NOT NULL');
  return parts.join(' ').trim();
};

export const buildColumnCommentSql = (tableRef: string, columnName: string, comment: string, dbType: string): string => {
  const columnRef = `${tableRef}.${quoteIdentifierPart(columnName, dbType)}`;
  const trimmed = String(comment || '').trim();
  if (!trimmed && isPgLikeDialect(dbType)) {
    return `COMMENT ON COLUMN ${columnRef} IS NULL;`;
  }
  return `COMMENT ON COLUMN ${columnRef} IS '${escapeSqlString(trimmed)}';`;
};

export const buildSqlServerColumnCommentSql = (
  tableName: string,
  columnName: string,
  comment: string,
): string => {
  const { schemaName, objectName } = splitQualifiedName(tableName);
  const schema = escapeSqlString(schemaName || 'dbo');
  const table = escapeSqlString(objectName || tableName);
  const column = escapeSqlString(columnName);
  const value = escapeSqlString(comment || '');
  return `IF EXISTS (SELECT 1 FROM sys.extended_properties ep JOIN sys.tables t ON ep.major_id = t.object_id JOIN sys.schemas s ON t.schema_id = s.schema_id JOIN sys.columns c ON ep.major_id = c.object_id AND ep.minor_id = c.column_id WHERE ep.name = N'MS_Description' AND s.name = N'${schema}' AND t.name = N'${table}' AND c.name = N'${column}') BEGIN EXEC sp_updateextendedproperty @name = N'MS_Description', @value = N'${value}', @level0type = N'SCHEMA', @level0name = N'${schema}', @level1type = N'TABLE', @level1name = N'${table}', @level2type = N'COLUMN', @level2name = N'${column}' END ELSE BEGIN EXEC sp_addextendedproperty @name = N'MS_Description', @value = N'${value}', @level0type = N'SCHEMA', @level0name = N'${schema}', @level1type = N'TABLE', @level1name = N'${table}', @level2type = N'COLUMN', @level2name = N'${column}' END;`;
};
