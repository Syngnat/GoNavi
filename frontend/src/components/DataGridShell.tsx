import React from 'react';
import ImportPreviewModal from './ImportPreviewModal';
import DataGridSecondaryActions from './DataGridSecondaryActions';
import { useDataGridShellRenderers } from './dataGrid/shell/useDataGridShellRenderers';
import { DataGridShellToolbar } from './dataGrid/shell/DataGridShellToolbar';
import { DataGridShellBody } from './dataGrid/shell/DataGridShellBody';
import { DataGridShellRowEditorModal } from './dataGrid/shell/DataGridShellRowEditorModal';
export { DataGridTableSurface } from './dataGrid/shell/DataGridTableSurface';

export type DataGridShellProps = Record<string, any>;

const DataGridShell: React.FC<DataGridShellProps> = (props) => {
  const {
    CellContextMenuContext,
    CustomEvent,
    DataGridColumnQuickFind,
    DataGridPageFind,
    DataGridPaginationBar,
    DataGridResultViewSwitcher,
    DndContext,
    EditableContext,
    Form,
    JSON,
    Set,
    SortableContext,
    Table,
    activePageFindPosition,
    activeShortcutPlatform,
    addFilter,
    aiShortcutLabel,
    allSelectedAreDeleted,
    applyAllFiltersDisabled,
    applyAllFiltersEnabled,
    applyExternalScrollToTableTargets,
    handleExternalHorizontalScrollPointerDown,
    handleExternalHorizontalScrollPointerRelease,
    handleExternalHorizontalScrollLostPointerCapture,
    applyFilters,
    applyJsonEditor,
    applyQuickWhereCondition,
    applyRowEditor,
    applySortInfo,
    autoCommitFailedTokenRef,
    autoCommitRemainingSeconds,
    batchEditModalOpen,
    batchEditSetNull,
    batchEditValue,
    bgContent,
    bgContextMenu,
    bgFilter,
    canCopyQueryResult,
    canExport,
    canImport,
    canModifyData,
    canEditContextMenuCell,
    canOpenObjectDesigner,
    canUndoContextMenuCellChange,
    canViewDdl,
    cellContextMenu,
    cellContextMenuPortalRef,
    cellContextMenuValue,
    cellEditMode,
    cellEditModeRef,
    cellEditorIsJson,
    cellEditorEscapeApplied,
    cellEditorMeta,
    cellEditorOpen,
    cellEditorReadOnly,
    cellEditorViewerMode,
    cellEditorValue,
    clearAllFiltersAndSorts,
    clearAutoCommitTimer,
    clearQuickWhereCondition,
    closeBatchEditModal,
    closeCellEditMode,
    closeCellEditor,
    closeDdlView,
    closeJsonEditor,
    closeRowEditor,
    closestCenter,
    columnInfoSettingContent,
    columnMetaCacheRef,
    columnMetaMap,
    columnMetaMapByLowerName,
    columnQuickFindOptions,
    columnQuickFindText,
    connectionId,
    connections,
    containerRef,
    contextHolder,
    copiedCellPatch,
    copiedRowsForPaste,
    copyRowsForPaste,
    copyToClipboard,
    currentConnConfig,
    designerReadOnly,
    currentTextRow,
    darkMode,
    dataEditAutoCommitDelayMs,
    dataEditCommitMode,
    deleteTargetRowCount,
    dataPanelDirtyRef,
    dataPanelIsJson,
    dataPanelOpen,
    dataPanelOriginalRef,
    dataPanelValue,
    dbName,
    schemaName,
    dbType,
    ddlLoading,
    ddlModalOpen,
    ddlSidebarResizePreviewX,
    ddlSidebarWidth,
    ddlText,
    ddlViewLayout,
    displayColumnNames,
    displayOutputColumnNames,
    effectiveEditLocator,
    enableVirtual,
    exportProgressModal,
    externalHorizontalScrollRef,
    externalScrollbarMinWidth,
    filterConditions,
    filterLogicOptions,
    filterOpOptions,
    filterPanelRef,
    filterTopPadding,
    focusedCellInfo,
    focusedCellWritable,
    foreignKeyCacheRef,
    form,
    formatTextViewValue,
    getTargets,
    getTemporalPickerType,
    gridCssText,
    gridFieldSelectOptions,
    gridId,
    handleAddRow,
    handleBatchFillCells,
    handleBatchFillToSelected,
    handleCellEditorSave,
    handleCellEditorValueChange,
    handleCellSetNull,
    handleSetNullForSelectedCells,
    handleClosePageFind,
    handleCommit,
    handleCopyContextMenuFieldName,
    handleCopyCsv,
    handleCopyDdl,
    handleCopyDelete,
    handleCopyInsert,
    handleCopyJson,
    handleCopyRowData,
    handleCopySelectedCellsToClipboard,
    handleCopySelectedColumnsFromRow,
    handleCopyUpdate,
    handleOpenContextMenuCellEditor,
    handleDataPanelFormatJson,
    handleDataPanelSave,
    handleDataGridRootPointerDownCapture,
    handleDdlSidebarResizeStart,
    handleDeleteSelected,
    handleDragEnd,
    handleExportSelected,
    handleFormatJsonEditor,
    handleFormatJsonInEditor,
    handleCompactJsonInEditor,
    handleEscapeCellEditorValue,
    handleUnescapeCellEditorValue,
    handleImport,
    handleImportSuccess,
    handleNavigatePageFind,
    handleOpenContextMenuRowEditor,
    handleOpenExportDialog,
    handleOpenJsonEditor,
    handleOpenTableDdl,
    handlePageSizeChange,
    handlePasteCopiedColumnsToSelectedRows,
    handlePasteCopiedRowsAsNew,
    handlePreviewChanges,
    handleQuickWherePaste,
    handleSubmitColumnQuickFind,
    handleTableChange,
    handleUndoContextMenuCellChange,
    handleUndoDeleteSelected,
    handleV2CellContextMenuAction,
    handleV2ColumnHeaderContextMenuAction,
    handleV2PageStep,
    handleViewModeChange,
    handleVirtualTableClickCapture,
    handleVirtualTableContextMenuCapture,
    handleVirtualTableDoubleClickCapture,
    hasChanges,
    headerCellMinHeight,
    horizontalListSortingStrategy,
    horizontalScrollVisible,
    horizontalScrollWidth,
    importFilePath,
    importPreviewVisible,
    isBetweenOp,
    isListOp,
    isNoValueOp,
    isQueryResultExport,
    isTableSurfaceActive,
    isWritableResultColumn,
    jsonEditorOpen,
    jsonEditorValue,
    jsonViewText,
    loading,
    localizedDataEditAutoCommitDelayOptions,
    looksLikeJsonText,
    mergedDisplayData,
    metadataCacheKey,
    noAutoCapInputProps,
    normalizedPageFindText,
    onCancelTotalCount,
    onOpenErTable,
    onPageChange,
    onLastPage,
    onReload,
    onRequestTotalCount,
    onSort,
    onToggleFilter,
    openBatchEditModal,
    openCurrentViewRowEditor,
    openRowEditorFieldEditor,
    pageFindInputRef,
    pageFindMatches,
    pageFindOpen,
    pageFindSummary,
    pageFindText,
    pagination,
    allowCustomPageSize,
    paginationHasKnownTotalPages,
    paginationPageSizeOptions,
    paginationPageText,
    paginationTotalPages,
    paginationV2SummaryText,
    panelFrameColor,
    panelOuterGap,
    panelPaddingX,
    panelPaddingY,
    panelRadius,
    pendingChangeCount,
    pinnedLeftColumnScope,
    pinnedLeftColumnSet,
    pkColumns,
    prefersManualTotalCount,
    previewModalOpen,
    previewSqlData,
    queryResultCopyMenu,
    quickWhereCondition,
    quickWhereDraft,
    quickWhereSuggestionOptions,
    quickWhereSuggestionsOpen,
    readOnly,
    removeFilter,
    renderGridFieldSelectOption,
    resetCellSelection,
    resolveColumnQuickFindTarget,
    resolveContextMenuFieldName,
    resolveWhereConditionSelectedValue,
    rootRef,
    rowClassName,
    rowEditorDisplayRef,
    rowEditorForm,
    rowEditorNullColsRef,
    rowEditorOpen,
    rowEditorRowKey,
    rowSelectionConfig,
    selectedCells,
    selectedCellCount,
    selectedCellRowCount,
    selectedRowCount,
    fillTemplateTargetRowCount,
    selectedRowKeys,
    sensors,
    setAddedRows,
    setBatchEditSetNull,
    setBatchEditValue,
    setCellContextMenu,
    setCellEditMode,
    setColumnQuickFindText,
    setDataEditTransactionOptions,
    setDataPanelValue,
    setDdlModalOpen,
    setDdlViewLayout,
    setDeletedRowKeys,
    setImportFilePath,
    setImportPreviewVisible,
    setJsonEditorValue,
    setMetadataReloadVersion,
    setModifiedColumns,
    setModifiedRows,
    setPageFindText,
    setPreviewModalOpen,
    setQuickWhereDraft,
    setQuickWhereSuggestionsOpen,
    setSelectedRowKeys,
    setTextRecordIndex,
    setTimeout,
    shouldApplyQuickWhereOnEnter,
    showColumnComment,
    showColumnType,
    showFilter,
    appliedFilterConditions,
    sortInfo,
    stopQuickWhereClipboardPropagation,
    supportsCopyInsert,
    tableBodyBottomPadding,
    tableColumns,
    tableComponents,
    tableContainerRef,
    tableName,
    tableRef,
    tableRenderData,
    tableScrollConfig,
    textRecordIndex,
    textViewRows,
    toggleDataPanel,
    toolbarBottomPadding,
    toolbarExtraActions,
    translateDataGrid,
    uniqueKeyGroupsCacheRef,
    updateFilter,
    useCallback,
    useMemo,
    useStore,
    viewMode,
    virtualListItemHeight,
    virtualListItemHeightFixed,
    virtualListItemNativeScrollbarControlled,
    virtualListItemHorizontalOffsetComposited,
    virtualListItemColumnVirtual,
    window,
  } = props;

const {
  renderDataTableView, floatingPageFindContent, columnQuickFindContent, resultViewSwitcher,
  handleToggleTotalCount, paginationContent, rowEditorFields, handleRefreshGrid,
  handleResetPendingChanges, handleToggleFilterWithDefault, handleToggleCellEditMode,
  handleRequestAiInsight,
} = useDataGridShellRenderers({
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
});

  return (
    <div
        ref={rootRef}
        tabIndex={-1}
        onPointerDownCapture={handleDataGridRootPointerDownCapture}
        className={`${gridId}${cellEditMode ? ' cell-edit-mode' : ''}${tableRenderData.length === 0 ? ' data-grid-empty' : ''} data-grid-root gn-v2-data-grid`}
        style={{ '--gonavi-header-min-height': `${headerCellMinHeight}px`, flex: '1 1 auto', height: '100%', overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, background: 'transparent', outline: 'none' } as React.CSSProperties}
    >
        <DataGridShellToolbar
          tableName={tableName} dbName={dbName} translateDataGrid={translateDataGrid}
          loading={loading} darkMode={darkMode} bgFilter={bgFilter}
          panelFrameColor={panelFrameColor} panelRadius={panelRadius}
          panelOuterGap={panelOuterGap} panelPaddingY={panelPaddingY}
          panelPaddingX={panelPaddingX} toolbarBottomPadding={toolbarBottomPadding}
          filterTopPadding={filterTopPadding} showFilter={showFilter}
          appliedFilterConditions={appliedFilterConditions} filterPanelRef={filterPanelRef}
          onReload={onReload} onToggleFilter={onToggleFilter} canModifyData={canModifyData}
          selectedRowKeys={selectedRowKeys} deleteTargetRowCount={deleteTargetRowCount}
          allSelectedAreDeleted={allSelectedAreDeleted} cellEditMode={cellEditMode}
          selectedCells={selectedCells} selectedCellRowCount={selectedCellRowCount}
          fillTemplateTargetRowCount={fillTemplateTargetRowCount}
          copiedCellPatch={copiedCellPatch} hasChanges={hasChanges}
          pendingChangeCount={pendingChangeCount} dataEditCommitMode={dataEditCommitMode}
          dataEditAutoCommitDelayMs={dataEditAutoCommitDelayMs}
          localizedDataEditAutoCommitDelayOptions={localizedDataEditAutoCommitDelayOptions}
          autoCommitRemainingSeconds={autoCommitRemainingSeconds} canImport={canImport}
          canExport={canExport} isQueryResultExport={isQueryResultExport}
          canCopyQueryResult={canCopyQueryResult}
          prefersManualTotalCount={prefersManualTotalCount}
          onRequestTotalCount={onRequestTotalCount} aiShortcutLabel={aiShortcutLabel}
          pagination={pagination} toolbarExtraActions={toolbarExtraActions}
          filterConditions={filterConditions} sortInfo={sortInfo}
          displayColumnNames={displayColumnNames} quickWhereDraft={quickWhereDraft}
          quickWhereCondition={quickWhereCondition}
          quickWhereSuggestionsOpen={quickWhereSuggestionsOpen}
          quickWhereSuggestionOptions={quickWhereSuggestionOptions}
          gridFieldSelectOptions={gridFieldSelectOptions} filterLogicOptions={filterLogicOptions}
          filterOpOptions={filterOpOptions}
          renderGridFieldSelectOption={renderGridFieldSelectOption}
          noAutoCapInputProps={noAutoCapInputProps} queryResultCopyMenu={queryResultCopyMenu}
          dbType={dbType} handleResetPendingChanges={handleResetPendingChanges}
          setDataEditTransactionOptions={setDataEditTransactionOptions}
          handleRefreshGrid={handleRefreshGrid}
          handleToggleFilterWithDefault={handleToggleFilterWithDefault}
          handleAddRow={handleAddRow} handleUndoDeleteSelected={handleUndoDeleteSelected}
          handleDeleteSelected={handleDeleteSelected}
          handleToggleCellEditMode={handleToggleCellEditMode}
          handleCopySelectedCellsToClipboard={handleCopySelectedCellsToClipboard}
          handleCopySelectedColumnsFromRow={handleCopySelectedColumnsFromRow}
          openBatchEditModal={openBatchEditModal}
          handlePasteCopiedColumnsToSelectedRows={handlePasteCopiedColumnsToSelectedRows}
          handleCommit={handleCommit} handlePreviewChanges={handlePreviewChanges}
          handleImport={handleImport} handleOpenExportDialog={handleOpenExportDialog}
          handleRequestAiInsight={handleRequestAiInsight}
          handleToggleTotalCount={handleToggleTotalCount} setQuickWhereDraft={setQuickWhereDraft}
          setQuickWhereSuggestionsOpen={setQuickWhereSuggestionsOpen}
          shouldApplyQuickWhereOnEnter={shouldApplyQuickWhereOnEnter}
          applyQuickWhereCondition={applyQuickWhereCondition}
          resolveWhereConditionSelectedValue={resolveWhereConditionSelectedValue}
          stopQuickWhereClipboardPropagation={stopQuickWhereClipboardPropagation}
          handleQuickWherePaste={handleQuickWherePaste}
          clearQuickWhereCondition={clearQuickWhereCondition} updateFilter={updateFilter}
          removeFilter={removeFilter} addFilter={addFilter} isListOp={isListOp}
          isBetweenOp={isBetweenOp} isNoValueOp={isNoValueOp} onSort={onSort}
          applySortInfo={applySortInfo} applyFilters={applyFilters}
          applyAllFiltersEnabled={applyAllFiltersEnabled}
          applyAllFiltersDisabled={applyAllFiltersDisabled}
          clearAllFiltersAndSorts={clearAllFiltersAndSorts}
        />

	       <DataGridShellBody
	         containerRef={containerRef} bgContent={bgContent} panelRadius={panelRadius}
	         panelFrameColor={panelFrameColor} contextHolder={contextHolder}
	         exportProgressModal={exportProgressModal} tableName={tableName} darkMode={darkMode}
	         translateDataGrid={translateDataGrid} displayColumnNames={displayColumnNames}
	         rowEditorOpen={rowEditorOpen} rowEditorRowKey={rowEditorRowKey}
	         rowEditorForm={rowEditorForm} rowEditorFields={rowEditorFields}
	         closeRowEditor={closeRowEditor} applyRowEditor={applyRowEditor}
	         openRowEditorFieldEditor={openRowEditorFieldEditor} cellEditorOpen={cellEditorOpen}
	         cellEditorMeta={cellEditorMeta} cellEditorReadOnly={cellEditorReadOnly}
	         cellEditorViewerMode={cellEditorViewerMode} cellEditorIsJson={cellEditorIsJson}
	         cellEditorEscapeApplied={cellEditorEscapeApplied} cellEditorValue={cellEditorValue}
	         closeCellEditor={closeCellEditor} handleFormatJsonInEditor={handleFormatJsonInEditor}
	         handleCompactJsonInEditor={handleCompactJsonInEditor}
	         handleEscapeCellEditorValue={handleEscapeCellEditorValue}
	         handleUnescapeCellEditorValue={handleUnescapeCellEditorValue}
	         handleCellEditorSave={handleCellEditorSave}
	         handleCellEditorValueChange={handleCellEditorValueChange}
	         batchEditModalOpen={batchEditModalOpen} selectedCells={selectedCells}
	         batchEditSetNull={batchEditSetNull} batchEditValue={batchEditValue}
	         closeBatchEditModal={closeBatchEditModal} handleBatchFillCells={handleBatchFillCells}
	         setBatchEditSetNull={setBatchEditSetNull} setBatchEditValue={setBatchEditValue}
	         jsonEditorOpen={jsonEditorOpen} jsonEditorValue={jsonEditorValue}
	         closeJsonEditor={closeJsonEditor} handleFormatJsonEditor={handleFormatJsonEditor}
	         applyJsonEditor={applyJsonEditor} setJsonEditorValue={setJsonEditorValue}
	         ddlModalOpen={ddlModalOpen} ddlLoading={ddlLoading} ddlText={ddlText}
	         setDdlModalOpen={setDdlModalOpen} handleCopyDdl={handleCopyDdl}
	         floatingPageFindContent={floatingPageFindContent} viewMode={viewMode}
	         renderDataTableView={renderDataTableView} canOpenObjectDesigner={canOpenObjectDesigner}
	         connectionId={connectionId} dbName={dbName} schemaName={schemaName}
	         designerReadOnly={designerReadOnly} displayOutputColumnNames={displayOutputColumnNames}
	         pkColumns={pkColumns} effectiveEditLocator={effectiveEditLocator}
	         columnMetaMap={columnMetaMap} columnMetaMapByLowerName={columnMetaMapByLowerName}
	         ddlViewLayout={ddlViewLayout} setDdlViewLayout={setDdlViewLayout}
	         closeDdlView={closeDdlView} handleOpenTableDdl={handleOpenTableDdl}
	         ddlSidebarWidth={ddlSidebarWidth} ddlSidebarResizePreviewX={ddlSidebarResizePreviewX}
	         handleDdlSidebarResizeStart={handleDdlSidebarResizeStart} connections={connections}
	         onOpenErTable={onOpenErTable} mergedDisplayData={mergedDisplayData}
	         canModifyData={canModifyData} jsonViewText={jsonViewText}
	         handleViewModeChange={handleViewModeChange} handleOpenJsonEditor={handleOpenJsonEditor}
	         textViewRows={textViewRows} textRecordIndex={textRecordIndex}
	         currentTextRow={currentTextRow} showColumnType={showColumnType}
	         showColumnComment={showColumnComment} setTextRecordIndex={setTextRecordIndex}
	         openCurrentViewRowEditor={openCurrentViewRowEditor}
	         formatTextViewValue={formatTextViewValue} dataPanelOpen={dataPanelOpen}
	         isTableSurfaceActive={isTableSurfaceActive} focusedCellInfo={focusedCellInfo}
	         dataPanelIsJson={dataPanelIsJson} focusedCellWritable={focusedCellWritable}
	         dataPanelValue={dataPanelValue} handleDataPanelFormatJson={handleDataPanelFormatJson}
	         handleDataPanelSave={handleDataPanelSave} setDataPanelValue={setDataPanelValue}
	         dataPanelDirtyRef={dataPanelDirtyRef} dataPanelOriginalRef={dataPanelOriginalRef}
	         cellContextMenu={cellContextMenu} cellContextMenuPortalRef={cellContextMenuPortalRef}
	         resolveContextMenuFieldName={resolveContextMenuFieldName} sortInfo={sortInfo}
	         activeShortcutPlatform={activeShortcutPlatform}
	         pinnedLeftColumnSet={pinnedLeftColumnSet} pinnedLeftColumnScope={pinnedLeftColumnScope}
	         handleV2ColumnHeaderContextMenuAction={handleV2ColumnHeaderContextMenuAction}
	         selectedRowKeys={selectedRowKeys} selectedCellCount={selectedCellCount}
	         canEditContextMenuCell={canEditContextMenuCell}
	         canUndoContextMenuCellChange={canUndoContextMenuCellChange}
	         copiedRowsForPaste={copiedRowsForPaste} copiedCellPatch={copiedCellPatch}
	         supportsCopyInsert={supportsCopyInsert}
	         handleV2CellContextMenuAction={handleV2CellContextMenuAction}
	       />

	       <DataGridSecondaryActions
                canViewDdl={canViewDdl}
                canOpenObjectDesigner={canOpenObjectDesigner}
                viewMode={viewMode}
                ddlLoading={ddlLoading}
                resultViewSwitcher={resultViewSwitcher}
                columnInfoSettingContent={columnInfoSettingContent}
                columnQuickFindContent={columnQuickFindContent}
                paginationContent={paginationContent}
                onViewModeChange={handleViewModeChange}
                translate={translateDataGrid}
            />

		        <style>{gridCssText}</style>

       {/* Preview SQL Modal */}
       <DataGridShellRowEditorModal
         translateDataGrid={translateDataGrid} previewModalOpen={previewModalOpen}
         setPreviewModalOpen={setPreviewModalOpen} previewSqlData={previewSqlData}
         darkMode={darkMode}
       />

       {/* Import Preview Modal */}
       <ImportPreviewModal
           visible={importPreviewVisible}
           filePath={importFilePath}
           connectionId={connectionId || ''}
           dbName={dbName || ''}
           tableName={tableName || ''}
           onClose={() => {
               setImportPreviewVisible(false);
               setImportFilePath('');
           }}
           onSuccess={handleImportSuccess}
       />
    </div>
  );
};

export default DataGridShell;
