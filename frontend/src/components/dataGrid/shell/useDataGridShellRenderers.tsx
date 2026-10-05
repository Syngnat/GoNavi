import { message } from 'antd';
import { DataGridTableSurface } from './DataGridTableSurface';
import type { DataGridShellProps } from '../../DataGridShell';

export interface UseDataGridShellRenderersInput {
  tableContainerRef: DataGridShellProps['tableContainerRef'];
  horizontalScrollVisible: DataGridShellProps['horizontalScrollVisible'];
  virtualListItemHorizontalOffsetComposited: DataGridShellProps['virtualListItemHorizontalOffsetComposited'];
  enableVirtual: DataGridShellProps['enableVirtual'];
  handleVirtualTableClickCapture: DataGridShellProps['handleVirtualTableClickCapture'];
  handleVirtualTableDoubleClickCapture: DataGridShellProps['handleVirtualTableDoubleClickCapture'];
  handleVirtualTableContextMenuCapture: DataGridShellProps['handleVirtualTableContextMenuCapture'];
  tableBodyBottomPadding: DataGridShellProps['tableBodyBottomPadding'];
  CellContextMenuContext: DataGridShellProps['CellContextMenuContext'];
  DndContext: DataGridShellProps['DndContext'];
  EditableContext: DataGridShellProps['EditableContext'];
  Form: DataGridShellProps['Form'];
  SortableContext: DataGridShellProps['SortableContext'];
  Table: DataGridShellProps['Table'];
  cellContextMenuValue: DataGridShellProps['cellContextMenuValue'];
  closestCenter: DataGridShellProps['closestCenter'];
  displayColumnNames: DataGridShellProps['displayColumnNames'];
  form: DataGridShellProps['form'];
  handleDragEnd: DataGridShellProps['handleDragEnd'];
  handleTableChange: DataGridShellProps['handleTableChange'];
  horizontalListSortingStrategy: DataGridShellProps['horizontalListSortingStrategy'];
  loading: DataGridShellProps['loading'];
  rowClassName: DataGridShellProps['rowClassName'];
  rowSelectionConfig: DataGridShellProps['rowSelectionConfig'];
  sensors: DataGridShellProps['sensors'];
  tableColumns: DataGridShellProps['tableColumns'];
  tableComponents: DataGridShellProps['tableComponents'];
  tableRef: DataGridShellProps['tableRef'];
  tableRenderData: DataGridShellProps['tableRenderData'];
  tableScrollConfig: DataGridShellProps['tableScrollConfig'];
  virtualListItemColumnVirtual: DataGridShellProps['virtualListItemColumnVirtual'];
  virtualListItemHeight: DataGridShellProps['virtualListItemHeight'];
  virtualListItemHeightFixed: DataGridShellProps['virtualListItemHeightFixed'];
  virtualListItemNativeScrollbarControlled: DataGridShellProps['virtualListItemNativeScrollbarControlled'];
  externalHorizontalScrollRef: DataGridShellProps['externalHorizontalScrollRef'];
  applyExternalScrollToTableTargets: DataGridShellProps['applyExternalScrollToTableTargets'];
  handleExternalHorizontalScrollPointerDown: DataGridShellProps['handleExternalHorizontalScrollPointerDown'];
  handleExternalHorizontalScrollPointerRelease: DataGridShellProps['handleExternalHorizontalScrollPointerRelease'];
  handleExternalHorizontalScrollLostPointerCapture: DataGridShellProps['handleExternalHorizontalScrollLostPointerCapture'];
  horizontalScrollWidth: DataGridShellProps['horizontalScrollWidth'];
  externalScrollbarMinWidth: DataGridShellProps['externalScrollbarMinWidth'];
  DataGridPageFind: DataGridShellProps['DataGridPageFind'];
  pageFindInputRef: DataGridShellProps['pageFindInputRef'];
  noAutoCapInputProps: DataGridShellProps['noAutoCapInputProps'];
  pageFindText: DataGridShellProps['pageFindText'];
  normalizedPageFindText: DataGridShellProps['normalizedPageFindText'];
  pageFindMatches: DataGridShellProps['pageFindMatches'];
  activePageFindPosition: DataGridShellProps['activePageFindPosition'];
  pageFindSummary: DataGridShellProps['pageFindSummary'];
  setPageFindText: DataGridShellProps['setPageFindText'];
  handleClosePageFind: DataGridShellProps['handleClosePageFind'];
  handleNavigatePageFind: DataGridShellProps['handleNavigatePageFind'];
  translateDataGrid: DataGridShellProps['translateDataGrid'];
  pageFindOpen: DataGridShellProps['pageFindOpen'];
  viewMode: DataGridShellProps['viewMode'];
  isTableSurfaceActive: DataGridShellProps['isTableSurfaceActive'];
  DataGridColumnQuickFind: DataGridShellProps['DataGridColumnQuickFind'];
  columnQuickFindText: DataGridShellProps['columnQuickFindText'];
  columnQuickFindOptions: DataGridShellProps['columnQuickFindOptions'];
  setColumnQuickFindText: DataGridShellProps['setColumnQuickFindText'];
  handleSubmitColumnQuickFind: DataGridShellProps['handleSubmitColumnQuickFind'];
  DataGridResultViewSwitcher: DataGridShellProps['DataGridResultViewSwitcher'];
  handleViewModeChange: DataGridShellProps['handleViewModeChange'];
  useCallback: DataGridShellProps['useCallback'];
  onRequestTotalCount: DataGridShellProps['onRequestTotalCount'];
  pagination: DataGridShellProps['pagination'];
  onCancelTotalCount: DataGridShellProps['onCancelTotalCount'];
  DataGridPaginationBar: DataGridShellProps['DataGridPaginationBar'];
  selectedRowCount: DataGridShellProps['selectedRowCount'];
  paginationV2SummaryText: DataGridShellProps['paginationV2SummaryText'];
  paginationTotalPages: DataGridShellProps['paginationTotalPages'];
  paginationPageText: DataGridShellProps['paginationPageText'];
  paginationPageSizeOptions: DataGridShellProps['paginationPageSizeOptions'];
  allowCustomPageSize: DataGridShellProps['allowCustomPageSize'];
  paginationHasKnownTotalPages: DataGridShellProps['paginationHasKnownTotalPages'];
  prefersManualTotalCount: DataGridShellProps['prefersManualTotalCount'];
  onPageChange: DataGridShellProps['onPageChange'];
  onLastPage: DataGridShellProps['onLastPage'];
  handlePageSizeChange: DataGridShellProps['handlePageSizeChange'];
  handleV2PageStep: DataGridShellProps['handleV2PageStep'];
  useMemo: DataGridShellProps['useMemo'];
  rowEditorDisplayRef: DataGridShellProps['rowEditorDisplayRef'];
  rowEditorNullColsRef: DataGridShellProps['rowEditorNullColsRef'];
  looksLikeJsonText: DataGridShellProps['looksLikeJsonText'];
  columnMetaMap: DataGridShellProps['columnMetaMap'];
  columnMetaMapByLowerName: DataGridShellProps['columnMetaMapByLowerName'];
  getTemporalPickerType: DataGridShellProps['getTemporalPickerType'];
  dbType: DataGridShellProps['dbType'];
  currentConnConfig: DataGridShellProps['currentConnConfig'];
  isWritableResultColumn: DataGridShellProps['isWritableResultColumn'];
  effectiveEditLocator: DataGridShellProps['effectiveEditLocator'];
  rowEditorOpen: DataGridShellProps['rowEditorOpen'];
  rowEditorRowKey: DataGridShellProps['rowEditorRowKey'];
  setSelectedRowKeys: DataGridShellProps['setSelectedRowKeys'];
  resetCellSelection: DataGridShellProps['resetCellSelection'];
  tableName: DataGridShellProps['tableName'];
  connectionId: DataGridShellProps['connectionId'];
  columnMetaCacheRef: DataGridShellProps['columnMetaCacheRef'];
  metadataCacheKey: DataGridShellProps['metadataCacheKey'];
  foreignKeyCacheRef: DataGridShellProps['foreignKeyCacheRef'];
  uniqueKeyGroupsCacheRef: DataGridShellProps['uniqueKeyGroupsCacheRef'];
  setMetadataReloadVersion: DataGridShellProps['setMetadataReloadVersion'];
  onReload: DataGridShellProps['onReload'];
  clearAutoCommitTimer: DataGridShellProps['clearAutoCommitTimer'];
  autoCommitFailedTokenRef: DataGridShellProps['autoCommitFailedTokenRef'];
  setAddedRows: DataGridShellProps['setAddedRows'];
  setModifiedRows: DataGridShellProps['setModifiedRows'];
  setDeletedRowKeys: DataGridShellProps['setDeletedRowKeys'];
  Set: DataGridShellProps['Set'];
  setModifiedColumns: DataGridShellProps['setModifiedColumns'];
  onToggleFilter: DataGridShellProps['onToggleFilter'];
  filterConditions: DataGridShellProps['filterConditions'];
  showFilter: DataGridShellProps['showFilter'];
  addFilter: DataGridShellProps['addFilter'];
  cellEditMode: DataGridShellProps['cellEditMode'];
  closeCellEditMode: DataGridShellProps['closeCellEditMode'];
  cellEditModeRef: DataGridShellProps['cellEditModeRef'];
  setCellEditMode: DataGridShellProps['setCellEditMode'];
  mergedDisplayData: DataGridShellProps['mergedDisplayData'];
  JSON: DataGridShellProps['JSON'];
  useStore: DataGridShellProps['useStore'];
  setTimeout: DataGridShellProps['setTimeout'];
  window: DataGridShellProps['window'];
  CustomEvent: DataGridShellProps['CustomEvent'];
}

