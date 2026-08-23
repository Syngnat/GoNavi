import type { SavedConnection } from '../../types';
import type { I18nParams } from '../../i18n';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { resolveAITableSchemaToolResult } from '../../utils/aiTableSchemaTool';
import type { AILocalToolRuntime } from './aiLocalToolRuntime';
import { translateInspectionCopy } from './aiInspectionI18n';
import {
  buildPreviewSQLForTable,
  normalizeColumns,
  normalizeColumnsWithTable,
  normalizePerTableColumnLimit,
  normalizePreviewLimit,
  normalizeTableLimit,
  normalizeTableList,
} from './aiDatabaseToolHelpers';

interface DatabaseToolExecutionResult {
  content: string;
  success: boolean;
}

interface InspectDatabaseBundleOptions {
  args: Record<string, any>;
  connection: SavedConnection;
  runtime: AILocalToolRuntime;
  translate?: (key: string, params?: I18nParams) => string;
}

const DATABASE_BUNDLE_KEY_PREFIX = 'ai_chat.inspection.database_bundle';

const translateDatabaseBundleCopy = (
  translate: InspectDatabaseBundleOptions['translate'],
  key: string,
  fallback: string,
  params?: I18nParams,
) => translateInspectionCopy(
  translate,
  `${DATABASE_BUNDLE_KEY_PREFIX}.${key}`,
  fallback,
  params,
);

const unknownError = (translate: InspectDatabaseBundleOptions['translate']) =>
  translateDatabaseBundleCopy(
    translate,
    'error.unknown',
    'Unknown error',
  );

const fulfilledDetail = (
  result: PromiseSettledResult<any>,
  valueSelector: (value: any) => unknown,
  translate: InspectDatabaseBundleOptions['translate'],
) => result.status === 'fulfilled'
  ? String(valueSelector(result.value) || unknownError(translate))
  : String(result.reason);

const databaseBundleWarning = (
  translate: InspectDatabaseBundleOptions['translate'],
  key: string,
  fallbackLabel: string,
  detail: string,
) => translateDatabaseBundleCopy(
  translate,
  `warning.${key}`,
  `${fallbackLabel}: ${detail}`,
  { detail },
);

