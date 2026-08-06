import { useCallback, useEffect, useMemo } from 'react';
import { message } from 'antd';
import { ExportQueryWithOptions } from '../../wailsjs/go/app/App';
import type { CopySqlError } from './dataGridCopyInsert';
import type { V2CellContextMenuActionKey, V2ColumnHeaderContextMenuActionKey } from './V2TableContextMenu';
import {
  buildTabularClipboardPayloadFromTsv,
  writeClipboardPayloadToEvent,
  type DataGridClipboardPayload,
} from './dataGridClipboardPayload';
import {
  DEFAULT_DATA_EXPORT_FORMAT,
  DEFAULT_XLSX_ROWS_PER_SHEET,
  showDataExportDialog,
  type DataExportDialogValues,
  type DataExportFileOptions,
  type DataExportScopeOption,
} from './DataExportDialog';
import type { DataGridExportScope } from './DataGridCore';

type DataGridV2ActionsContext = Record<string, any>;

export const useDataGridV2Actions = (ctx: DataGridV2ActionsContext) => {
  const {
    GONAVI_ROW_KEY,
    addTab,
    allTableColumnNames,
    applyColumnSort,
    autoFitColumnWidth,
    buildClipboardCsv,
    buildClipboardJson,
    buildClipboardMarkdown,
    buildClipboardTsv,
    buildCopyDeleteSQL,
    buildCopyInsertSQL,
    buildCopyUpdateSQL,
    buildDataGridSelectBaseSql,
    buildEffectiveFilterConditions,
    buildBackendExportOptions,
    buildOrderBySQL,
    buildPaginatedSelectSQL,
    buildRpcConnectionConfig,
    buildSelectedCellClipboardPayload,
    buildTableExportTab,
    buildWhereSQL,
    cellContextMenu,
    cellEditMode,
    canExportInsertSQL,
    closeCellEditMode,
    columnMetaMap,
    columnMetaMapByLowerName,
    columnTypeMapByLowerName,
    connectionId,
    connections,
    copiedCellPatch,
    copyRowsForPaste,
    copyToClipboard,
    currentConnConfig,
    currentSelectionRef,
    dbName,
    dbType,
    ddlText,
    displayColumnNames,
    displayData,
    displayDataRef,
    displayOutputColumnNames,
    escapeLiteral,
    exportData,
    filterConditions,
    handleBatchFillToSelected,
    handleCellSetNull,
    handleCopyColumnData,
    handleCopyContextMenuFieldName,
    handleOpenContextMenuRowEditor,
    handlePasteCopiedColumnsToSelectedRows,
    handlePasteCopiedRowsAsNew,
    handleUndoContextMenuCellChange,
    hasChanges,
    hasExplicitSort,
    hasFilteredExportSql,
    isActive,
    isTableSurfaceActive,
    isQueryResultExport,
    mergedDisplayData,
    modal,
    navigator,
    objectType,
    pagination,
    pickDataGridOutputRows,
    pickRowsForClipboard,
    pkColumns,
    quickWhereCondition,
    quoteIdentPart,
    resetCellSelection,
    resolveContextMenuFieldName,
    resolveDataSourceType,
    resultExportAllSql,
    resultSql,
    rootRef,
    rowKeyStr,
    runExportWithProgress,
    selectedCells,
    selectedRowKeys,
    selectedRowKeysRef,
    setCellContextMenu,
    setQueryOptions,
    setSelectedRowKeys,
    sortInfo,
    splitCellKey,
    supportsCopyInsert,
    supportsSqlQueryExport,
    tableName,
    pinnedLeftColumnScope,
    toggleColumnVisibility,
    pinnedLeftColumnNames,
    setTablePinnedLeftColumns,
    translateDataGrid,
    uniqueKeyGroups,
    withSortBufferTuningSQL,
  } = ctx;

const handleV2ColumnHeaderContextMenuAction = useCallback((action: V2ColumnHeaderContextMenuActionKey) => {
      const columnName = resolveContextMenuFieldName(cellContextMenu.dataIndex, cellContextMenu.title);
      if (!columnName) {
          void message.info(translateDataGrid('data_grid.message.no_field_name'));
          setCellContextMenu((prev: any) => ({ ...prev, visible: false }));
          return;
      }

      switch (action) {
          case 'copy-field-name':
              copyToClipboard(columnName);
              break;
          case 'copy-column-comment': {
              const columnMeta = columnMetaMap[columnName]
                  || columnMetaMapByLowerName[columnName.toLowerCase()];
              const comment = String(columnMeta?.comment || '').trim();
              if (!comment) {
                  void message.info(translateDataGrid('data_grid.context_menu.column_no_comment'));
                  break;
              }
              copyToClipboard(comment);
              break;
          }
          case 'copy-column-data':
              handleCopyColumnData(columnName);
              break;
          case 'sort-asc':
              applyColumnSort(columnName, 'ascend');
              break;
          case 'sort-desc':
              applyColumnSort(columnName, 'descend');
              break;
          case 'clear-sort':
              applyColumnSort(columnName, null);
              break;
          case 'auto-fit-column':
              autoFitColumnWidth(columnName);
              break;
          case 'pin-column-left': {
              if (!connectionId || !dbName || !pinnedLeftColumnScope) {
                  void message.info(translateDataGrid('data_grid.message.pin_column_unavailable'));
                  break;
              }
              const nextPinned = [
                  ...pinnedLeftColumnNames.filter((col: string) => col !== columnName),
                  columnName,
              ];
              setTablePinnedLeftColumns(connectionId, dbName, pinnedLeftColumnScope, nextPinned);
              break;
          }
          case 'unpin-column-left': {
              if (!connectionId || !dbName || !pinnedLeftColumnScope) break;
              const nextPinned = pinnedLeftColumnNames.filter((col: string) => col !== columnName);
              setTablePinnedLeftColumns(connectionId, dbName, pinnedLeftColumnScope, nextPinned);
              break;
          }
          case 'hide-column':
              if (displayColumnNames.length <= 1) {
                  void message.info(translateDataGrid('data_grid.message.keep_one_visible_column'));
                  break;
              }
              toggleColumnVisibility(columnName, false);
              break;
          case 'show-column-type':
              setQueryOptions({ showColumnType: true });
              break;
          case 'hide-column-type':
              setQueryOptions({ showColumnType: false });
              break;
          case 'show-column-comment':
              setQueryOptions({ showColumnComment: true });
              break;
          case 'hide-column-comment':
              setQueryOptions({ showColumnComment: false });
              break;
          default:
              break;
      }
      setCellContextMenu((prev: any) => ({ ...prev, visible: false }));
  }, [
      applyColumnSort,
      autoFitColumnWidth,
      cellContextMenu.dataIndex,
      cellContextMenu.title,
      connectionId,
      columnMetaMap,
      columnMetaMapByLowerName,
      copyToClipboard,
      dbName,
      displayColumnNames.length,
      handleCopyColumnData,
      pinnedLeftColumnNames,
      setQueryOptions,
      setTablePinnedLeftColumns,
      pinnedLeftColumnScope,
      translateDataGrid,
      toggleColumnVisibility,
  ]);

  const getClipboardRows = useCallback(() => (
      pickRowsForClipboard({
          rows: mergedDisplayData as Array<Record<string, unknown>>,
          selectedRowKeys,
          columnNames: displayOutputColumnNames,
          rowKeyField: GONAVI_ROW_KEY,
          rowKeyToString: rowKeyStr,
      })
  ), [mergedDisplayData, selectedRowKeys, displayOutputColumnNames, rowKeyStr]);

  const getClipboardColumnNames = useCallback((rows: Array<Record<string, unknown>>) => {
      if (rows.length === 0) return [];
      return displayOutputColumnNames;
  }, [displayOutputColumnNames]);

  const handleCopyQueryResultCsv = useCallback(() => {
      const rows = getClipboardRows();
      const columns = getClipboardColumnNames(rows);
      const text = buildClipboardCsv(rows, columns);
      if (!text) {
          void message.info(translateDataGrid('data_grid.message.result_set_no_copyable_content'));
          return;
      }
      copyToClipboard(text);
  }, [copyToClipboard, getClipboardColumnNames, getClipboardRows, translateDataGrid]);

  const handleCopyQueryResultJson = useCallback(() => {
      const rows = getClipboardRows();
      const text = buildClipboardJson(rows);
      if (!text) {
          void message.info(translateDataGrid('data_grid.message.result_set_no_copyable_content'));
          return;
      }
      copyToClipboard(text);
  }, [copyToClipboard, getClipboardRows, translateDataGrid]);

  const handleCopyQueryResultMarkdown = useCallback(() => {
      const rows = getClipboardRows();
      const columns = getClipboardColumnNames(rows);
      const text = buildClipboardMarkdown(rows, columns);
      if (!text) {
          void message.info(translateDataGrid('data_grid.message.result_set_no_copyable_content'));
          return;
      }
      copyToClipboard(text);
  }, [copyToClipboard, getClipboardColumnNames, getClipboardRows, translateDataGrid]);

  const handleCopyDdl = useCallback(() => {
      if (!ddlText.trim()) {
          void message.info(translateDataGrid('data_grid.message.no_ddl_to_copy'));
          return;
      }
      navigator.clipboard.writeText(ddlText)
          .then(() => message.success(translateDataGrid('data_grid.message.ddl_copied')))
          .catch(() => message.error(translateDataGrid('data_grid.message.ddl_copy_failed')));
  }, [ddlText, translateDataGrid]);

  const buildSelectedCellsClipboardPayload = useCallback((): DataGridClipboardPayload | null => {
      const activeSelection = currentSelectionRef.current.size > 0 ? currentSelectionRef.current : selectedCells;
      if (activeSelection.size === 0) {
          void message.info(translateDataGrid('data_grid.message.drag_select_cells_to_copy'));
          return null;
      }

      const parsed = Array.from(activeSelection)
          .map((cellKey) => splitCellKey(cellKey))
          .filter((item): item is { rowKey: string; colName: string } => !!item);
      if (parsed.length === 0) {
          void message.info(translateDataGrid('data_grid.message.no_copyable_cells'));
          return null;
      }

      const payload = buildSelectedCellClipboardPayload({
          selectedCells: parsed,
          rows: mergedDisplayData as Array<Record<string, any>>,
          columnOrder: displayColumnNames,
          rowKeyField: GONAVI_ROW_KEY,
      });
      if (!payload.plainText) {
          void message.info(translateDataGrid('data_grid.message.selection_no_copyable_content'));
          return null;
      }

      return payload;
  }, [
      GONAVI_ROW_KEY,
      buildSelectedCellClipboardPayload,
      currentSelectionRef,
      displayColumnNames,
      mergedDisplayData,
      selectedCells,
      splitCellKey,
      translateDataGrid,
  ]);

  const handleCopySelectedCellsToClipboard = useCallback(() => {
      const payload = buildSelectedCellsClipboardPayload();
      if (!payload) return;
      copyToClipboard(payload);
  }, [buildSelectedCellsClipboardPayload, copyToClipboard]);

  useEffect(() => {
      if (!isActive || !isTableSurfaceActive || (!cellEditMode && selectedCells.size === 0)) return;

      const onKeyDown = (event: KeyboardEvent) => {
          if (event.defaultPrevented) return;
          const activeElement = document.activeElement as HTMLElement | null;
          const eventTarget = event.target instanceof HTMLElement ? event.target : null;
          const nativeShortcutGuard = 'input, textarea, select, [contenteditable="true"], .ant-modal, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-popover, [data-gonavi-close-shortcut-guard]';
          if (activeElement?.closest(nativeShortcutGuard) || eventTarget?.closest(nativeShortcutGuard)) {
              return;
          }

          if (event.key === 'Escape') {
              const activeSelection = currentSelectionRef.current.size > 0 ? currentSelectionRef.current : selectedCells;
              if (activeSelection.size === 0) {
                  if (cellEditMode) {
                      event.preventDefault();
                      closeCellEditMode();
                  }
                  return;
              }
              event.preventDefault();
              resetCellSelection();
              return;
          }

      };

      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
  }, [cellEditMode, selectedCells, resetCellSelection, closeCellEditMode, isActive, isTableSurfaceActive]);

  useEffect(() => {
      if (!isActive || !isTableSurfaceActive || selectedCells.size === 0) return;

      const onCopy = (event: ClipboardEvent) => {
          if (event.defaultPrevented) return;
          const activeElement = document.activeElement as HTMLElement | null;
          const eventTarget = event.target instanceof HTMLElement ? event.target : null;
          const nativeShortcutGuard = 'input, textarea, select, [contenteditable="true"], .ant-modal, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-popover, [data-gonavi-close-shortcut-guard]';
          if (activeElement?.closest(nativeShortcutGuard) || eventTarget?.closest(nativeShortcutGuard)) return;
          if (document.getSelection?.()?.toString()) return;

          const payload = buildSelectedCellsClipboardPayload();
          if (!payload) return;
          if (writeClipboardPayloadToEvent(event, payload)) {
              void message.success(translateDataGrid('data_grid.message.copied_to_clipboard'));
              return;
          }
          copyToClipboard(payload);
      };

      window.addEventListener('copy', onCopy);
      return () => window.removeEventListener('copy', onCopy);
  }, [buildSelectedCellsClipboardPayload, copyToClipboard, isActive, isTableSurfaceActive, selectedCells.size, translateDataGrid]);

  useEffect(() => {
      if (!isActive || !isTableSurfaceActive || (!cellEditMode && selectedCells.size === 0)) return;

      const onPointerDown = (event: MouseEvent) => {
          const root = rootRef.current;
          const target = event.target instanceof Node ? event.target : null;
          if (!root || !target || root.contains(target)) return;
          if (target instanceof HTMLElement
              && target.closest('.ant-modal, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-popover')) {
              return;
          }
          if (cellEditMode) {
              closeCellEditMode();
          } else {
              resetCellSelection();
          }
      };

      document.addEventListener('mousedown', onPointerDown);
      return () => document.removeEventListener('mousedown', onPointerDown);
  }, [cellEditMode, closeCellEditMode, isActive, isTableSurfaceActive, resetCellSelection, selectedCells.size]);
  
  const getTargets = useCallback((clickedRecord: any) => {
      const selKeys = selectedRowKeysRef.current;
      const currentData = displayDataRef.current;
      const clickedKey = clickedRecord?.[GONAVI_ROW_KEY];
      if (clickedKey !== undefined && selKeys.includes(clickedKey)) {
          return currentData.filter((d: any) => selKeys.includes(d?.[GONAVI_ROW_KEY]));
      }
      return [clickedRecord];
  }, []);

  const getContextMenuTargetRows = useCallback((clickedRecord: any) => {
      if (!clickedRecord) return [];
      const selKeys = selectedRowKeysRef.current;
      const clickedKey = clickedRecord?.[GONAVI_ROW_KEY];
      const clickedKeyStr = clickedKey === undefined || clickedKey === null ? '' : rowKeyStr(clickedKey);
      const selectedKeyStrSet = new Set(selKeys.map(rowKeyStr));
      if (clickedKeyStr && selectedKeyStrSet.has(clickedKeyStr)) {
          return mergedDisplayData.filter((row: any) => {
              const rowKey = row?.[GONAVI_ROW_KEY];
              return rowKey !== undefined && rowKey !== null && selectedKeyStrSet.has(rowKeyStr(rowKey));
          });
      }
      return [clickedRecord];
  }, [mergedDisplayData, rowKeyStr]);

  const translateCopySqlError = useCallback((error: CopySqlError): string => {
      if (typeof error === 'string') {
          return error;
      }
      switch (error.key) {
          case 'data_grid.copy_sql.error.missing_table_name':
              return translateDataGrid('data_grid.copy_sql.error.missing_table_name', error.params);
          case 'data_grid.copy_sql.error.no_copyable_fields':
              return translateDataGrid('data_grid.copy_sql.error.no_copyable_fields');
          case 'data_grid.copy_sql.error.missing_safe_where':
          default:
              return translateDataGrid('data_grid.copy_sql.error.missing_safe_where');
      }
  }, [translateDataGrid]);

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
      const orderBySQL = buildOrderBySQL(dbType, sortInfo, pkColumns);
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
      sql += buildOrderBySQL(dbType, sortInfo, pkColumns);
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

  const handleV2CellContextMenuAction = useCallback((action: V2CellContextMenuActionKey) => {
      const record = cellContextMenu.record;
      const closeMenu = () => setCellContextMenu((prev: any) => ({ ...prev, visible: false }));

      switch (action) {
          case 'copy-field-name':
              handleCopyContextMenuFieldName();
              return;
          case 'copy-row-data':
              if (record) handleCopyRowData(record);
              closeMenu();
              return;
          case 'copy-row-for-paste':
              if (record) {
                  const rowKey = record?.[GONAVI_ROW_KEY];
                  if (rowKey === undefined || rowKey === null) {
                      void message.info(translateDataGrid('data_grid.message.no_copyable_rows'));
                  } else {
                      setSelectedRowKeys([rowKey]);
                      copyRowsForPaste([rowKey]);
                  }
              }
              closeMenu();
              return;
          case 'paste-row-as-new':
              handlePasteCopiedRowsAsNew();
              closeMenu();
              return;
          case 'copy-column-data':
              handleCopyColumnData(cellContextMenu.dataIndex);
              closeMenu();
              return;
          case 'undo-cell-change':
              handleUndoContextMenuCellChange();
              return;
          case 'set-null':
              handleCellSetNull();
              return;
          case 'edit-row':
              handleOpenContextMenuRowEditor();
              return;
          case 'fill-selected':
              if (selectedRowKeys.length > 0 && record) {
                  handleBatchFillToSelected(record, cellContextMenu.dataIndex);
              }
              closeMenu();
              return;
          case 'paste-copied-columns':
              if (copiedCellPatch) {
                  handlePasteCopiedColumnsToSelectedRows(record?.[GONAVI_ROW_KEY]);
              }
              closeMenu();
              return;
          case 'copy-insert':
              if (record) handleCopyInsert(record);
              closeMenu();
              return;
          case 'copy-update':
              if (record) handleCopyUpdate(record);
              closeMenu();
              return;
          case 'copy-delete':
              if (record) handleCopyDelete(record);
              closeMenu();
              return;
          case 'copy-json':
              if (record) handleCopyJson(record);
              closeMenu();
              return;
          case 'copy-csv':
              if (record) handleCopyCsv(record);
              closeMenu();
              return;
          case 'copy-markdown':
              if (record) {
                  const records = getTargets(record);
                  const columns = getClipboardColumnNames(records);
                  copyToClipboard(buildClipboardMarkdown(records, columns));
              }
              closeMenu();
              return;
          case 'export-csv':
          case 'export-xlsx':
          case 'export-json':
          case 'export-html':
              if (record) {
                  const format = action.replace('export-', '') as DataExportDialogValues['format'];
                  handleExportSelected({ format }, record).catch(console.error);
              }
              closeMenu();
              return;
          default:
              closeMenu();
      }
  }, [
      cellContextMenu.record,
      cellContextMenu.dataIndex,
      copiedCellPatch,
      copyRowsForPaste,
      copyToClipboard,
      getClipboardColumnNames,
      getTargets,
      handleBatchFillToSelected,
      handleCellSetNull,
      handleUndoContextMenuCellChange,
      handleCopyContextMenuFieldName,
      handleCopyCsv,
      handleCopyDelete,
      handleCopyInsert,
      handleCopyJson,
      handleCopyColumnData,
      handleCopyRowData,
      handleCopyUpdate,
      handleExportSelected,
      handleOpenContextMenuRowEditor,
      handlePasteCopiedColumnsToSelectedRows,
      handlePasteCopiedRowsAsNew,
      selectedRowKeys.length,
      translateDataGrid,
  ]);

  // Export
  const handleOpenExportDialog = useCallback(async () => {
      const selectedCount = selectedRowKeys.length;
      const allRowsLabel = (resultExportAllSql || resultSql)
          ? translateDataGrid('data_grid.export.scope.all_results_requery')
          : translateDataGrid('data_grid.export.scope.all_results_cached', { count: mergedDisplayData.length });
      const commonInitialValues: Partial<DataExportDialogValues> = {
          format: DEFAULT_DATA_EXPORT_FORMAT,
          xlsxMaxRowsPerSheet: DEFAULT_XLSX_ROWS_PER_SHEET,
      };

      if (isQueryResultExport) {
          const scopeOptions: DataExportScopeOption[] = [
              {
                  value: 'selected',
                  label: selectedCount > 0
                      ? translateDataGrid('data_grid.export.scope.selected_rows_count', { count: selectedCount })
                      : translateDataGrid('data_grid.export.scope.selected_rows'),
                  description: translateDataGrid('data_grid.export.scope.selected_rows_description'),
                  disabled: selectedCount <= 0,
              },
              {
                  value: 'page',
                  label: translateDataGrid('data_grid.export.scope.current_page', {
                      count: queryResultCurrentPageRows.length,
                  }),
                  description: translateDataGrid('data_grid.export.scope.current_page_description'),
              },
              {
                  value: 'all',
                  label: allRowsLabel,
                  description: (resultExportAllSql || resultSql)
                      ? translateDataGrid('data_grid.export.scope.all_results_requery_description')
                      : translateDataGrid('data_grid.export.scope.all_results_cached_description'),
              },
          ];
          const values = await showDataExportDialog(modal, {
              title: translateDataGrid('file.backend.dialog.export_query_result'),
              scopeOptions,
              availableColumns: displayOutputColumnNames,
              allowInsertSql: canExportInsertSQL,
              initialValues: {
                  ...commonInitialValues,
                  scope: (resultExportAllSql || resultSql) ? 'all' : (selectedCount > 0 ? 'selected' : 'page'),
              },
          });
          if (!values) return;
          await exportQueryResultRows(
              { ...values, columns: values.columns },
              values.scope as Exclude<DataGridExportScope, 'filteredAll'>,
          );
          return;
      }

      if (!connectionId) return;
      const config = buildConnConfig();
      const dbType = config ? resolveDataSourceType(config) : '';
      const currentPageSql = config && !hasChanges ? buildCurrentPageSql(dbType) : '';
      const filteredAllSql = config && supportsSqlQueryExport ? buildFilteredAllSql(dbType) : '';
      const allRowsSql = config && objectType !== 'table' ? buildAllRowsSql(dbType) : '';
      const hasKnownFilteredTotal = hasFilteredExportSql && pagination && pagination.totalKnown !== false;
      const hasKnownAllTotal = !hasFilteredExportSql && pagination && pagination.totalKnown !== false;

      addTab(buildTableExportTab({
          connectionId,
          dbName,
          tableName: tableName || 'export',
          title: resolveExportTitle(tableName || 'export'),
          objectType,
          scopeOptions: [
              {
                  value: 'page',
                  label: translateDataGrid('data_grid.export.scope.current_page', {
                      count: displayData.length,
                  }),
                  description: currentPageSql
                      ? translateDataGrid('data_grid.export.scope.current_page_requery_description')
                      : translateDataGrid('data_grid.export.scope.current_page_unavailable_description'),
                  disabled: !currentPageSql,
              },
              ...(hasFilteredExportSql ? [{
                  value: 'filteredAll' as const,
                  label: translateDataGrid('data_grid.export.scope.filtered_results_all'),
                  description: filteredAllSql
                      ? translateDataGrid('data_grid.export.scope.filtered_results_all_requery_description')
                      : translateDataGrid('data_grid.export.scope.filtered_results_all_unavailable_description'),
                  disabled: !filteredAllSql,
              }] : []),
              {
                  value: 'all',
                  label: translateDataGrid('data_export.workbench.scope.all.label'),
                  description: translateDataGrid('data_export.workbench.scope.all.description'),
              },
          ],
          initialScope: hasFilteredExportSql && filteredAllSql ? 'filteredAll' : 'all',
          queryByScope: {
              ...(currentPageSql ? { page: currentPageSql } : {}),
              ...(filteredAllSql ? { filteredAll: filteredAllSql } : {}),
              ...(allRowsSql ? { all: allRowsSql } : {}),
          },
          rowCountByScope: {
              page: displayData.length,
              ...(hasKnownFilteredTotal ? { filteredAll: Number(pagination?.total) } : {}),
              ...(hasKnownAllTotal ? { all: Number(pagination?.total) } : {}),
          },
      }));
  }, [
      addTab,
      buildAllRowsSql,
      buildBackendExportOptions,
      buildConnConfig,
      buildCurrentPageSql,
      buildFilteredAllSql,
      canExportInsertSQL,
      connectionId,
      dbName,
      displayData.length,
      displayOutputColumnNames,
      exportQueryResultRows,
      hasFilteredExportSql,
      objectType,
      isQueryResultExport,
      mergedDisplayData.length,
      modal,
      pagination,
      queryResultCurrentPageRows.length,
      resultExportAllSql,
      resultSql,
      selectedRowKeys.length,
      supportsSqlQueryExport,
      tableName,
      hasChanges,
      translateDataGrid,
  ]);

  return {
    handleV2ColumnHeaderContextMenuAction,
    buildConnConfig,
    buildCopySqlBatchText,
    getTargets,
    handleCopyCsv,
    handleCopyDdl,
    handleCopyDelete,
    handleCopyInsert,
    handleCopyJson,
    handleCopyQueryResultCsv,
    handleCopyQueryResultJson,
    handleCopyQueryResultMarkdown,
    handleCopyRowData,
    handleCopySelectedCellsToClipboard,
    handleCopyUpdate,
    handleExportSelected,
    handleV2CellContextMenuAction,
    handleOpenExportDialog,
  };
};
