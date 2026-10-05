import {
  isMysqlFamilyDialect,
  isOracleLikeDialect,
  isSqlServerDialect,
  isPgLikeDialect,
  resolveSqlDialect,
  isBacktickIdentifierDialect,
} from '../utils/sqlDialect';
import {
  type EditableColumnSnapshot,
  buildMySqlColumnDefinition,
  buildStandardColumnDefinition,
  quoteIdentifierPart,
  type BuildCreateTablePreviewInput,
  buildSqlServerColumnCommentSql,
  buildColumnCommentSql,
  type StarRocksKeyModel,
  type StarRocksDistributionType,
  type StarRocksCreateTableOptions,
  type StarRocksRollupOption,
  quoteIdentifierPath,
  buildStarRocksColumnDefinition,
  translateSchemaSqlComment,
  type BuildStarRocksMaterializedViewPreviewInput,
  escapeSqlString,
} from './tableDesignerSchemaSqlColumns';

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
