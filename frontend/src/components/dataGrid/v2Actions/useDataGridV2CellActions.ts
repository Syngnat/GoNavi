import { useCallback } from 'react';
import { message } from 'antd';
import type { V2CellContextMenuActionKey } from '../../V2TableContextMenu';
import {
  type DataExportDialogValues,
  DEFAULT_DATA_EXPORT_FORMAT,
  DEFAULT_XLSX_ROWS_PER_SHEET,
  type DataExportScopeOption,
  showDataExportDialog,
} from '../../DataExportDialog';
import type { DataGridExportScope } from '../../DataGridCore';
import type { DataGridV2CopyExportApi } from './useDataGridV2CopyExport';
import type { DataGridV2ColumnActionsApi } from './useDataGridV2ColumnActions';
import type { DataGridV2ActionsContext } from '../../useDataGridV2Actions';

export interface UseDataGridV2CellActionsInput {
  cellContextMenu: DataGridV2ActionsContext['cellContextMenu'];
  setCellContextMenu: DataGridV2ActionsContext['setCellContextMenu'];
  handleCopyContextMenuFieldName: DataGridV2ActionsContext['handleCopyContextMenuFieldName'];
  GONAVI_ROW_KEY: DataGridV2ActionsContext['GONAVI_ROW_KEY'];
  translateDataGrid: DataGridV2ActionsContext['translateDataGrid'];
  setSelectedRowKeys: DataGridV2ActionsContext['setSelectedRowKeys'];
  copyRowsForPaste: DataGridV2ActionsContext['copyRowsForPaste'];
  handlePasteCopiedRowsAsNew: DataGridV2ActionsContext['handlePasteCopiedRowsAsNew'];
  handleCopyColumnData: DataGridV2ActionsContext['handleCopyColumnData'];
  handleUndoContextMenuCellChange: DataGridV2ActionsContext['handleUndoContextMenuCellChange'];
  handleCellSetNull: DataGridV2ActionsContext['handleCellSetNull'];
  handleSetNullForSelectedCells: DataGridV2ActionsContext['handleSetNullForSelectedCells'];
  handleOpenContextMenuRowEditor: DataGridV2ActionsContext['handleOpenContextMenuRowEditor'];
  handleOpenContextMenuCellEditor: DataGridV2ActionsContext['handleOpenContextMenuCellEditor'];
  selectedRowKeys: DataGridV2ActionsContext['selectedRowKeys'];
  handleBatchFillToSelected: DataGridV2ActionsContext['handleBatchFillToSelected'];
  copiedCellPatch: DataGridV2ActionsContext['copiedCellPatch'];
  handlePasteCopiedColumnsToSelectedRows: DataGridV2ActionsContext['handlePasteCopiedColumnsToSelectedRows'];
  copyToClipboard: DataGridV2ActionsContext['copyToClipboard'];
  buildClipboardMarkdown: DataGridV2ActionsContext['buildClipboardMarkdown'];
  handleCopyRowData: DataGridV2CopyExportApi['handleCopyRowData'];
  handleCopyInsert: DataGridV2CopyExportApi['handleCopyInsert'];
  handleCopyUpdate: DataGridV2CopyExportApi['handleCopyUpdate'];
  handleCopyDelete: DataGridV2CopyExportApi['handleCopyDelete'];
  handleCopyJson: DataGridV2CopyExportApi['handleCopyJson'];
  handleCopyCsv: DataGridV2CopyExportApi['handleCopyCsv'];
  getTargets: DataGridV2ColumnActionsApi['getTargets'];
  getClipboardColumnNames: DataGridV2ColumnActionsApi['getClipboardColumnNames'];
  handleExportSelected: DataGridV2CopyExportApi['handleExportSelected'];
  resultExportAllSql: DataGridV2ActionsContext['resultExportAllSql'];
  resultSql: DataGridV2ActionsContext['resultSql'];
  mergedDisplayData: DataGridV2ActionsContext['mergedDisplayData'];
  isQueryResultExport: DataGridV2ActionsContext['isQueryResultExport'];
  modal: DataGridV2ActionsContext['modal'];
  displayOutputColumnNames: DataGridV2ActionsContext['displayOutputColumnNames'];
  canExportInsertSQL: DataGridV2ActionsContext['canExportInsertSQL'];
  connectionId: DataGridV2ActionsContext['connectionId'];
  resolveDataSourceType: DataGridV2ActionsContext['resolveDataSourceType'];
  hasChanges: DataGridV2ActionsContext['hasChanges'];
  supportsSqlQueryExport: DataGridV2ActionsContext['supportsSqlQueryExport'];
  objectType: DataGridV2ActionsContext['objectType'];
  hasFilteredExportSql: DataGridV2ActionsContext['hasFilteredExportSql'];
  pagination: DataGridV2ActionsContext['pagination'];
  addTab: DataGridV2ActionsContext['addTab'];
  buildTableExportTab: DataGridV2ActionsContext['buildTableExportTab'];
  dbName: DataGridV2ActionsContext['dbName'];
  tableName: DataGridV2ActionsContext['tableName'];
  displayData: DataGridV2ActionsContext['displayData'];
  buildBackendExportOptions: DataGridV2ActionsContext['buildBackendExportOptions'];
  queryResultCurrentPageRows: DataGridV2CopyExportApi['queryResultCurrentPageRows'];
  exportQueryResultRows: DataGridV2CopyExportApi['exportQueryResultRows'];
  buildConnConfig: DataGridV2CopyExportApi['buildConnConfig'];
  buildCurrentPageSql: DataGridV2CopyExportApi['buildCurrentPageSql'];
  buildFilteredAllSql: DataGridV2CopyExportApi['buildFilteredAllSql'];
  buildAllRowsSql: DataGridV2CopyExportApi['buildAllRowsSql'];
  resolveExportTitle: DataGridV2CopyExportApi['resolveExportTitle'];
}

