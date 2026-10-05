import React, { useCallback, useMemo, useRef, useEffect } from 'react';
import { message } from 'antd';
import {
    resolveContextMenuFieldName,
    GONAVI_ROW_KEY,
    type Item,
    shouldOpenModalEditor,
    getCellFieldName,
    setCellFieldValue,
    normalizeDateTimeString,
    looksLikeJsonText,
} from '../../DataGridCore';
import { isWritableResultColumn } from '../../../utils/rowLocator';
import {
    formatJsonCellText,
    compactJsonCellText,
    escapeCellText,
    unescapeCellText,
} from '../../../utils/dataGridCellTextTransform';
import { getTemporalPickerType, parseToDayjs } from '../../dataGridTemporal';
import { useDataGridPreviewPanel } from '../../useDataGridPreviewPanel';
import { useReportDataGridPendingChanges } from '../../useControllableDataGridSelection';
import { pickDataGridOutputRows } from '../../dataGridOutput';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridCellEditingApi } from './useDataGridCellEditing';
import type { DataGridTableMetricsApi } from './useDataGridTableMetrics';
import type { DataGridColumnTitlesApi } from './useDataGridColumnTitles';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridProps } from '../../DataGridCore';

export interface UseDataGridInlineEditorInput {
    cellContextMenu: DataGridCellEditorStateApi['cellContextMenu'];
    canEditContextMenuCell: DataGridCellEditingApi['canEditContextMenuCell'];
    closeVirtualInlineEditor: DataGridTableMetricsApi['closeVirtualInlineEditor'];
    openCellEditor: DataGridCellEditorStateApi['openCellEditor'];
    setCellContextMenu: DataGridCellEditorStateApi['setCellContextMenu'];
    rowKeyStr: DataGridColumnTitlesApi['rowKeyStr'];
    addedRowKeySet: DataGridCellEditingApi['addedRowKeySet'];
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    modifiedColumns: DataGridTableMetricsApi['modifiedColumns'];
    baseData: DataGridColumnTitlesApi['baseData'];
    handleCellSave: DataGridCellEditingApi['handleCellSave'];
    cellEditorMeta: DataGridCellEditorStateApi['cellEditorMeta'];
    cellEditorApplyRef: DataGridCellEditorStateApi['cellEditorApplyRef'];
    cellEditorValue: DataGridCellEditorStateApi['cellEditorValue'];
    cellEditorRuntimeRef: DataGridCoreStateApi['cellEditorRuntimeRef'];
    isCellEditorSourceCurrent: DataGridCellEditorStateApi['isCellEditorSourceCurrent'];
    closeCellEditor: DataGridCellEditorStateApi['closeCellEditor'];
    handleCellSaveRef: DataGridCellEditingApi['handleCellSaveRef'];
    cellEditorIsJson: DataGridCellEditorStateApi['cellEditorIsJson'];
    cellEditorEscapeApplied: DataGridCellEditorStateApi['cellEditorEscapeApplied'];
    setCellEditorValue: DataGridCellEditorStateApi['setCellEditorValue'];
    setCellEditorEscapeApplied: DataGridCellEditorStateApi['setCellEditorEscapeApplied'];
    isActive: Exclude<DataGridProps['isActive'], undefined>;
    data: DataGridProps['data'];
    connectionId: DataGridProps['connectionId'];
    dbName: DataGridProps['dbName'];
    tableName: DataGridProps['tableName'];
    canModifyData: DataGridCoreStateApi['canModifyData'];
    effectiveEditLocator: DataGridCoreStateApi['effectiveEditLocator'];
    columnMetaMap: DataGridTableMetricsApi['columnMetaMap'];
    columnMetaMapByLowerName: DataGridTableMetricsApi['columnMetaMapByLowerName'];
    dbType: DataGridCoreStateApi['dbType'];
    currentConnConfig: DataGridCoreStateApi['currentConnConfig'];
    form: DataGridCoreStateApi['form'];
    isMongoDBConnection: DataGridCoreStateApi['isMongoDBConnection'];
    mongoAwareEditableText: DataGridCoreStateApi['mongoAwareEditableText'];
    virtualEditingSessionSequenceRef: DataGridCellEditorStateApi['virtualEditingSessionSequenceRef'];
    virtualEditingSessionRef: DataGridCellEditorStateApi['virtualEditingSessionRef'];
    setVirtualEditingCell: DataGridCellEditorStateApi['setVirtualEditingCell'];
    showCellContextMenu: DataGridCellEditorStateApi['showCellContextMenu'];
    displayData: DataGridCellEditingApi['displayData'];
    modifiedRows: DataGridTableMetricsApi['modifiedRows'];
    deletedRowKeys: DataGridTableMetricsApi['deletedRowKeys'];
    mergedDisplayDataRef: DataGridCellEditorStateApi['mergedDisplayDataRef'];
    sessionState: DataGridProps['sessionState'];
    hasChanges: DataGridCellEditingApi['hasChanges'];
    cellEditMode: DataGridCellEditorStateApi['cellEditMode'];
    virtualEditingCell: DataGridCellEditorStateApi['virtualEditingCell'];
    onDataChange: DataGridProps['onDataChange'];
    dataChangeOutputColumnNames: DataGridCoreStateApi['dataChangeOutputColumnNames'];
    connectionParamsOverride: DataGridProps['connectionParamsOverride'];
    resolvedDdlDbName: DataGridCoreStateApi['resolvedDdlDbName'];
    resolvedDdlTableName: DataGridCoreStateApi['resolvedDdlTableName'];
    setAddedRows: DataGridTableMetricsApi['setAddedRows'];
    setModifiedRows: DataGridTableMetricsApi['setModifiedRows'];
    setDeletedRowKeys: DataGridTableMetricsApi['setDeletedRowKeys'];
    setModifiedColumns: DataGridTableMetricsApi['setModifiedColumns'];
    setSelectedRowKeys: DataGridCellEditorStateApi['setSelectedRowKeys'];
    resetCellSelection: DataGridCellEditingApi['resetCellSelection'];
    setCopiedCellPatch: DataGridCellEditorStateApi['setCopiedCellPatch'];
    setCopiedRowsForPaste: DataGridCellEditorStateApi['setCopiedRowsForPaste'];
    closeRowEditor: DataGridCellEditorStateApi['closeRowEditor'];
    viewMode: DataGridColumnTitlesApi['viewMode'];
    resetDdlViewState: DataGridColumnTitlesApi['resetDdlViewState'];
    canViewDdl: DataGridCoreStateApi['canViewDdl'];
    formRef: DataGridCellEditorStateApi['formRef'];
    openCellViewer: DataGridCellEditorStateApi['openCellViewer'];
}

