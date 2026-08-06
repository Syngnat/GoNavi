import {
  isBacktickIdentifierDialect,
  isMysqlFamilyDialect,
  isOracleLikeDialect,
  isPgLikeDialect,
  isSqlServerDialect,
  quoteSqlIdentifierPart,
  quoteSqlIdentifierPath,
  resolveSqlDialect,
  unquoteSqlIdentifierPart,
  unquoteSqlIdentifierPath,
} from '../utils/sqlDialect';
import { splitQualifiedNameLast } from '../utils/qualifiedName';
import { t as translateCatalog, type I18nParams } from '../i18n';

type SchemaSqlTranslator = (key: string, params?: I18nParams) => string;

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

const collectPrimaryKeyColumnKeys = (columns: EditableColumnSnapshot[]): string[] => (
  columns
    .filter((col) => col.key === 'PRI')
    .map((col) => col._key)
);

const escapeSqlString = (value: string) => String(value || '').replace(/'/g, "''");

const translateSchemaSqlComment = (
  translate: SchemaSqlTranslator | undefined,
  key: string,
  params?: I18nParams,
): string => {
  const resolved = (translate || translateCatalog)(key, params);
  return resolved && resolved !== key ? resolved : key;
};

const stripIdentifierQuotes = unquoteSqlIdentifierPart;

const splitQualifiedName = (qualifiedName: string): { schemaName: string; objectName: string } => {
  const parsed = splitQualifiedNameLast(qualifiedName);
  return {
    schemaName: parsed.parentPath,
    objectName: parsed.objectName,
  };
};

const quoteIdentifierPart = (part: string, dbType: string): string => quoteSqlIdentifierPart(dbType, part);

const quoteIdentifierPath = (path: string, dbType: string): string => quoteSqlIdentifierPath(dbType, path);

const normalizeDefaultText = (value: unknown): string => String(value ?? '').trim();

const hasDefaultValue = (column: EditableColumnSnapshot): boolean => (
  typeof column.hasDefault === 'boolean'
    ? column.hasDefault
    : column.default !== undefined && column.default !== null && normalizeDefaultText(column.default).length > 0
);

const defaultDefinitionChanged = (curr: EditableColumnSnapshot, orig: EditableColumnSnapshot): boolean => (
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

const formatEnabledDefaultExpression = (column: EditableColumnSnapshot, dbType: string): string => {
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

const definitionChanged = (
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

const physicalDefinitionChanged = (curr: EditableColumnSnapshot, orig: EditableColumnSnapshot): boolean => (
  curr.type !== orig.type ||
  curr.nullable !== orig.nullable ||
  defaultDefinitionChanged(curr, orig) ||
  Boolean(curr.isAutoIncrement) !== Boolean(orig.isAutoIncrement)
);

const buildMySqlColumnDefinition = (column: EditableColumnSnapshot, dbType: string): string => {
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

const buildDorisColumnDefinition = (column: EditableColumnSnapshot, dbType: string): string => {
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

const buildStarRocksColumnDefinition = (column: EditableColumnSnapshot): string => {
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

const buildStandardColumnDefinition = (
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

const buildPgLikeColumnDefinition = (column: EditableColumnSnapshot, dbType: string): string => {
  const parts = [quoteIdentifierPart(column.name, dbType), String(column.type || '').trim()];
  const defaultSql = buildDefaultSql(column, dbType);
  if (defaultSql) parts.push(defaultSql);
  if (column.nullable === 'NO') parts.push('NOT NULL');
  return parts.join(' ').trim();
};

const buildColumnCommentSql = (tableRef: string, columnName: string, comment: string, dbType: string): string => {
  const columnRef = `${tableRef}.${quoteIdentifierPart(columnName, dbType)}`;
  const trimmed = String(comment || '').trim();
  if (!trimmed && isPgLikeDialect(dbType)) {
    return `COMMENT ON COLUMN ${columnRef} IS NULL;`;
  }
  return `COMMENT ON COLUMN ${columnRef} IS '${escapeSqlString(trimmed)}';`;
};

const buildSqlServerColumnCommentSql = (
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

const buildMySqlAlterPreviewSql = (input: BuildAlterTablePreviewInput, dbType: string): string => {
  const tableName = quoteIdentifierPath(input.tableName, dbType);
  const alters: string[] = [];

  input.originalColumns.forEach((orig) => {
    if (!input.columns.find((col) => col._key === orig._key)) {
      alters.push(`DROP COLUMN ${quoteIdentifierPart(orig.name, dbType)}`);
    }
  });

  input.columns.forEach((curr, index) => {
    const orig = input.originalColumns.find((col) => col._key === curr._key);
    const prevCol = index > 0 ? input.columns[index - 1] : null;
    const positionSql = prevCol ? `AFTER ${quoteIdentifierPart(prevCol.name, dbType)}` : 'FIRST';
    const colDef = buildMySqlColumnDefinition(curr, dbType);

    if (!orig) {
      alters.push(`ADD COLUMN ${colDef} ${positionSql}`.trim());
      return;
    }

    if (curr.name !== orig.name) {
      alters.push(`CHANGE COLUMN ${quoteIdentifierPart(orig.name, dbType)} ${colDef} ${positionSql}`.trim());
      return;
    }

    if (definitionChanged(curr, orig, dbType === 'mysql')) {
      alters.push(`MODIFY COLUMN ${colDef} ${positionSql}`.trim());
    }
  });

  const origPKKeys = input.originalColumns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const newPKKeys = input.columns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const keysChanged = origPKKeys.length !== newPKKeys.length || !origPKKeys.every((key) => newPKKeys.includes(key));
  if (keysChanged) {
    if (origPKKeys.length > 0) alters.push('DROP PRIMARY KEY');
    if (newPKKeys.length > 0) {
      const pkNames = input.columns
        .filter((col) => col.key === 'PRI')
        .map((col) => quoteIdentifierPart(col.name, dbType))
        .join(', ');
      alters.push(`ADD PRIMARY KEY (${pkNames})`);
    }
  }

  return alters.length === 0 ? '' : `ALTER TABLE ${tableName}\n${alters.join(',\n')};`;
};

const buildDorisAlterPreviewSql = (input: BuildAlterTablePreviewInput, dbType: string): string => {
  const tableName = quoteIdentifierPath(input.tableName, dbType);
  const statements: string[] = [];

  input.originalColumns.forEach((orig) => {
    if (!input.columns.find((col) => col._key === orig._key)) {
      statements.push(`ALTER TABLE ${tableName}\nDROP COLUMN ${quoteIdentifierPart(orig.name, dbType)};`);
    }
  });

  input.columns.forEach((curr) => {
    const orig = input.originalColumns.find((col) => col._key === curr._key);
    if (!orig) {
      statements.push(`ALTER TABLE ${tableName}\nADD COLUMN ${buildDorisColumnDefinition(curr, dbType)};`);
      return;
    }

    let currentName = orig.name;
    if (curr.name !== orig.name) {
      statements.push(`ALTER TABLE ${tableName}\nRENAME COLUMN ${quoteIdentifierPart(orig.name, dbType)} ${quoteIdentifierPart(curr.name, dbType)};`);
      currentName = curr.name;
    }

    if (definitionChanged(curr, orig)) {
      statements.push(`ALTER TABLE ${tableName}\nMODIFY COLUMN ${buildDorisColumnDefinition({ ...curr, name: currentName }, dbType)};`);
    }
  });

  const origPKKeys = input.originalColumns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const newPKKeys = input.columns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const keysChanged = origPKKeys.length !== newPKKeys.length || !origPKKeys.every((key) => newPKKeys.includes(key));
  if (keysChanged) {
    statements.push(translateSchemaSqlComment(input.translate, 'table_designer.schema_sql.doris.primary_key_hint'));
  }

  return statements.join('\n');
};

const buildPgLikeAlterPreviewSql = (input: BuildAlterTablePreviewInput, dbType: string): string => {
  const tableParts = splitQualifiedName(input.tableName);
  const baseTableName = tableParts.objectName || stripIdentifierQuotes(input.tableName);
  const tableRef = quoteIdentifierPath(input.tableName, dbType);
  const statements: string[] = [];

  input.originalColumns.forEach((orig) => {
    if (!input.columns.find((col) => col._key === orig._key)) {
      statements.push(`ALTER TABLE ${tableRef}\nDROP COLUMN ${quoteIdentifierPart(orig.name, dbType)};`);
    }
  });

  input.columns.forEach((curr) => {
    const orig = input.originalColumns.find((col) => col._key === curr._key);
    if (!orig) {
      statements.push(`ALTER TABLE ${tableRef}\nADD COLUMN ${buildPgLikeColumnDefinition(curr, dbType)};`);
      if (String(curr.comment || '').trim()) statements.push(buildColumnCommentSql(tableRef, curr.name, curr.comment || '', dbType));
      return;
    }

    let currentName = orig.name;
    if (curr.name !== orig.name) {
      statements.push(`ALTER TABLE ${tableRef}\nRENAME COLUMN ${quoteIdentifierPart(orig.name, dbType)} TO ${quoteIdentifierPart(curr.name, dbType)};`);
      currentName = curr.name;
    }

    if (curr.type !== orig.type) {
      statements.push(`ALTER TABLE ${tableRef}\nALTER COLUMN ${quoteIdentifierPart(currentName, dbType)} TYPE ${curr.type};`);
    }

    const currHasDefault = hasDefaultValue(curr);
    const origHasDefault = hasDefaultValue(orig);
    if (currHasDefault !== origHasDefault || (currHasDefault && normalizeDefaultText(curr.default) !== normalizeDefaultText(orig.default))) {
      if (currHasDefault) {
        statements.push(`ALTER TABLE ${tableRef}\nALTER COLUMN ${quoteIdentifierPart(currentName, dbType)} SET DEFAULT ${formatEnabledDefaultExpression(curr, dbType)};`);
      } else {
        statements.push(`ALTER TABLE ${tableRef}\nALTER COLUMN ${quoteIdentifierPart(currentName, dbType)} DROP DEFAULT;`);
      }
    }

    if (curr.nullable !== orig.nullable) {
      statements.push(`ALTER TABLE ${tableRef}\nALTER COLUMN ${quoteIdentifierPart(currentName, dbType)} ${curr.nullable === 'NO' ? 'SET NOT NULL' : 'DROP NOT NULL'};`);
    }

    if ((curr.comment || '') !== (orig.comment || '')) {
      statements.push(buildColumnCommentSql(tableRef, currentName, curr.comment || '', dbType));
    }
  });

  const origPKKeys = input.originalColumns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const newPKKeys = input.columns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const keysChanged = origPKKeys.length !== newPKKeys.length || !origPKKeys.every((key) => newPKKeys.includes(key));
  if (keysChanged) {
    if (origPKKeys.length > 0) {
      statements.push(`ALTER TABLE ${tableRef}\nDROP CONSTRAINT IF EXISTS ${quoteIdentifierPart(`${baseTableName}_pkey`, dbType)};`);
    }
    if (newPKKeys.length > 0) {
      const pkNames = input.columns
        .filter((col) => col.key === 'PRI')
        .map((col) => quoteIdentifierPart(col.name, dbType))
        .join(', ');
      statements.push(`ALTER TABLE ${tableRef}\nADD PRIMARY KEY (${pkNames});`);
    }
  }

  return statements.join('\n');
};

const buildOracleLikeAlterPreviewSql = (input: BuildAlterTablePreviewInput, dbType: string): string => {
  const tableRef = quoteIdentifierPath(input.tableName, dbType);
  const statements: string[] = [];

  input.originalColumns.forEach((orig) => {
    if (!input.columns.find((col) => col._key === orig._key)) {
      statements.push(`ALTER TABLE ${tableRef}\nDROP COLUMN ${quoteIdentifierPart(orig.name, dbType)};`);
    }
  });

  input.columns.forEach((curr) => {
    const orig = input.originalColumns.find((col) => col._key === curr._key);
    if (!orig) {
      statements.push(`ALTER TABLE ${tableRef}\nADD (${buildStandardColumnDefinition(curr, dbType, { includeIdentity: true })});`);
      if (String(curr.comment || '').trim()) statements.push(buildColumnCommentSql(tableRef, curr.name, curr.comment || '', dbType));
      return;
    }

    let currentName = orig.name;
    if (curr.name !== orig.name) {
      statements.push(`ALTER TABLE ${tableRef}\nRENAME COLUMN ${quoteIdentifierPart(orig.name, dbType)} TO ${quoteIdentifierPart(curr.name, dbType)};`);
      currentName = curr.name;
    }

    if (physicalDefinitionChanged(curr, orig)) {
      statements.push(`ALTER TABLE ${tableRef}\nMODIFY (${buildStandardColumnDefinition({ ...curr, name: currentName }, dbType, { includeIdentity: true })});`);
    }

    if ((curr.comment || '') !== (orig.comment || '')) {
      statements.push(buildColumnCommentSql(tableRef, currentName, curr.comment || '', dbType));
    }
  });

  const origPKKeys = input.originalColumns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const newPKKeys = input.columns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const keysChanged = origPKKeys.length !== newPKKeys.length || !origPKKeys.every((key) => newPKKeys.includes(key));
  if (keysChanged) {
    if (origPKKeys.length > 0) statements.push(`ALTER TABLE ${tableRef}\nDROP PRIMARY KEY;`);
    if (newPKKeys.length > 0) {
      const pkNames = input.columns.filter((col) => col.key === 'PRI').map((col) => quoteIdentifierPart(col.name, dbType)).join(', ');
      statements.push(`ALTER TABLE ${tableRef}\nADD PRIMARY KEY (${pkNames});`);
    }
  }

  return statements.join('\n');
};

const buildSqlServerDefaultDropBatch = (tableName: string, columnName: string): string => {
  const { schemaName, objectName } = splitQualifiedName(tableName);
  const schema = escapeSqlString(schemaName || 'dbo');
  const table = escapeSqlString(objectName || tableName);
  const column = escapeSqlString(columnName);
  const tableRef = quoteIdentifierPath(`${schemaName || 'dbo'}.${objectName || tableName}`, 'sqlserver');
  return `DECLARE @gonavi_df nvarchar(128); SELECT @gonavi_df = dc.name FROM sys.default_constraints dc JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id JOIN sys.tables t ON c.object_id = t.object_id JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE s.name = N'${schema}' AND t.name = N'${table}' AND c.name = N'${column}'; IF @gonavi_df IS NOT NULL EXEC(N'ALTER TABLE ${tableRef} DROP CONSTRAINT ' + QUOTENAME(@gonavi_df));`;
};

const buildSqlServerAlterPreviewSql = (input: BuildAlterTablePreviewInput): string => {
  const dbType = 'sqlserver';
  const tableRef = quoteIdentifierPath(input.tableName, dbType);
  const statements: string[] = [];

  input.originalColumns.forEach((orig) => {
    if (!input.columns.find((col) => col._key === orig._key)) {
      statements.push(`ALTER TABLE ${tableRef}\nDROP COLUMN ${quoteIdentifierPart(orig.name, dbType)};`);
    }
  });

  input.columns.forEach((curr) => {
    const orig = input.originalColumns.find((col) => col._key === curr._key);
    if (!orig) {
      statements.push(`ALTER TABLE ${tableRef}\nADD ${buildStandardColumnDefinition(curr, dbType, { includeNull: true, includeIdentity: true })};`);
      if (String(curr.comment || '').trim()) statements.push(buildSqlServerColumnCommentSql(input.tableName, curr.name, curr.comment || ''));
      return;
    }

    let currentName = orig.name;
    if (curr.name !== orig.name) {
      const plainTablePath = unquoteSqlIdentifierPath(input.tableName);
      statements.push(`EXEC sp_rename '${escapeSqlString(`${plainTablePath}.${orig.name}`)}', '${escapeSqlString(curr.name)}', 'COLUMN';`);
      currentName = curr.name;
    }

    if (curr.type !== orig.type || curr.nullable !== orig.nullable || Boolean(curr.isAutoIncrement) !== Boolean(orig.isAutoIncrement)) {
      statements.push(`ALTER TABLE ${tableRef}\nALTER COLUMN ${buildStandardColumnDefinition({ ...curr, name: currentName, default: undefined, hasDefault: false }, dbType, { includeNull: true, includeIdentity: false })};`);
    }

    const currHasDefault = hasDefaultValue(curr);
    const origHasDefault = hasDefaultValue(orig);
    if (currHasDefault !== origHasDefault || (currHasDefault && normalizeDefaultText(curr.default) !== normalizeDefaultText(orig.default))) {
      statements.push(buildSqlServerDefaultDropBatch(input.tableName, currentName));
      if (currHasDefault) {
        statements.push(`ALTER TABLE ${tableRef}\nADD DEFAULT ${formatEnabledDefaultExpression(curr, dbType)} FOR ${quoteIdentifierPart(currentName, dbType)};`);
      }
    }

    if ((curr.comment || '') !== (orig.comment || '')) {
      statements.push(buildSqlServerColumnCommentSql(input.tableName, currentName, curr.comment || ''));
    }
  });

  const origPKKeys = input.originalColumns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const newPKKeys = input.columns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const keysChanged = origPKKeys.length !== newPKKeys.length || !origPKKeys.every((key) => newPKKeys.includes(key));
  if (keysChanged) {
    const { objectName } = splitQualifiedName(input.tableName);
    const constraintName = quoteIdentifierPart(`PK_${objectName || 'table'}`, dbType);
    if (origPKKeys.length > 0) {
      statements.push(translateSchemaSqlComment(input.translate, 'table_designer.schema_sql.sqlserver.drop_primary_key_hint'));
    }
    if (newPKKeys.length > 0) {
      const pkNames = input.columns.filter((col) => col.key === 'PRI').map((col) => quoteIdentifierPart(col.name, dbType)).join(', ');
      statements.push(`ALTER TABLE ${tableRef}\nADD CONSTRAINT ${constraintName} PRIMARY KEY (${pkNames});`);
    }
  }

  return statements.join('\n');
};

const buildSqliteAlterPreviewSql = (input: BuildAlterTablePreviewInput): string => {
  const dbType = 'sqlite';
  const tableRef = quoteIdentifierPath(input.tableName, dbType);
  const statements: string[] = [];

  input.originalColumns.forEach((orig) => {
    if (!input.columns.find((col) => col._key === orig._key)) {
      statements.push(`ALTER TABLE ${tableRef}\nDROP COLUMN ${quoteIdentifierPart(orig.name, dbType)};`);
    }
  });

  input.columns.forEach((curr) => {
    const orig = input.originalColumns.find((col) => col._key === curr._key);
    if (!orig) {
      statements.push(`ALTER TABLE ${tableRef}\nADD COLUMN ${buildStandardColumnDefinition(curr, dbType)};`);
      return;
    }

    let currentName = orig.name;
    if (curr.name !== orig.name) {
      statements.push(`ALTER TABLE ${tableRef}\nRENAME COLUMN ${quoteIdentifierPart(orig.name, dbType)} TO ${quoteIdentifierPart(curr.name, dbType)};`);
      currentName = curr.name;
    }
    if (physicalDefinitionChanged(curr, orig) || (curr.comment || '') !== (orig.comment || '')) {
      statements.push(translateSchemaSqlComment(input.translate, 'table_designer.schema_sql.sqlite.modify_column_hint', {
        column: currentName,
      }));
    }
  });

  return statements.join('\n');
};

const buildDuckDbAlterPreviewSql = (input: BuildAlterTablePreviewInput): string => {
  const dbType = 'duckdb';
  const tableRef = quoteIdentifierPath(input.tableName, dbType);
  const statements: string[] = [];

  input.originalColumns.forEach((orig) => {
    if (!input.columns.find((col) => col._key === orig._key)) {
      statements.push(`ALTER TABLE ${tableRef}\nDROP COLUMN ${quoteIdentifierPart(orig.name, dbType)};`);
    }
  });

  input.columns.forEach((curr) => {
    const orig = input.originalColumns.find((col) => col._key === curr._key);
    if (!orig) {
      statements.push(`ALTER TABLE ${tableRef}\nADD COLUMN ${buildStandardColumnDefinition(curr, dbType)};`);
      return;
    }

    let currentName = orig.name;
    if (curr.name !== orig.name) {
      statements.push(`ALTER TABLE ${tableRef}\nRENAME COLUMN ${quoteIdentifierPart(orig.name, dbType)} TO ${quoteIdentifierPart(curr.name, dbType)};`);
      currentName = curr.name;
    }
    if (curr.type !== orig.type) {
      statements.push(`ALTER TABLE ${tableRef}\nALTER COLUMN ${quoteIdentifierPart(currentName, dbType)} SET DATA TYPE ${curr.type};`);
    }
    const currHasDefault = hasDefaultValue(curr);
    const origHasDefault = hasDefaultValue(orig);
    if (currHasDefault !== origHasDefault || (currHasDefault && normalizeDefaultText(curr.default) !== normalizeDefaultText(orig.default))) {
      if (currHasDefault) {
        statements.push(`ALTER TABLE ${tableRef}\nALTER COLUMN ${quoteIdentifierPart(currentName, dbType)} SET DEFAULT ${formatEnabledDefaultExpression(curr, dbType)};`);
      } else {
        statements.push(`ALTER TABLE ${tableRef}\nALTER COLUMN ${quoteIdentifierPart(currentName, dbType)} DROP DEFAULT;`);
      }
    }
    if (curr.nullable !== orig.nullable) {
      statements.push(`ALTER TABLE ${tableRef}\nALTER COLUMN ${quoteIdentifierPart(currentName, dbType)} ${curr.nullable === 'NO' ? 'SET NOT NULL' : 'DROP NOT NULL'};`);
    }
    if ((curr.comment || '') !== (orig.comment || '')) {
      statements.push(translateSchemaSqlComment(input.translate, 'table_designer.schema_sql.duckdb.comment_hint', {
        column: currentName,
      }));
    }
  });

  const origPKKeys = collectPrimaryKeyColumnKeys(input.originalColumns);
  const newPKKeys = collectPrimaryKeyColumnKeys(input.columns);
  const keysChanged = origPKKeys.length !== newPKKeys.length || !origPKKeys.every((key) => newPKKeys.includes(key));
  if (keysChanged) {
    if (origPKKeys.length === 0 && newPKKeys.length > 0) {
      const pkNames = input.columns
        .filter((col) => col.key === 'PRI')
        .map((col) => quoteIdentifierPart(col.name, dbType))
        .join(', ');
      statements.push(`ALTER TABLE ${tableRef}\nADD PRIMARY KEY (${pkNames});`);
    } else {
      statements.push(translateSchemaSqlComment(input.translate, 'table_designer.schema_sql.duckdb.primary_key_hint'));
    }
  }

  return statements.join('\n');
};

const buildLimitedBacktickAlterPreviewSql = (input: BuildAlterTablePreviewInput, dbType: string, label: string): string => {
  const tableRef = quoteIdentifierPath(input.tableName, dbType);
  const statements: string[] = [];

  input.originalColumns.forEach((orig) => {
    if (!input.columns.find((col) => col._key === orig._key)) {
      statements.push(`ALTER TABLE ${tableRef}\nDROP COLUMN ${quoteIdentifierPart(orig.name, dbType)};`);
    }
  });

  input.columns.forEach((curr) => {
    const orig = input.originalColumns.find((col) => col._key === curr._key);
    if (!orig) {
      statements.push(`ALTER TABLE ${tableRef}\nADD COLUMN ${quoteIdentifierPart(curr.name, dbType)} ${curr.type};`);
      if (curr.nullable === 'NO' || hasDefaultValue(curr) || String(curr.comment || '').trim()) {
        statements.push(translateSchemaSqlComment(input.translate, 'table_designer.schema_sql.limited_column_hint', {
          dialect: label,
        }));
      }
      return;
    }

    let currentName = orig.name;
    if (curr.name !== orig.name) {
      statements.push(`ALTER TABLE ${tableRef}\nRENAME COLUMN ${quoteIdentifierPart(orig.name, dbType)} TO ${quoteIdentifierPart(curr.name, dbType)};`);
      currentName = curr.name;
    }
    if (curr.type !== orig.type) {
      statements.push(`ALTER TABLE ${tableRef}\nMODIFY COLUMN ${quoteIdentifierPart(currentName, dbType)} ${curr.type};`);
    }
    if (
      curr.nullable !== orig.nullable ||
      defaultDefinitionChanged(curr, orig) ||
      (curr.comment || '') !== (orig.comment || '') ||
      Boolean(curr.isAutoIncrement) !== Boolean(orig.isAutoIncrement)
    ) {
      statements.push(translateSchemaSqlComment(input.translate, 'table_designer.schema_sql.limited_column_hint', {
        dialect: label,
      }));
    }
  });

  return statements.join('\n');
};

export const buildAlterTablePreviewSql = (input: BuildAlterTablePreviewInput): string => {
  const dbType = resolveSqlDialect(input.dbType);
  if (isPgLikeDialect(dbType)) return buildPgLikeAlterPreviewSql({ ...input, dbType }, dbType);
  if (isOracleLikeDialect(dbType)) return buildOracleLikeAlterPreviewSql({ ...input, dbType }, dbType);
  if (isSqlServerDialect(dbType)) return buildSqlServerAlterPreviewSql({ ...input, dbType });
  if (dbType === 'sqlite') return buildSqliteAlterPreviewSql({ ...input, dbType });
  if (dbType === 'duckdb') return buildDuckDbAlterPreviewSql({ ...input, dbType });
  if (dbType === 'diros') return buildDorisAlterPreviewSql({ ...input, dbType }, dbType);
  if (dbType === 'starrocks') return buildLimitedBacktickAlterPreviewSql({ ...input, dbType }, dbType, 'StarRocks');
  if (dbType === 'clickhouse') return buildLimitedBacktickAlterPreviewSql({ ...input, dbType }, dbType, 'ClickHouse');
  if (dbType === 'tdengine') return buildLimitedBacktickAlterPreviewSql({ ...input, dbType }, dbType, 'TDengine');
  if (isMysqlFamilyDialect(dbType)) return buildMySqlAlterPreviewSql({ ...input, dbType }, dbType);
  return buildPgLikeAlterPreviewSql({ ...input, dbType }, dbType);
};

export const hasAlterTableDraftChanges = (input: BuildAlterTablePreviewInput): boolean =>
  buildAlterTablePreviewSql(input).trim().length > 0;

const buildCreateTableColumnDefinition = (column: EditableColumnSnapshot, dbType: string): string => {
  if (isMysqlFamilyDialect(dbType)) {
    return buildMySqlColumnDefinition(column, dbType);
  }
  if (isOracleLikeDialect(dbType)) {
    return buildStandardColumnDefinition(column, dbType, { includeIdentity: true });
  }
  if (isSqlServerDialect(dbType)) {
    return buildStandardColumnDefinition(column, dbType, { includeNull: true, includeIdentity: true });
  }
  if (dbType === 'clickhouse' || dbType === 'tdengine') {
    return [quoteIdentifierPart(column.name, dbType), String(column.type || '').trim()].join(' ');
  }
  return buildStandardColumnDefinition(column, dbType);
};

const buildCreateColumnComments = (tableRef: string, input: BuildCreateTablePreviewInput, dbType: string): string[] => (
  input.columns
    .filter((column) => String(column.comment || '').trim())
    .map((column) => {
      if (isSqlServerDialect(dbType)) {
        return buildSqlServerColumnCommentSql(input.tableName, column.name, column.comment || '');
      }
      if (isPgLikeDialect(dbType) || isOracleLikeDialect(dbType)) {
        return buildColumnCommentSql(tableRef, column.name, column.comment || '', dbType);
      }
      return '';
    })
    .filter(Boolean)
);

const normalizeStarRocksKeyModel = (value: unknown): StarRocksKeyModel => {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'PRIMARY' || normalized === 'UNIQUE' || normalized === 'AGGREGATE') return normalized;
  return 'DUPLICATE';
};

const normalizeStarRocksDistributionType = (value: unknown): StarRocksDistributionType => {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'RANDOM' || normalized === 'NONE') return normalized;
  return 'HASH';
};

const pickStarRocksKeyColumns = (
  input: BuildCreateTablePreviewInput,
  options: StarRocksCreateTableOptions,
): string[] => {
  const requested = Array.isArray(options.keyColumnNames) ? options.keyColumnNames : [];
  const fallback = input.columns.filter((column) => column.key === 'PRI').map((column) => column.name);
  const source = requested.length > 0 ? requested : (fallback.length > 0 ? fallback : input.columns.slice(0, 1).map((column) => column.name));
  return source.map((columnName) => String(columnName || '').trim()).filter(Boolean);
};

const quoteStarRocksColumnList = (columnNames: string[]): string => (
  columnNames.map((columnName) => quoteIdentifierPart(columnName, 'starrocks')).filter(Boolean).join(', ')
);

const normalizeStarRocksPropertiesBlock = (raw: unknown): string => {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/,+$/, ''))
    .filter(Boolean);
  if (lines.length === 0) return '';
  return `PROPERTIES (\n  ${lines.join(',\n  ')}\n)`;
};

const buildStarRocksDistributionSql = (
  input: BuildCreateTablePreviewInput,
  options: StarRocksCreateTableOptions,
  keyColumns: string[],
): string => {
  const distributionType = normalizeStarRocksDistributionType(options.distributionType);
  if (distributionType === 'NONE') return '';
  if (distributionType === 'RANDOM') {
    return options.bucketMode === 'NUMBER' && Number(options.bucketCount) > 0
      ? `DISTRIBUTED BY RANDOM BUCKETS ${Number(options.bucketCount)}`
      : 'DISTRIBUTED BY RANDOM BUCKETS AUTO';
  }

  const requested = Array.isArray(options.distributionColumnNames) ? options.distributionColumnNames : [];
  const distributionColumns = requested.length > 0 ? requested : keyColumns;
  const columnList = quoteStarRocksColumnList(
    distributionColumns.length > 0 ? distributionColumns : input.columns.slice(0, 1).map((column) => column.name)
  );
  if (!columnList) return '';

  const bucketSql = options.bucketMode === 'NUMBER' && Number(options.bucketCount) > 0
    ? `BUCKETS ${Number(options.bucketCount)}`
    : 'BUCKETS AUTO';
  return `DISTRIBUTED BY HASH(${columnList}) ${bucketSql}`;
};

const buildStarRocksRollupSql = (tableRef: string, rollups: StarRocksRollupOption[] | undefined): string[] => (
  (Array.isArray(rollups) ? rollups : [])
    .map((rollup) => {
      const rollupName = String(rollup?.name || '').trim();
      const columnList = quoteStarRocksColumnList(Array.isArray(rollup?.columnNames) ? rollup.columnNames : []);
      if (!rollupName || !columnList) return '';
      const fromSql = String(rollup.fromIndexName || '').trim()
        ? ` FROM ${quoteIdentifierPart(String(rollup.fromIndexName || '').trim(), 'starrocks')}`
        : '';
      const propertiesSql = normalizeStarRocksPropertiesBlock(rollup.properties);
      const suffix = propertiesSql ? `\n${propertiesSql}` : '';
      return `ALTER TABLE ${tableRef}\nADD ROLLUP ${quoteIdentifierPart(rollupName, 'starrocks')} (${columnList})${fromSql}${suffix};`;
    })
    .filter(Boolean)
);

const buildStarRocksCreateTablePreviewSql = (input: BuildCreateTablePreviewInput): string => {
  const options = input.starRocksOptions || {};
  const tableRef = quoteIdentifierPath(input.tableName, 'starrocks');
  const colDefs = input.columns.map((column) => buildStarRocksColumnDefinition(column));
  const createPrefix = options.tableKind === 'external' ? 'CREATE EXTERNAL TABLE' : 'CREATE TABLE';
  const createSql = `${createPrefix} ${tableRef} (\n  ${colDefs.join(',\n  ')}\n)`;

  if (options.tableKind === 'external') {
    const engine = String(options.externalEngine || 'hive').trim().toUpperCase();
    const propertiesSql = normalizeStarRocksPropertiesBlock(options.externalProperties || options.properties);
    return `${createSql}\nENGINE=${engine}${propertiesSql ? `\n${propertiesSql}` : ''};`;
  }

  const keyModel = normalizeStarRocksKeyModel(options.keyModel);
  const keyColumns = pickStarRocksKeyColumns(input, options);
  const keyColumnSql = quoteStarRocksColumnList(keyColumns);
  const keySql = keyColumnSql ? `${keyModel} KEY (${keyColumnSql})` : '';
  const partitionSql = String(options.partitionClause || '').trim().replace(/;+\s*$/, '');
  const distributionSql = buildStarRocksDistributionSql(input, options, keyColumns);
  const propertiesSql = normalizeStarRocksPropertiesBlock(options.properties);

  const clauses = [
    'ENGINE=OLAP',
    keySql,
    partitionSql,
    distributionSql,
    propertiesSql,
  ].filter(Boolean);
  const createStatement = `${createSql}\n${clauses.join('\n')};`;
  const rollupStatements = buildStarRocksRollupSql(tableRef, options.rollups);
  return [createStatement, ...rollupStatements].join('\n');
};

const buildTDengineCreateTablePreviewSql = (input: BuildCreateTablePreviewInput): string => {
  const options = input.tdengineOptions || {};
  const tableKind = options.tableKind || 'normal';
  const tableRef = quoteIdentifierPath(input.tableName, 'tdengine');

  if (tableKind === 'child') {
    const stableRef = quoteIdentifierPath(String(options.stableName || '').trim(), 'tdengine');
    const tagValues = String(options.tagValues || '').trim().replace(/;+\s*$/, '');
    return `CREATE TABLE ${tableRef}\nUSING ${stableRef}\nTAGS (${tagValues});`;
  }

  const colDefs = input.columns.map((column) => buildCreateTableColumnDefinition(column, 'tdengine'));
  const createPrefix = tableKind === 'stable' ? 'CREATE STABLE' : 'CREATE TABLE';
  let createSql = `${createPrefix} ${tableRef} (\n  ${colDefs.join(',\n  ')}\n)`;

  if (tableKind === 'stable') {
    const tagDefs = (Array.isArray(options.tagDefinitions) ? options.tagDefinitions : [])
      .map((tag) => ({
        name: String(tag?.name || '').trim(),
        type: String(tag?.type || '').trim(),
      }))
      .filter((tag) => tag.name && tag.type)
      .map((tag) => `${quoteIdentifierPart(tag.name, 'tdengine')} ${tag.type}`);
    createSql += `\nTAGS (\n  ${tagDefs.join(',\n  ')}\n)`;
  }

  const timestampHint = input.columns.some((column) => /^timestamp$/i.test(String(column.type || '').trim()))
    ? ''
    : `\n${translateSchemaSqlComment(input.translate, 'table_designer.schema_sql.tdengine.timestamp_hint')}`;
  return `${createSql};${timestampHint}`;
};

export const buildStarRocksMaterializedViewPreviewSql = (
  input: BuildStarRocksMaterializedViewPreviewInput,
): string => {
  const name = quoteIdentifierPath(input.name || 'mv_name', 'starrocks');
  const query = String(input.query || '').trim().replace(/;+\s*$/, '') || 'SELECT column1, COUNT(*) AS cnt\nFROM table_name\nGROUP BY column1';
  const commentSql = String(input.comment || '').trim() ? `\nCOMMENT '${escapeSqlString(String(input.comment || '').trim())}'` : '';
  const refreshSql = String(input.refreshClause || '').trim()
    || (input.async === false ? 'REFRESH MANUAL' : 'REFRESH ASYNC');
  const partitionSql = String(input.partitionClause || '').trim().replace(/;+\s*$/, '');
  const distributionColumns = quoteStarRocksColumnList(Array.isArray(input.distributionColumnNames) ? input.distributionColumnNames : []);
  const distributionSql = distributionColumns
    ? `DISTRIBUTED BY HASH(${distributionColumns}) BUCKETS ${Number(input.bucketCount) > 0 ? Number(input.bucketCount) : 'AUTO'}`
    : '';
  const orderByColumns = quoteStarRocksColumnList(Array.isArray(input.orderByColumnNames) ? input.orderByColumnNames : []);
  const orderBySql = orderByColumns ? `ORDER BY (${orderByColumns})` : '';
  const propertiesSql = normalizeStarRocksPropertiesBlock(input.properties);
  return [
    `CREATE MATERIALIZED VIEW ${name}${commentSql}`,
    refreshSql,
    partitionSql,
    distributionSql,
    orderBySql,
    propertiesSql,
    'AS',
    `${query};`,
  ].filter(Boolean).join('\n');
};

export const buildCreateTablePreviewSql = (input: BuildCreateTablePreviewInput): string => {
  const dbType = resolveSqlDialect(input.dbType);
  if (dbType === 'starrocks') {
    return buildStarRocksCreateTablePreviewSql({ ...input, dbType });
  }
  if (dbType === 'tdengine') {
    return buildTDengineCreateTablePreviewSql({ ...input, dbType });
  }

  const tableRef = quoteIdentifierPath(input.tableName, dbType);
  const colDefs = input.columns.map((column) => buildCreateTableColumnDefinition(column, dbType));
  const pkColumns = input.columns.filter((column) => column.key === 'PRI');
  if (pkColumns.length > 0) {
    const pkNames = pkColumns.map((column) => quoteIdentifierPart(column.name, dbType)).join(', ');
    colDefs.push(`PRIMARY KEY (${pkNames})`);
  }

  const createSql = `CREATE TABLE ${tableRef} (\n  ${colDefs.join(',\n  ')}\n)`;
  const comments = buildCreateColumnComments(tableRef, input, dbType);

  if (dbType === 'mysql' || dbType === 'mariadb') {
    const charset = String(input.charset || '').trim();
    const collation = String(input.collation || '').trim();
    const charsetSql = charset ? ` DEFAULT CHARSET=${charset}` : '';
    const collationSql = collation ? ` COLLATE=${collation}` : '';
    return `${createSql} ENGINE=InnoDB${charsetSql}${collationSql};`;
  }

  if (dbType === 'clickhouse') {
    return `${createSql}\nENGINE = MergeTree\nORDER BY tuple();`;
  }

  const suffixComments = comments.length > 0 ? `\n${comments.join('\n')}` : '';
  if (isBacktickIdentifierDialect(dbType) && dbType !== 'mysql' && dbType !== 'mariadb') {
    return `${createSql};${suffixComments}`;
  }

  return `${createSql};${suffixComments}`;
};