export const useDataGridShellRenderers = ({
  tableContainerRef, horizontalScrollVisible, virtualListItemHorizontalOffsetComposited,
  enableVirtual, handleVirtualTableClickCapture, handleVirtualTableDoubleClickCapture,
  handleVirtualTableContextMenuCapture, tableBodyBottomPadding, CellContextMenuContext, DndContext,
  EditableContext, Form, SortableContext, Table, cellContextMenuValue, closestCenter,
  displayColumnNames, form, handleDragEnd, handleTableChange, horizontalListSortingStrategy,
  loading, rowClassName, rowSelectionConfig, sensors, tableColumns, tableComponents, tableRef,
  tableRenderData, tableScrollConfig, virtualListItemColumnVirtual, virtualListItemHeight,
  virtualListItemHeightFixed, virtualListItemNativeScrollbarControlled, externalHorizontalScrollRef,
  applyExternalScrollToTableTargets, handleExternalHorizontalScrollPointerDown,
  handleExternalHorizontalScrollPointerRelease, handleExternalHorizontalScrollLostPointerCapture,
  horizontalScrollWidth, externalScrollbarMinWidth, DataGridPageFind, pageFindInputRef,
  noAutoCapInputProps, pageFindText, normalizedPageFindText, pageFindMatches,
  activePageFindPosition, pageFindSummary, setPageFindText, handleClosePageFind,
  handleNavigatePageFind, translateDataGrid, pageFindOpen, viewMode, isTableSurfaceActive,
  DataGridColumnQuickFind, columnQuickFindText, columnQuickFindOptions, setColumnQuickFindText,
  handleSubmitColumnQuickFind, DataGridResultViewSwitcher, handleViewModeChange, useCallback,
  onRequestTotalCount, pagination, onCancelTotalCount, DataGridPaginationBar, selectedRowCount,
  paginationV2SummaryText, paginationTotalPages, paginationPageText, paginationPageSizeOptions,
  allowCustomPageSize, paginationHasKnownTotalPages, prefersManualTotalCount, onPageChange,
  onLastPage, handlePageSizeChange, handleV2PageStep, useMemo, rowEditorDisplayRef,
  rowEditorNullColsRef, looksLikeJsonText, columnMetaMap, columnMetaMapByLowerName,
  getTemporalPickerType, dbType, currentConnConfig, isWritableResultColumn, effectiveEditLocator,
  rowEditorOpen, rowEditorRowKey, setSelectedRowKeys, resetCellSelection, tableName, connectionId,
  columnMetaCacheRef, metadataCacheKey, foreignKeyCacheRef, uniqueKeyGroupsCacheRef,
  setMetadataReloadVersion, onReload, clearAutoCommitTimer, autoCommitFailedTokenRef, setAddedRows,
  setModifiedRows, setDeletedRowKeys, Set, setModifiedColumns, onToggleFilter, filterConditions,
  showFilter, addFilter, cellEditMode, closeCellEditMode, cellEditModeRef, setCellEditMode,
  mergedDisplayData, JSON, useStore, setTimeout, window, CustomEvent,
}: UseDataGridShellRenderersInput) => {
  const renderDataTableView = () => (
        <div
            ref={tableContainerRef}
            className={`gn-v2-data-grid-table-shell gn-v2-data-grid-table-wrap data-grid-table-wrap${horizontalScrollVisible ? ' data-grid-table-wrap-external-active' : ''}`}
            data-horizontal-scroll-sync={virtualListItemHorizontalOffsetComposited ? 'transform' : undefined}
            onClickCapture={enableVirtual ? handleVirtualTableClickCapture : undefined}
            onDoubleClickCapture={enableVirtual ? handleVirtualTableDoubleClickCapture : undefined}
            onContextMenuCapture={enableVirtual ? handleVirtualTableContextMenuCapture : undefined}
            style={{
                flex: '1 1 auto',
                minHeight: 0,
                position: 'relative',
                boxSizing: 'border-box',
                paddingBottom: enableVirtual ? tableBodyBottomPadding : 0,
            }}
        >
            <DataGridTableSurface
                CellContextMenuContext={CellContextMenuContext}
                DndContext={DndContext}
                EditableContext={EditableContext}
                Form={Form}
                SortableContext={SortableContext}
                Table={Table}
                cellContextMenuValue={cellContextMenuValue}
                closestCenter={closestCenter}
                displayColumnNames={displayColumnNames}
                enableVirtual={enableVirtual}
                form={form}
                handleDragEnd={handleDragEnd}
                handleTableChange={handleTableChange}
                horizontalListSortingStrategy={horizontalListSortingStrategy}
                loading={loading}
                rowClassName={rowClassName}
                rowSelectionConfig={rowSelectionConfig}
                sensors={sensors}
                tableColumns={tableColumns}
                tableComponents={tableComponents}
                tableRef={tableRef}
                tableRenderData={tableRenderData}
                tableScrollConfig={tableScrollConfig}
                virtualListItemColumnVirtual={virtualListItemColumnVirtual}
                virtualListItemHeight={virtualListItemHeight}
                virtualListItemHeightFixed={virtualListItemHeightFixed}
                virtualListItemNativeScrollbarControlled={virtualListItemNativeScrollbarControlled}
                virtualListItemHorizontalOffsetComposited={virtualListItemHorizontalOffsetComposited}
            />
            <div
                ref={externalHorizontalScrollRef}
                className="data-grid-external-horizontal-scroll"
                aria-hidden={!horizontalScrollVisible}
                onScroll={applyExternalScrollToTableTargets}
                onPointerDown={handleExternalHorizontalScrollPointerDown}
                onPointerUp={handleExternalHorizontalScrollPointerRelease}
                onPointerCancel={handleExternalHorizontalScrollPointerRelease}
                onLostPointerCapture={handleExternalHorizontalScrollLostPointerCapture}
                style={{
                    opacity: horizontalScrollVisible ? 1 : 0,
                    pointerEvents: horizontalScrollVisible ? 'auto' : 'none',
                }}
            >
                <div
                    className="data-grid-external-horizontal-scroll-inner"
                    style={{ width: `${Math.max(horizontalScrollWidth, externalScrollbarMinWidth)}px` }}
                />
            </div>
        </div>
    );
    const pageFindContent = (
        <DataGridPageFind
            inputRef={pageFindInputRef}
            inputProps={noAutoCapInputProps as Record<string, unknown>}
            pageFindText={pageFindText}
            normalizedPageFindText={normalizedPageFindText}
            hasMatches={pageFindMatches.length > 0}
            activePageFindPosition={activePageFindPosition}
            matchCount={pageFindMatches.length}
            occurrenceCount={pageFindSummary.occurrenceCount}
            matchedCellCount={pageFindSummary.matchedCellCount}
            onPageFindTextChange={setPageFindText}
            onCancel={handleClosePageFind}
            onNavigatePrevious={() => handleNavigatePageFind('previous')}
            onNavigateNext={() => handleNavigatePageFind('next')}
            translate={translateDataGrid}
        />
    );
    const floatingPageFindContent = pageFindOpen && viewMode === 'table'
        ? pageFindContent
        : null;
    const columnQuickFindContent = isTableSurfaceActive ? (
        <DataGridColumnQuickFind
            inputProps={noAutoCapInputProps as Record<string, unknown>}
            value={columnQuickFindText}
            options={columnQuickFindOptions}
            translate={translateDataGrid}
            onChange={setColumnQuickFindText}
            onSubmit={handleSubmitColumnQuickFind}
        />
    ) : null;
    const resultViewSwitcher = (
        <DataGridResultViewSwitcher
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            translate={translateDataGrid}
        />
    );
    const handleToggleTotalCount = useCallback(() => {
        if (!onRequestTotalCount) return;
        if (pagination?.totalCountLoading) {
            onCancelTotalCount?.();
            return;
        }
        if (pagination?.totalCountUnavailableReason) return;
        onRequestTotalCount();
    }, [onCancelTotalCount, onRequestTotalCount, pagination?.totalCountLoading, pagination?.totalCountUnavailableReason]);
    const paginationContent = (
        <DataGridPaginationBar
            pagination={pagination}
            selectedRowCount={selectedRowCount}
            paginationV2SummaryText={paginationV2SummaryText}
            paginationTotalPages={paginationTotalPages}
            paginationPageText={paginationPageText}
            paginationPageSizeOptions={paginationPageSizeOptions}
            allowCustomPageSize={allowCustomPageSize}
            showKnownPageCount={paginationHasKnownTotalPages}
            manualTotalCountAvailable={prefersManualTotalCount && !!onRequestTotalCount}
            totalCountLoading={pagination?.totalCountLoading}
            onPageChange={onPageChange}
            onLastPage={onLastPage}
            onPageSizeChange={handlePageSizeChange}
            onV2PageStep={handleV2PageStep}
            onToggleTotalCount={onRequestTotalCount ? handleToggleTotalCount : undefined}
            translate={translateDataGrid}
        />
    );
  
    const rowEditorFields = useMemo(() => (
        displayColumnNames.map((col: string) => {
            const sample = rowEditorDisplayRef.current?.[col] ?? '';
            const placeholder = rowEditorNullColsRef.current?.has(col) ? '(NULL)' : undefined;
            const isJson = looksLikeJsonText(sample);
            const useTextArea = isJson || sample.includes('\n') || sample.length >= 160;
            const colMeta = columnMetaMap[col] || columnMetaMapByLowerName[col.toLowerCase()];
            const pickerType = getTemporalPickerType(colMeta?.type, dbType, currentConnConfig);
            const isTemporalValue = !!pickerType && !(/^0{4}-0{2}-0{2}/.test(String(sample || '')));
            const isWritable = isWritableResultColumn(col, effectiveEditLocator);
            return {
                columnName: col,
                sample,
                placeholder,
                isJson,
                useTextArea,
                pickerType,
                isTemporalValue,
                isWritable,
            };
        })
    ), [columnMetaMap, columnMetaMapByLowerName, currentConnConfig, dbType, displayColumnNames, effectiveEditLocator, rowEditorOpen, rowEditorRowKey]);
  
    const handleRefreshGrid = useCallback(() => {
        setSelectedRowKeys([]);
        resetCellSelection();
        const normalizedTableName = String(tableName || '').trim();
        if (connectionId && normalizedTableName) {
            delete columnMetaCacheRef.current[metadataCacheKey];
            delete foreignKeyCacheRef.current[metadataCacheKey];
            delete uniqueKeyGroupsCacheRef.current[metadataCacheKey];
            setMetadataReloadVersion((value: number) => value + 1);
        }
        if (onReload) onReload();
    }, [connectionId, metadataCacheKey, onReload, resetCellSelection, tableName]);
  
    const handleResetPendingChanges = useCallback(() => {
        clearAutoCommitTimer();
        autoCommitFailedTokenRef.current = -1;
        setAddedRows([]);
        setModifiedRows({});
        setDeletedRowKeys(new Set());
        setModifiedColumns({});
    }, [clearAutoCommitTimer]);
  
    const handleToggleFilterWithDefault = useCallback(() => {
        if (!onToggleFilter) return;
        onToggleFilter();
        if (filterConditions.length === 0 && !showFilter) addFilter();
    }, [onToggleFilter, filterConditions.length, showFilter]);
  
    const handleToggleCellEditMode = useCallback(() => {
        const next = !cellEditMode;
        if (!next) {
            closeCellEditMode();
        } else {
            cellEditModeRef.current = true;
            setCellEditMode(true);
            resetCellSelection();
        }
        void message.info(next
            ? translateDataGrid('data_grid.message.cell_edit_mode_entered')
            : translateDataGrid('data_grid.message.cell_edit_mode_exited')).then();
    }, [cellEditMode, closeCellEditMode, resetCellSelection, translateDataGrid]);
  
    const handleRequestAiInsight = useCallback(() => {
        const sampleData = mergedDisplayData.slice(0, 10);
        const prompt = translateDataGrid('data_grid.ai_insight.prompt', {
            count: sampleData.length,
            json: JSON.stringify(sampleData, null, 2),
        });
        const store = useStore.getState();
        const wasClosed = !store.aiPanelVisible;
        if (wasClosed) store.setAIPanelVisible(true);
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('gonavi:ai:inject-prompt', { detail: { prompt } }));
        }, wasClosed ? 350 : 0);
    }, [mergedDisplayData, translateDataGrid]);
  return {
    renderDataTableView, floatingPageFindContent, columnQuickFindContent, resultViewSwitcher,
    handleToggleTotalCount, paginationContent, rowEditorFields, handleRefreshGrid,
    handleResetPendingChanges, handleToggleFilterWithDefault, handleToggleCellEditMode,
    handleRequestAiInsight,
  };
};

export type DataGridShellRenderersApi = ReturnType<typeof useDataGridShellRenderers>;