export const useDataGridInlineEditor = ({
    cellContextMenu, canEditContextMenuCell, closeVirtualInlineEditor, openCellEditor,
    setCellContextMenu, rowKeyStr, addedRowKeySet, translateDataGrid, modifiedColumns, baseData,
    handleCellSave, cellEditorMeta, cellEditorApplyRef, cellEditorValue, cellEditorRuntimeRef,
    isCellEditorSourceCurrent, closeCellEditor, handleCellSaveRef, cellEditorIsJson,
    cellEditorEscapeApplied, setCellEditorValue, setCellEditorEscapeApplied, isActive, data,
    connectionId, dbName, tableName, canModifyData, effectiveEditLocator, columnMetaMap,
    columnMetaMapByLowerName, dbType, currentConnConfig, form, isMongoDBConnection,
    mongoAwareEditableText, virtualEditingSessionSequenceRef, virtualEditingSessionRef,
    setVirtualEditingCell, showCellContextMenu, displayData, modifiedRows, deletedRowKeys,
    mergedDisplayDataRef, sessionState, hasChanges, cellEditMode, virtualEditingCell, onDataChange,
    dataChangeOutputColumnNames, connectionParamsOverride, resolvedDdlDbName, resolvedDdlTableName,
    setAddedRows, setModifiedRows, setDeletedRowKeys, setModifiedColumns, setSelectedRowKeys,
    resetCellSelection, setCopiedCellPatch, setCopiedRowsForPaste, closeRowEditor, viewMode,
    resetDdlViewState, canViewDdl, formRef, openCellViewer,
}: UseDataGridInlineEditorInput) => {
    const handleOpenContextMenuCellEditor = useCallback(() => {
      const record = cellContextMenu.record;
      const dataIndex = String(cellContextMenu.dataIndex ?? '');
      if (!canEditContextMenuCell || !record || !dataIndex) return;
      closeVirtualInlineEditor();
      openCellEditor(
        record,
        dataIndex,
        resolveContextMenuFieldName(dataIndex, cellContextMenu.title),
      );
    }, [canEditContextMenuCell, cellContextMenu.dataIndex, cellContextMenu.record, cellContextMenu.title, closeVirtualInlineEditor, openCellEditor, resolveContextMenuFieldName]);

    const handleUndoContextMenuCellChange = useCallback(() => {
      const record = cellContextMenu.record;
      const dataIndex = String(cellContextMenu.dataIndex || '').trim();
      const rowKey = record?.[GONAVI_ROW_KEY];
      if (!record || !dataIndex || rowKey === undefined || rowKey === null) return;

      const keyStr = rowKeyStr(rowKey);
      if (addedRowKeySet.has(keyStr)) {
        void message.info(translateDataGrid('data_grid.message.undo_added_row_hint'));
        setCellContextMenu(prev => ({ ...prev, visible: false }));
        return;
      }
      if (!modifiedColumns[keyStr]?.has(dataIndex)) {
        setCellContextMenu(prev => ({ ...prev, visible: false }));
        return;
      }

      const originalRow = baseData.find((row) => rowKeyStr(row?.[GONAVI_ROW_KEY]) === keyStr);
      if (!originalRow) {
        void message.error(translateDataGrid('data_grid.message.undo_cell_original_missing'));
        setCellContextMenu(prev => ({ ...prev, visible: false }));
        return;
      }

      handleCellSave({ ...record, [dataIndex]: originalRow[dataIndex] });
      setCellContextMenu(prev => ({ ...prev, visible: false }));
      void message.success(translateDataGrid('data_grid.message.undo_cell_success'));
    }, [addedRowKeySet, baseData, cellContextMenu.dataIndex, cellContextMenu.record, handleCellSave, modifiedColumns, rowKeyStr, translateDataGrid]);

    const handleCellEditorSave = useCallback(() => {
        if (!cellEditorMeta) return;
        const runtime = cellEditorRuntimeRef.current;
        if (!runtime.isActive || !isCellEditorSourceCurrent()) {
            closeCellEditor();
            return;
        }
        if (
            cellEditorMeta.readOnly
            || !runtime.canModifyData
            || !isWritableResultColumn(cellEditorMeta.dataIndex, runtime.effectiveEditLocator)
        ) {
            closeCellEditor();
            return;
        }
        const apply = cellEditorApplyRef.current;
        if (apply) {
            apply(cellEditorValue);
            closeCellEditor();
            return;
        }
        const nextRow: any = { ...cellEditorMeta.record, [cellEditorMeta.dataIndex]: cellEditorValue };
        handleCellSaveRef.current(nextRow);
        closeCellEditor();
    }, [cellEditorMeta, cellEditorValue, closeCellEditor, isCellEditorSourceCurrent]);

    const handleFormatJsonInEditor = useCallback(() => {
        if (!cellEditorIsJson || cellEditorEscapeApplied) return;
        try {
            setCellEditorValue(formatJsonCellText(cellEditorValue));
        } catch (e: any) {
            const rawErrorMessage = e?.message || String(e);
            void message.error(translateDataGrid('data_grid.json_editor.invalid_format', { error: rawErrorMessage }));
        }
    }, [cellEditorEscapeApplied, cellEditorIsJson, cellEditorValue, translateDataGrid]);

    const handleCompactJsonInEditor = useCallback(() => {
        if (!cellEditorIsJson || cellEditorEscapeApplied) return;
        try {
            setCellEditorValue(compactJsonCellText(cellEditorValue));
        } catch (e: any) {
            const rawErrorMessage = e?.message || String(e);
            void message.error(translateDataGrid('data_grid.json_editor.invalid_format', { error: rawErrorMessage }));
        }
    }, [cellEditorEscapeApplied, cellEditorIsJson, cellEditorValue, translateDataGrid]);

    const handleEscapeCellEditorValue = useCallback(() => {
        if (cellEditorEscapeApplied) return;
        setCellEditorValue(escapeCellText(cellEditorValue));
        setCellEditorEscapeApplied(true);
    }, [cellEditorEscapeApplied, cellEditorValue, setCellEditorEscapeApplied, setCellEditorValue]);

    const handleUnescapeCellEditorValue = useCallback(() => {
        try {
            setCellEditorValue(unescapeCellText(cellEditorValue));
            setCellEditorEscapeApplied(false);
        } catch (e: any) {
            const rawErrorMessage = e?.message || String(e);
            void message.error(translateDataGrid('data_grid.cell_editor.invalid_unescape', { error: rawErrorMessage }));
        }
    }, [cellEditorValue, setCellEditorEscapeApplied, setCellEditorValue, translateDataGrid]);

    const handleCellEditorValueChange = useCallback((value: string) => {
        setCellEditorValue(value);
        setCellEditorEscapeApplied(false);
    }, [setCellEditorEscapeApplied, setCellEditorValue]);

    const openVirtualInlineEditor = useCallback((record: Item, dataIndex: string, title: React.ReactNode) => {
        if (
            !record
            || !dataIndex
            || !isActive
            || !canModifyData
            || !isWritableResultColumn(dataIndex, effectiveEditLocator)
        ) {
            return;
        }
        const rowKey = record?.[GONAVI_ROW_KEY];
        if (rowKey === undefined || rowKey === null) return;

        closeVirtualInlineEditor();

        const raw = record?.[dataIndex];
        if (shouldOpenModalEditor(raw)) {
            openCellEditor(record, dataIndex, title);
            return;
        }

        const columnType = (columnMetaMap[dataIndex] || columnMetaMapByLowerName[dataIndex.toLowerCase()])?.type;
        const pickerType = getTemporalPickerType(columnType, dbType, currentConnConfig);
        const isDateTimeField = !!pickerType && !(/^0{4}-0{2}-0{2}/.test(String(raw || '')));
        const fieldName = getCellFieldName(record, dataIndex);
        if (isDateTimeField) {
            setCellFieldValue(form, fieldName, parseToDayjs(raw, pickerType));
        } else {
            const initialValue = isMongoDBConnection
                ? mongoAwareEditableText(raw, dataIndex)
                : (typeof raw === 'string' ? normalizeDateTimeString(raw) : raw);
            setCellFieldValue(form, fieldName, initialValue);
        }
        const rowKeyText = rowKeyStr(rowKey);
        const sessionId = virtualEditingSessionSequenceRef.current + 1;
        virtualEditingSessionSequenceRef.current = sessionId;
        virtualEditingSessionRef.current = {
            sessionId,
            sourceData: data,
            connectionId,
            dbName,
            tableName,
            rowKey: rowKeyText,
            dataIndex,
        };
        setVirtualEditingCell({
            sessionId,
            rowKey: rowKeyText,
            dataIndex,
            title,
            columnType,
        });
    }, [canModifyData, closeVirtualInlineEditor, columnMetaMap, columnMetaMapByLowerName, connectionId, currentConnConfig, data, dbName, dbType, effectiveEditLocator, form, isActive, isMongoDBConnection, mongoAwareEditableText, openCellEditor, rowKeyStr, tableName]);

    const handleVirtualCellActivate = useCallback((record: Item, dataIndex: string, title: React.ReactNode) => {
        if (!canModifyData) return;
        openVirtualInlineEditor(record, dataIndex, title);
    }, [canModifyData, openVirtualInlineEditor]);

    const handleVirtualCellContextMenu = useCallback((e: React.MouseEvent, record: Item, dataIndex: string) => {
        e.preventDefault();
        e.stopPropagation();
        showCellContextMenu(e, record, dataIndex, dataIndex);
    }, [showCellContextMenu]);

    // Merge Data for Display
    // 'displayData' already merges addedRows.
    // We need to merge modifiedRows into it for rendering.
    const mergedDisplayData = useMemo(() => {
        return displayData.map(row => {
            const k = row?.[GONAVI_ROW_KEY];
            const keyStr = k !== undefined ? rowKeyStr(k) : undefined;
            let result = row;
            if (keyStr !== undefined && modifiedRows[keyStr]) {
                result = { ...row, ...modifiedRows[keyStr] };
            }
            if (keyStr !== undefined && deletedRowKeys.has(keyStr)) {
                // 为已删除行创建新对象引用，确保 Ant Design 数据源检测到变化并触发行重渲染
                // 仅当 result 尚未被 modifiedRows 分支重新分配时才创建新引用
                result = result === row ? { ...row } : result;
            }
            return result;
        });
    }, [displayData, modifiedRows, deletedRowKeys]);
    mergedDisplayDataRef.current = mergedDisplayData;
    const {
        dataPanelOpen,
        dataPanelOpenRef,
        focusedCellInfo,
        dataPanelValue,
        setDataPanelValue,
        dataPanelIsJson,
        dataPanelDirtyRef,
        dataPanelOriginalRef,
        toggleDataPanel,
        updateFocusedCell,
        handleDataPanelFormatJson,
    } = useDataGridPreviewPanel({
        previewAvailable: mergedDisplayData.length > 0,
        toEditableText: mongoAwareEditableText,
        looksLikeJsonText,
        normalizeDateTimeString,
    });
    useReportDataGridPendingChanges(hasChanges || cellEditMode || virtualEditingCell !== null || dataPanelDirtyRef.current, sessionState?.onPendingChangesChange);
    const focusedCellWritable = useMemo(() => (
        canModifyData &&
        !!focusedCellInfo &&
        isWritableResultColumn(focusedCellInfo.dataIndex, effectiveEditLocator)
    ), [canModifyData, focusedCellInfo, effectiveEditLocator]);
    const handleDataPanelSave = useCallback((): boolean => {
        if (!focusedCellInfo) return false;
        if (!focusedCellWritable) {
            void message.info(translateDataGrid('data_grid.message.current_field_not_editable'));
            return false;
        }
        // 与 updateFocusedCell 设置的原始值比较，避免幽灵变更
        if (dataPanelValue === dataPanelOriginalRef.current) {
            dataPanelDirtyRef.current = false;
            void message.info(translateDataGrid('data_grid.message.no_data_changes'));
            return true;
        }
        const nextRow: any = { ...focusedCellInfo.record, [focusedCellInfo.dataIndex]: dataPanelValue };
        handleCellSave(nextRow);
        dataPanelOriginalRef.current = dataPanelValue;
        dataPanelDirtyRef.current = false;
        void message.success(translateDataGrid('data_grid.message.saved'));
        return true;
    }, [focusedCellInfo, focusedCellWritable, dataPanelValue, handleCellSave, translateDataGrid]);
    const lastReportedDataFingerprintRef = useRef('');
    useEffect(() => {
        if (!onDataChange) return;
        const currentRows = mergedDisplayData.filter((row) => {
            const rowKey = row?.[GONAVI_ROW_KEY];
            return rowKey === undefined || !deletedRowKeys.has(rowKeyStr(rowKey));
        });
        // A hidden column is still part of the result snapshot. Only presentation
        // uses displayOutputColumnNames; detach/attach state must keep full rows.
        const outputRows = pickDataGridOutputRows(currentRows, dataChangeOutputColumnNames);
        const fingerprint = JSON.stringify(outputRows);
        if (fingerprint === lastReportedDataFingerprintRef.current) return;
        lastReportedDataFingerprintRef.current = fingerprint;
        onDataChange(outputRows);
    }, [dataChangeOutputColumnNames, deletedRowKeys, mergedDisplayData, onDataChange, rowKeyStr]);

    const dataSourceContextKey = useMemo(
        () => `${connectionId || ''}\u0001${dbName || ''}\u0001${tableName || ''}\u0001${resolvedDdlDbName || ''}\u0001${resolvedDdlTableName || ''}\u0001${connectionParamsOverride || ''}`,
        [connectionId, connectionParamsOverride, dbName, resolvedDdlDbName, resolvedDdlTableName, tableName],
    );
    const previousDataSourceContextKeyRef = useRef<string | null>(dataSourceContextKey);

    // Reset local state when data source likely changes (e.g. tableName change)
    useEffect(() => {
        const previousContextKey = previousDataSourceContextKeyRef.current;
        const contextChanged = previousContextKey !== dataSourceContextKey;
        previousDataSourceContextKeyRef.current = dataSourceContextKey;
        if (!contextChanged) return;

        setAddedRows([]);
        setModifiedRows({});
        setDeletedRowKeys(new Set());
        setModifiedColumns({});
        setSelectedRowKeys([]);
        resetCellSelection();
        setCopiedCellPatch(null);
        setCopiedRowsForPaste([]);
        closeRowEditor();
        const shouldKeepOpenV2DdlView = previousContextKey !== null
            && viewMode === 'ddl'
            && canViewDdl
            && !!currentConnConfig
            && !!resolvedDdlTableName;
        if (!shouldKeepOpenV2DdlView && previousContextKey !== null) {
            resetDdlViewState();
        }
        closeVirtualInlineEditor();
        closeCellEditor();
        formRef.current.resetFields();
    }, [
        canViewDdl,
        closeCellEditor,
        closeRowEditor,
        closeVirtualInlineEditor,
        currentConnConfig,
        dataSourceContextKey,
        resetCellSelection,
        resetDdlViewState,
        resolvedDdlTableName,
        viewMode,
    ]); // Reset on context change

    const mergedDisplayDataByRowKey = useMemo(() => {
        const next = new Map<string, Item>();
        mergedDisplayData.forEach((row) => {
            const key = row?.[GONAVI_ROW_KEY];
            if (key === undefined || key === null) return;
            next.set(rowKeyStr(key), row);
        });
        return next;
    }, [mergedDisplayData, rowKeyStr]);
    const mergedDisplayDataByRowKeyRef = useRef(mergedDisplayDataByRowKey);
    mergedDisplayDataByRowKeyRef.current = mergedDisplayDataByRowKey;

    const resolveRenderedCellInfoFromElement = useCallback((target: EventTarget | null) => {
        const closestSource = target && typeof target === 'object' && 'closest' in target
            ? target as { closest?: (selector: string) => { getAttribute?: (name: string) => string | null } | null }
            : null;
        const element = typeof closestSource?.closest === 'function'
            ? closestSource.closest('[data-row-key][data-col-name]')
            : null;
        if (!element) {
            return null;
        }
        const rowKey = element.getAttribute?.('data-row-key');
        const dataIndex = element.getAttribute?.('data-col-name');
        if (rowKey === null || rowKey === undefined || rowKey === '' || dataIndex === null || dataIndex === undefined) {
            return null;
        }
        const record = mergedDisplayDataByRowKeyRef.current.get(rowKey);
        if (!record) {
            return null;
        }
        return { rowKey, dataIndex, record };
    }, []);

    const handleSharedCellContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
        const eventTarget = (event.currentTarget as EventTarget | null) ?? event.target;
        const cellInfo = resolveRenderedCellInfoFromElement(eventTarget);
        if (!cellInfo) return;
        event.preventDefault();
        event.stopPropagation();
        showCellContextMenu(event, cellInfo.record, cellInfo.dataIndex, cellInfo.dataIndex);
    }, [resolveRenderedCellInfoFromElement, showCellContextMenu]);

    const handleSharedCellDoubleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
        const eventTarget = (event.currentTarget as EventTarget | null) ?? event.target;
        const cellInfo = resolveRenderedCellInfoFromElement(eventTarget);
        if (!cellInfo) return;
        event.preventDefault();
        event.stopPropagation();
        openCellViewer(cellInfo.record, cellInfo.dataIndex, cellInfo.dataIndex);
    }, [openCellViewer, resolveRenderedCellInfoFromElement]);

    const handleVirtualTableClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (!dataPanelOpenRef.current) return;
        const cellInfo = resolveRenderedCellInfoFromElement(event.target);
        if (!cellInfo) return;
        updateFocusedCell(cellInfo.record, cellInfo.dataIndex);
    }, [resolveRenderedCellInfoFromElement, updateFocusedCell]);

    const handleVirtualTableDoubleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const eventTarget = event.target && typeof event.target === 'object' && 'closest' in event.target
            ? event.target as { closest?: (selector: string) => unknown }
            : null;
        if (typeof eventTarget?.closest === 'function' && eventTarget.closest('.data-grid-virtual-inline-editing')) {
            return;
        }
        const cellInfo = resolveRenderedCellInfoFromElement(event.target);
        if (!cellInfo) return;
        const rowDeleted = cellInfo.record?.[GONAVI_ROW_KEY] !== undefined
            ? deletedRowKeys.has(rowKeyStr(cellInfo.record[GONAVI_ROW_KEY]))
            : false;
        if (rowDeleted) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (!canModifyData || !isWritableResultColumn(cellInfo.dataIndex, effectiveEditLocator)) {
            openCellViewer(cellInfo.record, cellInfo.dataIndex, cellInfo.dataIndex);
            return;
        }
        handleVirtualCellActivate(cellInfo.record, cellInfo.dataIndex, cellInfo.dataIndex);
    }, [canModifyData, deletedRowKeys, effectiveEditLocator, handleVirtualCellActivate, openCellViewer, resolveRenderedCellInfoFromElement, rowKeyStr]);

    const handleVirtualTableContextMenuCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const cellInfo = resolveRenderedCellInfoFromElement(event.target);
        if (!cellInfo) return;
        event.preventDefault();
        event.stopPropagation();
        showCellContextMenu(event, cellInfo.record, cellInfo.dataIndex, cellInfo.dataIndex);
    }, [resolveRenderedCellInfoFromElement, showCellContextMenu]);
    return {
        handleOpenContextMenuCellEditor, handleUndoContextMenuCellChange, handleCellEditorSave,
        handleFormatJsonInEditor, handleCompactJsonInEditor, handleEscapeCellEditorValue,
        handleUnescapeCellEditorValue, handleCellEditorValueChange, handleVirtualCellActivate,
        handleVirtualCellContextMenu, mergedDisplayData, dataPanelOpen, dataPanelOpenRef,
        focusedCellInfo, dataPanelValue, setDataPanelValue, dataPanelIsJson, dataPanelDirtyRef,
        dataPanelOriginalRef, toggleDataPanel, updateFocusedCell, handleDataPanelFormatJson,
        focusedCellWritable, handleDataPanelSave, mergedDisplayDataByRowKeyRef,
        handleSharedCellContextMenu, handleSharedCellDoubleClick, handleVirtualTableClickCapture,
        handleVirtualTableDoubleClickCapture, handleVirtualTableContextMenuCapture,
    };
};

export type DataGridInlineEditorApi = ReturnType<typeof useDataGridInlineEditor>;
