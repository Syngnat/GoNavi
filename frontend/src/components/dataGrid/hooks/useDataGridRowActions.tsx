import React, { useMemo, useCallback } from 'react';
import type { ColumnType } from 'antd/es/table/interface';
import { message } from 'antd';
import {
    GONAVI_ROW_NUMBER_COLUMN_KEY,
    type Item,
    GONAVI_ROW_KEY,
    buildDataGridCommitChangeSet,
} from '../../DataGridCore';
import { absorbExtraWidthIntoFlexibleColumns } from '../../dataGridLayout';
import { buildCopiedRowsForPaste, buildPastedRowsFromCopiedRows } from '../../dataGridRowClipboard';
import { isWritableResultColumn } from '../../../utils/rowLocator';
import { PreviewChanges } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridColumnsApi } from './useDataGridColumns';
import type { DataGridCellEditingApi } from './useDataGridCellEditing';
import type { DataGridTableMetricsApi } from './useDataGridTableMetrics';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridInlineEditorApi } from './useDataGridInlineEditor';
import type { DataGridColumnTitlesApi } from './useDataGridColumnTitles';
import type { DataGridProps } from '../../DataGridCore';

export interface UseDataGridRowActionsInput {
    pagination: DataGridProps['pagination'];
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    rowNumberColumnWidth: DataGridColumnsApi['rowNumberColumnWidth'];
    handleResizeStart: DataGridCellEditingApi['handleResizeStart'];
    handleResizeAutoFit: DataGridCellEditingApi['handleResizeAutoFit'];
    handleRowNumberClick: DataGridColumnsApi['handleRowNumberClick'];
    handleRowNumberDoubleClick: DataGridColumnsApi['handleRowNumberDoubleClick'];
    resolvedShowRowNumberColumn: DataGridCoreStateApi['resolvedShowRowNumberColumn'];
    mergedColumns: DataGridColumnsApi['mergedColumns'];
    pinnedLeftColumnNames: DataGridCoreStateApi['pinnedLeftColumnNames'];
    selectionColumnWidth: DataGridCoreStateApi['selectionColumnWidth'];
    tableViewportWidth: DataGridTableMetricsApi['tableViewportWidth'];
    densityParams: DataGridCoreStateApi['densityParams'];
    visibleColumnNames: DataGridCoreStateApi['visibleColumnNames'];
    pendingScrollToBottomRef: DataGridCellEditorStateApi['pendingScrollToBottomRef'];
    setAddedRows: DataGridTableMetricsApi['setAddedRows'];
    mergedDisplayData: DataGridInlineEditorApi['mergedDisplayData'];
    displayOutputColumnNames: DataGridCoreStateApi['displayOutputColumnNames'];
    effectiveEditLocator: DataGridCoreStateApi['effectiveEditLocator'];
    rowKeyStr: DataGridColumnTitlesApi['rowKeyStr'];
    setCopiedRowsForPaste: DataGridCellEditorStateApi['setCopiedRowsForPaste'];
    selectedRowKeys: DataGridCellEditorStateApi['selectedRowKeys'];
    copiedRowsForPaste: DataGridCellEditorStateApi['copiedRowsForPaste'];
    pastedRowSequenceRef: DataGridCellEditorStateApi['pastedRowSequenceRef'];
    setSelectedRowKeys: DataGridCellEditorStateApi['setSelectedRowKeys'];
    deleteTargetRowKeys: DataGridCellEditingApi['deleteTargetRowKeys'];
    addedRowKeySet: DataGridCellEditingApi['addedRowKeySet'];
    deletedRowKeys: DataGridTableMetricsApi['deletedRowKeys'];
    setDeletedRowKeys: DataGridTableMetricsApi['setDeletedRowKeys'];
    cellEditMode: DataGridCellEditorStateApi['cellEditMode'];
    resetCellSelection: DataGridCellEditingApi['resetCellSelection'];
    connectionId: DataGridProps['connectionId'];
    tableName: DataGridProps['tableName'];
    dbName: DataGridProps['dbName'];
    connections: DataGridCoreStateApi['connections'];
    addedRows: DataGridTableMetricsApi['addedRows'];
    modifiedRows: DataGridTableMetricsApi['modifiedRows'];
    baseData: DataGridColumnTitlesApi['baseData'];
    normalizeCommitCellValue: DataGridTableMetricsApi['normalizeCommitCellValue'];
    shouldCommitColumn: DataGridCoreStateApi['shouldCommitColumn'];
    rowLocatorMessages: DataGridCoreStateApi['rowLocatorMessages'];
    setPreviewSqlData: DataGridTableMetricsApi['setPreviewSqlData'];
    setPreviewModalOpen: DataGridTableMetricsApi['setPreviewModalOpen'];
}

