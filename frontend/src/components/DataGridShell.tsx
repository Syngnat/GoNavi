import React from 'react';
import { Button, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { createPortal } from 'react-dom';
import { APP_POPUP_Z_INDEX } from '../utils/overlayZIndex';

import Modal from './common/ResizableDraggableModal';
import ImportPreviewModal from './ImportPreviewModal';
import DataGridModals from './DataGridModals';
import DataGridPreviewPanel from './DataGridPreviewPanel';
import DataGridSecondaryActions from './DataGridSecondaryActions';
import DataGridToolbarFrame from './DataGridToolbarFrame';
import LogPanel from './LogPanel';
import { DataGridJsonView, DataGridTextView } from './DataGridRecordViews';
import { DataGridV2DdlSideWorkspace, DataGridV2DdlView } from './DataGridV2DdlWorkspace';
import { DataGridV2ErView, DataGridV2FieldsView } from './DataGridV2MetadataViews';
import DataGridLegacyCellContextMenu from './DataGridLegacyCellContextMenu';
import TableDesigner from './TableDesigner';
import { V2CellContextMenuView, V2ColumnHeaderContextMenuView } from './V2TableContextMenu';
import {
  FILTER_FIELD_POPUP_WIDTH,
  FILTER_FIELD_SELECT_STYLE,
  GONAVI_ROW_KEY,
} from './DataGridCore';

type DataGridShellProps = Record<string, any>;

const DataGridShell: React.FC<DataGridShellProps> = (props) => {
  const {
    CellContextMenuContext,
    CustomEvent,
    DataContext,
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
    canOpenObjectDesigner,
    canUndoContextMenuCellChange,
    canViewDdl,
    cellContextMenu,
    cellContextMenuPortalRef,
    cellContextMenuValue,
    cellEditMode,
    cellEditModeRef,
    cellEditorIsJson,
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
    dataContextValue,
    dataEditAutoCommitDelayMs,
    dataEditCommitMode,
    deleteTargetRowCount,
    dataPanelDirtyRef,
    dataPanelIsJson,
    dataPanelOpen,
    dataPanelOriginalRef,
    dataPanelValue,
    dbName,
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
    ghostRef,
    gridCssText,
    gridFieldSelectOptions,
    gridId,
    handleAddRow,
    handleBatchFillCells,
    handleBatchFillToSelected,
    handleCellEditorSave,
    handleCellSetNull,
    handleClosePageFind,
    handleCommit,
    handleCopyContextMenuFieldName,
    handleCopyCsv,
    handleCopyDdl,
    handleCopyDelete,
    handleCopyInsert,
    handleCopyJson,
    handleCopyQueryResultCsv,
    handleCopyRowData,
    handleCopySelectedCellsToClipboard,
    handleCopySelectedColumnsFromRow,
    handleCopyUpdate,
    handleDataPanelFormatJson,
    handleDataPanelSave,
    handleDataGridRootPointerDownCapture,
    handleDdlSidebarResizeStart,
    handleDeleteSelected,
    handleDragEnd,
    handleExportSelected,
    handleFormatJsonEditor,
    handleFormatJsonInEditor,
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
    isV2Ui,
    isWritableResultColumn,
    jsonEditorOpen,
    jsonEditorValue,
    jsonViewText,
    legacyAiButtonStyle,
    loading,
    localizedDataEditAutoCommitDelayOptions,
    looksLikeJsonText,
    mergedDisplayData,
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
    paginationControlTotal,
    paginationHasKnownTotalPages,
    paginationPageSizeOptions,
    paginationPageText,
    paginationSummaryText,
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
    selectedRowKeys,
    selectionAccentHex,
    sensors,
    setAddedRows,
    setBatchEditSetNull,
    setBatchEditValue,
    setCellContextMenu,
    setCellEditMode,
    setCellEditorValue,
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
    sortInfo,
    stopQuickWhereClipboardPropagation,
    supportsCopyInsert,
    tableBodyBottomPadding,
    tableColumns,
    tableComponents,
    tableContainerRef,
    tableName,
    tableOnRow,
    tableRef,
    tableRenderData,
    tableScrollConfig,
    textRecordIndex,
    textViewRows,
    toggleDataPanel,
    toolbarBottomPadding,
    toolbarDividerColor,
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
    virtualListItemColumnVirtual,
    window,
  } = props;

const renderDataTableView = () => (
      <div
          ref={tableContainerRef}
          className={`${isV2Ui ? 'gn-v2-data-grid-table-shell gn-v2-data-grid-table-wrap ' : ''}data-grid-table-wrap${horizontalScrollVisible ? ' data-grid-table-wrap-external-active' : ''}`}
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
          <Form component={false} form={form}>
              <DataContext.Provider value={dataContextValue}>
                  <CellContextMenuContext.Provider value={cellContextMenuValue}>
                      <EditableContext.Provider value={form}>
                          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                              <SortableContext items={displayColumnNames} strategy={horizontalListSortingStrategy}>
                                  <Table
                                      ref={tableRef}
                                      components={tableComponents}
                                      dataSource={tableRenderData}
                                      columns={tableColumns}
                                      {...(enableVirtual && typeof virtualListItemHeight === 'number'
                                          ? {
                                              listItemHeight: virtualListItemHeight,
                                              listItemHeightFixed: virtualListItemHeightFixed,
                                              listItemColumnVirtual: virtualListItemColumnVirtual,
                                          }
                                          : {})}
                                      showSorterTooltip={{ target: 'sorter-icon' }}
                                      size="small"
                                      tableLayout="fixed"
                                      scroll={tableScrollConfig}
                                      sticky={false}
                                      virtual={enableVirtual}
                                      loading={loading}
                                      rowKey={GONAVI_ROW_KEY}
                                      pagination={false}
                                      onChange={handleTableChange}
                                      rowHoverable={!enableVirtual}
                                      bordered
                                      rowSelection={rowSelectionConfig}
                                      rowClassName={rowClassName}
                                      onRow={tableOnRow}
                                  />
                              </SortableContext>
                          </DndContext>
                      </EditableContext.Provider>
                  </CellContextMenuContext.Provider>
              </DataContext.Provider>
          </Form>
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
          isV2Ui={isV2Ui}
          darkMode={darkMode}
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
  const floatingPageFindContent = isV2Ui && pageFindOpen && viewMode === 'table'
      ? pageFindContent
      : null;
  const legacyPageFindContent = !isV2Ui && viewMode === 'table'
      ? pageFindContent
      : null;
  const columnQuickFindContent = isTableSurfaceActive ? (
      <DataGridColumnQuickFind
          isV2Ui={isV2Ui}
          darkMode={darkMode}
          inputProps={noAutoCapInputProps as Record<string, unknown>}
          value={columnQuickFindText}
          options={columnQuickFindOptions}
          hasTarget={!!resolveColumnQuickFindTarget(columnQuickFindText)}
          translate={translateDataGrid}
          onChange={setColumnQuickFindText}
          onSubmit={handleSubmitColumnQuickFind}
      />
  ) : null;
  const resultViewSwitcher = (
      <DataGridResultViewSwitcher
          isV2Ui={isV2Ui}
          darkMode={darkMode}
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
      onRequestTotalCount();
  }, [onCancelTotalCount, onRequestTotalCount, pagination?.totalCountLoading]);
  const paginationContent = (
      <DataGridPaginationBar
          isV2Ui={isV2Ui}
          pagination={pagination}
          paginationV2SummaryText={paginationV2SummaryText}
          paginationSummaryText={paginationSummaryText}
          paginationControlTotal={paginationControlTotal}
          paginationTotalPages={paginationTotalPages}
          paginationPageText={paginationPageText}
          paginationPageSizeOptions={paginationPageSizeOptions}
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
      const normalizedDbName = String(dbName || '').trim();
      if (connectionId && normalizedTableName) {
          const cacheKey = `${connectionId}|${normalizedDbName}|${normalizedTableName}`;
          delete columnMetaCacheRef.current[cacheKey];
          delete foreignKeyCacheRef.current[cacheKey];
          delete uniqueKeyGroupsCacheRef.current[cacheKey];
          setMetadataReloadVersion((value: number) => value + 1);
      }
      if (onReload) onReload();
  }, [connectionId, dbName, onReload, resetCellSelection, tableName]);

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

  return (
    <div
        ref={rootRef}
        tabIndex={isV2Ui ? -1 : undefined}
        onPointerDownCapture={isV2Ui ? handleDataGridRootPointerDownCapture : undefined}
        className={`${gridId}${cellEditMode ? ' cell-edit-mode' : ''} data-grid-root${isV2Ui ? ' gn-v2-data-grid' : ''}`}
        style={{ '--gonavi-header-min-height': `${headerCellMinHeight}px`, flex: '1 1 auto', height: '100%', overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, background: 'transparent', outline: 'none' } as React.CSSProperties}
    >
        <DataGridToolbarFrame
            isV2Ui={isV2Ui}
            tableName={tableName}
            dbName={dbName}
            translate={translateDataGrid}
            loading={loading}
            darkMode={darkMode}
            bgFilter={bgFilter}
            panelFrameColor={panelFrameColor}
            panelRadius={panelRadius}
            panelOuterGap={panelOuterGap}
            panelPaddingY={panelPaddingY}
            panelPaddingX={panelPaddingX}
            toolbarBottomPadding={toolbarBottomPadding}
            filterTopPadding={filterTopPadding}
            selectionAccentHex={selectionAccentHex}
            toolbarDividerColor={toolbarDividerColor}
            showFilter={showFilter}
            filterPanelRef={filterPanelRef}
            onReload={onReload}
            onToggleFilter={onToggleFilter}
            canModifyData={canModifyData}
            selectedRowKeysLength={selectedRowKeys.length}
            deleteTargetRowCount={deleteTargetRowCount}
            allSelectedAreDeleted={allSelectedAreDeleted}
            cellEditMode={cellEditMode}
            selectedCellsSize={selectedCells.size}
            copiedCellPatchColumnCount={copiedCellPatch ? Object.keys(copiedCellPatch.values).length : 0}
            hasChanges={hasChanges}
            pendingChangeCount={pendingChangeCount}
            dataEditCommitMode={dataEditCommitMode}
            dataEditAutoCommitDelayMs={dataEditAutoCommitDelayMs}
            dataEditAutoCommitDelayOptions={localizedDataEditAutoCommitDelayOptions}
            autoCommitRemainingSeconds={autoCommitRemainingSeconds}
            canImport={canImport}
            canExport={canExport}
            isQueryResultExport={isQueryResultExport}
            canCopyQueryResult={canCopyQueryResult}
            prefersManualTotalCount={prefersManualTotalCount && !!onRequestTotalCount}
            aiShortcutLabel={aiShortcutLabel}
            legacyAiButtonStyle={legacyAiButtonStyle}
            paginationTotalCountLoading={pagination?.totalCountLoading}
            toolbarExtraActions={toolbarExtraActions}
            filterConditions={filterConditions}
            sortInfo={sortInfo}
            displayColumnNames={displayColumnNames}
            quickWhereDraft={quickWhereDraft}
            quickWhereCondition={quickWhereCondition}
            quickWhereSuggestionsOpen={quickWhereSuggestionsOpen}
            quickWhereSuggestionOptions={quickWhereSuggestionOptions}
            gridFieldSelectOptions={gridFieldSelectOptions}
            filterLogicOptions={filterLogicOptions}
            filterOpOptions={filterOpOptions}
            renderGridFieldSelectOption={renderGridFieldSelectOption}
            noAutoCapInputProps={noAutoCapInputProps as Record<string, unknown>}
            filterFieldSelectStyle={FILTER_FIELD_SELECT_STYLE}
            filterFieldPopupWidth={FILTER_FIELD_POPUP_WIDTH}
            queryResultCopyMenu={queryResultCopyMenu}
            dbType={dbType}
            onResetPendingChanges={handleResetPendingChanges}
            onDataEditCommitModeChange={(mode) => setDataEditTransactionOptions({ commitMode: mode })}
            onDataEditAutoCommitDelayChange={(delayMs) => setDataEditTransactionOptions({ autoCommitDelayMs: delayMs })}
            onRefresh={handleRefreshGrid}
            onToggleFilterClick={handleToggleFilterWithDefault}
            onAddRow={handleAddRow}
            onUndoDeleteSelected={handleUndoDeleteSelected}
            onDeleteSelected={handleDeleteSelected}
            onToggleCellEditMode={handleToggleCellEditMode}
            onCopySelectedCellsToClipboard={handleCopySelectedCellsToClipboard}
            onCopySelectedColumnsFromRow={handleCopySelectedColumnsFromRow}
            onOpenBatchEditModal={openBatchEditModal}
            onPasteCopiedColumnsToSelectedRows={() => handlePasteCopiedColumnsToSelectedRows()}
            onCommit={handleCommit}
            onPreviewChanges={handlePreviewChanges}
            onImport={handleImport}
            onOpenExportModal={handleOpenExportDialog}
            onCopyQueryResultCsv={handleCopyQueryResultCsv}
            onRequestAiInsight={handleRequestAiInsight}
            onToggleTotalCount={handleToggleTotalCount}
            onQuickWhereDraftChange={setQuickWhereDraft}
            onQuickWhereSuggestionsOpenChange={setQuickWhereSuggestionsOpen}
            onQuickWhereKeyDown={(event) => {
                const isClipboardShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && ['c', 'v', 'x'].includes(String(event.key || '').toLowerCase());
                if (isClipboardShortcut) {
                    event.stopPropagation();
                    return;
                }
                if (!shouldApplyQuickWhereOnEnter({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: Boolean((event.nativeEvent as any)?.isComposing),
                    suggestionsOpen: quickWhereSuggestionsOpen,
                    suggestionCount: quickWhereSuggestionOptions.length,
                    activeSuggestionId: event.currentTarget.getAttribute('aria-activedescendant'),
                })) {
                    return;
                }
                event.preventDefault();
                applyQuickWhereCondition();
            }}
            onQuickWhereSelect={(value, option) => {
                setQuickWhereDraft(resolveWhereConditionSelectedValue({
                    selectedValue: value,
                    currentInput: quickWhereDraft,
                    insertText: (option as any)?.insertText,
                }));
            }}
            onQuickWhereCopy={stopQuickWhereClipboardPropagation}
            onQuickWhereCut={stopQuickWhereClipboardPropagation}
            onQuickWherePaste={handleQuickWherePaste}
            onApplyQuickWhere={() => applyQuickWhereCondition()}
            onClearQuickWhere={clearQuickWhereCondition}
            updateFilter={updateFilter}
            removeFilter={removeFilter}
            addFilter={addFilter}
            isListOp={isListOp}
            isBetweenOp={isBetweenOp}
            isNoValueOp={isNoValueOp}
            enableSortControls={!!onSort}
            onApplySortInfo={applySortInfo}
            onApplyFilters={applyFilters}
            onEnableAllFilters={applyAllFiltersEnabled}
            onDisableAllFilters={applyAllFiltersDisabled}
            onClearFiltersAndSorts={clearAllFiltersAndSorts}
        />

	       <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column', background: `var(--gn-bg-panel, ${bgContent})`, borderRadius: panelRadius, border: `1px solid ${panelFrameColor}`, boxSizing: 'border-box' }}>
	        {contextHolder}
            {exportProgressModal}
            <DataGridModals
                tableName={tableName}
                darkMode={darkMode}
                translate={translateDataGrid}
                displayColumnNames={displayColumnNames}
                rowEditorOpen={rowEditorOpen}
                rowEditorRowKey={rowEditorRowKey}
                rowEditorForm={rowEditorForm}
                rowEditorFields={rowEditorFields}
                onCloseRowEditor={closeRowEditor}
                onApplyRowEditor={applyRowEditor}
                onOpenRowEditorFieldEditor={openRowEditorFieldEditor}
                cellEditorOpen={cellEditorOpen}
                cellEditorMeta={cellEditorMeta}
                cellEditorReadOnly={cellEditorReadOnly}
                cellEditorViewerMode={cellEditorViewerMode}
                cellEditorIsJson={cellEditorIsJson}
                cellEditorValue={cellEditorValue}
                onCloseCellEditor={closeCellEditor}
                onFormatJsonInEditor={handleFormatJsonInEditor}
                onSaveCellEditor={handleCellEditorSave}
                onCellEditorValueChange={setCellEditorValue}
                batchEditModalOpen={batchEditModalOpen}
                selectedCellsSize={selectedCells.size}
                batchEditSetNull={batchEditSetNull}
                batchEditValue={batchEditValue}
                onCloseBatchEditModal={closeBatchEditModal}
                onApplyBatchFill={handleBatchFillCells}
                onBatchEditSetNullChange={setBatchEditSetNull}
                onBatchEditValueChange={setBatchEditValue}
                jsonEditorOpen={jsonEditorOpen}
                jsonEditorValue={jsonEditorValue}
                onCloseJsonEditor={closeJsonEditor}
                onFormatJsonEditor={handleFormatJsonEditor}
                onApplyJsonEditor={applyJsonEditor}
                onJsonEditorValueChange={setJsonEditorValue}
                ddlModalOpen={ddlModalOpen}
                ddlLoading={ddlLoading}
                ddlText={ddlText}
                onCloseDdlModal={() => setDdlModalOpen(false)}
                onCopyDdl={handleCopyDdl}
            />
            {floatingPageFindContent ? (
                <div
                    data-grid-page-find-overlay="true"
                    className="gn-v2-data-grid-page-find-overlay"
                >
                    {floatingPageFindContent}
                </div>
            ) : null}

        {viewMode === 'table' ? (
            renderDataTableView()
        ) : isV2Ui && viewMode === 'fields' ? (
            canOpenObjectDesigner ? (
                <TableDesigner
                    embedded
                    tab={{
                        id: `embedded-design-${connectionId || ''}-${dbName || ''}-${tableName || ''}`,
                        title: translateDataGrid('data_grid.embedded_designer.title', { tableName: tableName || '' }),
                        type: 'design',
                        connectionId: String(connectionId || ''),
                        dbName,
                        tableName,
                        initialTab: 'columns',
                        readOnly: designerReadOnly,
                        objectType: 'table',
                    }}
                />
            ) : (
                <DataGridV2FieldsView
                    tableName={tableName}
                    displayOutputColumnNames={displayOutputColumnNames}
                    pkColumns={pkColumns}
                    locatorColumns={effectiveEditLocator?.columns}
                    columnMetaMap={columnMetaMap}
                    columnMetaMapByLowerName={columnMetaMapByLowerName}
                    translate={translateDataGrid}
                />
            )
        ) : isV2Ui && viewMode === 'ddl' && ddlViewLayout === 'side' ? (
            <DataGridV2DdlSideWorkspace
                tableContent={renderDataTableView()}
                translate={translateDataGrid}
                tableName={tableName}
                ddlViewLayout={ddlViewLayout}
                ddlLoading={ddlLoading}
                ddlText={ddlText}
                darkMode={darkMode}
                onDdlViewLayoutChange={setDdlViewLayout}
                onClose={closeDdlView}
                onReload={() => {
                    void handleOpenTableDdl({ asView: true });
                }}
                onCopy={handleCopyDdl}
                ddlSidebarWidth={ddlSidebarWidth}
                ddlSidebarResizePreviewX={ddlSidebarResizePreviewX}
                onResizeStart={handleDdlSidebarResizeStart}
            />
        ) : isV2Ui && viewMode === 'ddl' ? (
            <DataGridV2DdlView
                layout="bottom"
                translate={translateDataGrid}
                tableName={tableName}
                ddlViewLayout={ddlViewLayout}
                ddlLoading={ddlLoading}
                ddlText={ddlText}
                darkMode={darkMode}
                onDdlViewLayoutChange={setDdlViewLayout}
                onClose={closeDdlView}
                onReload={() => {
                    void handleOpenTableDdl({ asView: true });
                }}
                onCopy={handleCopyDdl}
            />
        ) : isV2Ui && viewMode === 'er' ? (
            <DataGridV2ErView
                connections={connections}
                connectionId={connectionId}
                dbName={dbName}
                tableName={tableName}
                displayOutputColumnNames={displayOutputColumnNames}
                columnMetaMap={columnMetaMap}
                columnMetaMapByLowerName={columnMetaMapByLowerName}
                onOpenTable={onOpenErTable}
                translate={translateDataGrid}
            />
        ) : isV2Ui && viewMode === 'sqlLog' ? (
            <LogPanel variant="embedded" />
        ) : viewMode === 'json' ? (
            <DataGridJsonView
                darkMode={darkMode}
                rowCount={mergedDisplayData.length}
                canModifyData={canModifyData}
                jsonViewText={jsonViewText}
                translate={translateDataGrid}
                onOpenJsonEditor={handleOpenJsonEditor}
            />
        ) : (
            <DataGridTextView
                darkMode={darkMode}
                rowCount={textViewRows.length}
                textRecordIndex={textRecordIndex}
                canModifyData={canModifyData}
                currentTextRow={currentTextRow}
                displayOutputColumnNames={displayOutputColumnNames}
                columnMetaMap={columnMetaMap}
                columnMetaMapByLowerName={columnMetaMapByLowerName}
                showColumnType={showColumnType}
                showColumnComment={showColumnComment}
                translate={translateDataGrid}
                onPrev={() => setTextRecordIndex((i: number) => Math.max(0, i - 1))}
                onNext={() => setTextRecordIndex((i: number) => Math.min(textViewRows.length - 1, i + 1))}
                onEditCurrent={openCurrentViewRowEditor}
                formatTextViewValue={formatTextViewValue}
            />
        )}

        <DataGridPreviewPanel
            visible={dataPanelOpen}
            isTableSurfaceActive={isTableSurfaceActive}
            darkMode={darkMode}
            focusedCellInfo={focusedCellInfo}
            dataPanelIsJson={dataPanelIsJson}
            focusedCellWritable={focusedCellWritable}
            dataPanelValue={dataPanelValue}
            columnMetaMap={columnMetaMap}
            columnMetaMapByLowerName={columnMetaMapByLowerName}
            translate={translateDataGrid}
            onFormatJson={() => {
                handleDataPanelFormatJson((errorMessage: string) => {
                    void message.error(translateDataGrid('data_grid.json_editor.invalid_format', { error: errorMessage }));
                });
            }}
            onSave={handleDataPanelSave}
            onValueChange={setDataPanelValue}
            onDirtyChange={(dirty) => {
                dataPanelDirtyRef.current = dirty;
            }}
            isDirtyComparedToOriginal={(value) => value !== dataPanelOriginalRef.current}
        />

        {isTableSurfaceActive && isV2Ui && cellContextMenu.visible && createPortal(
            <div
                ref={cellContextMenuPortalRef}
                className="gn-v2-table-context-menu-portal"
                data-gonavi-close-shortcut-guard="true"
                data-gonavi-close-shortcut-blocks-background="true"
                style={{
                    position: 'fixed',
                    left: cellContextMenu.x,
                    top: cellContextMenu.y,
                    zIndex: APP_POPUP_Z_INDEX,
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {cellContextMenu.kind === 'column' ? (() => {
                    const fieldName = resolveContextMenuFieldName(cellContextMenu.dataIndex, cellContextMenu.title);
                    const meta = columnMetaMap[fieldName] || columnMetaMapByLowerName[fieldName.toLowerCase()];
                    const activeSort = sortInfo.find((item: any) => item.columnKey === fieldName && item.enabled !== false);
                    return (
                        <V2ColumnHeaderContextMenuView
                            fieldName={fieldName}
                            shortcutPlatform={activeShortcutPlatform}
                            columnType={meta?.type}
                            columnComment={meta?.comment}
                            sortOrder={(activeSort?.order === 'ascend' || activeSort?.order === 'descend') ? activeSort.order : null}
                            showColumnType={showColumnType}
                            showColumnComment={showColumnComment}
                            pinnedLeft={Boolean(pinnedLeftColumnSet?.has?.(fieldName))}
                            canPinLeft={Boolean(connectionId && dbName && pinnedLeftColumnScope)}
                            onAction={handleV2ColumnHeaderContextMenuAction}
                        />
                    );
                })() : (
                    <V2CellContextMenuView
                        fieldName={resolveContextMenuFieldName(cellContextMenu.dataIndex, cellContextMenu.title)}
                        shortcutPlatform={activeShortcutPlatform}
                        tableName={tableName}
                        rowLabel={cellContextMenu.record?.[GONAVI_ROW_KEY] === undefined ? undefined : `row ${String(cellContextMenu.record?.[GONAVI_ROW_KEY])}`}
                        selectedRowCount={selectedRowKeys.length}
                        canModifyData={canModifyData}
                        canUndoCellChange={canUndoContextMenuCellChange}
                        copiedRowCount={copiedRowsForPaste.length}
                        canPasteCopiedColumns={!!copiedCellPatch}
                        supportsCopyInsert={supportsCopyInsert}
                        onAction={handleV2CellContextMenuAction}
                    />
                )}
            </div>,
            document.body
        )}

        <DataGridLegacyCellContextMenu
            visible={isTableSurfaceActive && !isV2Ui && cellContextMenu.visible}
            darkMode={darkMode}
            bgContextMenu={bgContextMenu}
            cellContextMenu={cellContextMenu}
            canModifyData={canModifyData}
            copiedRowsForPasteLength={copiedRowsForPaste.length}
            selectedRowKeysLength={selectedRowKeys.length}
            copiedCellPatchAvailable={!!copiedCellPatch}
            canUndoCellChange={canUndoContextMenuCellChange}
            supportsCopyInsert={supportsCopyInsert}
            translate={translateDataGrid}
            onClose={() => setCellContextMenu((prev: any) => ({ ...prev, visible: false }))}
            onCopyFieldName={handleCopyContextMenuFieldName}
            onCopyRowData={() => {
                if (cellContextMenu.record) handleCopyRowData(cellContextMenu.record);
            }}
            onCopyRowForPaste={() => {
                const rowKey = cellContextMenu.record?.[GONAVI_ROW_KEY];
                if (rowKey === undefined || rowKey === null) {
                    void message.info(translateDataGrid('data_grid.message.no_copyable_rows'));
                    return;
                }
                setSelectedRowKeys([rowKey]);
                copyRowsForPaste([rowKey]);
            }}
            onPasteCopiedRowsAsNew={handlePasteCopiedRowsAsNew}
            onUndoCellChange={handleUndoContextMenuCellChange}
            onSetNull={handleCellSetNull}
            onEditRow={handleOpenContextMenuRowEditor}
            onFillToSelected={() => {
                if (selectedRowKeys.length > 0 && cellContextMenu.record) {
                    handleBatchFillToSelected(cellContextMenu.record, cellContextMenu.dataIndex);
                }
            }}
            onPasteCopiedColumns={() => {
                const fallbackKey = cellContextMenu.record?.[GONAVI_ROW_KEY];
                handlePasteCopiedColumnsToSelectedRows(fallbackKey);
            }}
            onCopyInsert={() => {
                if (cellContextMenu.record) handleCopyInsert(cellContextMenu.record);
            }}
            onCopyUpdate={() => {
                if (cellContextMenu.record) handleCopyUpdate(cellContextMenu.record);
            }}
            onCopyDelete={() => {
                if (cellContextMenu.record) handleCopyDelete(cellContextMenu.record);
            }}
            onCopyJson={() => {
                if (cellContextMenu.record) handleCopyJson(cellContextMenu.record);
            }}
            onCopyCsv={() => {
                if (cellContextMenu.record) handleCopyCsv(cellContextMenu.record);
            }}
            onCopyMarkdown={() => {
                if (cellContextMenu.record) {
                    const records = getTargets(cellContextMenu.record);
                    const lines = records.map((r: any) => {
                        const { [GONAVI_ROW_KEY]: _rowKey, ...vals } = r;
                        return `| ${Object.values(vals).join(' | ')} |`;
                    });
                    copyToClipboard(lines.join('\n'));
                }
            }}
            onExportCsv={() => {
                if (cellContextMenu.record) handleExportSelected({ format: 'csv' }, cellContextMenu.record).catch(console.error);
            }}
            onExportXlsx={() => {
                if (cellContextMenu.record) handleExportSelected({ format: 'xlsx' }, cellContextMenu.record).catch(console.error);
            }}
            onExportJson={() => {
                if (cellContextMenu.record) handleExportSelected({ format: 'json' }, cellContextMenu.record).catch(console.error);
            }}
            onExportHtml={() => {
                if (cellContextMenu.record) handleExportSelected({ format: 'html' }, cellContextMenu.record).catch(console.error);
            }}
        />
       </div>

	       <DataGridSecondaryActions
                isV2Ui={isV2Ui}
                canViewDdl={canViewDdl}
                canOpenObjectDesigner={canOpenObjectDesigner}
                viewMode={viewMode}
                ddlLoading={ddlLoading}
                showColumnComment={showColumnComment}
                showColumnType={showColumnType}
                resultViewSwitcher={resultViewSwitcher}
                columnInfoSettingContent={columnInfoSettingContent}
                columnQuickFindContent={columnQuickFindContent}
                pageFindContent={legacyPageFindContent}
                paginationContent={paginationContent}
                onViewModeChange={handleViewModeChange}
                dataPanelOpen={dataPanelOpen}
                isTableSurfaceActive={isTableSurfaceActive}
                onToggleDataPanel={toggleDataPanel}
                onOpenTableDdl={() => {
                    void handleOpenTableDdl();
                }}
                translate={translateDataGrid}
            />

		        <style>{gridCssText}</style>
       
       {/* Ghost Resize Line for Columns */}
       <div
           ref={ghostRef}
           style={{
               position: 'absolute',
               top: 0,
               bottom: 0, // Fits container height
               left: 0,
               width: '2px',
               background: selectionAccentHex,
               zIndex: 9999,
               display: 'none',
               pointerEvents: 'none',
               willChange: 'transform'
           }}
       />

       {/* Preview SQL Modal */}
       <Modal
           title={translateDataGrid('data_grid.preview_sql.title')}
           open={previewModalOpen}
           onCancel={() => setPreviewModalOpen(false)}
           width={800}
           footer={null}
       >
           <div style={{ marginBottom: 16 }}>
               {previewSqlData.deletes.length > 0 && (
                   <div style={{ marginBottom: 12 }}>
                       <div style={{ fontWeight: 'bold', color: '#ff4d4f', marginBottom: 8 }}>
                           DELETE ({previewSqlData.deletes.length})
                       </div>
                        {previewSqlData.deletes.map((sql: string, i: number) => (
                           <div key={`del-${i}`} style={{ position: 'relative', marginBottom: 8 }}>
                               <pre style={{
                                   background: darkMode ? 'rgba(255, 77, 79, 0.10)' : '#fff2f0',
                                   border: darkMode ? '1px solid rgba(255, 77, 79, 0.25)' : '1px solid #ffccc7',
                                   padding: '8px 40px 8px 12px', borderRadius: 4,
                                   fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                                   margin: 0,
                               }}>{sql}</pre>
                               <Button
                                   size="small" type="text"
                                   icon={<CopyOutlined />}
                                   style={{ position: 'absolute', top: 4, right: 4 }}
                                   onClick={() => { navigator.clipboard.writeText(sql).then(() => message.success(translateDataGrid('data_grid.preview_sql.copied'))); }}
                               />
                           </div>
                       ))}
                   </div>
               )}
               {previewSqlData.updates.length > 0 && (
                   <div style={{ marginBottom: 12 }}>
                       <div style={{ fontWeight: 'bold', color: '#fa8c16', marginBottom: 8 }}>
                           UPDATE ({previewSqlData.updates.length})
                       </div>
                        {previewSqlData.updates.map((sql: string, i: number) => (
                           <div key={`upd-${i}`} style={{ position: 'relative', marginBottom: 8 }}>
                               <pre style={{
                                   background: darkMode ? 'rgba(250, 140, 22, 0.10)' : '#fff7e6',
                                   border: darkMode ? '1px solid rgba(250, 140, 22, 0.25)' : '1px solid #ffd591',
                                   padding: '8px 40px 8px 12px', borderRadius: 4,
                                   fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                                   margin: 0,
                               }}>{sql}</pre>
                               <Button
                                   size="small" type="text"
                                   icon={<CopyOutlined />}
                                   style={{ position: 'absolute', top: 4, right: 4 }}
                                   onClick={() => { navigator.clipboard.writeText(sql).then(() => message.success(translateDataGrid('data_grid.preview_sql.copied'))); }}
                               />
                           </div>
                       ))}
                   </div>
               )}
               {previewSqlData.inserts.length > 0 && (
                   <div style={{ marginBottom: 12 }}>
                       <div style={{ fontWeight: 'bold', color: '#52c41a', marginBottom: 8 }}>
                           INSERT ({previewSqlData.inserts.length})
                       </div>
                        {previewSqlData.inserts.map((sql: string, i: number) => (
                           <div key={`ins-${i}`} style={{ position: 'relative', marginBottom: 8 }}>
                               <pre style={{
                                   background: darkMode ? 'rgba(82, 196, 26, 0.10)' : '#f6ffed',
                                   border: darkMode ? '1px solid rgba(82, 196, 26, 0.25)' : '1px solid #b7eb8f',
                                   padding: '8px 40px 8px 12px', borderRadius: 4,
                                   fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                                   margin: 0,
                               }}>{sql}</pre>
                               <Button
                                   size="small" type="text"
                                   icon={<CopyOutlined />}
                                   style={{ position: 'absolute', top: 4, right: 4 }}
                                   onClick={() => { navigator.clipboard.writeText(sql).then(() => message.success(translateDataGrid('data_grid.preview_sql.copied'))); }}
                               />
                           </div>
                       ))}
                   </div>
               )}
               {previewSqlData.deletes.length === 0 && previewSqlData.updates.length === 0 && previewSqlData.inserts.length === 0 && (
                   <div style={{ color: darkMode ? '#888' : '#999', textAlign: 'center', padding: 24 }}>
                       {translateDataGrid('data_grid.preview_sql.no_changes')}
                   </div>
               )}
           </div>
           <div style={{ color: darkMode ? '#999' : '#888', fontSize: 12, borderTop: darkMode ? '1px solid #303030' : '1px solid #f0f0f0', paddingTop: 8 }}>
               {translateDataGrid('data_grid.preview_sql.summary', {
                   deletes: previewSqlData.deletes.length,
                   updates: previewSqlData.updates.length,
                   inserts: previewSqlData.inserts.length
               })}
           </div>
       </Modal>

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
