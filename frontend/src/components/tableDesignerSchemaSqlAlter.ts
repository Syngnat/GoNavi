import {
  unquoteSqlIdentifierPath,
  resolveSqlDialect,
  isPgLikeDialect,
  isOracleLikeDialect,
  isSqlServerDialect,
  isMysqlFamilyDialect,
} from '../utils/sqlDialect';
import {
  type BuildAlterTablePreviewInput,
  quoteIdentifierPath,
  quoteIdentifierPart,
  collectPositionChangedColumnKeys,
  buildMySqlColumnDefinition,
  definitionChanged,
  buildDorisColumnDefinition,
  translateSchemaSqlComment,
  splitQualifiedName,
  stripIdentifierQuotes,
  buildPgLikeColumnDefinition,
  buildColumnCommentSql,
  hasDefaultValue,
  normalizeDefaultText,
  formatEnabledDefaultExpression,
  buildStandardColumnDefinition,
  physicalDefinitionChanged,
  escapeSqlString,
  buildSqlServerColumnCommentSql,
  collectPrimaryKeyColumnKeys,
  defaultDefinitionChanged,
} from './tableDesignerSchemaSqlColumns';
import { buildInformixAlterPreviewSql } from './tableDesignerSchemaSqlInformix';
import { buildFirebirdAlterPreviewSql } from './tableDesignerSchemaSqlFirebird';
import { getDataSourceDialectFamily } from '../utils/dataSourceRegistry';

const buildMySqlAlterPreviewSql = (input: BuildAlterTablePreviewInput, dbType: string): string => {
  const tableName = quoteIdentifierPath(input.tableName, dbType);
  const alters: string[] = [];

  input.originalColumns.forEach((orig) => {
    if (!input.columns.find((col) => col._key === orig._key)) {
      alters.push(`DROP COLUMN ${quoteIdentifierPart(orig.name, dbType)}`);
    }
  });

  const positionChangedKeys = collectPositionChangedColumnKeys(input);

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

    if (definitionChanged(curr, orig, dbType === 'mysql') || positionChangedKeys.has(curr._key)) {
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
  if (getDataSourceDialectFamily(dbType) === 'informix') return buildInformixAlterPreviewSql({ ...input, dbType }, dbType);
  if (getDataSourceDialectFamily(dbType) === 'firebird') return buildFirebirdAlterPreviewSql({ ...input, dbType }, dbType);
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
