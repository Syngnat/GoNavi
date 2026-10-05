import { useCallback, useRef, useEffect } from 'react';
import { message } from 'antd';
import { flushSync } from 'react-dom';
import {
    buildDataGridCommitChangeSet,
    resolveContextMenuFieldName,
    normalizeClipboardTsvCell,
    formatClipboardCellText,
    GONAVI_ROW_KEY,
    buildClipboardTsv,
    splitCellKey,
} from '../../DataGridCore';
import { confirmProductionRisk } from '../../../utils/productionRiskConfirm';
import { ApplyChanges } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { buildDataGridTransactionLog } from '../../dataGridTransactionLog';
import { isShortcutMatch } from '../../../utils/shortcuts';
import { registerWorkbenchTabCloseGuard } from '../../../utils/workbenchTabCloseProtection';
import {
    type DataGridClipboardPayload,
    writeClipboardPayload,
    buildTabularClipboardPayloadFromTsv,
} from '../../dataGridClipboardPayload';
import { useDataGridV2Actions } from '../../useDataGridV2Actions';
import {
    buildClipboardCsv,
    buildClipboardJson,
    buildClipboardMarkdown,
    pickRowsForClipboard,
} from '../../dataGridClipboardExport';
import {
    buildCopyDeleteSQL,
    buildCopyInsertSQL,
    buildCopyUpdateSQL,
} from '../../dataGridCopyInsert';
import { buildDataGridSelectBaseSql, pickDataGridOutputRows } from '../../dataGridOutput';
import { buildEffectiveFilterConditions } from '../../../utils/dataGridWhereFilter';
import {
    buildOrderBySQL,
    buildPaginatedSelectSQL,
    buildWhereSQL,
    escapeLiteral,
    hasExplicitSort,
    quoteIdentPart,
    withSortBufferTuningSQL,
} from '../../../utils/sql';
import { buildSelectedCellClipboardPayload } from '../../dataGridSelectionCopy';
import { buildTableExportTab } from '../../../utils/tableExportTab';
import { resolveDataSourceType } from '../../../utils/dataSourceCapabilities';
import type { DataGridCellEditingApi } from './useDataGridCellEditing';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridTableMetricsApi } from './useDataGridTableMetrics';
import type { DataGridColumnTitlesApi } from './useDataGridColumnTitles';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridInlineEditorApi } from './useDataGridInlineEditor';
import type { DataGridRowActionsApi } from './useDataGridRowActions';
import type { DataGridRowEditorsApi } from './useDataGridRowEditors';
import type { DataGridProps } from '../../DataGridCore';