export const inspectTableBundle = async ({
  args,
  connection,
  runtime,
  translate,
}: InspectDatabaseBundleOptions): Promise<DatabaseToolExecutionResult> => {
  try {
    const safeDbName = args.dbName ? String(args.dbName).trim() : '';
    const safeTable = args.tableName ? String(args.tableName).trim() : '';
    if (!safeTable) {
      return {
        content: translateDatabaseBundleCopy(
          translate,
          'error.table_name_required',
          'tableName is required',
        ),
        success: false,
      };
    }
    const includeSampleRows = args.includeSampleRows === true;
    const sampleLimit = normalizePreviewLimit(args.sampleLimit ?? 10);
    const rpcConfig = buildRpcConnectionConfig(connection.config) as any;
    const results = await Promise.allSettled([
      runtime.getColumns(rpcConfig, safeDbName, safeTable),
      runtime.getIndexes(rpcConfig, safeDbName, safeTable),
      runtime.getForeignKeys(rpcConfig, safeDbName, safeTable),
      runtime.getTriggers(rpcConfig, safeDbName, safeTable),
      resolveAITableSchemaToolResult({
        tableName: safeTable,
        fetchDDL: () => runtime.showCreateTable(rpcConfig, safeDbName, safeTable),
        fetchColumns: () => runtime.getColumns(rpcConfig, safeDbName, safeTable),
      }),
      includeSampleRows
        ? runtime.query(rpcConfig, safeDbName, buildPreviewSQLForTable(connection, safeTable, sampleLimit))
        : Promise.resolve(undefined),
    ]);
    const warnings: string[] = [];
    const payload: Record<string, unknown> = {
      dbName: safeDbName,
      tableName: safeTable,
      columns: [],
      indexes: [],
      foreignKeys: [],
      triggers: [],
      ddl: '',
    };
    const columnsResult = results[0];
    const indexesResult = results[1];
    const foreignKeysResult = results[2];
    const triggersResult = results[3];
    const ddlResult = results[4];
    const sampleRowsResult = results[5];
    if (columnsResult.status === 'fulfilled' && columnsResult.value?.success && Array.isArray(columnsResult.value.data)) {
      payload.columns = normalizeColumns(columnsResult.value.data);
    } else {
      warnings.push(databaseBundleWarning(
        translate,
        'columns_failed',
        'Failed to fetch column list',
        fulfilledDetail(columnsResult, (value) => value?.message, translate),
      ));
    }
    if (indexesResult.status === 'fulfilled' && indexesResult.value?.success && Array.isArray(indexesResult.value.data)) {
      payload.indexes = indexesResult.value.data;
    } else {
      warnings.push(databaseBundleWarning(
        translate,
        'indexes_failed',
        'Failed to fetch index definitions',
        fulfilledDetail(indexesResult, (value) => value?.message, translate),
      ));
    }
    if (foreignKeysResult.status === 'fulfilled' && foreignKeysResult.value?.success && Array.isArray(foreignKeysResult.value.data)) {
      payload.foreignKeys = foreignKeysResult.value.data;
    } else {
      warnings.push(databaseBundleWarning(
        translate,
        'foreign_keys_failed',
        'Failed to fetch foreign key relationships',
        fulfilledDetail(foreignKeysResult, (value) => value?.message, translate),
      ));
    }
    if (triggersResult.status === 'fulfilled' && triggersResult.value?.success && Array.isArray(triggersResult.value.data)) {
      payload.triggers = triggersResult.value.data;
    } else {
      warnings.push(databaseBundleWarning(
        translate,
        'triggers_failed',
        'Failed to fetch triggers',
        fulfilledDetail(triggersResult, (value) => value?.message, translate),
      ));
    }
    if (ddlResult.status === 'fulfilled' && ddlResult.value?.success) {
      payload.ddl = ddlResult.value.content;
    } else {
      warnings.push(databaseBundleWarning(
        translate,
        'ddl_failed',
        'Failed to fetch DDL',
        fulfilledDetail(ddlResult, (value) => value?.content, translate),
      ));
    }
    if (includeSampleRows) {
      if (sampleRowsResult.status === 'fulfilled' && sampleRowsResult.value?.success) {
        const rows = Array.isArray(sampleRowsResult.value.data) ? sampleRowsResult.value.data : [];
        payload.sampleRows = {
          limit: sampleLimit,
          rowCount: rows.length,
          rows: rows.slice(0, sampleLimit),
        };
      } else {
        warnings.push(databaseBundleWarning(
          translate,
          'sample_rows_failed',
          'Failed to fetch sample rows',
          fulfilledDetail(sampleRowsResult, (value) => value?.message, translate),
        ));
      }
    }
    if (warnings.length > 0) {
      payload.warnings = warnings;
    }
    return { content: JSON.stringify(payload), success: true };
  } catch (error: any) {
    const detail = String(error?.message || error);
    return {
      content: translateDatabaseBundleCopy(
        translate,
        'error.table_snapshot_failed',
        `Failed to build table structure snapshot: ${detail}`,
        { detail },
      ),
      success: false,
    };
  }
};

