import React, { useMemo, useCallback, useRef, useEffect } from 'react';
import { message, type InputRef } from 'antd';
import { useDataGridFilters } from '../../useDataGridFilters';
import {
    resolveDefaultGridFilterOperator,
    resolveNextGridFilterOperatorForColumnChange,
    type GridViewMode,
    makeCellKey,
} from '../../DataGridCore';
import { normalizeMongoDocumentForEditing } from '../../../utils/mongodb';
import {
    countGridColumnValues,
    filterRowsByGridConditions,
} from '../../../utils/dataGridClientFilter';
import DataGridColumnTitle, { type DataGridColumnFilterDraft } from '../../DataGridColumnTitle';
import { useDataGridDdlView } from '../../useDataGridDdlView';
import { isEditableElement, isShortcutMatch } from '../../../utils/shortcuts';
import { syncDataGridCellSelectionVisuals } from '../../dataGridCellHighlight';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridTableMetricsApi } from './useDataGridTableMetrics';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridProps } from '../../DataGridCore';

export interface UseDataGridColumnTitlesInput {
    appliedFilterConditions: DataGridProps['appliedFilterConditions'];
    quickWhereCondition: DataGridProps['quickWhereCondition'];
    showFilter: DataGridProps['showFilter'];
    onApplyFilter: DataGridProps['onApplyFilter'];
    onApplyQuickWhereCondition: DataGridProps['onApplyQuickWhereCondition'];
    onSort: DataGridProps['onSort'];
    displayColumnNames: DataGridCoreStateApi['displayColumnNames'];
    allTableColumnNames: DataGridTableMetricsApi['allTableColumnNames'];
    columnMetaMap: DataGridTableMetricsApi['columnMetaMap'];
    getColumnFilterType: DataGridTableMetricsApi['getColumnFilterType'];
    dbType: DataGridCoreStateApi['dbType'];
    darkMode: DataGridCoreStateApi['darkMode'];
    dataGridFilterMessageApi: DataGridCoreStateApi['dataGridFilterMessageApi'];
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    data: DataGridProps['data'];
    isMongoDBConnection: DataGridCoreStateApi['isMongoDBConnection'];
    addedRows: DataGridTableMetricsApi['addedRows'];
    exportScope: Exclude<DataGridProps['exportScope'], undefined>;
    columnMetaMapByLowerName: DataGridTableMetricsApi['columnMetaMapByLowerName'];
    foreignKeyMap: DataGridTableMetricsApi['foreignKeyMap'];
    foreignKeyMapByLowerName: DataGridTableMetricsApi['foreignKeyMapByLowerName'];
    showColumnType: DataGridCoreStateApi['showColumnType'];
    showColumnComment: DataGridCoreStateApi['showColumnComment'];
    densityParams: DataGridCoreStateApi['densityParams'];
    columnMetaHintColor: DataGridCoreStateApi['columnMetaHintColor'];
    columnMetaTooltipColor: DataGridCoreStateApi['columnMetaTooltipColor'];
    highlightedColumnName: DataGridCoreStateApi['highlightedColumnName'];
    pinnedLeftColumnSet: DataGridCoreStateApi['pinnedLeftColumnSet'];
    openForeignKeyTarget: DataGridTableMetricsApi['openForeignKeyTarget'];
    selectedRowKeys: DataGridCellEditorStateApi['selectedRowKeys'];
    pendingScrollToBottomRef: DataGridCellEditorStateApi['pendingScrollToBottomRef'];
    scrollTableBodyToBottom: DataGridCellEditorStateApi['scrollTableBodyToBottom'];
    isActive: Exclude<DataGridProps['isActive'], undefined>;
    initialViewMode: DataGridProps['initialViewMode'];
    initialViewModeRequestId: DataGridProps['initialViewModeRequestId'];
    initialViewModeScope: DataGridProps['initialViewModeScope'];
    canViewDdl: DataGridCoreStateApi['canViewDdl'];
    currentConnConfig: DataGridCoreStateApi['currentConnConfig'];
    resolvedDdlDbName: DataGridCoreStateApi['resolvedDdlDbName'];
    resolvedDdlTableName: DataGridCoreStateApi['resolvedDdlTableName'];
    cellEditMode: DataGridCellEditorStateApi['cellEditMode'];
    mergedDisplayDataRef: DataGridCellEditorStateApi['mergedDisplayDataRef'];
    closeCellEditModeRef: DataGridCellEditorStateApi['closeCellEditModeRef'];
    setTextRecordIndex: DataGridCoreStateApi['setTextRecordIndex'];
    activeShortcutPlatform: DataGridCoreStateApi['activeShortcutPlatform'];
    pageFindInputRef: DataGridCellEditorStateApi['pageFindInputRef'];
    setPageFindOpen: DataGridCoreStateApi['setPageFindOpen'];
    setPageFindText: DataGridCoreStateApi['setPageFindText'];
    setActivePageFindMatchIndex: DataGridCoreStateApi['setActivePageFindMatchIndex'];
    rootRef: DataGridCellEditorStateApi['rootRef'];
    connectionId: DataGridProps['connectionId'];
    dbName: DataGridProps['dbName'];
    schemaName: DataGridProps['schemaName'];
    tableName: DataGridProps['tableName'];
    enableSqlLogEvent: Exclude<DataGridProps['enableSqlLogEvent'], undefined>;
    onDataViewActivate: DataGridProps['onDataViewActivate'];
    cellContextMenu: DataGridCellEditorStateApi['cellContextMenu'];
    setCellContextMenu: DataGridCellEditorStateApi['setCellContextMenu'];
    cellContextMenuPortalRef: DataGridCellEditorStateApi['cellContextMenuPortalRef'];
    resolveContextMenuPosition: DataGridCellEditorStateApi['resolveContextMenuPosition'];
    cellEditModeRef: DataGridCellEditorStateApi['cellEditModeRef'];
    containerRef: DataGridCellEditorStateApi['containerRef'];
    selectionStartRef: DataGridCellEditorStateApi['selectionStartRef'];
    cellSelectionSourceDataRef: DataGridCellEditorStateApi['cellSelectionSourceDataRef'];
    setCellSelectionDeleteEligible: DataGridCellEditorStateApi['setCellSelectionDeleteEligible'];
    cellSelectionUserSourceDataRef: DataGridCellEditorStateApi['cellSelectionUserSourceDataRef'];
}