export interface UseDataGridCommitInput {
    connectionId: DataGridProps['connectionId'];
    tableName: DataGridProps['tableName'];
    dbName: DataGridProps['dbName'];
    onReload: DataGridProps['onReload'];
    clearAutoCommitTimer: DataGridCellEditingApi['clearAutoCommitTimer'];
    connections: DataGridCoreStateApi['connections'];
    addedRows: DataGridTableMetricsApi['addedRows'];
    setAddedRows: DataGridTableMetricsApi['setAddedRows'];
    modifiedRows: DataGridTableMetricsApi['modifiedRows'];
    setModifiedRows: DataGridTableMetricsApi['setModifiedRows'];
    deletedRowKeys: DataGridTableMetricsApi['deletedRowKeys'];
    setDeletedRowKeys: DataGridTableMetricsApi['setDeletedRowKeys'];
    baseData: DataGridColumnTitlesApi['baseData'];
    effectiveEditLocator: DataGridCoreStateApi['effectiveEditLocator'];
    visibleColumnNames: DataGridCoreStateApi['visibleColumnNames'];
    rowKeyStr: DataGridColumnTitlesApi['rowKeyStr'];
    normalizeCommitCellValue: DataGridTableMetricsApi['normalizeCommitCellValue'];
    shouldCommitColumn: DataGridCoreStateApi['shouldCommitColumn'];
    rowLocatorMessages: DataGridCoreStateApi['rowLocatorMessages'];
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    dbType: DataGridCoreStateApi['dbType'];
    autoCommitFailedTokenRef: DataGridCellEditingApi['autoCommitFailedTokenRef'];
    addSqlLog: DataGridCoreStateApi['addSqlLog'];
    setModifiedColumns: DataGridTableMetricsApi['setModifiedColumns'];
    autoCommitChangeTokenRef: DataGridCellEditingApi['autoCommitChangeTokenRef'];
    isActive: Exclude<DataGridProps['isActive'], undefined>;
    isTableSurfaceActive: DataGridColumnTitlesApi['isTableSurfaceActive'];
    canModifyData: DataGridCoreStateApi['canModifyData'];
    hasChanges: DataGridCellEditingApi['hasChanges'];
    activeShortcutPlatform: DataGridCoreStateApi['activeShortcutPlatform'];
    rootRef: DataGridCellEditorStateApi['rootRef'];
    workbenchTabId: DataGridProps['workbenchTabId'];
    dataPanelDirtyRef: DataGridInlineEditorApi['dataPanelDirtyRef'];
    setDataPanelValue: DataGridInlineEditorApi['setDataPanelValue'];
    dataPanelOriginalRef: DataGridInlineEditorApi['dataPanelOriginalRef'];
    handleDataPanelSave: DataGridInlineEditorApi['handleDataPanelSave'];
    dataEditCommitMode: DataGridCellEditingApi['dataEditCommitMode'];
    dataEditAutoCommitDelayMs: DataGridCellEditingApi['dataEditAutoCommitDelayMs'];
    setAutoCommitRemainingSeconds: DataGridCellEditingApi['setAutoCommitRemainingSeconds'];
    autoCommitCountdownRef: DataGridCellEditingApi['autoCommitCountdownRef'];
    autoCommitTimerRef: DataGridCellEditingApi['autoCommitTimerRef'];
    pendingChangeCount: DataGridCellEditingApi['pendingChangeCount'];
    cellContextMenu: DataGridCellEditorStateApi['cellContextMenu'];
    setCellContextMenu: DataGridCellEditorStateApi['setCellContextMenu'];
    displayOutputColumnNames: DataGridCoreStateApi['displayOutputColumnNames'];
    mergedDisplayData: DataGridInlineEditorApi['mergedDisplayData'];
    columnMetaMap: DataGridTableMetricsApi['columnMetaMap'];
    columnMetaMapByLowerName: DataGridTableMetricsApi['columnMetaMapByLowerName'];
    currentConnConfig: DataGridCoreStateApi['currentConnConfig'];
    objectType: Exclude<DataGridProps['objectType'], undefined>;
    pagination: DataGridProps['pagination'];
    pkColumns: Exclude<DataGridProps['pkColumns'], undefined>;
    quickWhereCondition: DataGridProps['quickWhereCondition'];
    resultExportAllSql: DataGridProps['resultExportAllSql'];
    resultSql: DataGridProps['resultSql'];
    addTab: DataGridCoreStateApi['addTab'];
    allTableColumnNames: DataGridTableMetricsApi['allTableColumnNames'];
    columnTypeMapByLowerName: DataGridTableMetricsApi['columnTypeMapByLowerName'];
    uniqueKeyGroups: DataGridTableMetricsApi['uniqueKeyGroups'];
    applyColumnSort: DataGridCellEditingApi['applyColumnSort'];
    autoFitColumnWidth: DataGridCellEditingApi['autoFitColumnWidth'];
    buildBackendExportOptions: DataGridTableMetricsApi['buildBackendExportOptions'];
    cellEditMode: DataGridCellEditorStateApi['cellEditMode'];
    canExportInsertSQL: DataGridTableMetricsApi['canExportInsertSQL'];
    closeCellEditMode: DataGridCellEditingApi['closeCellEditMode'];
    copiedCellPatch: DataGridCellEditorStateApi['copiedCellPatch'];
    copyRowsForPaste: DataGridRowActionsApi['copyRowsForPaste'];
    currentSelectionRef: DataGridCellEditorStateApi['currentSelectionRef'];
    ddlText: DataGridColumnTitlesApi['ddlText'];
    displayColumnNames: DataGridCoreStateApi['displayColumnNames'];
    displayData: DataGridCellEditingApi['displayData'];
    displayDataRef: DataGridColumnTitlesApi['displayDataRef'];
    exportData: DataGridTableMetricsApi['exportData'];
    filterConditions: DataGridColumnTitlesApi['filterConditions'];
    handleBatchFillToSelected: DataGridCellEditingApi['handleBatchFillToSelected'];
    handleSetNullForSelectedCells: DataGridCellEditingApi['handleSetNullForSelectedCells'];
    handlePasteCopiedColumnsToSelectedRows: DataGridCellEditingApi['handlePasteCopiedColumnsToSelectedRows'];
    handleCellSetNull: DataGridCellEditingApi['handleCellSetNull'];
    handleOpenContextMenuCellEditor: DataGridInlineEditorApi['handleOpenContextMenuCellEditor'];
    handleOpenContextMenuRowEditor: DataGridRowEditorsApi['handleOpenContextMenuRowEditor'];
    handlePasteCopiedRowsAsNew: DataGridRowActionsApi['handlePasteCopiedRowsAsNew'];
    handleUndoContextMenuCellChange: DataGridInlineEditorApi['handleUndoContextMenuCellChange'];
    hasFilteredExportSql: DataGridCoreStateApi['hasFilteredExportSql'];
    isQueryResultExport: DataGridCoreStateApi['isQueryResultExport'];
    modal: DataGridCoreStateApi['modal'];
    resetCellSelection: DataGridCellEditingApi['resetCellSelection'];
    runExportWithProgress: DataGridCoreStateApi['runExportWithProgress'];
    selectedCells: DataGridCellEditorStateApi['selectedCells'];
    selectedRowKeys: DataGridCellEditorStateApi['selectedRowKeys'];
    setSelectedRowKeys: DataGridCellEditorStateApi['setSelectedRowKeys'];
    selectedRowKeysRef: DataGridColumnTitlesApi['selectedRowKeysRef'];
    setQueryOptions: DataGridCoreStateApi['setQueryOptions'];
    sortInfo: DataGridCellEditorStateApi['sortInfo'];
    supportsCopyInsert: DataGridCoreStateApi['supportsCopyInsert'];
    supportsSqlQueryExport: DataGridCoreStateApi['supportsSqlQueryExport'];
    pinnedLeftColumnScope: DataGridCoreStateApi['pinnedLeftColumnScope'];
    toggleColumnVisibility: DataGridCoreStateApi['toggleColumnVisibility'];
    pinnedLeftColumnNames: DataGridCoreStateApi['pinnedLeftColumnNames'];
    setTablePinnedLeftColumns: DataGridCoreStateApi['setTablePinnedLeftColumns'];
}

