import { message, MenuProps } from 'antd';
import { useMemo, useCallback, useEffect } from 'react';
import { ImportData } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import DataGridColumnInfoPopoverContent from '../../DataGridColumnInfoPopoverContent';
import {
    calculateVirtualTableScrollX,
    resolveExternalHorizontalScrollMetrics,
    resolveVirtualHorizontalMaxScroll,
} from '../../dataGridLayout';
import {
    shouldVirtualizeDataGridColumns,
    applyDataGridFixedCellPreviewOffset,
    syncDataGridHeaderHorizontalOffset,
    createDataGridVisualFrameGuard,
    commitDataGridFixedCellOffset,
} from '../../dataGridVirtualScroll';
import { EditableCell, SortableHeaderCell } from '../../DataGridCore';
import type { DataGridCommitApi } from './useDataGridCommit';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridInlineEditorApi } from './useDataGridInlineEditor';
import type { DataGridCellEditingApi } from './useDataGridCellEditing';
import type { DataGridRowActionsApi } from './useDataGridRowActions';
import type { DataGridTableMetricsApi } from './useDataGridTableMetrics';
import type { DataGridColumnsApi } from './useDataGridColumns';
import type { DataGridColumnTitlesApi } from './useDataGridColumnTitles';
import type { DataGridProps } from '../../DataGridCore';