export const useDataGridV2CellActions = ({
  cellContextMenu, setCellContextMenu, handleCopyContextMenuFieldName, GONAVI_ROW_KEY,
  translateDataGrid, setSelectedRowKeys, copyRowsForPaste, handlePasteCopiedRowsAsNew,
  handleCopyColumnData, handleUndoContextMenuCellChange, handleCellSetNull,
  handleSetNullForSelectedCells, handleOpenContextMenuRowEditor, handleOpenContextMenuCellEditor,
  selectedRowKeys, handleBatchFillToSelected, copiedCellPatch,
  handlePasteCopiedColumnsToSelectedRows, copyToClipboard, buildClipboardMarkdown,
  handleCopyRowData, handleCopyInsert, handleCopyUpdate, handleCopyDelete, handleCopyJson,
  handleCopyCsv, getTargets, getClipboardColumnNames, handleExportSelected, resultExportAllSql,
  resultSql, mergedDisplayData, isQueryResultExport, modal, displayOutputColumnNames,
  canExportInsertSQL, connectionId, resolveDataSourceType, hasChanges, supportsSqlQueryExport,
  objectType, hasFilteredExportSql, pagination, addTab, buildTableExportTab, dbName, tableName,
  displayData, buildBackendExportOptions, queryResultCurrentPageRows, exportQueryResultRows,
  buildConnConfig, buildCurrentPageSql, buildFilteredAllSql, buildAllRowsSql, resolveExportTitle,
}: UseDataGridV2CellActionsInput) => {
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
          case 'set-null-selected':
              // This explicit menu action always targets the current cell
              // selection; the right-clicked cell is not a fallback here.
              handleSetNullForSelectedCells();
              return;
          case 'edit-row':
              handleOpenContextMenuRowEditor();
              return;
          case 'edit-cell':
              handleOpenContextMenuCellEditor();
              closeMenu();
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
      handleSetNullForSelectedCells,
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
      handleOpenContextMenuCellEditor,
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
  return { handleV2CellContextMenuAction, handleOpenExportDialog };
};

export type DataGridV2CellActionsApi = ReturnType<typeof useDataGridV2CellActions>;