export const useDataGridCommit = ({
    connectionId, tableName, dbName, onReload, clearAutoCommitTimer, connections, addedRows,
    setAddedRows, modifiedRows, setModifiedRows, deletedRowKeys, setDeletedRowKeys, baseData,
    effectiveEditLocator, visibleColumnNames, rowKeyStr, normalizeCommitCellValue,
    shouldCommitColumn, rowLocatorMessages, translateDataGrid, dbType, autoCommitFailedTokenRef,
    addSqlLog, setModifiedColumns, autoCommitChangeTokenRef, isActive, isTableSurfaceActive,
    canModifyData, hasChanges, activeShortcutPlatform, rootRef, workbenchTabId, dataPanelDirtyRef,
    setDataPanelValue, dataPanelOriginalRef, handleDataPanelSave, dataEditCommitMode,
    dataEditAutoCommitDelayMs, setAutoCommitRemainingSeconds, autoCommitCountdownRef,
    autoCommitTimerRef, pendingChangeCount, cellContextMenu, setCellContextMenu,
    displayOutputColumnNames, mergedDisplayData, columnMetaMap, columnMetaMapByLowerName,
    currentConnConfig, objectType, pagination, pkColumns, quickWhereCondition, resultExportAllSql,
    resultSql, addTab, allTableColumnNames, columnTypeMapByLowerName, uniqueKeyGroups,
    applyColumnSort, autoFitColumnWidth, buildBackendExportOptions, cellEditMode,
    canExportInsertSQL, closeCellEditMode, copiedCellPatch, copyRowsForPaste, currentSelectionRef,
    ddlText, displayColumnNames, displayData, displayDataRef, exportData, filterConditions,
    handleBatchFillToSelected, handleSetNullForSelectedCells,
    handlePasteCopiedColumnsToSelectedRows, handleCellSetNull, handleOpenContextMenuCellEditor,
    handleOpenContextMenuRowEditor, handlePasteCopiedRowsAsNew, handleUndoContextMenuCellChange,
    hasFilteredExportSql, isQueryResultExport, modal, resetCellSelection, runExportWithProgress,
    selectedCells, selectedRowKeys, setSelectedRowKeys, selectedRowKeysRef, setQueryOptions,
    sortInfo, supportsCopyInsert, supportsSqlQueryExport, pinnedLeftColumnScope,
    toggleColumnVisibility, pinnedLeftColumnNames, setTablePinnedLeftColumns,
}: UseDataGridCommitInput) => {
    const handleCommit = useCallback(async (source: 'manual' | 'auto' = 'manual'): Promise<boolean> => {
        clearAutoCommitTimer();
        if (!connectionId || !tableName) return false;
        const conn = connections.find(c => c.id === connectionId);
        if (!conn) return false;
        const changeSetResult = buildDataGridCommitChangeSet({
            addedRows,
            modifiedRows,
            deletedRowKeys,
            data: baseData,
            editLocator: effectiveEditLocator,
            visibleColumnNames,
            rowKeyToString: rowKeyStr,
            normalizeCommitCellValue,
            shouldCommitColumn,
            rowLocatorMessages,
        });
        if (!changeSetResult.ok) {
            void message.error(changeSetResult.error
                ? translateDataGrid('data_grid.message.change_set_build_failed_detail', { detail: changeSetResult.error })
                : translateDataGrid('data_grid.message.change_set_build_failed'));
            return false;
        }

        const { inserts, updates, deletes, previousDeletes, locatorColumns } = changeSetResult.changes;
        if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) {
            void message.info(translateDataGrid('data_grid.message.no_changes_to_commit'));
            return true;
        }

        const config = {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
        };

        const approved = await confirmProductionRisk({
            connection: conn,
            action: translateDataGrid('connection.production_risk.action.execute_sql'),
            target: [dbName, tableName].filter(Boolean).join(' / '),
            translate: translateDataGrid,
        });
        if (!approved) return false;

        const startTime = Date.now();
        // previousDeletes / locatorColumns 是执行前快照的还原线索，必须与正向变更一起送达后端；
        // 只传 inserts/updates/deletes 会让快照生成静默失效（提交照样成功，但事后不可还原）。
        const res = await ApplyChanges(buildRpcConnectionConfig(config) as any, dbName || '', tableName, {
            inserts,
            updates,
            deletes,
            locatorStrategy: effectiveEditLocator?.strategy,
            previousDeletes,
            locatorColumns,
        } as any);
        const duration = Date.now() - startTime;
        const outcomeUnknown = res?.outcomeUnknown === true;
        const logMessage = outcomeUnknown
            ? `${res.message} (${translateDataGrid('data_grid.message.transaction_outcome_unknown')})`
            : res.message;

        const logSql = buildDataGridTransactionLog({
            dbType,
            tableName,
            preview: res.data,
            committed: res.success,
            outcomeUnknown,
        });

        if (res.success) {
            autoCommitFailedTokenRef.current = -1;
            addSqlLog({
                id: Date.now().toString(),
                timestamp: Date.now(),
                sql: logSql.trim(),
                status: 'success',
                duration,
                message: logMessage,
                dbName
            });
            setAddedRows([]);
            setModifiedRows({});
            setDeletedRowKeys(new Set());
            setModifiedColumns({});
            await onReload?.();
            void message.success(source === 'auto'
                ? translateDataGrid('data_grid.message.auto_commit_success')
                : translateDataGrid('data_grid.message.transaction_committed'));
            return true;
        } else {
            addSqlLog({
                id: Date.now().toString(),
                timestamp: Date.now(),
                sql: logSql.trim(),
                status: 'error',
                duration,
                message: logMessage,
                dbName
            });
            if (source === 'auto') {
                autoCommitFailedTokenRef.current = autoCommitChangeTokenRef.current;
            }
            if (outcomeUnknown) {
                autoCommitFailedTokenRef.current = autoCommitChangeTokenRef.current;
                setAddedRows([]);
                setModifiedRows({});
                setDeletedRowKeys(new Set());
                setModifiedColumns({});
                try {
                    await onReload?.();
                } catch {
                    // Reload failures must not hide the unknown-outcome warning.
                } finally {
                    void message.warning(source === 'auto'
                        ? translateDataGrid('data_grid.message.auto_commit_outcome_unknown', { detail: res.message })
                        : translateDataGrid('data_grid.message.commit_outcome_unknown', { detail: res.message }));
                }
                return false;
            }
            void message.error(source === 'auto'
                ? translateDataGrid('data_grid.message.auto_commit_failed', { detail: res.message })
                : translateDataGrid('data_grid.message.commit_failed', { detail: res.message }));
            return false;
        }
    }, [
        clearAutoCommitTimer,
        connectionId,
        tableName,
        connections,
        addedRows,
        modifiedRows,
        deletedRowKeys,
        baseData,
        effectiveEditLocator,
        visibleColumnNames,
        rowKeyStr,
        normalizeCommitCellValue,
        shouldCommitColumn,
        dbName,
        dbType,
        addSqlLog,
        onReload,
        translateDataGrid,
    ]);
    const handleCommitRef = useRef(handleCommit);
    handleCommitRef.current = handleCommit;

    useEffect(() => {
      if (!isActive || !isTableSurfaceActive || !canModifyData || !hasChanges) return undefined;

      const handleDataGridSaveShortcut = (event: KeyboardEvent) => {
        const saveShortcut = activeShortcutPlatform === 'mac' ? 'Meta+S' : 'Ctrl+S';
        if (!isShortcutMatch(event, saveShortcut)) return;

        const root = rootRef.current;
        const eventTarget = event.target;
        const activeElement = document.activeElement;
        const eventTargetNode = typeof Node !== 'undefined' && eventTarget instanceof Node
          ? eventTarget
          : null;
        const activeElementNode = typeof Node !== 'undefined' && activeElement instanceof Node
          ? activeElement
          : null;
        const eventTargetElement = eventTarget && typeof (eventTarget as Element).closest === 'function'
          ? eventTarget as Element
          : null;
        const activeElementTarget = activeElement && typeof (activeElement as Element).closest === 'function'
          ? activeElement as Element
          : null;
        const isEventTargetInGrid = root
          ? !!eventTargetNode && root.contains(eventTargetNode)
          : !!eventTargetElement?.closest('.data-grid-root');
        const isActiveElementInGrid = root
          ? !!activeElementNode && root.contains(activeElementNode)
          : !!activeElementTarget?.closest('.data-grid-root');
        if (!isEventTargetInGrid && !isActiveElementInGrid) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void handleCommitRef.current('manual');
      };

      window.addEventListener('keydown', handleDataGridSaveShortcut, true);
      return () => {
        window.removeEventListener('keydown', handleDataGridSaveShortcut, true);
      };
    }, [activeShortcutPlatform, canModifyData, hasChanges, isActive, isTableSurfaceActive]);

    useEffect(() => {
        if (!workbenchTabId) return undefined;
        return registerWorkbenchTabCloseGuard(workbenchTabId, {
            isDirty: () => hasChanges || dataPanelDirtyRef.current,
            save: async () => {
                if (dataPanelDirtyRef.current) {
                    const applied = flushSync(() => handleDataPanelSave());
                    if (!applied || dataPanelDirtyRef.current) return false;
                }
                return handleCommitRef.current('manual');
            },
            discard: () => {
                clearAutoCommitTimer();
                setAddedRows([]);
                setModifiedRows({});
                setDeletedRowKeys(new Set());
                setModifiedColumns({});
                setDataPanelValue(dataPanelOriginalRef.current);
                dataPanelDirtyRef.current = false;
            },
        });
    }, [clearAutoCommitTimer, handleDataPanelSave, hasChanges, setDataPanelValue, workbenchTabId]);

    useEffect(() => {
        if (!canModifyData || dataEditCommitMode !== 'auto' || !hasChanges) {
            clearAutoCommitTimer();
            return;
        }
        if (autoCommitFailedTokenRef.current === autoCommitChangeTokenRef.current) {
            clearAutoCommitTimer();
            return;
        }

        const delayMs = dataEditAutoCommitDelayMs;
        const dueAt = Date.now() + delayMs;
        const updateRemaining = () => {
            setAutoCommitRemainingSeconds(Math.max(1, Math.ceil((dueAt - Date.now()) / 1000)));
        };
        clearAutoCommitTimer();
        updateRemaining();
        autoCommitCountdownRef.current = setInterval(updateRemaining, 250);
        autoCommitTimerRef.current = setTimeout(() => {
            autoCommitTimerRef.current = null;
            if (autoCommitCountdownRef.current) {
                clearInterval(autoCommitCountdownRef.current);
                autoCommitCountdownRef.current = null;
            }
            setAutoCommitRemainingSeconds(null);
            void handleCommit('auto');
        }, delayMs);

        return clearAutoCommitTimer;
    }, [
        canModifyData,
        dataEditCommitMode,
        dataEditAutoCommitDelayMs,
        hasChanges,
        pendingChangeCount,
        handleCommit,
        clearAutoCommitTimer,
    ]);

    useEffect(() => clearAutoCommitTimer, [clearAutoCommitTimer]);

    const copyToClipboard = useCallback((value: string | DataGridClipboardPayload) => {
        const payload = typeof value === 'string' ? { plainText: value } : value;
        writeClipboardPayload(payload).catch(console.error);
        void message.success(translateDataGrid('data_grid.message.copied_to_clipboard'));
    }, [translateDataGrid]);

    const handleCopyContextMenuFieldName = useCallback(() => {
        const fieldName = resolveContextMenuFieldName(cellContextMenu.dataIndex, cellContextMenu.title);
        if (!fieldName) {
            void message.info(translateDataGrid('data_grid.message.no_field_name'));
            return;
        }
        copyToClipboard(fieldName);
        setCellContextMenu(prev => ({ ...prev, visible: false }));
    }, [cellContextMenu.dataIndex, cellContextMenu.title, copyToClipboard, translateDataGrid]);

    const handleCopyColumnData = useCallback((columnName: string) => {
        const normalizedColumnName = String(columnName || '').trim();
        if (!normalizedColumnName || !displayOutputColumnNames.includes(normalizedColumnName)) {
            void message.info(translateDataGrid('data_grid.message.no_copyable_columns'));
            return;
        }
        if (mergedDisplayData.length === 0) {
            void message.info(translateDataGrid('data_grid.message.result_set_no_copyable_content'));
            return;
        }

        const columnType = (columnMetaMap[normalizedColumnName] || columnMetaMapByLowerName[normalizedColumnName.toLowerCase()])?.type;
        const text = mergedDisplayData
            .map((row) => normalizeClipboardTsvCell(formatClipboardCellText(row?.[normalizedColumnName], columnType, currentConnConfig)))
            .join('\n');
        copyToClipboard(buildTabularClipboardPayloadFromTsv(text));
    }, [columnMetaMap, columnMetaMapByLowerName, copyToClipboard, currentConnConfig, displayOutputColumnNames, mergedDisplayData, translateDataGrid]);

    const {
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
    } = useDataGridV2Actions({
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
      handleSetNullForSelectedCells,
      handleCopyColumnData,
      handleCopyContextMenuFieldName,
      handleOpenContextMenuCellEditor,
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
      navigator: globalThis.navigator,
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
    });
    return {
        handleCommit, copyToClipboard, handleCopyContextMenuFieldName,
        handleV2ColumnHeaderContextMenuAction, buildConnConfig, getTargets, handleCopyCsv,
        handleCopyDdl, handleCopyDelete, handleCopyInsert, handleCopyJson, handleCopyQueryResultCsv,
        handleCopyQueryResultJson, handleCopyQueryResultMarkdown, handleCopyRowData,
        handleCopySelectedCellsToClipboard, handleCopyUpdate, handleExportSelected,
        handleV2CellContextMenuAction, handleOpenExportDialog,
    };
};

export type DataGridCommitApi = ReturnType<typeof useDataGridCommit>;