export const useDataGridRowActions = ({
    pagination, translateDataGrid, rowNumberColumnWidth, handleResizeStart, handleResizeAutoFit,
    handleRowNumberClick, handleRowNumberDoubleClick, resolvedShowRowNumberColumn, mergedColumns,
    pinnedLeftColumnNames, selectionColumnWidth, tableViewportWidth, densityParams,
    visibleColumnNames, pendingScrollToBottomRef, setAddedRows, mergedDisplayData,
    displayOutputColumnNames, effectiveEditLocator, rowKeyStr, setCopiedRowsForPaste,
    selectedRowKeys, copiedRowsForPaste, pastedRowSequenceRef, setSelectedRowKeys,
    deleteTargetRowKeys, addedRowKeySet, deletedRowKeys, setDeletedRowKeys, cellEditMode,
    resetCellSelection, connectionId, tableName, dbName, connections, addedRows, modifiedRows,
    baseData, normalizeCommitCellValue, shouldCommitColumn, rowLocatorMessages, setPreviewSqlData,
    setPreviewModalOpen,
}: UseDataGridRowActionsInput) => {
    const rowNumberColumn = useMemo<ColumnType<any>>(() => ({
        title: (
            <div
                className="gn-v2-column-title is-single-line"
                data-grid-row-number-title="true"
                data-grid-column-title-single-line="true"
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 0,
                    width: '100%',
                    maxWidth: '100%',
                    minHeight: 'var(--gonavi-header-min-height, 40px)',
                    lineHeight: 1.2,
                    textAlign: 'center',
                }}
            >
                {/* 序号列默认固定，不展示 📌，仅用户钉住的数据列显示图标 */}
                <span aria-label={translateDataGrid('data_grid.aria.row_number')}>#</span>
            </div>
        ),
        key: GONAVI_ROW_NUMBER_COLUMN_KEY,
        dataIndex: GONAVI_ROW_NUMBER_COLUMN_KEY,
        width: rowNumberColumnWidth,
        className: 'data-grid-row-number-cell',
        align: 'center',
        // 横向滚动时固定在左侧；支持拖拽调宽，不参与排序
        fixed: 'left' as const,
        sorter: false,
        ellipsis: false,
        onHeaderCell: () => ({
            // 无 id → 不参与列拖拽排序；有 width + onResizeStart → 可拖列宽
            className: 'data-grid-row-number-cell ant-table-cell-fix-left',
            width: rowNumberColumnWidth,
            onResizeStart: handleResizeStart(GONAVI_ROW_NUMBER_COLUMN_KEY),
            onResizeAutoFit: handleResizeAutoFit(GONAVI_ROW_NUMBER_COLUMN_KEY),
            style: {
                textAlign: 'center' as const,
                paddingInline: 2,
                verticalAlign: 'middle' as const,
                width: rowNumberColumnWidth,
                minWidth: rowNumberColumnWidth,
                maxWidth: rowNumberColumnWidth,
                flex: `0 0 ${rowNumberColumnWidth}px`,
            },
        }),
        onCell: (record: Item, index?: number) => ({
            'data-grid-row-number-action': 'true',
            style: {
                width: rowNumberColumnWidth,
                minWidth: rowNumberColumnWidth,
                maxWidth: rowNumberColumnWidth,
                flex: `0 0 ${rowNumberColumnWidth}px`,
                padding: 0,
                textAlign: 'center' as const,
              },
            onClick: (event: React.MouseEvent<HTMLElement>) => {
                event.stopPropagation();
                handleRowNumberClick(record);
            },
            onDoubleClick: (event: React.MouseEvent<HTMLElement>) => {
                event.preventDefault();
                event.stopPropagation();
                handleRowNumberDoubleClick(index ?? 0);
            },
        }),
        render: (_value: unknown, _record: Item, index: number) => {
            const currentPage = Math.max(1, Number(pagination?.current) || 1);
            const pageSize = Math.max(1, Number(pagination?.pageSize) || 0);
            const offset = pageSize > 0 ? (currentPage - 1) * pageSize : 0;
            return (
                <span
                    className="data-grid-row-number"
                    data-grid-row-number="true"
                    title={translateDataGrid('data_grid.row_number.double_click_to_view')}
                    style={{
                        display: 'flex',
                        width: '100%',
                        height: '100%',
                        minHeight: 24,
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                    }}
                    onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        handleRowNumberDoubleClick(index);
                    }}
                >
                    {offset + index + 1}
                </span>
            );
        },
    }), [handleResizeAutoFit, handleResizeStart, handleRowNumberClick, handleRowNumberDoubleClick, pagination?.current, pagination?.pageSize, rowNumberColumnWidth, translateDataGrid]);

    const baseTableColumns = useMemo(() => (
        resolvedShowRowNumberColumn
            ? [rowNumberColumn, ...mergedColumns]
            : mergedColumns
    ), [mergedColumns, resolvedShowRowNumberColumn, rowNumberColumn]);
    const tableColumns = useMemo(() => {
        // 少列时把视口多余宽度只加到数据列，避免行号列被 rc-table 均摊撑宽
        const fixedKeys = [
            ...(resolvedShowRowNumberColumn ? [GONAVI_ROW_NUMBER_COLUMN_KEY] : []),
            ...pinnedLeftColumnNames,
        ];
        return absorbExtraWidthIntoFlexibleColumns({
            columns: baseTableColumns,
            selectionColumnWidth,
            tableViewportWidth,
            fixedColumnKeys: fixedKeys,
            defaultColumnWidth: densityParams.defaultColumnWidth,
        });
    }, [
        baseTableColumns,
        densityParams.defaultColumnWidth,
        pinnedLeftColumnNames,
        resolvedShowRowNumberColumn,
        selectionColumnWidth,
        tableViewportWidth,
    ]);

    const handleAddRow = () => {
        const newKey = `new-${Date.now()}`;
        const newRow: any = { [GONAVI_ROW_KEY]: newKey };
        visibleColumnNames.forEach(col => newRow[col] = '');
        pendingScrollToBottomRef.current = true;
        setAddedRows(prev => [...prev, newRow]);
    };

    const copyRowsForPaste = useCallback((keys: React.Key[]) => {
        if (keys.length === 0) {
            void message.info(translateDataGrid('data_grid.message.select_rows_to_copy'));
            return;
        }
        const copiedRows = buildCopiedRowsForPaste({
            rows: mergedDisplayData as Array<Record<string, any>>,
            selectedRowKeys: keys,
            columnNames: displayOutputColumnNames.filter((columnName) => isWritableResultColumn(columnName, effectiveEditLocator)),
            rowKeyField: GONAVI_ROW_KEY,
            rowKeyToString: rowKeyStr,
        });
        if (copiedRows.length === 0) {
            void message.info(translateDataGrid('data_grid.message.no_copyable_rows'));
            return;
        }

        setCopiedRowsForPaste(copiedRows);
        void message.success(translateDataGrid('data_grid.message.copied_rows', { count: copiedRows.length }));
    }, [mergedDisplayData, displayOutputColumnNames, rowKeyStr, effectiveEditLocator, translateDataGrid]);

    const handleCopySelectedRowsForPaste = useCallback(() => {
        copyRowsForPaste(selectedRowKeys);
    }, [copyRowsForPaste, selectedRowKeys]);

    const handlePasteCopiedRowsAsNew = useCallback(() => {
        if (copiedRowsForPaste.length === 0) {
            void message.info(translateDataGrid('data_grid.message.copy_rows_first'));
            return;
        }

        const nextRows = buildPastedRowsFromCopiedRows({
            rows: copiedRowsForPaste,
            columnNames: displayOutputColumnNames.filter((columnName) => isWritableResultColumn(columnName, effectiveEditLocator)),
            rowKeyField: GONAVI_ROW_KEY,
            createRowKey: (index) => {
                pastedRowSequenceRef.current += 1;
                return `paste-${Date.now()}-${pastedRowSequenceRef.current}-${index}`;
            },
        });
        if (nextRows.length === 0) {
            void message.info(translateDataGrid('data_grid.message.no_pasteable_rows'));
            return;
        }

        pendingScrollToBottomRef.current = true;
        setAddedRows(prev => [...prev, ...nextRows]);
        setSelectedRowKeys(nextRows.map(row => row[GONAVI_ROW_KEY]));
        void message.success(translateDataGrid('data_grid.message.pasted_rows_as_new', { count: nextRows.length }));
    }, [copiedRowsForPaste, displayOutputColumnNames, effectiveEditLocator, translateDataGrid]);

    const handleDeleteSelected = () => {
        const addedKeysToRemove: string[] = [];
        const baseKeysToDelete: string[] = [];
        for (const keyStr of deleteTargetRowKeys) {
            if (addedRowKeySet.has(keyStr)) {
                addedKeysToRemove.push(keyStr);
            } else if (!deletedRowKeys.has(keyStr)) {
                baseKeysToDelete.push(keyStr);
            }
        }

        if (addedKeysToRemove.length > 0) {
            const removeSet = new Set(addedKeysToRemove);
            setAddedRows(prev => prev.filter(row => {
                const k = row?.[GONAVI_ROW_KEY];
                return k === undefined || k === null || !removeSet.has(rowKeyStr(k));
            }));
        }
        if (baseKeysToDelete.length > 0) {
            setDeletedRowKeys(prev => {
                const newDeleted = new Set(prev);
                baseKeysToDelete.forEach(key => newDeleted.add(key));
                return newDeleted;
            });
        }
        setSelectedRowKeys([]);
        if (cellEditMode) resetCellSelection();
    };

    const handleUndoDeleteSelected = () => {
        setDeletedRowKeys(prev => {
            const newDeleted = new Set(prev);
            deleteTargetRowKeys.forEach(key => newDeleted.delete(key));
            return newDeleted;
        });
        setSelectedRowKeys([]);
        if (cellEditMode) resetCellSelection();
    };

    const handlePreviewChanges = useCallback(async () => {
        if (!connectionId || !tableName) return;
        const conn = connections.find(c => c.id === connectionId);
        if (!conn) return;
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
            return;
        }
        const { changes } = changeSetResult;
        const config = {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
        };
        try {
            const res = await PreviewChanges(buildRpcConnectionConfig(config) as any, dbName || '', tableName, {
                inserts: changes.inserts,
                updates: changes.updates,
                deletes: changes.deletes,
                locatorStrategy: effectiveEditLocator?.strategy || '',
            } as any);
            if (res.success) {
                const d = res.data as { deletes: string[]; updates: string[]; inserts: string[] };
                setPreviewSqlData({
                    deletes: d?.deletes || [],
                    updates: d?.updates || [],
                    inserts: d?.inserts || [],
                });
                setPreviewModalOpen(true);
            } else {
                void message.error(res.message
                    ? translateDataGrid('data_grid.message.preview_sql_failed_detail', { detail: res.message })
                    : translateDataGrid('data_grid.message.preview_sql_failed'));
            }
        } catch (e: any) {
            const rawErrorMessage = e?.message || String(e);
            void message.error(translateDataGrid('data_grid.message.preview_sql_failed_detail', { detail: rawErrorMessage }));
        }
    }, [addedRows, modifiedRows, deletedRowKeys, baseData, effectiveEditLocator,
        visibleColumnNames, rowKeyStr, normalizeCommitCellValue, shouldCommitColumn,
        connectionId, tableName, connections, rowLocatorMessages, translateDataGrid]);
    return {
        tableColumns, handleAddRow, copyRowsForPaste, handlePasteCopiedRowsAsNew,
        handleDeleteSelected, handleUndoDeleteSelected, handlePreviewChanges,
    };
};

export type DataGridRowActionsApi = ReturnType<typeof useDataGridRowActions>;