export interface UseDataGridHorizontalVirtualScrollInput {
    connectionId: DataGridProps['connectionId'];
    tableName: DataGridProps['tableName'];
    dbName: DataGridProps['dbName'];
    buildConnConfig: DataGridCommitApi['buildConnConfig'];
    setImportFilePath: DataGridCellEditorStateApi['setImportFilePath'];
    setImportPreviewVisible: DataGridCellEditorStateApi['setImportPreviewVisible'];
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    onReload: DataGridProps['onReload'];
    handleCopyQueryResultCsv: DataGridCommitApi['handleCopyQueryResultCsv'];
    handleCopyQueryResultJson: DataGridCommitApi['handleCopyQueryResultJson'];
    handleCopyQueryResultMarkdown: DataGridCommitApi['handleCopyQueryResultMarkdown'];
    isQueryResultExport: DataGridCoreStateApi['isQueryResultExport'];
    mergedDisplayData: DataGridInlineEditorApi['mergedDisplayData'];
    displayOutputColumnNames: DataGridCoreStateApi['displayOutputColumnNames'];
    darkMode: DataGridCoreStateApi['darkMode'];
    showColumnComment: DataGridCoreStateApi['showColumnComment'];
    showColumnType: DataGridCoreStateApi['showColumnType'];
    alignNumericTemporalRight: DataGridCoreStateApi['alignNumericTemporalRight'];
    resolvedShowRowNumberColumn: DataGridCoreStateApi['resolvedShowRowNumberColumn'];
    columnSearchText: DataGridCoreStateApi['columnSearchText'];
    setColumnSearchText: DataGridCoreStateApi['setColumnSearchText'];
    allOrderedColumnNames: DataGridCoreStateApi['allOrderedColumnNames'];
    localHiddenColumns: DataGridCoreStateApi['localHiddenColumns'];
    setLocalHiddenColumns: DataGridCoreStateApi['setLocalHiddenColumns'];
    enableColumnOrderMemory: DataGridCoreStateApi['enableColumnOrderMemory'];
    enableHiddenColumnMemory: DataGridCoreStateApi['enableHiddenColumnMemory'];
    tableColumnOrders: DataGridCoreStateApi['tableColumnOrders'];
    tableHiddenColumns: DataGridCoreStateApi['tableHiddenColumns'];
    setQueryOptions: DataGridCoreStateApi['setQueryOptions'];
    setAppearance: DataGridCoreStateApi['setAppearance'];
    toggleAllColumnsVisibility: DataGridCoreStateApi['toggleAllColumnsVisibility'];
    toggleColumnVisibility: DataGridCoreStateApi['toggleColumnVisibility'];
    setEnableColumnOrderMemory: DataGridCoreStateApi['setEnableColumnOrderMemory'];
    setEnableHiddenColumnMemory: DataGridCoreStateApi['setEnableHiddenColumnMemory'];
    clearTableColumnOrder: DataGridCoreStateApi['clearTableColumnOrder'];
    clearTableHiddenColumns: DataGridCoreStateApi['clearTableHiddenColumns'];
    showCellContextMenu: DataGridCellEditorStateApi['showCellContextMenu'];
    handleBatchFillToSelected: DataGridCellEditingApi['handleBatchFillToSelected'];
    selectedRowKeys: DataGridCellEditorStateApi['selectedRowKeys'];
    setSelectedRowKeys: DataGridCellEditorStateApi['setSelectedRowKeys'];
    selectionColumnWidth: DataGridCoreStateApi['selectionColumnWidth'];
    tableColumns: DataGridRowActionsApi['tableColumns'];
    densityParams: DataGridCoreStateApi['densityParams'];
    tableViewportWidth: DataGridTableMetricsApi['tableViewportWidth'];
    isMacLike: DataGridCoreStateApi['isMacLike'];
    isWindowsLike: DataGridCoreStateApi['isWindowsLike'];
    mergedColumns: DataGridColumnsApi['mergedColumns'];
    measuredHorizontalScrollMetrics: DataGridTableMetricsApi['measuredHorizontalScrollMetrics'];
    floatingScrollbarInset: DataGridCoreStateApi['floatingScrollbarInset'];
    isTableSurfaceActive: DataGridColumnTitlesApi['isTableSurfaceActive'];
    tableHeight: DataGridTableMetricsApi['tableHeight'];
    effectiveUiScale: DataGridCoreStateApi['effectiveUiScale'];
    virtualEditingCellForRender: DataGridCellEditorStateApi['virtualEditingCellForRender'];
    enableVirtual: DataGridColumnsApi['enableVirtual'];
    displayColumnNames: DataGridCoreStateApi['displayColumnNames'];
    useInlineEditableBodyCell: DataGridColumnsApi['useInlineEditableBodyCell'];
    virtualHorizontalElementsRef: DataGridCellEditorStateApi['virtualHorizontalElementsRef'];
    tableContainerRef: DataGridCellEditorStateApi['tableContainerRef'];
    virtualHorizontalPreviewActiveRef: DataGridCellEditorStateApi['virtualHorizontalPreviewActiveRef'];
    virtualHorizontalMaxScrollRef: DataGridCellEditorStateApi['virtualHorizontalMaxScrollRef'];
    virtualHorizontalPostCommitGuardRef: DataGridCellEditorStateApi['virtualHorizontalPostCommitGuardRef'];
    virtualHorizontalPostCommitFrameHandlerRef: DataGridCellEditorStateApi['virtualHorizontalPostCommitFrameHandlerRef'];
    externalScrollbarDraggingRef: DataGridCellEditorStateApi['externalScrollbarDraggingRef'];
    externalScrollInteractionUntilRef: DataGridCellEditorStateApi['externalScrollInteractionUntilRef'];
    externalIdleCommitSchedulerRef: DataGridCellEditorStateApi['externalIdleCommitSchedulerRef'];
    externalSyncRafRef: DataGridCellEditorStateApi['externalSyncRafRef'];
    externalScrollSettleRafRef: DataGridCellEditorStateApi['externalScrollSettleRafRef'];
    pendingExternalScrollLeftRef: DataGridCellEditorStateApi['pendingExternalScrollLeftRef'];
    tableHorizontalWheelRafRef: DataGridCellEditorStateApi['tableHorizontalWheelRafRef'];
    nativeHorizontalSyncRafRef: DataGridCellEditorStateApi['nativeHorizontalSyncRafRef'];
    pendingTableHorizontalDeltaRef: DataGridCellEditorStateApi['pendingTableHorizontalDeltaRef'];
    horizontalSyncSourceRef: DataGridCellEditorStateApi['horizontalSyncSourceRef'];
    tableRef: DataGridCellEditorStateApi['tableRef'];
    lastCommittedVirtualHorizontalOffsetRef: DataGridCellEditorStateApi['lastCommittedVirtualHorizontalOffsetRef'];
    virtualHorizontalAlignmentRafRef: DataGridCellEditorStateApi['virtualHorizontalAlignmentRafRef'];
    externalHorizontalScrollRef: DataGridCellEditorStateApi['externalHorizontalScrollRef'];
    lastTableScrollLeftRef: DataGridCellEditorStateApi['lastTableScrollLeftRef'];
    lastExternalScrollLeftRef: DataGridCellEditorStateApi['lastExternalScrollLeftRef'];
}

