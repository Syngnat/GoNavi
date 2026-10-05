import { useCallback, useMemo } from 'react';
import { message } from 'antd';
import { buildTabularClipboardPayloadFromTsv } from '../../dataGridClipboardPayload';
import type { DataExportFileOptions } from '../../DataExportDialog';
import { ExportQueryWithOptions } from '../../../../wailsjs/go/app/App';
import type { DataGridExportScope } from '../../DataGridCore';
import type { DataGridV2ColumnActionsApi } from './useDataGridV2ColumnActions';
import type { DataGridV2ActionsContext } from '../../useDataGridV2Actions';
import { getDataSourceSpec } from '../../../utils/dataSourceRegistry';

// 与数据浏览一致：自然顺序的数据源（ui.naturalOrder）未指定排序时不追加主键排序，否则会退化为客户端全量排序。
const resolveExportOrderFallbackColumns = (dbType: string, pkColumns: string[]): string[] =>
  getDataSourceSpec(dbType)?.ui?.naturalOrder ? [] : pkColumns;

export interface UseDataGridV2CopyExportInput {
  supportsCopyInsert: DataGridV2ActionsContext['supportsCopyInsert'];
  translateDataGrid: DataGridV2ActionsContext['translateDataGrid'];
  displayOutputColumnNames: DataGridV2ActionsContext['displayOutputColumnNames'];
  buildCopyInsertSQL: DataGridV2ActionsContext['buildCopyInsertSQL'];
  dbType: DataGridV2ActionsContext['dbType'];
  tableName: DataGridV2ActionsContext['tableName'];
  columnTypeMapByLowerName: DataGridV2ActionsContext['columnTypeMapByLowerName'];
  buildCopyUpdateSQL: DataGridV2ActionsContext['buildCopyUpdateSQL'];
  pkColumns: DataGridV2ActionsContext['pkColumns'];
  uniqueKeyGroups: DataGridV2ActionsContext['uniqueKeyGroups'];
  allTableColumnNames: DataGridV2ActionsContext['allTableColumnNames'];
  buildCopyDeleteSQL: DataGridV2ActionsContext['buildCopyDeleteSQL'];
  getTargets: DataGridV2ColumnActionsApi['getTargets'];
  translateCopySqlError: DataGridV2ColumnActionsApi['translateCopySqlError'];
  copyToClipboard: DataGridV2ActionsContext['copyToClipboard'];
  pickDataGridOutputRows: DataGridV2ActionsContext['pickDataGridOutputRows'];
  getContextMenuTargetRows: DataGridV2ColumnActionsApi['getContextMenuTargetRows'];
  buildClipboardTsv: DataGridV2ActionsContext['buildClipboardTsv'];
  columnMetaMap: DataGridV2ActionsContext['columnMetaMap'];
  columnMetaMapByLowerName: DataGridV2ActionsContext['columnMetaMapByLowerName'];
  currentConnConfig: DataGridV2ActionsContext['currentConnConfig'];
  connectionId: DataGridV2ActionsContext['connectionId'];
  connections: DataGridV2ActionsContext['connections'];
  runExportWithProgress: DataGridV2ActionsContext['runExportWithProgress'];
  buildRpcConnectionConfig: DataGridV2ActionsContext['buildRpcConnectionConfig'];
  dbName: DataGridV2ActionsContext['dbName'];
  buildBackendExportOptions: DataGridV2ActionsContext['buildBackendExportOptions'];
  quoteIdentPart: DataGridV2ActionsContext['quoteIdentPart'];
  escapeLiteral: DataGridV2ActionsContext['escapeLiteral'];
  pagination: DataGridV2ActionsContext['pagination'];
  buildEffectiveFilterConditions: DataGridV2ActionsContext['buildEffectiveFilterConditions'];
  filterConditions: DataGridV2ActionsContext['filterConditions'];
  quickWhereCondition: DataGridV2ActionsContext['quickWhereCondition'];
  buildWhereSQL: DataGridV2ActionsContext['buildWhereSQL'];
  buildDataGridSelectBaseSql: DataGridV2ActionsContext['buildDataGridSelectBaseSql'];
  buildOrderBySQL: DataGridV2ActionsContext['buildOrderBySQL'];
  sortInfo: DataGridV2ActionsContext['sortInfo'];
  hasExplicitSort: DataGridV2ActionsContext['hasExplicitSort'];
  buildPaginatedSelectSQL: DataGridV2ActionsContext['buildPaginatedSelectSQL'];
  withSortBufferTuningSQL: DataGridV2ActionsContext['withSortBufferTuningSQL'];
  isQueryResultExport: DataGridV2ActionsContext['isQueryResultExport'];
  mergedDisplayData: DataGridV2ActionsContext['mergedDisplayData'];
  selectedRowKeys: DataGridV2ActionsContext['selectedRowKeys'];
  rowKeyStr: DataGridV2ActionsContext['rowKeyStr'];
  GONAVI_ROW_KEY: DataGridV2ActionsContext['GONAVI_ROW_KEY'];
  exportData: DataGridV2ActionsContext['exportData'];
  resultExportAllSql: DataGridV2ActionsContext['resultExportAllSql'];
  resultSql: DataGridV2ActionsContext['resultSql'];
  hasChanges: DataGridV2ActionsContext['hasChanges'];
  resolveDataSourceType: DataGridV2ActionsContext['resolveDataSourceType'];
}

