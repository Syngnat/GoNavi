import type {
  DataSyncCompareMode,
  DataSyncCompareResult,
  DataSyncTableDiffSummary,
} from './model';
import { getDataSourceSpec } from '../../utils/dataSourceRegistry';

const PG_LIKE = new Set([
  'postgres',
  'postgresql',
  'kingbase',
  'highgo',
  'opengauss',
  'gaussdb',
  'vastbase',
]);

const normalizeDialect = (value: string): string => {
  const dialect = String(value || '').trim().toLowerCase();
  if (dialect === 'postgresql') return 'postgres';
  if (['mssql', 'sql_server', 'sql-server'].includes(dialect)) return 'sqlserver';
  // 描述表类型按借用方言生成修复 SQL（CockroachDB → postgres 用双引号，TiDB → mysql 用反引号）。
  return getDataSourceSpec(dialect)?.ddlDialect || dialect;
};

export const quoteCompareIdent = (name: string, dialect: string): string => {
  const normalized = normalizeDialect(dialect);
  if (PG_LIKE.has(normalized)) return `"${String(name).replace(/"/g, '""')}"`;
  return `\`${String(name).replace(/`/g, '``')}\``;
};

export const qualifyCompareTable = (
  table: string,
  schema: string,
  dialect: string,
): string => {
  const quoted = quoteCompareIdent(table, dialect);
  const schemaName = String(schema || '').trim();
  return schemaName ? `${quoteCompareIdent(schemaName, dialect)}.${quoted}` : quoted;
};

export const tableHasCompareDiff = (
  summary: DataSyncTableDiffSummary,
  mode?: DataSyncCompareMode,
): boolean => {
  const showData = mode === 'data' || mode === 'both' || !mode;
  const showSchema = mode === 'schema' || mode === 'both' || summary.hasSchema === true;
  const hasSchemaDiff =
    (summary.schemaDiffCount ?? 0) > 0 ||
    (summary.missingColumns || []).length > 0 ||
    (summary.columnDiffs || []).length > 0;
  const hasDataDiff =
    summary.inserts > 0 || summary.updates > 0 || summary.deletes > 0;
  return (showSchema && hasSchemaDiff) || (showData && hasDataDiff);
};

const addColumnSql = (
  tableSql: string,
  column: string,
  type: string,
  dialect: string,
): string => {
  const col = quoteCompareIdent(column, dialect);
  const columnType = type.trim() || 'TEXT';
  if (normalizeDialect(dialect) === 'sqlserver') {
    return `ALTER TABLE ${tableSql} ADD ${col} ${columnType} NULL;`;
  }
  return `ALTER TABLE ${tableSql} ADD COLUMN ${col} ${columnType} NULL;`;
};

const modifyTypeSql = (
  tableSql: string,
  column: string,
  type: string,
  dialect: string,
): string => {
  const col = quoteCompareIdent(column, dialect);
  const columnType = type.trim();
  if (!columnType) return `-- ${tableSql}.${col}: missing source type, skipped`;
  const normalized = normalizeDialect(dialect);
  if (PG_LIKE.has(normalized)) {
    return `ALTER TABLE ${tableSql} ALTER COLUMN ${col} TYPE ${columnType};`;
  }
  if (normalized === 'sqlserver') {
    return `ALTER TABLE ${tableSql} ALTER COLUMN ${col} ${columnType} NULL;`;
  }
  return `ALTER TABLE ${tableSql} MODIFY COLUMN ${col} ${columnType};`;
};

export const buildCompareRepairSQL = (
  result: DataSyncCompareResult,
  options: { dialect: string; schema?: string },
): string => {
  const dialect = options.dialect;
  const schema = options.schema || '';
  const blocks: string[] = [
    '-- 由结构比对结果生成，请在目标库核对后再执行。',
    '-- 删除目标多出的列默认注释掉，避免误删数据。',
  ];
  for (const summary of result.tables) {
    const diffs = summary.columnDiffs || [];
    const missing = (summary.missingColumns || []).filter(
      (column) => !diffs.some((diff) => diff.column === column && diff.kind === 'missing_in_target'),
    );
    if (diffs.length === 0 && missing.length === 0) continue;
    const tableSql = qualifyCompareTable(
      summary.targetObject || summary.table,
      schema,
      dialect,
    );
    const statements: string[] = [`-- ${summary.table}`];
    missing.forEach((column) => {
      statements.push(addColumnSql(tableSql, column, '', dialect));
    });
    diffs.forEach((diff) => {
      if (diff.kind === 'missing_in_target') {
        statements.push(addColumnSql(tableSql, diff.column, diff.source || '', dialect));
        return;
      }
      if (diff.kind === 'extra_in_target') {
        statements.push(
          `-- ALTER TABLE ${tableSql} DROP COLUMN ${quoteCompareIdent(diff.column, dialect)}; -- 目标多出 ${diff.target || ''}`.trim(),
        );
        return;
      }
      if (diff.kind === 'type') {
        statements.push(modifyTypeSql(tableSql, diff.column, diff.source || '', dialect));
        return;
      }
      if (diff.kind === 'nullable') {
        statements.push(
          `-- ${tableSql}.${quoteCompareIdent(diff.column, dialect)} 可空性不同：源 ${diff.source || '—'} / 目标 ${diff.target || '—'}`,
        );
      }
    });
    blocks.push(statements.join('\n'));
  }
  return blocks.length > 2
    ? blocks.join('\n\n')
    : `${blocks.join('\n\n')}\n\n-- 当前比对结果没有可生成的结构修复语句。`;
};

export const buildCompareAiPrompt = (
  result: DataSyncCompareResult,
  options: { dialect: string; sourceName: string; targetName: string },
): string => {
  const tables = result.tables.map((summary) => ({
    table: summary.table,
    sourceObject: summary.sourceObject,
    targetObject: summary.targetObject,
    inserts: summary.inserts,
    updates: summary.updates,
    deletes: summary.deletes,
    same: summary.same,
    schemaDiffCount: summary.schemaDiffCount,
    columnDiffs: summary.columnDiffs,
    message: summary.message,
  }));
  return [
    '请根据下面的数据库比对差异，生成可在目标库执行的修复 SQL，并简要说明每条语句的风险。',
    '只输出 SQL 和简短说明，不要改源库。删除类语句请单独标出风险。',
    `源：${options.sourceName}`,
    `目标：${options.targetName}`,
    `目标库类型：${options.dialect || 'unknown'}`,
    '差异 JSON：',
    JSON.stringify(tables, null, 2),
  ].join('\n');
};