export const useDataGridHorizontalVirtualScroll = ({
    connectionId, tableName, dbName, buildConnConfig, setImportFilePath, setImportPreviewVisible,
    translateDataGrid, onReload, handleCopyQueryResultCsv, handleCopyQueryResultJson,
    handleCopyQueryResultMarkdown, isQueryResultExport, mergedDisplayData, displayOutputColumnNames,
    darkMode, showColumnComment, showColumnType, alignNumericTemporalRight,
    resolvedShowRowNumberColumn, columnSearchText, setColumnSearchText, allOrderedColumnNames,
    localHiddenColumns, setLocalHiddenColumns, enableColumnOrderMemory, enableHiddenColumnMemory,
    tableColumnOrders, tableHiddenColumns, setQueryOptions, setAppearance,
    toggleAllColumnsVisibility, toggleColumnVisibility, setEnableColumnOrderMemory,
    setEnableHiddenColumnMemory, clearTableColumnOrder, clearTableHiddenColumns,
    showCellContextMenu, handleBatchFillToSelected, selectedRowKeys, setSelectedRowKeys,
    selectionColumnWidth, tableColumns, densityParams, tableViewportWidth, isMacLike, isWindowsLike,
    mergedColumns, measuredHorizontalScrollMetrics, floatingScrollbarInset, isTableSurfaceActive,
    tableHeight, effectiveUiScale, virtualEditingCellForRender, enableVirtual, displayColumnNames,
    useInlineEditableBodyCell, virtualHorizontalElementsRef, tableContainerRef,
    virtualHorizontalPreviewActiveRef, virtualHorizontalMaxScrollRef,
    virtualHorizontalPostCommitGuardRef, virtualHorizontalPostCommitFrameHandlerRef,
    externalScrollbarDraggingRef, externalScrollInteractionUntilRef, externalIdleCommitSchedulerRef,
    externalSyncRafRef, externalScrollSettleRafRef, pendingExternalScrollLeftRef,
    tableHorizontalWheelRafRef, nativeHorizontalSyncRafRef, pendingTableHorizontalDeltaRef,
    horizontalSyncSourceRef, tableRef, lastCommittedVirtualHorizontalOffsetRef,
    virtualHorizontalAlignmentRafRef, externalHorizontalScrollRef, lastTableScrollLeftRef,
    lastExternalScrollLeftRef,
}: UseDataGridHorizontalVirtualScrollInput) => {
    const handleImport = async () => {
        if (!connectionId || !tableName) return;
        const config = buildConnConfig();
        if (!config) return;

        const res = await ImportData(buildRpcConnectionConfig(config) as any, dbName || '', tableName);
        if (res.success && res.data && res.data.filePath) {
            setImportFilePath(res.data.filePath);
            setImportPreviewVisible(true);
        } else if (res.message !== "已取消") {
            void message.error(translateDataGrid('data_grid.message.select_file_failed', { detail: res.message }));
        }
    };

    const handleImportSuccess = async () => {
        setImportPreviewVisible(false);
        setImportFilePath('');
        await onReload?.();
        void message.success(translateDataGrid('data_grid.message.import_done'));
    };

    const queryResultCopyMenu: MenuProps['items'] = [
        { key: 'csv', label: 'CSV', onClick: handleCopyQueryResultCsv },
        { key: 'json', label: 'JSON', onClick: handleCopyQueryResultJson },
        { key: 'markdown', label: 'Markdown', onClick: handleCopyQueryResultMarkdown },
    ];
    const canCopyQueryResult = isQueryResultExport && mergedDisplayData.length > 0 && displayOutputColumnNames.length > 0;

    const columnInfoSettingContent = (
        <DataGridColumnInfoPopoverContent
            darkMode={darkMode}
            showColumnComment={showColumnComment}
            showColumnType={showColumnType}
            alignNumericTemporalRight={alignNumericTemporalRight}
            showRowNumberColumn={resolvedShowRowNumberColumn}
            columnSearchText={columnSearchText}
            allOrderedColumnNames={allOrderedColumnNames}
            localHiddenColumns={localHiddenColumns}
            enableColumnOrderMemory={enableColumnOrderMemory}
            enableHiddenColumnMemory={enableHiddenColumnMemory}
            canResetOrder={!!connectionId && !!dbName && !!tableName && !!tableColumnOrders[`${connectionId}-${dbName}-${tableName}`]}
            canResetHidden={!!connectionId && !!dbName && !!tableName && !!tableHiddenColumns[`${connectionId}-${dbName}-${tableName}`]}
            translate={translateDataGrid}
            onShowColumnCommentChange={(checked) => setQueryOptions({ showColumnComment: checked })}
            onShowColumnTypeChange={(checked) => setQueryOptions({ showColumnType: checked })}
            onAlignNumericTemporalRightChange={(checked) => setQueryOptions({ alignNumericTemporalCellsRight: checked })}
            onShowRowNumberColumnChange={(checked) => setAppearance({ showDataTableRowNumber: checked })}
            onToggleAllColumnsVisibility={toggleAllColumnsVisibility}
            onColumnSearchTextChange={setColumnSearchText}
            onToggleColumnVisibility={toggleColumnVisibility}
            onEnableColumnOrderMemoryChange={setEnableColumnOrderMemory}
            onEnableHiddenColumnMemoryChange={setEnableHiddenColumnMemory}
            onResetOrder={() => {
                if (connectionId && dbName && tableName) {
                    clearTableColumnOrder(connectionId, dbName, tableName);
                    void message.success(translateDataGrid('data_grid.column_settings.reset_order_success'));
                }
            }}
            onResetHidden={() => {
                if (connectionId && dbName && tableName) {
                    clearTableHiddenColumns(connectionId, dbName, tableName);
                    setLocalHiddenColumns([]);
                    void message.success(translateDataGrid('data_grid.column_settings.reset_hidden_success'));
                }
            }}
        />
    );

    const cellContextMenuValue = useMemo(() => ({
        showMenu: showCellContextMenu,
        handleBatchFillToSelected,
    }), [showCellContextMenu, handleBatchFillToSelected]);

    const rowSelectionConfig = useMemo(() => ({
        selectedRowKeys,
        onChange: setSelectedRowKeys,
        columnWidth: selectionColumnWidth,
        // 与行号列一起左侧固定，横向滚动时仍可勾选/识别行
        fixed: true as const,
    }), [selectedRowKeys, selectionColumnWidth]);

    const totalWidth = tableColumns.reduce((sum: number, col: any) => sum + (Number(col.width) || densityParams.defaultColumnWidth), 0) + selectionColumnWidth;
    const tableScrollX = useMemo(() => {
        // rc-table 在 scroll.x 小于容器宽度时会把实际列宽按视口补齐。
        // 这里必须与其使用同一套 scroll.x 口径，否则少字段场景下 header/body 会错位。
        return calculateVirtualTableScrollX({
            totalWidth,
            tableViewportWidth,
            isMacLike,
            nativeHorizontalScroll: isMacLike || isWindowsLike,
            stretchToViewport: mergedColumns.length > 0,
        });
    }, [mergedColumns.length, totalWidth, isMacLike, isWindowsLike, tableViewportWidth]);
    const externalHorizontalScrollMetrics = useMemo(() => resolveExternalHorizontalScrollMetrics({
        tableScrollWidth: tableScrollX,
        tableViewportWidth,
        measuredScrollWidth: measuredHorizontalScrollMetrics.scrollWidth,
        measuredClientWidth: measuredHorizontalScrollMetrics.clientWidth,
        measuredTrackClientWidth: measuredHorizontalScrollMetrics.trackClientWidth,
        trackInset: floatingScrollbarInset,
    }), [
        floatingScrollbarInset,
        measuredHorizontalScrollMetrics.clientWidth,
        measuredHorizontalScrollMetrics.scrollWidth,
        measuredHorizontalScrollMetrics.trackClientWidth,
        tableScrollX,
        tableViewportWidth,
    ]);
    const horizontalScrollVisible = isTableSurfaceActive && !isWindowsLike && externalHorizontalScrollMetrics.visible;
    const horizontalScrollWidth = externalHorizontalScrollMetrics.innerWidth;
    const tableScrollConfig = useMemo(() => ({ x: tableScrollX, y: tableHeight }), [tableScrollX, tableHeight]);
    // V2 data rows have a CSS-enforced 28px height. Entering fixed mode on the
    // first render avoids a later rAF measurement that would rebuild the virtual
    // window while the user is already scrolling.
    const virtualListItemHeight = Math.max(1, 28 * effectiveUiScale);
    const virtualListItemHeightFixed = !virtualEditingCellForRender;
    const virtualListItemNativeScrollbarControlled = isMacLike && virtualListItemHeightFixed;
    const virtualListItemHorizontalOffsetComposited = isMacLike || isWindowsLike;
    // Wide result sets keep every column mounted only when the column window
    // cannot be trusted. It is trusted now: the rc-table patch keeps a 640px
    // leading / 960px trailing overscan plus a 512px retention buffer, so a
    // one-frame-late window still covers the viewport instead of exposing blanks.
    const virtualListItemColumnVirtual = enableVirtual
        && !virtualEditingCellForRender
        && shouldVirtualizeDataGridColumns(displayColumnNames.length);
    const tableComponents = useMemo(() => {
        const body: Record<string, any> = {};
        // 虚拟表模式下 render() 已返回 EditableCell；这里再挂 body.cell 会形成双层包装，
        // 增加滚动期间的组件与上下文开销。
        if (useInlineEditableBodyCell) {
            body.cell = EditableCell;
        }
        return Object.keys(body).length > 0
            ? { body, header: { cell: SortableHeaderCell } }
            : { header: { cell: SortableHeaderCell } };
    }, [useInlineEditableBodyCell]);

    const resolveVirtualHorizontalElements = useCallback((tableContainer: HTMLElement) => {
        const cached = virtualHorizontalElementsRef.current;
        if (
            cached.tableContainer === tableContainer
            && cached.holderEl?.isConnected
            && cached.innerEl?.isConnected
            && cached.headerEl?.isConnected
        ) {
            return cached;
        }

        const holderEl = tableContainer.querySelector('.ant-table-tbody-virtual-holder') as HTMLElement | null;
        const innerEl = holderEl?.querySelector('.ant-table-tbody-virtual-holder-inner') as HTMLElement | null;
        const headerEl = tableContainer.querySelector('.ant-table-header') as HTMLElement | null;
        const nextElements = { tableContainer, holderEl, innerEl, headerEl };
        virtualHorizontalElementsRef.current = nextElements;
        return nextElements;
    }, []);

    useEffect(() => {
        if (!isTableSurfaceActive || !enableVirtual) return;
        const tableContainer = tableContainerRef.current;
        if (!(tableContainer instanceof HTMLElement)) return;

        const stopPreviewHeaderScroll = (event: Event) => {
            if (!virtualHorizontalPreviewActiveRef.current) return;
            const target = event.target;
            if (target instanceof HTMLElement && target.classList.contains('ant-table-header')) {
                // rc-table mirrors header scrollLeft back into rc-virtual-list. During a
                // visual preview that would turn every pixel into a React render.
                event.stopPropagation();
            }
        };

        tableContainer.addEventListener('scroll', stopPreviewHeaderScroll, true);
        return () => tableContainer.removeEventListener('scroll', stopPreviewHeaderScroll, true);
    }, [enableVirtual, isTableSurfaceActive]);

    const readVirtualHorizontalOffset = useCallback((tableContainer: HTMLElement): number => {
        const { holderEl, innerEl, headerEl } = resolveVirtualHorizontalElements(tableContainer);
        if (virtualListItemHorizontalOffsetComposited && holderEl instanceof HTMLElement) {
            return Math.max(0, holderEl.scrollLeft);
        }
        if (innerEl instanceof HTMLElement) {
            return Math.max(0, Math.abs(parseFloat(innerEl.style.marginLeft) || 0));
        }
        return headerEl ? Math.max(0, headerEl.scrollLeft) : 0;
    }, [resolveVirtualHorizontalElements, virtualListItemHorizontalOffsetComposited]);

    /**
     * 虚拟表横滚视觉同步：
     * - 原生表体：holder 只持有滚动条，sticky filler 避免合成线程抢先移动内容
     * - 原生表头/表体：在同一次 scroll 回调中写入 translate，固定列由 CSS 补偿
     * - 其他平台：保留 marginLeft + 单 CSS 变量补偿
     */

    const syncVirtualHorizontalVisualOffset = useCallback((tableContainer: HTMLElement, nextOffset: number) => {
        const { holderEl, innerEl, headerEl } = resolveVirtualHorizontalElements(tableContainer);
        if (!(holderEl instanceof HTMLElement) || !(innerEl instanceof HTMLElement)) {
            return null;
        }

        const maxScroll = resolveVirtualHorizontalMaxScroll({
            tableScrollX,
            clientWidth: holderEl.clientWidth,
            scrollWidth: holderEl.scrollWidth,
            useNativeScroll: virtualListItemHorizontalOffsetComposited,
        });
        const clampedOffset = Math.max(0, Math.min(maxScroll, nextOffset));
        const headerScrollLeft = headerEl?.scrollLeft;
        virtualHorizontalMaxScrollRef.current = maxScroll;
        const currentOffset = virtualListItemHorizontalOffsetComposited
            ? Math.max(0, holderEl.scrollLeft)
            : Math.max(0, Math.abs(parseFloat(innerEl.style.marginLeft) || 0));
        if (virtualListItemHorizontalOffsetComposited) {
            // post-commit guard would reapply an older React offset after the
            // compositor has already advanced the holder.
            virtualHorizontalPostCommitGuardRef.current?.cancel();
            virtualHorizontalPreviewActiveRef.current = false;
        } else {
            virtualHorizontalPreviewActiveRef.current = true;
            virtualHorizontalPostCommitGuardRef.current?.update(clampedOffset);
        }

        if (virtualListItemHorizontalOffsetComposited) {
            const nextMaxScrollVar = `${maxScroll}px`;
            if (tableContainer.style.getPropertyValue('--gn-datagrid-h-max') !== nextMaxScrollVar) {
                tableContainer.style.setProperty('--gn-datagrid-h-max', nextMaxScrollVar);
            }
            // Windows 原生横滚由浏览器持有 scrollLeft；再写回去会把滑块从轨道末端弹回。
            if (!isWindowsLike && Math.abs(holderEl.scrollLeft - clampedOffset) > 0.5) {
                holderEl.scrollLeft = clampedOffset;
            }
            const nextBodyTranslate = `${-clampedOffset}px 0`;
            if (innerEl.style.translate !== nextBodyTranslate) innerEl.style.translate = nextBodyTranslate;
            if (innerEl.style.marginLeft) {
                innerEl.style.removeProperty('margin-left');
            }
            // 固定列直接用内联 transform 钉住，不再写继承变量。变量必须落在共同祖先
            // 上，会让 99 列 × 41 行的整棵子树（约 615 个单元格）每帧失效重算——实测
            // 一次 2s 拖动要花掉约 2s 的样式重算，这正是横向拖动卡顿的来源。
            // 只写真正固定的约 82 个单元格，拖动回到稳定 60fps。
            applyDataGridFixedCellPreviewOffset(innerEl, clampedOffset, maxScroll);
        } else {
            const nextMarginLeft = `${-clampedOffset}px`;
            if (innerEl.style.marginLeft !== nextMarginLeft) {
                innerEl.style.marginLeft = nextMarginLeft;
            }
            applyDataGridFixedCellPreviewOffset(innerEl, clampedOffset, maxScroll);
        }
        if (tableContainer.style.getPropertyValue('--gn-datagrid-h-scroll')) {
            tableContainer.style.removeProperty('--gn-datagrid-h-scroll');
        }
        if (holderEl.style.getPropertyValue('--gn-datagrid-h-scroll')) {
            holderEl.style.removeProperty('--gn-datagrid-h-scroll');
        }

        if (headerEl instanceof HTMLElement) {
            syncDataGridHeaderHorizontalOffset(headerEl, clampedOffset, virtualListItemHorizontalOffsetComposited, headerScrollLeft);
        }

        return { holderEl, innerEl, clampedOffset, currentOffset };
    }, [isWindowsLike, resolveVirtualHorizontalElements, tableScrollX, virtualListItemHorizontalOffsetComposited]);

    virtualHorizontalPostCommitFrameHandlerRef.current = (offset) => {
        const tableContainer = tableContainerRef.current;
        if (!(tableContainer instanceof HTMLElement)) return;
        syncVirtualHorizontalVisualOffset(tableContainer, offset);
    };

    const getVirtualHorizontalPostCommitGuard = useCallback(() => {
        if (virtualHorizontalPostCommitGuardRef.current === null) {
            virtualHorizontalPostCommitGuardRef.current = createDataGridVisualFrameGuard<number>({
                onFrame: (offset) => virtualHorizontalPostCommitFrameHandlerRef.current(offset),
                shouldContinue: () => (
                    externalScrollbarDraggingRef.current
                    || Date.now() < externalScrollInteractionUntilRef.current
                    || !!externalIdleCommitSchedulerRef.current?.hasPending()
                    || externalSyncRafRef.current !== null
                    || externalScrollSettleRafRef.current !== null
                    || pendingExternalScrollLeftRef.current !== null
                    || tableHorizontalWheelRafRef.current !== null
                    || nativeHorizontalSyncRafRef.current !== null
                    || Math.abs(pendingTableHorizontalDeltaRef.current) >= 0.5
                ),
                onStop: () => {
                    virtualHorizontalPreviewActiveRef.current = false;
                    horizontalSyncSourceRef.current = '';
                },
            });
        }
        return virtualHorizontalPostCommitGuardRef.current;
    }, []);

    const scheduleVirtualHorizontalPostCommit = useCallback((tableContainer: HTMLElement, committedOffset: number) => {
        if (!tableContainer.isConnected || virtualListItemHorizontalOffsetComposited) return;
        const guard = getVirtualHorizontalPostCommitGuard();
        guard.update(committedOffset);
        guard.start();
    }, [getVirtualHorizontalPostCommitGuard, virtualListItemHorizontalOffsetComposited]);

    const applyVirtualHorizontalOffset = useCallback((
        tableContainer: HTMLElement,
        nextOffset: number,
        options?: { forceInternalScroll?: boolean },
    ) => {
        const synced = syncVirtualHorizontalVisualOffset(tableContainer, nextOffset);
        if (!synced) {
            return false;
        }

        const { holderEl, innerEl, clampedOffset, currentOffset } = synced;
        const deltaX = clampedOffset - currentOffset;
        if (Math.abs(deltaX) < 0.5 && !options?.forceInternalScroll) {
            scheduleVirtualHorizontalPostCommit(tableContainer, clampedOffset);
            return true;
        }

        // Windows keeps horizontal movement on the compositor, so the visual
        // offset is already correct without touching rc-virtual-list. The column
        // window is the exception: body rows resolve their visible column range
        // from the list's own offsetLeft, so it must still be committed or the
        // window stays frozen at the first columns while the user scrolls right.
        const tableInstance = tableRef.current;
        if (isWindowsLike && virtualListItemHorizontalOffsetComposited && !virtualListItemColumnVirtual) {
            lastCommittedVirtualHorizontalOffsetRef.current = clampedOffset;
            return true;
        }
        if (tableInstance && typeof tableInstance.scrollTo === 'function') {
            // Update rc-virtual-list's internal offsetLeft, which is what body rows
            // use to resolve their visible column range. This stays asynchronous on
            // purpose: committing inside a scroll callback with flushSync re-renders
            // the whole virtual table on the main thread mid-drag, which is what made
            // horizontal dragging feel stuck. The column window's own overscan covers
            // the one-frame lag instead.
            tableInstance.scrollTo({ left: clampedOffset });

            if (!virtualListItemHorizontalOffsetComposited) {
                commitDataGridFixedCellOffset(tableContainer, innerEl, clampedOffset, virtualHorizontalMaxScrollRef.current);
            }
            lastCommittedVirtualHorizontalOffsetRef.current = clampedOffset;
            scheduleVirtualHorizontalPostCommit(tableContainer, clampedOffset);
            return true;
        }

        // 回退：合成 WheelEvent 驱动 rc-virtual-list 内部 offsetLeft state
        holderEl.dispatchEvent(new WheelEvent('wheel', {
            deltaX: deltaX,
            deltaY: 0,
            bubbles: true,
            cancelable: true,
        }));
        if (!virtualListItemHorizontalOffsetComposited) {
            commitDataGridFixedCellOffset(tableContainer, innerEl, clampedOffset, virtualHorizontalMaxScrollRef.current);
        }
        lastCommittedVirtualHorizontalOffsetRef.current = clampedOffset;
        scheduleVirtualHorizontalPostCommit(tableContainer, clampedOffset);
        return true;
    }, [isWindowsLike, scheduleVirtualHorizontalPostCommit, syncVirtualHorizontalVisualOffset, virtualListItemColumnVirtual, virtualListItemHorizontalOffsetComposited]);

    const scheduleVirtualHorizontalAlignment = useCallback((preferredLeft?: number) => {
        if (!enableVirtual || !isTableSurfaceActive) return;
        if (virtualHorizontalAlignmentRafRef.current !== null) {
            cancelAnimationFrame(virtualHorizontalAlignmentRafRef.current);
        }
        virtualHorizontalAlignmentRafRef.current = requestAnimationFrame(() => {
            virtualHorizontalAlignmentRafRef.current = null;
            const tableContainer = tableContainerRef.current;
            if (!(tableContainer instanceof HTMLElement)) return;

            virtualHorizontalElementsRef.current = {
                tableContainer: null,
                holderEl: null,
                innerEl: null,
                headerEl: null,
            };
            const externalScroll = externalHorizontalScrollRef.current;
            const nextLeft = Math.max(0, preferredLeft ?? (
                virtualListItemHorizontalOffsetComposited
                ? readVirtualHorizontalOffset(tableContainer)
                : externalScroll?.scrollLeft ?? lastTableScrollLeftRef.current
            ));
            const applied = applyVirtualHorizontalOffset(tableContainer, nextLeft, { forceInternalScroll: nextLeft !== 0 || lastCommittedVirtualHorizontalOffsetRef.current !== 0 });
            const resolvedLeft = applied ? readVirtualHorizontalOffset(tableContainer) : nextLeft;
            lastTableScrollLeftRef.current = resolvedLeft;
            if (externalScroll && Math.abs(externalScroll.scrollLeft - resolvedLeft) > 1) {
                externalScroll.scrollLeft = resolvedLeft;
            }
            lastExternalScrollLeftRef.current = externalScroll?.scrollLeft ?? resolvedLeft;
        });
    }, [applyVirtualHorizontalOffset, enableVirtual, isTableSurfaceActive, readVirtualHorizontalOffset, virtualListItemHorizontalOffsetComposited]);
    return {
        handleImport, handleImportSuccess, queryResultCopyMenu, canCopyQueryResult,
        columnInfoSettingContent, cellContextMenuValue, rowSelectionConfig, totalWidth,
        tableScrollX, horizontalScrollVisible, horizontalScrollWidth, tableScrollConfig,
        virtualListItemHeight, virtualListItemHeightFixed, virtualListItemNativeScrollbarControlled,
        virtualListItemHorizontalOffsetComposited, virtualListItemColumnVirtual, tableComponents,
        resolveVirtualHorizontalElements, readVirtualHorizontalOffset,
        syncVirtualHorizontalVisualOffset, applyVirtualHorizontalOffset,
        scheduleVirtualHorizontalAlignment,
    };
};

export type DataGridHorizontalVirtualScrollApi = ReturnType<typeof useDataGridHorizontalVirtualScroll>;