export const useDataGridV2CopyExport = ({
  supportsCopyInsert, translateDataGrid, displayOutputColumnNames, buildCopyInsertSQL, dbType,
  tableName, columnTypeMapByLowerName, buildCopyUpdateSQL, pkColumns, uniqueKeyGroups,
  allTableColumnNames, buildCopyDeleteSQL, getTargets, translateCopySqlError, copyToClipboard,
  pickDataGridOutputRows, getContextMenuTargetRows, buildClipboardTsv, columnMetaMap,
  columnMetaMapByLowerName, currentConnConfig, connectionId, connections, runExportWithProgress,
  buildRpcConnectionConfig, dbName, buildBackendExportOptions, quoteIdentPart, escapeLiteral,
  pagination, buildEffectiveFilterConditions, filterConditions, quickWhereCondition, buildWhereSQL,
  buildDataGridSelectBaseSql, buildOrderBySQL, sortInfo, hasExplicitSort, buildPaginatedSelectSQL,
  withSortBufferTuningSQL, isQueryResultExport, mergedDisplayData, selectedRowKeys, rowKeyStr,
  GONAVI_ROW_KEY, exportData, resultExportAllSql, resultSql, hasChanges, resolveDataSourceType,
}: UseDataGridV2CopyExportInput) => {
  const buildCopySqlBatchText = useCallback((mode: 'insert' | 'update' | 'delete', record: any): string | null => {
      if (!supportsCopyInsert) {
          void message.warning(translateDataGrid('data_grid.message.copy_sql_not_supported'));
          return null;
      }
      const records = getTargets(record);
      const orderedCols = displayOutputColumnNames;
      if (mode === 'insert') {
          return records.map((row: any) => buildCopyInsertSQL({
              dbType,
              tableName,
              orderedCols,
              record: row,
              columnTypesByLowerName: columnTypeMapByLowerName,
          })).join('\n\n');
      }

      const sqlResults = records.map((row: any) => (
          mode === 'update'
              ? buildCopyUpdateSQL({
                  dbType,
                  tableName,
                  orderedCols,
                  record: row,
                  pkColumns,
                  uniqueKeyGroups,
                  allTableColumns: allTableColumnNames,
                  columnTypesByLowerName: columnTypeMapByLowerName,
              })
              : buildCopyDeleteSQL({
                  dbType,
                  tableName,
                  orderedCols,
                  record: row,
                  pkColumns,
                  uniqueKeyGroups,
                  allTableColumns: allTableColumnNames,
                  columnTypesByLowerName: columnTypeMapByLowerName,
              })
      ));
      const failedResult = sqlResults.find((result: any) => result.ok === false);
      if (failedResult && failedResult.ok === false) {
          void message.warning(translateCopySqlError(failedResult.error));
          return null;
      }
      const sqlTexts: string[] = [];
      sqlResults.forEach((result: any) => {
          if (result.ok) {
              sqlTexts.push(result.sql);
          }
      });
      return sqlTexts.join('\n\n');
  }, [
      supportsCopyInsert,
      getTargets,
      displayOutputColumnNames,
      dbType,
      tableName,
      columnTypeMapByLowerName,
      pkColumns,
      uniqueKeyGroups,
      allTableColumnNames,
      translateCopySqlError,
      translateDataGrid,
  ]);

  const handleCopyInsert = useCallback((record: any) => {
      const batchText = buildCopySqlBatchText('insert', record);
      if (!batchText) return;
      copyToClipboard(batchText);
  }, [buildCopySqlBatchText, copyToClipboard]);

  const handleCopyUpdate = useCallback((record: any) => {
      const batchText = buildCopySqlBatchText('update', record);
      if (!batchText) return;
      copyToClipboard(batchText);
  }, [buildCopySqlBatchText, copyToClipboard]);

  const handleCopyDelete = useCallback((record: any) => {
      const batchText = buildCopySqlBatchText('delete', record);
      if (!batchText) return;
      copyToClipboard(batchText);
  }, [buildCopySqlBatchText, copyToClipboard]);

  const handleCopyJson = useCallback((record: any) => {
      const records = getTargets(record);
      const cleanRecords = pickDataGridOutputRows(records, displayOutputColumnNames);
      copyToClipboard(JSON.stringify(cleanRecords, null, 2));
  }, [getTargets, displayOutputColumnNames, copyToClipboard]);

  const handleCopyCsv = useCallback((record: any) => {
      const records = getTargets(record);
      const orderedCols = displayOutputColumnNames;
      const header = orderedCols.map((c: string) => `"${c}"`).join(',');
      const lines = records.map((r: any) => {
          const values = orderedCols.map((c: string) => {
              const v = r[c];
              if (v === null || v === undefined) return 'NULL';
              // CSV 标准：值中的双引号转义为两个双引号
              const escaped = String(v).replace(/"/g, '""');
              return `"${escaped}"`;
          });
          return values.join(',');
      });
      copyToClipboard([header, ...lines].join('\n'));
  }, [getTargets, displayOutputColumnNames, copyToClipboard]);

  const handleCopyRowData = useCallback((record: any) => {
      const rows = getContextMenuTargetRows(record);
      const columns = displayOutputColumnNames;
      const text = buildClipboardTsv(
          rows,
          columns,
          (columnName: string) => (columnMetaMap[columnName] || columnMetaMapByLowerName[columnName.toLowerCase()])?.type,
          currentConnConfig,
      );
      if (!text) {
          void message.info(translateDataGrid('data_grid.message.current_row_no_copyable_content'));
          return;
      }
      copyToClipboard(buildTabularClipboardPayloadFromTsv(text, { firstRowIsHeader: true }));
  }, [columnMetaMap, columnMetaMapByLowerName, copyToClipboard, currentConnConfig, displayOutputColumnNames, getContextMenuTargetRows, translateDataGrid]);

  const buildConnConfig = useCallback(() => {
      if (!connectionId) return null;
      const conn = connections.find((c: any) => c.id === connectionId);
      if (!conn) return null;
      return {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };
  }, [connections, connectionId]);

  const resolveExportTitle = useCallback((defaultName: string) => {
      const normalizedDefaultName = String(defaultName || '').trim();
      if (normalizedDefaultName === 'query_result') {
          return translateDataGrid('file.backend.dialog.export_query_result');
      }
      if (normalizedDefaultName && normalizedDefaultName !== 'export') {
          return translateDataGrid('file.backend.dialog.export_table', { table: normalizedDefaultName });
      }
      return translateDataGrid('file.backend.dialog.export_data');
  }, [translateDataGrid]);

  const exportByQuery = useCallback(async (sql: string, defaultName: string, options: DataExportFileOptions, totalRows?: number) => {
      const config = buildConnConfig();
      if (!config) return;
      const normalizedDefaultName = String(defaultName || '').trim();
      const totalRowsKnown = Number.isFinite(totalRows) && Number(totalRows) >= 0;
      await runExportWithProgress({
          title: resolveExportTitle(normalizedDefaultName),
          targetName: normalizedDefaultName || 'export',
          format: options.format,
          totalRows: totalRowsKnown ? Number(totalRows) : undefined,
          run: (jobId: string) => ExportQueryWithOptions(
              buildRpcConnectionConfig(config) as any,
              dbName || '',
              sql,
              normalizedDefaultName || 'export',
              {
                  ...buildBackendExportOptions(options),
                  jobId,
                  totalRowsHint: totalRowsKnown ? Number(totalRows) : 0,
                  totalRowsKnown,
              } as any,
          ),
      });
  }, [buildBackendExportOptions, buildConnConfig, dbName, resolveExportTitle, runExportWithProgress]);

  const buildPkWhereSql = useCallback((rows: any[], dbType: string) => {
      if (!tableName || pkColumns.length === 0) return '';
      const targets = (rows || []).filter(Boolean);
      if (targets.length === 0) return '';

      const clauses: string[] = [];
      for (const r of targets) {
          const andParts: string[] = [];
          for (const pk of pkColumns) {
              const col = quoteIdentPart(dbType, pk);
              const v = r?.[pk];
              if (v === null || v === undefined) return '';
              andParts.push(`${col} = '${escapeLiteral(String(v))}'`);
          }
          if (andParts.length === pkColumns.length) {
              clauses.push(`(${andParts.join(' AND ')})`);
          }
      }
      if (clauses.length === 0) return '';
      return clauses.join(' OR ');
  }, [pkColumns, tableName]);

  const buildCurrentPageSql = useCallback((dbType: string) => {
      if (!tableName || !pagination) return '';
      const effectiveFilterConditions = buildEffectiveFilterConditions(filterConditions, quickWhereCondition);
      const whereSQL = buildWhereSQL(dbType, effectiveFilterConditions);
      const baseSql = buildDataGridSelectBaseSql({
          dbType,
          tableName,
          columnNames: displayOutputColumnNames,
          whereSql: whereSQL,
      });
      const orderBySQL = buildOrderBySQL(dbType, sortInfo, resolveExportOrderFallbackColumns(dbType, pkColumns));
      const normalizedType = String(dbType || '').trim().toLowerCase();
      const hasSortForBuffer = hasExplicitSort(sortInfo);
      const offset = (pagination.current - 1) * pagination.pageSize;
      let sql = buildPaginatedSelectSQL(dbType, baseSql, orderBySQL, pagination.pageSize, offset);
      if (hasSortForBuffer && (normalizedType === 'mysql' || normalizedType === 'mariadb')) {
          sql = withSortBufferTuningSQL(normalizedType, sql, 32 * 1024 * 1024);
      }
      return sql;
  }, [tableName, pagination, filterConditions, quickWhereCondition, sortInfo, pkColumns, displayOutputColumnNames]);

  const buildAllRowsSql = useCallback((dbType: string) => {
      if (!tableName) return '';
      return buildDataGridSelectBaseSql({
          dbType,
          tableName,
          columnNames: displayOutputColumnNames,
      });
  }, [tableName, displayOutputColumnNames]);

  const buildFilteredAllSql = useCallback((dbType: string) => {
      if (!tableName) return '';
      const effectiveFilterConditions = buildEffectiveFilterConditions(filterConditions, quickWhereCondition);
      const whereSQL = buildWhereSQL(dbType, effectiveFilterConditions);
      if (!whereSQL) return '';
      let sql = buildDataGridSelectBaseSql({
          dbType,
          tableName,
          columnNames: displayOutputColumnNames,
          whereSql: whereSQL,
      });
      sql += buildOrderBySQL(dbType, sortInfo, resolveExportOrderFallbackColumns(dbType, pkColumns));
      const normalizedType = String(dbType || '').trim().toLowerCase();
      const hasSortForBuffer = hasExplicitSort(sortInfo);
      if (hasSortForBuffer && (normalizedType === 'mysql' || normalizedType === 'mariadb')) {
          sql = withSortBufferTuningSQL(normalizedType, sql, 32 * 1024 * 1024);
      }
      return sql;
  }, [tableName, filterConditions, quickWhereCondition, sortInfo, pkColumns, displayOutputColumnNames]);

  const queryResultCurrentPageRows = useMemo(() => {
      if (isQueryResultExport) {
          return mergedDisplayData;
      }
      if (!pagination) {
          return mergedDisplayData;
      }
      const offset = Math.max(0, (pagination.current - 1) * pagination.pageSize);
      return mergedDisplayData.slice(offset, offset + pagination.pageSize);
  }, [isQueryResultExport, mergedDisplayData, pagination]);

  const exportQueryResultRows = useCallback(async (options: DataExportFileOptions, scope: Exclude<DataGridExportScope, 'filteredAll'>) => {
      if (scope === 'selected') {
          const selectedKeySet = new Set(selectedRowKeys.map((key: any) => rowKeyStr(key)));
          const rows = mergedDisplayData.filter((row: any) => {
              const key = row?.[GONAVI_ROW_KEY];
              return key !== undefined && key !== null && selectedKeySet.has(rowKeyStr(key));
          });
          if (rows.length === 0) {
              void message.info(translateDataGrid('data_grid.message.no_rows_selected'));
              return;
          }
          await exportData(rows, options);
          return;
      }
      if (scope === 'page') {
          await exportData(queryResultCurrentPageRows, options);
          return;
      }
      const exportAllSql = String(resultExportAllSql || '').trim();
      const fallbackAllSql = String(resultSql || '').trim();
      const backendExportSql = exportAllSql || fallbackAllSql;
      if (backendExportSql && connectionId) {
          const totalRows = pagination && pagination.totalKnown !== false ? Number(pagination.total) : undefined;
          await exportByQuery(backendExportSql, tableName || 'query_result', options, totalRows);
          return;
      }
      await exportData(mergedDisplayData, options);
  }, [connectionId, exportByQuery, exportData, mergedDisplayData, pagination, queryResultCurrentPageRows, resultExportAllSql, resultSql, rowKeyStr, selectedRowKeys, tableName]);

  // Context Menu Export
  const handleExportSelected = useCallback(async (options: DataExportFileOptions, record: any) => {
      if (isQueryResultExport) {
          await exportData(getContextMenuTargetRows(record), options);
          return;
      }
      const records = getTargets(record);
      if (!connectionId || !tableName) {
          await exportData(records, options);
          return;
      }

      // 有未提交修改时，优先按界面数据导出，避免与数据库不一致。
      if (hasChanges) {
          await exportData(records, options);
          void message.warning(translateDataGrid('data_grid.message.export_with_uncommitted_changes'));
          return;
      }

      const config = buildConnConfig();
      if (!config) {
          await exportData(records, options);
          return;
      }

      const dbType = resolveDataSourceType(config);
      const pkWhere = buildPkWhereSql(records, dbType);
      if (!pkWhere) {
          await exportData(records, options);
          return;
      }

      const sql = buildDataGridSelectBaseSql({
          dbType,
          tableName,
          columnNames: displayOutputColumnNames,
          whereSql: `WHERE ${pkWhere}`,
      });
      await exportByQuery(sql, tableName || 'export', options, records.length);
  }, [getTargets, isQueryResultExport, connectionId, tableName, hasChanges, exportData, buildConnConfig, buildPkWhereSql, exportByQuery, displayOutputColumnNames, translateDataGrid]);
  return {
    buildCopySqlBatchText, handleCopyInsert, handleCopyUpdate, handleCopyDelete, handleCopyJson,
    handleCopyCsv, handleCopyRowData, buildConnConfig, resolveExportTitle, buildCurrentPageSql,
    buildAllRowsSql, buildFilteredAllSql, queryResultCurrentPageRows, exportQueryResultRows,
    handleExportSelected,
  };
};

export type DataGridV2CopyExportApi = ReturnType<typeof useDataGridV2CopyExport>;