export const inspectDatabaseBundle = async ({
  args,
  connection,
  runtime,
  translate,
}: InspectDatabaseBundleOptions): Promise<DatabaseToolExecutionResult> => {
  try {
    const safeDbName = args.dbName ? String(args.dbName).trim() : '';
    if (!safeDbName) {
      return {
        content: translateDatabaseBundleCopy(
          translate,
          'error.db_name_required',
          'dbName is required',
        ),
        success: false,
      };
    }
    const includeColumns = args.includeColumns !== false;
    const tableLimit = normalizeTableLimit(args.tableLimit);
    const perTableColumnLimit = normalizePerTableColumnLimit(args.perTableColumnLimit);
    const rpcConfig = buildRpcConnectionConfig(connection.config) as any;
    const results = await Promise.allSettled([
      runtime.getTables(rpcConfig, safeDbName),
      includeColumns ? runtime.getAllColumns(rpcConfig, safeDbName) : Promise.resolve(undefined),
    ]);
    const warnings: string[] = [];
    const tablesResult = results[0];
    const allColumnsResult = results[1];
    const allColumns = allColumnsResult.status === 'fulfilled' && allColumnsResult.value?.success && Array.isArray(allColumnsResult.value.data)
      ? normalizeColumnsWithTable(allColumnsResult.value.data)
      : [];
    const allColumnsMetadataWarnings = allColumnsResult.status === 'fulfilled' && allColumnsResult.value?.success
      ? (Array.isArray(allColumnsResult.value.warnings)
        ? allColumnsResult.value.warnings.map((warning: unknown) => String(warning || '').trim()).filter(Boolean)
        : [])
      : [];
    const tableNamesFromColumns = Array.from(new Set(allColumns.map((column) => column.tableName).filter(Boolean)));
    let tableNames: string[] = [];
    if (tablesResult.status === 'fulfilled' && tablesResult.value?.success && Array.isArray(tablesResult.value.data)) {
      tableNames = normalizeTableList(tablesResult.value.data).filter(Boolean);
    } else if (tableNamesFromColumns.length > 0) {
      tableNames = tableNamesFromColumns;
      warnings.push(databaseBundleWarning(
        translate,
        'tables_failed_with_column_fallback',
        'Failed to fetch table list, fell back to column summary inference',
        fulfilledDetail(tablesResult, (value) => value?.message, translate),
      ));
    } else {
      warnings.push(databaseBundleWarning(
        translate,
        'tables_failed',
        'Failed to fetch table list',
        fulfilledDetail(tablesResult, (value) => value?.message, translate),
      ));
    }
    if (includeColumns && allColumnsResult.status === 'fulfilled' && (!allColumnsResult.value?.success || !Array.isArray(allColumnsResult.value.data))) {
      warnings.push(databaseBundleWarning(
        translate,
        'all_columns_failed',
        'Failed to fetch column summary',
        String(allColumnsResult.value?.message || unknownError(translate)),
      ));
    } else if (includeColumns && allColumnsResult.status === 'rejected') {
      warnings.push(databaseBundleWarning(
        translate,
        'all_columns_failed',
        'Failed to fetch column summary',
        String(allColumnsResult.reason),
      ));
    }
    if (includeColumns && allColumnsResult.status === 'fulfilled' && allColumnsResult.value?.success && allColumnsResult.value?.partial) {
      warnings.push(...allColumnsMetadataWarnings);
    }
    const uniqueTableNames = Array.from(new Set(tableNames.filter(Boolean)));
    const visibleTableNames = uniqueTableNames.slice(0, tableLimit);
    const columnsByTable = new Map<string, ReturnType<typeof normalizeColumnsWithTable>>();
    allColumns.forEach((column) => {
      const tableName = String(column.tableName || '').trim();
      if (!tableName) return;
      const current = columnsByTable.get(tableName) || [];
      current.push(column);
      columnsByTable.set(tableName, current);
    });
    const payload: Record<string, unknown> = {
      dbName: safeDbName,
      columnSummaryPartial: Boolean(allColumnsResult.status === 'fulfilled' && allColumnsResult.value?.partial),
      tableCount: uniqueTableNames.length,
      totalColumns: allColumns.length,
      tables: visibleTableNames,
      truncatedTables: uniqueTableNames.length > visibleTableNames.length,
    };
    if (includeColumns) {
      payload.tableSummaries = visibleTableNames.map((tableName) => {
        const tableColumns = columnsByTable.get(tableName) || [];
        return {
          tableName,
          columnCount: tableColumns.length,
          truncatedColumns: tableColumns.length > perTableColumnLimit,
          columns: tableColumns.slice(0, perTableColumnLimit),
        };
      });
    }
    if (warnings.length > 0) {
      payload.warnings = warnings;
    }
    return { content: JSON.stringify(payload), success: true };
  } catch (error: any) {
    const detail = String(error?.message || error);
    return {
      content: translateDatabaseBundleCopy(
        translate,
        'error.database_overview_failed',
        `Failed to build database structure overview: ${detail}`,
        { detail },
      ),
      success: false,
    };
  }
};