export const useDataGridColumnTitles = ({
    appliedFilterConditions, quickWhereCondition, showFilter, onApplyFilter,
    onApplyQuickWhereCondition, onSort, displayColumnNames, allTableColumnNames, columnMetaMap,
    getColumnFilterType, dbType, darkMode, dataGridFilterMessageApi, translateDataGrid, data,
    isMongoDBConnection, addedRows, exportScope, columnMetaMapByLowerName, foreignKeyMap,
    foreignKeyMapByLowerName, showColumnType, showColumnComment, densityParams, columnMetaHintColor,
    columnMetaTooltipColor, highlightedColumnName, pinnedLeftColumnSet, openForeignKeyTarget,
    selectedRowKeys, pendingScrollToBottomRef, scrollTableBodyToBottom, isActive, initialViewMode,
    initialViewModeRequestId, initialViewModeScope, canViewDdl, currentConnConfig,
    resolvedDdlDbName, resolvedDdlTableName, cellEditMode, mergedDisplayDataRef,
    closeCellEditModeRef, setTextRecordIndex, activeShortcutPlatform, pageFindInputRef,
    setPageFindOpen, setPageFindText, setActivePageFindMatchIndex, rootRef, connectionId, dbName,
    schemaName, tableName, enableSqlLogEvent, onDataViewActivate, cellContextMenu,
    setCellContextMenu, cellContextMenuPortalRef, resolveContextMenuPosition, cellEditModeRef,
    containerRef, selectionStartRef, cellSelectionSourceDataRef, setCellSelectionDeleteEligible,
    cellSelectionUserSourceDataRef,
}: UseDataGridColumnTitlesInput) => {
    const {
        filterConditions,
        setFilterConditions,
        quickWhereDraft,
        setQuickWhereDraft,
        quickWhereSuggestionsOpen,
        setQuickWhereSuggestionsOpen,
        filterPanelRef,
        filterOpOptions,
        filterLogicOptions,
        quickWhereSuggestionOptions,
        handleQuickWherePaste,
        stopQuickWhereClipboardPropagation,
        isNoValueOp,
        isBetweenOp,
        isListOp,
        addFilter,
        updateFilter,
        removeFilter,
        applyColumnFilter,
        clearColumnFilter,
        applyQuickWhereCondition,
        clearQuickWhereCondition,
        clearAllFiltersAndSorts,
        applyFilters,
        applyAllFiltersEnabled,
        applyAllFiltersDisabled,
    } = useDataGridFilters({
        appliedFilterConditions,
        quickWhereCondition,
        showFilter,
        displayColumnNames,
        allTableColumnNames,
        columnMetaMap,
        dbType,
        darkMode,
        onApplyFilter,
        onApplyQuickWhereCondition,
        onSort,
        messageApi: dataGridFilterMessageApi,
        translate: translateDataGrid,
        getColumnFilterType,
        resolveDefaultGridFilterOperator,
        resolveNextGridFilterOperatorForColumnChange,
    });

    // 表数据页：服务端筛选（onApplyFilter）；查询结果页：列头筛选 + 客户端过滤当前结果
    const baseData = useMemo(() => (
        isMongoDBConnection
            ? data.map((row) => normalizeMongoDocumentForEditing(row))
            : data
    ), [data, isMongoDBConnection]);
    const rowsBeforeClientFilter = useMemo(() => [...baseData, ...addedRows], [addedRows, baseData]);
    const getCurrentColumnValueCounts = useMemo(() => {
        const cache = new Map<string, ReturnType<typeof countGridColumnValues>>();
        return (columnName: string) => {
            const cached = cache.get(columnName);
            if (cached) return cached;
            const rowsForValueCounts = exportScope === 'queryResult'
                ? filterRowsByGridConditions(rowsBeforeClientFilter, filterConditions.filter((condition) => (
                    String(condition?.column || '') !== columnName
                )))
                : rowsBeforeClientFilter;
            const counts = countGridColumnValues(rowsForValueCounts, columnName);
            cache.set(columnName, counts);
            return counts;
        };
    }, [exportScope, filterConditions, rowsBeforeClientFilter]);
    const columnHeaderFilterEnabled = !!onApplyFilter || exportScope === 'queryResult';
    const columnHeaderFilterOpOptions = useMemo(
        () => filterOpOptions.filter((option) => option.value !== 'CUSTOM'),
        [filterOpOptions],
    );
    const getColumnHeaderFilterState = useCallback((columnName: string) => {
        const normalizedName = String(columnName || '').trim();
        const columnFilterConditions = filterConditions.filter((cond) => (
            String(cond?.column || '') === normalizedName && String(cond?.op || '') !== 'CUSTOM'
        ));
        const firstCondition = columnFilterConditions[0];
        const defaultOperator = resolveDefaultGridFilterOperator(getColumnFilterType(normalizedName));
        return {
            active: columnFilterConditions.some((cond) => cond.enabled !== false),
            defaultOperator,
            initialOperator: String(firstCondition?.op || defaultOperator),
            initialValue: String(firstCondition?.value ?? ''),
            initialValue2: String(firstCondition?.value2 ?? ''),
            initialValueSelection: firstCondition?.valueSelection,
        };
    }, [filterConditions, getColumnFilterType]);

    const applyColumnHeaderFilter = useCallback((columnName: string, draft: DataGridColumnFilterDraft) => {
        return applyColumnFilter({
            column: columnName,
            op: draft.op,
            value: draft.value,
            value2: draft.value2,
            valueSelection: draft.valueSelection,
        });
    }, [applyColumnFilter]);

    const renderColumnTitle = useCallback((name: string): React.ReactNode => {
        const normalizedName = String(name || '');
        const meta = columnMetaMap[normalizedName] || columnMetaMapByLowerName[normalizedName.toLowerCase()];
        const foreignKeyTarget = foreignKeyMap[normalizedName] || foreignKeyMapByLowerName[normalizedName.toLowerCase()];
        const columnFilterState = columnHeaderFilterEnabled ? getColumnHeaderFilterState(normalizedName) : null;

        return (
            <DataGridColumnTitle
                columnName={normalizedName}
                columnMeta={meta}
                foreignKeyTarget={foreignKeyTarget}
                showColumnType={showColumnType}
                showColumnComment={showColumnComment}
                metaFontSize={densityParams.metaFontSize}
                columnMetaHintColor={columnMetaHintColor}
                columnMetaTooltipColor={columnMetaTooltipColor}
                darkMode={darkMode}
                highlighted={highlightedColumnName === normalizedName}
                pinnedLeft={pinnedLeftColumnSet.has(normalizedName)}
                translate={translateDataGrid}
                onOpenForeignKey={foreignKeyTarget ? () => openForeignKeyTarget(foreignKeyTarget) : undefined}
                loadCurrentValueCounts={() => getCurrentColumnValueCounts(normalizedName)}
                columnFilter={columnFilterState ? {
                    active: columnFilterState.active,
                    operatorOptions: columnHeaderFilterOpOptions,
                    defaultOperator: columnFilterState.defaultOperator,
                    initialOperator: columnFilterState.initialOperator,
                    initialValue: columnFilterState.initialValue,
                    initialValue2: columnFilterState.initialValue2,
                    initialValueSelection: columnFilterState.initialValueSelection,
                    filterLabel: translateDataGrid('data_grid.toolbar.filter'),
                    applyLabel: translateDataGrid('data_grid.filter.apply'),
                    clearLabel: translateDataGrid('data_grid.filter.clear'),
                    valuePlaceholder: translateDataGrid('data_grid.filter.start_value_placeholder'),
                    secondValuePlaceholder: translateDataGrid('data_grid.filter.end_value_placeholder'),
                    listValuePlaceholder: translateDataGrid('data_grid.filter.list_values_placeholder'),
                    noValuePlaceholder: translateDataGrid('data_grid.filter.no_value_placeholder'),
                    isNoValueOp,
                    isBetweenOp,
                    isListOp,
                    onApply: (draft) => applyColumnHeaderFilter(normalizedName, draft),
                    onClear: () => clearColumnFilter(normalizedName),
                } : null}
            />
        );
    }, [
        applyColumnHeaderFilter,
        clearColumnFilter,
        columnHeaderFilterEnabled,
        columnHeaderFilterOpOptions,
        columnMetaHintColor,
        columnMetaTooltipColor,
        columnMetaMap,
        columnMetaMapByLowerName,
        darkMode,
        densityParams.metaFontSize,
        foreignKeyMap,
        foreignKeyMapByLowerName,
        getColumnHeaderFilterState,
        getCurrentColumnValueCounts,
        highlightedColumnName,
        isBetweenOp,
        isListOp,
        isNoValueOp,
        openForeignKeyTarget,
        pinnedLeftColumnSet,
        showColumnComment,
        showColumnType,
        translateDataGrid,
    ]);
    const selectedRowKeysRef = useRef(selectedRowKeys);
    const displayDataRef = useRef<any[]>([]);

    useEffect(() => { selectedRowKeysRef.current = selectedRowKeys; }, [selectedRowKeys]);

    useEffect(() => {
        if (!pendingScrollToBottomRef.current) return;
        pendingScrollToBottomRef.current = false;
        // 等待 Table 渲染出新增行后再滚动到底部（virtual 模式也适用）
        requestAnimationFrame(() => {
            scrollTableBodyToBottom();
            requestAnimationFrame(() => scrollTableBodyToBottom());
        });
    }, [addedRows.length, scrollTableBodyToBottom]);

    const rowKeyStr = useCallback((k: React.Key) => String(k), []);

    const {
        viewMode,
        setViewMode,
        ddlModalOpen,
        setDdlModalOpen,
        ddlLoading,
        ddlText,
        ddlViewLayout,
        setDdlViewLayout,
        ddlSidebarWidth,
        ddlSidebarResizePreviewX,
        ddlRequestSeqRef,
        isTableSurfaceActive,
        handleOpenTableDdl,
        handleViewModeChange,
        handleDdlSidebarResizeStart,
        resetDdlViewState,
        closeDdlView,
    } = useDataGridDdlView({
        canViewDdl,
        currentConnConfig,
        dbName: resolvedDdlDbName,
        dbType,
        tableName: resolvedDdlTableName,
        isActive,
        cellEditMode,
        selectedRowKeys,
        mergedDisplayDataRef,
        rowKeyStr,
        closeCellEditModeRef,
        setTextRecordIndex,
        messageApi: {
            error: (content) => {
                void message.error(content);
            },
        },
        translate: translateDataGrid,
        initialViewMode,
        initialViewModeRequestId,
        initialViewModeScope,
    });

    const pageFindShortcutCombo = activeShortcutPlatform === 'mac' ? 'Meta+F' : 'Ctrl+F';

    const focusPageFindInput = useCallback(() => {
        requestAnimationFrame(() => {
            const inputHandle = pageFindInputRef.current as (InputRef & HTMLInputElement) | null;
            const input = inputHandle?.input ?? inputHandle;
            input?.focus?.({ preventScroll: true });
            input?.select?.();
        });
    }, []);

    const handleOpenPageFind = useCallback(() => {
        setPageFindOpen(true);
        focusPageFindInput();
    }, [focusPageFindInput]);

    const handleClosePageFind = useCallback(() => {
        setPageFindOpen(false);
        setPageFindText('');
        setActivePageFindMatchIndex(-1);
        requestAnimationFrame(() => {
            rootRef.current?.focus({ preventScroll: true });
        });
    }, []);

    const handleDataGridRootPointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (isEditableElement(event.target)) return;
        event.currentTarget.focus({ preventScroll: true });
    }, []);

    useEffect(() => {
        if (isActive && viewMode === 'table') return;
        setPageFindOpen(false);
        setPageFindText('');
        setActivePageFindMatchIndex(-1);
    }, [isActive, viewMode]);

    useEffect(() => {
        if (!isActive || viewMode !== 'table') return;

        const handlePageFindShortcut = (event: KeyboardEvent) => {
            if (!isShortcutMatch(event, pageFindShortcutCombo)) return;

            const root = rootRef.current;
            const eventTarget = event.target;
            const targetNode = typeof Node !== 'undefined' && eventTarget instanceof Node
                ? eventTarget
                : null;
            const targetElement = eventTarget
                && typeof (eventTarget as Element).closest === 'function'
                ? eventTarget as Element
                : null;
            const activeElement = document.activeElement;
            const eventTargetInGrid = !!(root && targetNode && root.contains(targetNode));
            const activeElementInGrid = !!(root && activeElement && root.contains(activeElement));
            const isDocumentLevelTarget = eventTarget === window
                || eventTarget === document
                || eventTarget === document.body
                || eventTarget === document.documentElement;
            const hasGridShortcutContext = eventTargetInGrid
                || activeElementInGrid
                || (exportScope === 'table' && isDocumentLevelTarget);
            if (!hasGridShortcutContext) return;

            const isPageFindInput = !!targetElement?.closest('[data-grid-page-find="true"]');
            if (
                !isPageFindInput
                && (isEditableElement(event.target) || isEditableElement(activeElement))
            ) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            handleOpenPageFind();
        };

        window.addEventListener('keydown', handlePageFindShortcut, true);
        return () => {
            window.removeEventListener('keydown', handlePageFindShortcut, true);
        };
    }, [
        exportScope,
        handleOpenPageFind,
        isActive,
        pageFindShortcutCombo,
        viewMode,
    ]);

    useEffect(() => {
        const handleExternalViewModeChange = (event: Event) => {
            const detail = (event as CustomEvent<any>)?.detail || {};
            if (String(detail.connectionId || '') !== String(connectionId || '')) return;
            if (String(detail.dbName || '') !== String(dbName || '')) return;
            if (String(detail.schemaName || '').trim() !== String(schemaName || '').trim()) return;
            if (String(detail.tableName || '') !== String(tableName || '')) return;
            const nextMode = String(detail.viewMode || '').trim();
            if (!nextMode) return;
            if (!['table', 'json', 'text', 'fields', 'ddl', 'er', 'sqlLog'].includes(nextMode)) return;
            handleViewModeChange(nextMode as GridViewMode);
        };

        window.addEventListener('gonavi:data-grid:set-view-mode', handleExternalViewModeChange as EventListener);
        return () => window.removeEventListener('gonavi:data-grid:set-view-mode', handleExternalViewModeChange as EventListener);
    }, [connectionId, dbName, handleViewModeChange, schemaName, tableName]);

    useEffect(() => {
        if (!enableSqlLogEvent || !isActive) return;
        const handleOpenSqlExecutionLog = () => {
            handleViewModeChange('sqlLog');
        };

        window.addEventListener('gonavi:show-sql-execution-log', handleOpenSqlExecutionLog as EventListener);
        return () => window.removeEventListener('gonavi:show-sql-execution-log', handleOpenSqlExecutionLog as EventListener);
    }, [enableSqlLogEvent, handleViewModeChange, isActive]);

    const dataViewActiveRef = useRef(false);
    useEffect(() => {
        const requiresTableData = isActive && (
            viewMode === 'table'
            || viewMode === 'json'
            || viewMode === 'text'
            || (viewMode === 'ddl' && isTableSurfaceActive)
        );
        if (!requiresTableData) {
            dataViewActiveRef.current = false;
            return;
        }
        if (dataViewActiveRef.current) return;
        dataViewActiveRef.current = true;
        onDataViewActivate?.();
    }, [isActive, isTableSurfaceActive, onDataViewActivate, viewMode]);

    useEffect(() => {
        if (!isTableSurfaceActive || !cellContextMenu.visible) return;
        const portal = cellContextMenuPortalRef.current;
        if (!portal) return;
        const frame = requestAnimationFrame(() => {
            const element = cellContextMenuPortalRef.current;
            if (!element) return;
            const rect = element.getBoundingClientRect();
            const next = resolveContextMenuPosition(cellContextMenu.x, cellContextMenu.y, rect.width, rect.height);
            if (next.x !== cellContextMenu.x || next.y !== cellContextMenu.y) {
                setCellContextMenu((prev) => {
                    if (!prev.visible) return prev;
                    if (prev.x === next.x && prev.y === next.y) return prev;
                    return { ...prev, x: next.x, y: next.y };
                });
            }
        });
        return () => cancelAnimationFrame(frame);
    }, [cellContextMenu.visible, cellContextMenu.x, cellContextMenu.y, isTableSurfaceActive, resolveContextMenuPosition]);

    useEffect(() => {
        cellEditModeRef.current = cellEditMode;
    }, [cellEditMode]);

    const columnIndexMap = useMemo(() => {
      const map = new Map<string, number>();
      displayColumnNames.forEach((name: string, idx: number) => map.set(name, idx));
      return map;
    }, [displayColumnNames]);

    // 直接操作 DOM 同步单元格选区与活动行列，避免拖选时触发 React 重渲染。
    const updateCellSelection = useCallback((newSelection: Set<string>) => {
      const container = containerRef.current;
      if (!container) return;

      const selectionStart = selectionStartRef.current;
      syncDataGridCellSelectionVisuals({
        container,
        selectedCells: newSelection,
        activeCell: selectionStart
          ? { rowKey: selectionStart.rowKey, colName: selectionStart.colName }
          : null,
        makeCellKey,
      });
    }, []);

    const markCellSelectionDeleteEligible = useCallback((eligible: boolean) => {
      cellSelectionSourceDataRef.current = eligible ? data : null;
      setCellSelectionDeleteEligible(eligible);
    }, [data]);

    const markCellSelectionUserSelection = useCallback((active: boolean) => {
      cellSelectionUserSourceDataRef.current = active ? data : null;
    }, [data]);
    return {
        filterConditions, setFilterConditions, quickWhereDraft, setQuickWhereDraft,
        quickWhereSuggestionsOpen, setQuickWhereSuggestionsOpen, filterPanelRef, filterOpOptions,
        filterLogicOptions, quickWhereSuggestionOptions, handleQuickWherePaste,
        stopQuickWhereClipboardPropagation, isNoValueOp, isBetweenOp, isListOp, addFilter,
        updateFilter, removeFilter, applyQuickWhereCondition, clearQuickWhereCondition,
        clearAllFiltersAndSorts, applyFilters, applyAllFiltersEnabled, applyAllFiltersDisabled,
        baseData, rowsBeforeClientFilter, renderColumnTitle, selectedRowKeysRef, displayDataRef,
        rowKeyStr, viewMode, ddlModalOpen, setDdlModalOpen, ddlLoading, ddlText, ddlViewLayout,
        setDdlViewLayout, ddlSidebarWidth, ddlSidebarResizePreviewX, isTableSurfaceActive,
        handleOpenTableDdl, handleViewModeChange, handleDdlSidebarResizeStart, resetDdlViewState,
        closeDdlView, handleClosePageFind, handleDataGridRootPointerDownCapture, columnIndexMap,
        updateCellSelection, markCellSelectionDeleteEligible, markCellSelectionUserSelection,
    };
};

export type DataGridColumnTitlesApi = ReturnType<typeof useDataGridColumnTitles>;
