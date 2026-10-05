// cspell:ignore anticon sqls uuidv uuidv4 hscroll
import React, { useMemo, useCallback } from 'react';
import { Table, Form } from 'antd';
import {
    DndContext,
    closestCenter,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { useStore } from '../store';
import 'react-resizable/css/styles.css';
import '../styles/v2-theme-workbench.css';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import { getTemporalPickerType } from './dataGridTemporal';
import {
    resolveWhereConditionSelectedValue,
    shouldApplyQuickWhereOnEnter,
} from '../utils/dataGridWhereFilter';
import { isWritableResultColumn } from '../utils/rowLocator';
import DataGridColumnQuickFind from './DataGridColumnQuickFind';
import DataGridPageFind from './DataGridPageFind';
import DataGridPaginationBar from './DataGridPaginationBar';
import DataGridResultViewSwitcher from './DataGridResultViewSwitcher';
import DataGridShell from './DataGridShell';

// --- Error Boundary ---
import {
    DataGridErrorBoundary,
    useDataGridI18nLanguage,
    resolveContextMenuFieldName,
    looksLikeJsonText,
    EditableContext,
    CellContextMenuContext,
    renderGridFieldSelectOption,
} from './DataGridCore';

import type { DataGridProps } from './DataGridCore';
import { useDataGridCoreState } from './dataGrid/hooks/useDataGridCoreState';
import { useDataGridCellEditorState } from './dataGrid/hooks/useDataGridCellEditorState';
import { useDataGridTableMetrics } from './dataGrid/hooks/useDataGridTableMetrics';
import { useDataGridColumnTitles } from './dataGrid/hooks/useDataGridColumnTitles';
import { useDataGridCellEditing } from './dataGrid/hooks/useDataGridCellEditing';
import { useDataGridInlineEditor } from './dataGrid/hooks/useDataGridInlineEditor';
import { useDataGridRowEditors } from './dataGrid/hooks/useDataGridRowEditors';
import { useDataGridColumns } from './dataGrid/hooks/useDataGridColumns';
import { useDataGridRowActions } from './dataGrid/hooks/useDataGridRowActions';
import { useDataGridCommit } from './dataGrid/hooks/useDataGridCommit';
import {
    useDataGridHorizontalVirtualScroll,
} from './dataGrid/hooks/useDataGridHorizontalVirtualScroll';
import { useDataGridPageFind } from './dataGrid/hooks/useDataGridPageFind';
import { useDataGridExternalScroll } from './dataGrid/hooks/useDataGridExternalScroll';
import { useDataGridLayoutEffects } from './dataGrid/hooks/useDataGridLayoutEffects';
export { buildDataGridPaginationPageSizeOptions } from './dataGrid/dataGridPagingOptions';

export {
    GONAVI_ROW_KEY,
    GONAVI_ROW_NUMBER_COLUMN_KEY,
    resolveContextMenuFieldName,
    formatCellDisplayText,
    attachDataGridVirtualEditRenderVersion,
    hasDataGridVirtualEditRenderVersionChanged,
    isStringLikeGridFilterColumnType,
    resolveDefaultGridFilterOperator,
    resolveNextGridFilterOperatorForColumnChange,
    buildGridFieldSelectOptions,
    buildDataGridCommitChangeSet,
    collectDataGridCellSelectionRowKeys,
    filterDataGridCellSelectionToVisibleRows,
    resolveDataGridCellSelectionAnchor,
    collectDataGridFillTemplateTargetRowKeys,
    buildColumnMetaMap,
    shouldOmitBlankDataGridInsertValue,
} from './DataGridCore';
export {
    attachDataGridDisplayRenderVersion, hasDataGridDisplayRenderVersionChanged,
} from './dataGridDisplayRenderVersion';

const DataGrid: React.FC<DataGridProps> = ({
    data, columnNames, loading, tableName, columnPinScope, objectType = 'table', exportScope = 'table', dbName, schemaName, ddlDbName, ddlTableName, connectionId, connectionParamsOverride, pkColumns = [], editLocator, readOnly = false,
    resultSql,
    resultExportAllSql,
    onReload, onSort, onPageChange, onLastPage, queryMaxRows, pagination, onRequestTotalCount, onCancelTotalCount, sortInfoExternal, showFilter, onToggleFilter, exportSqlWithFilter, onApplyFilter, appliedFilterConditions, quickWhereCondition,
    onApplyQuickWhereCondition,
    scrollSnapshot, onScrollSnapshotChange, toolbarExtraActions, showRowNumberColumn, isActive = true, enableSqlLogEvent = false,
    initialViewMode,
    initialViewModeRequestId,
    initialViewModeScope,
    onDataViewActivate,
    onDataChange,
    workbenchTabId,
    initialColumnMetaMap,
    initialUniqueKeyGroups,
    sessionState,
}) => {
  const {
      connections, addTab, setActiveContext, addSqlLog, theme, setAppearance, setQueryOptions,
      dataEditTransactionOptions, setDataEditTransactionOptions, tableColumnOrders,
      enableColumnOrderMemory, setEnableColumnOrderMemory, clearTableColumnOrder,
      setTablePinnedLeftColumns, tableHiddenColumns, enableHiddenColumnMemory,
      setEnableHiddenColumnMemory, clearTableHiddenColumns, shortcutOptions, language,
      translateDataGrid, localizedDataEditAutoCommitDelayOptions, rowLocatorMessages, isMacLike,
      isWindowsLike, effectiveUiScale, activeShortcutPlatform, darkMode, opacity,
      dataGridBackdropFilter, resolvedShowRowNumberColumn, dataTableDensity, densityParams,
      headerCellMinHeight, inputCellPadding, dataTableVerticalBorderRule, effectiveEditLocator,
      visibleColumnNames, shouldCommitColumn, canModifyData, showColumnComment, showColumnType,
      alignNumericTemporalRight, allOrderedColumnNames, localHiddenColumns, setLocalHiddenColumns,
      columnSearchText, setColumnSearchText, columnQuickFindText, setColumnQuickFindText,
      highlightedColumnName, setHighlightedColumnName, pageFindOpen, setPageFindOpen, pageFindText,
      setPageFindText, activePageFindMatchIndex, setActivePageFindMatchIndex,
      columnQuickFindHighlightTimerRef, normalizedPageFindText, normalizedColumnQuickFindText,
      toggleColumnVisibility, toggleAllColumnsVisibility, pinnedLeftColumnScope,
      pinnedLeftColumnNames, pinnedLeftColumnSet, displayColumnNames, displayOutputColumnNames,
      dataChangeOutputColumnNames, sensors, columnOrderDragScopeRef, reorderVisibleColumns,
      selectionColumnWidth, currentConnConfig, prefersManualTotalCount,
      supportsApproximateTableCount, supportsApproximateTotalPages, designerReadOnly, dbType,
      isMongoDBConnection, supportsCopyInsert, supportsSqlQueryExport, isQueryResultExport,
      canImport, canExport, resolvedDdlDbName, resolvedDdlTableName, canViewDdl,
      canOpenObjectDesigner, hasFilteredExportSql, mongoAwareEditableText, mongoAwareFormText,
      normalizeMongoEditedCellValue, normalizeMongoEditedRow, themeStyles, dataGridFilterMessageApi,
      bgContent, bgFilter, bgContextMenu, rowAddedBg, rowModBg, selectionAccentHex,
      selectionAccentRgb, columnMetaHintColor, columnMetaTooltipColor, panelFrameColor,
      floatingScrollbarThumbBg, floatingScrollbarThumbHoverBg, floatingScrollbarThumbBorderColor,
      floatingScrollbarThumbShadow, verticalScrollbarTrackBg, horizontalScrollbarThumbBg,
      horizontalScrollbarThumbHoverBg, paginationShellBg, paginationShellBorderColor,
      paginationShellShadow, paginationChipBg, paginationChipBorderColor, paginationHoverBg,
      paginationPrimaryTextColor, paginationSecondaryTextColor, paginationAccentBg,
      paginationAccentBorderColor, paginationActiveItemBg, paginationActiveItemBorderColor,
      paginationActiveItemTextColor, panelRadius, panelOuterGap, panelPaddingY, panelPaddingX,
      toolbarBottomPadding, filterTopPadding, floatingScrollbarGap, floatingScrollbarBottomOffset,
      floatingScrollbarInset, floatingScrollbarHeight, horizontalScrollbarTrackBg,
      horizontalScrollbarTrackBorderColor, horizontalScrollbarTrackShadow,
      horizontalScrollbarThumbBorderColor, horizontalScrollbarThumbShadow,
      externalScrollbarMinWidth, paginationPageSizeOptions, form, modal, contextHolder,
      exportProgressModal, runExportWithProgress, gridId, textRecordIndex, setTextRecordIndex,
      cellEditorSourceRef, cellEditorRuntimeRef,
  } = useDataGridCoreState({
      connectionParamsOverride, connectionId, showRowNumberColumn, editLocator, pkColumns,
      columnNames, readOnly, tableName, dbName, columnPinScope, exportScope, ddlDbName,
      ddlTableName, objectType, exportSqlWithFilter, queryMaxRows, data, isActive,
  });
  const {
      cellEditorValue, setCellEditorValue, cellEditorEscapeApplied, setCellEditorEscapeApplied,
      cellEditorIsJson, cellEditorMeta, cellEditorApplyRef, jsonEditorOpen, jsonEditorValue,
      setJsonEditorValue, openJsonEditor, closeJsonEditor, rowEditorOpen, rowEditorRowKey,
      rowEditorBaseRawRef, rowEditorDisplayRef, rowEditorNullColsRef, rowEditorForm, closeRowEditor,
      openRowEditor, batchEditModalOpen, batchEditValue, setBatchEditValue, batchEditSetNull,
      setBatchEditSetNull, openBatchEditModal, closeBatchEditModal, isCellEditorSourceCurrent,
      closeCellEditor, openCellEditor, openCellViewer, cellEditorViewerMode, cellEditorReadOnly,
      cellEditorOpenForRender, virtualEditingSessionSequenceRef, virtualEditingSessionRef,
      virtualEditingCell, setVirtualEditingCell, isVirtualEditingSessionCurrent,
      virtualEditingPermissionLost, virtualEditingUnavailable, virtualEditingCellForRender,
      virtualInlineInputRef, virtualInlinePickerOpenRef, virtualInlinePickerInteractionTimerRef,
      virtualInlinePickerInteractionTokenRef, virtualInlinePickerPendingValueRef,
      virtualInlinePickerCommitSessionRef, virtualInlinePickerSaveSessionRef,
      virtualInlineScrollLockRef, cellContextMenu, setCellContextMenu, cellContextMenuPortalRef,
      rootRef, pageFindInputRef, containerRef, tableContainerRef, tableRef,
      cellSelectionAutoScrollControllerRef, tableScrollTargetsRef, externalHorizontalScrollRef,
      virtualHorizontalElementsRef, horizontalSyncSourceRef, lastTableScrollLeftRef,
      lastCommittedVirtualHorizontalOffsetRef, virtualHorizontalMaxScrollRef,
      lastExternalScrollLeftRef, externalSyncRafRef, externalScrollSettleRafRef,
      pendingExternalScrollLeftRef, externalScrollSequenceRef, externalScrollbarDraggingRef,
      externalScrollInteractionUntilRef, externalIdleCommitHandlerRef,
      externalIdleCommitSchedulerRef, tableTargetSyncRafRef, tableHorizontalWheelRafRef,
      nativeHorizontalSyncRafRef, virtualHorizontalAlignmentRafRef,
      virtualHorizontalPostCommitFrameHandlerRef, virtualHorizontalPostCommitGuardRef,
      virtualHorizontalPreviewActiveRef, pendingTableHorizontalDeltaRef,
      pendingTableTargetSyncSourceRef, scrollSnapshotRafRef, pendingScrollToBottomRef,
      pastedRowSequenceRef, lastReportedScrollRef, didRestoreScrollRef, cellEditMode,
      setCellEditMode, selectedRowKeys, setSelectedRowKeys, selectedCells, setSelectedCells,
      cellSelectionDeleteEligible, setCellSelectionDeleteEligible, cellSelectionSourceDataRef,
      cellSelectionUserSourceDataRef, cellSelectionAnchorSourceRef, copiedCellPatch,
      setCopiedCellPatch, copiedRowsForPaste, setCopiedRowsForPaste, cellSelectionRafRef,
      cellSelectionScrollRafRef, cellSelectionAutoScrollRafRef, cellSelectionPointerRef,
      pendingCellSelectionStartRef, suppressCellSelectionClickRef, cellEditModeRef, isDraggingRef,
      importPreviewVisible, setImportPreviewVisible, importFilePath, setImportFilePath,
      currentSelectionRef, selectionStartRef, rowIndexMapRef, scrollTableBodyToBottom,
      resolveContextMenuPosition, showCellContextMenu, showColumnHeaderContextMenu, sortInfo,
      setSortInfo, columnWidths, setColumnWidths, mergedDisplayDataRef, closeCellEditModeRef,
      formRef,
  } = useDataGridCellEditorState({
      mongoAwareEditableText, cellEditorSourceRef, cellEditorRuntimeRef, data, connectionId, dbName,
      tableName, isMongoDBConnection, canModifyData, effectiveEditLocator, isActive,
      translateDataGrid, sessionState, displayColumnNames, densityParams, form, sortInfoExternal,
  });

  const {
      allTableColumnNames, columnMetaCacheRef, columnMetaMap, columnMetaMapByLowerName,
      columnTypeMapByLowerName, foreignKeyCacheRef, foreignKeyMap, foreignKeyMapByLowerName,
      getColumnFilterType, metadataCacheKey, setMetadataReloadVersion, uniqueKeyGroups,
      uniqueKeyGroupsCacheRef, displayColumnTypeMap, gridColumnAlignMap, canExportInsertSQL,
      buildBackendExportOptions, exportData, normalizeCommitCellValue, openTableByName,
      openForeignKeyTarget, lockVirtualInlineTableScroll, cancelVirtualInlinePickerInteraction,
      closeVirtualInlineEditor, tableHeight, tableViewportWidth, measuredHorizontalScrollMetrics,
      tableBodyBottomPadding, gridCssText, recalculateTableMetrics, addedRows, setAddedRows,
      modifiedRows, setModifiedRows, deletedRowKeys, setDeletedRowKeys, modifiedColumns,
      setModifiedColumns, previewModalOpen, setPreviewModalOpen, previewSqlData, setPreviewSqlData,
      gridFieldSelectOptions,
  } = useDataGridTableMetrics({
      connectionId, connectionParamsOverride, dbName, tableName, exportScope, loading,
      initialColumnMetaMap, initialUniqueKeyGroups, connections, visibleColumnNames,
      displayColumnNames, alignNumericTemporalRight, dbType, currentConnConfig,
      displayOutputColumnNames, isQueryResultExport, supportsCopyInsert, translateDataGrid,
      runExportWithProgress, isMongoDBConnection, schemaName, setActiveContext, addTab,
      virtualInlineScrollLockRef, tableContainerRef, virtualInlinePickerInteractionTimerRef,
      virtualInlinePickerInteractionTokenRef, virtualEditingSessionRef, virtualInlinePickerOpenRef,
      virtualInlinePickerPendingValueRef, virtualInlinePickerCommitSessionRef,
      virtualInlinePickerSaveSessionRef, setVirtualEditingCell, virtualEditingCell,
      virtualEditingUnavailable, virtualEditingPermissionLost, darkMode, bgContent,
      floatingScrollbarThumbBg, floatingScrollbarThumbBorderColor, floatingScrollbarThumbHoverBg,
      floatingScrollbarThumbShadow, horizontalScrollbarThumbBg, horizontalScrollbarThumbHoverBg,
      paginationAccentBg, paginationAccentBorderColor, paginationActiveItemBg,
      paginationActiveItemBorderColor, paginationActiveItemTextColor, paginationChipBg,
      paginationChipBorderColor, paginationHoverBg, paginationPrimaryTextColor,
      paginationSecondaryTextColor, paginationShellBg, paginationShellBorderColor,
      paginationShellShadow, rowAddedBg, rowModBg, selectionAccentHex, selectionAccentRgb,
      verticalScrollbarTrackBg, dataGridBackdropFilter, dataTableVerticalBorderRule, densityParams,
      floatingScrollbarBottomOffset, floatingScrollbarHeight, floatingScrollbarInset, gridId,
      horizontalScrollbarThumbBorderColor, horizontalScrollbarThumbShadow,
      horizontalScrollbarTrackBg, horizontalScrollbarTrackBorderColor,
      horizontalScrollbarTrackShadow, panelRadius, themeStyles, opacity, containerRef,
      externalHorizontalScrollRef, floatingScrollbarGap, isWindowsLike,
  });

  const {
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
  } = useDataGridColumnTitles({
      appliedFilterConditions, quickWhereCondition, showFilter, onApplyFilter,
      onApplyQuickWhereCondition, onSort, displayColumnNames, allTableColumnNames, columnMetaMap,
      getColumnFilterType, dbType, darkMode, dataGridFilterMessageApi, translateDataGrid, data,
      isMongoDBConnection, addedRows, exportScope, columnMetaMapByLowerName, foreignKeyMap,
      foreignKeyMapByLowerName, showColumnType, showColumnComment, densityParams,
      columnMetaHintColor, columnMetaTooltipColor, highlightedColumnName, pinnedLeftColumnSet,
      openForeignKeyTarget, selectedRowKeys, pendingScrollToBottomRef, scrollTableBodyToBottom,
      isActive, initialViewMode, initialViewModeRequestId, initialViewModeScope, canViewDdl,
      currentConnConfig, resolvedDdlDbName, resolvedDdlTableName, cellEditMode,
      mergedDisplayDataRef, closeCellEditModeRef, setTextRecordIndex, activeShortcutPlatform,
      pageFindInputRef, setPageFindOpen, setPageFindText, setActivePageFindMatchIndex, rootRef,
      connectionId, dbName, schemaName, tableName, enableSqlLogEvent, onDataViewActivate,
      cellContextMenu, setCellContextMenu, cellContextMenuPortalRef, resolveContextMenuPosition,
      cellEditModeRef, containerRef, selectionStartRef, cellSelectionSourceDataRef,
      setCellSelectionDeleteEligible, cellSelectionUserSourceDataRef,
  });

  const {
      resetCellSelection, closeCellEditMode, handleBatchFillCells, handleSetNullForSelectedCells,
      handleCopySelectedColumnsFromRow, handlePasteCopiedColumnsToSelectedRows,
      handleBatchFillToSelected, selectEditableColumnCells, displayData, pendingChangeCount,
      hasChanges, dataEditCommitMode, dataEditAutoCommitDelayMs, autoCommitRemainingSeconds,
      setAutoCommitRemainingSeconds, autoCommitTimerRef, autoCommitCountdownRef,
      autoCommitChangeTokenRef, autoCommitFailedTokenRef, clearAutoCommitTimer, selectedCellCount,
      selectedCellRowCount, selectedRowCount, fillTemplateTargetRowCount, deleteTargetRowKeys,
      deleteTargetRowCount, allSelectedAreDeleted, addedRowKeySet, rowClassName, handleTableChange,
      applySortInfo, applyColumnSort, autoFitColumnWidth, handleResizeAutoFit, handleResizeStart,
      handleDragEnd, handleCellSave, handleCellSaveRef, handleCellSetNull,
      canUndoContextMenuCellChange, canEditContextMenuCell,
  } = useDataGridCellEditing({
      setSelectedCells, markCellSelectionDeleteEligible, markCellSelectionUserSelection,
      currentSelectionRef, selectionStartRef, cellSelectionAnchorSourceRef,
      pendingCellSelectionStartRef, isDraggingRef, cellSelectionPointerRef, cellSelectionRafRef,
      cellSelectionScrollRafRef, cellSelectionAutoScrollRafRef, updateCellSelection,
      setCellEditMode, cellEditModeRef, closeBatchEditModal, data, setSelectedRowKeys,
      deletedRowKeys, setDeletedRowKeys, closeCellEditModeRef, cellEditMode,
      cellSelectionDeleteEligible, cellSelectionSourceDataRef, isActive, addedRows, setAddedRows,
      batchEditSetNull, batchEditValue, canModifyData, cellSelectionAutoScrollControllerRef,
      columnIndexMap, containerRef, copiedCellPatch, setCopiedCellPatch, displayColumnNames,
      displayDataRef, effectiveEditLocator, isTableSurfaceActive, modifiedRows, setModifiedRows,
      rowIndexMapRef, rowKeyStr, selectedCells, selectedRowKeysRef, setCellContextMenu,
      setModifiedColumns, suppressCellSelectionClickRef, translateDataGrid, exportScope,
      filterConditions, rowsBeforeClientFilter, dataEditTransactionOptions,
      cellSelectionUserSourceDataRef, selectedRowKeys, onSort, setSortInfo, sortInfo, columnMetaMap,
      columnMetaMapByLowerName, columnWidths, setColumnWidths, dataTableDensity, densityParams,
      showColumnComment, showColumnType, reorderVisibleColumns, normalizeMongoEditedRow, baseData,
      cellContextMenu, modifiedColumns,
  });

  const {
      handleOpenContextMenuCellEditor, handleUndoContextMenuCellChange, handleCellEditorSave,
      handleFormatJsonInEditor, handleCompactJsonInEditor, handleEscapeCellEditorValue,
      handleUnescapeCellEditorValue, handleCellEditorValueChange, handleVirtualCellActivate,
      handleVirtualCellContextMenu, mergedDisplayData, dataPanelOpen, dataPanelOpenRef,
      focusedCellInfo, dataPanelValue, setDataPanelValue, dataPanelIsJson, dataPanelDirtyRef,
      dataPanelOriginalRef, toggleDataPanel, updateFocusedCell, handleDataPanelFormatJson,
      focusedCellWritable, handleDataPanelSave, mergedDisplayDataByRowKeyRef,
      handleSharedCellContextMenu, handleSharedCellDoubleClick, handleVirtualTableClickCapture,
      handleVirtualTableDoubleClickCapture, handleVirtualTableContextMenuCapture,
  } = useDataGridInlineEditor({
      cellContextMenu, canEditContextMenuCell, closeVirtualInlineEditor, openCellEditor,
      setCellContextMenu, rowKeyStr, addedRowKeySet, translateDataGrid, modifiedColumns, baseData,
      handleCellSave, cellEditorMeta, cellEditorApplyRef, cellEditorValue, cellEditorRuntimeRef,
      isCellEditorSourceCurrent, closeCellEditor, handleCellSaveRef, cellEditorIsJson,
      cellEditorEscapeApplied, setCellEditorValue, setCellEditorEscapeApplied, isActive, data,
      connectionId, dbName, tableName, canModifyData, effectiveEditLocator, columnMetaMap,
      columnMetaMapByLowerName, dbType, currentConnConfig, form, isMongoDBConnection,
      mongoAwareEditableText, virtualEditingSessionSequenceRef, virtualEditingSessionRef,
      setVirtualEditingCell, showCellContextMenu, displayData, modifiedRows, deletedRowKeys,
      mergedDisplayDataRef, sessionState, hasChanges, cellEditMode, virtualEditingCell,
      onDataChange, dataChangeOutputColumnNames, connectionParamsOverride, resolvedDdlDbName,
      resolvedDdlTableName, setAddedRows, setModifiedRows, setDeletedRowKeys, setModifiedColumns,
      setSelectedRowKeys, resetCellSelection, setCopiedCellPatch, setCopiedRowsForPaste,
      closeRowEditor, viewMode, resetDdlViewState, canViewDdl, formRef, openCellViewer,
  });

  const {
      saveVirtualInlineEditor, scheduleVirtualInlinePickerInteraction,
      commitVirtualInlinePickerValue, pageFindMatches, pageFindSummary, activePageFindPosition,
      tableRenderData, jsonViewText, textViewRows, currentTextRow, formatTextViewValue,
      openCurrentViewRowEditor, handleOpenJsonEditor, handleOpenContextMenuRowEditor,
      handleFormatJsonEditor, applyJsonEditor, openRowEditorFieldEditor,
  } = useDataGridRowEditors({
      isVirtualEditingSessionCurrent, virtualInlinePickerSaveSessionRef,
      cancelVirtualInlinePickerInteraction, virtualInlinePickerPendingValueRef,
      mergedDisplayDataByRowKeyRef, closeVirtualInlineEditor, dbType, currentConnConfig, form,
      handleCellSaveRef, virtualInlinePickerInteractionTimerRef,
      virtualInlinePickerInteractionTokenRef, virtualInlinePickerOpenRef,
      virtualInlinePickerCommitSessionRef, mergedDisplayData, displayColumnNames,
      normalizedPageFindText, columnMetaMap, columnMetaMapByLowerName, setActivePageFindMatchIndex,
      markCellSelectionUserSelection, setSelectedCells, currentSelectionRef, selectionStartRef,
      cellSelectionAnchorSourceRef, updateCellSelection, activePageFindMatchIndex, theme,
      dataTableDensity, effectiveUiScale, virtualEditingCellForRender, setTextRecordIndex, viewMode,
      displayOutputColumnNames, textRecordIndex, canModifyData, translateDataGrid, rowKeyStr,
      baseData, addedRows, visibleColumnNames, mongoAwareFormText, openRowEditor, openJsonEditor,
      cellContextMenu, setCellContextMenu, jsonEditorValue, setJsonEditorValue, closeJsonEditor,
      setAddedRows, effectiveEditLocator, setModifiedRows, rowEditorForm, openCellEditor,
  });

  const {
      applyRowEditor, enableVirtual, useInlineEditableBodyCell, mergedColumns, rowNumberColumnWidth,
      handleRowNumberClick, handleRowNumberDoubleClick,
  } = useDataGridColumns({
      rowEditorRowKey, rowEditorForm, rowEditorBaseRawRef, closeRowEditor, addedRows, setAddedRows,
      rowKeyStr, effectiveEditLocator, columnMetaMap, columnMetaMapByLowerName, dbType,
      currentConnConfig, normalizeMongoEditedCellValue, visibleColumnNames, setModifiedRows,
      isTableSurfaceActive, canModifyData, virtualEditingCellForRender, virtualInlineInputRef,
      onSort, displayColumnNames, renderColumnTitle, columnWidths, dataTableDensity,
      pinnedLeftColumnSet, sortInfo, normalizedPageFindText, displayColumnTypeMap,
      columnOrderDragScopeRef, showColumnComment, showColumnType, language, handleResizeStart,
      handleResizeAutoFit, reorderVisibleColumns, showColumnHeaderContextMenu, cellEditMode,
      selectEditableColumnCells, deletedRowKeys, modifiedColumns, gridColumnAlignMap,
      dataPanelOpenRef, updateFocusedCell, handleCellSave, openCellEditor, inputCellPadding,
      handleSharedCellContextMenu, handleSharedCellDoubleClick, handleVirtualCellContextMenu,
      virtualInlinePickerPendingValueRef, scheduleVirtualInlinePickerInteraction,
      isVirtualEditingSessionCurrent, virtualInlinePickerOpenRef, lockVirtualInlineTableScroll,
      cancelVirtualInlinePickerInteraction, form, translateDataGrid, commitVirtualInlinePickerValue,
      saveVirtualInlineEditor, closeVirtualInlineEditor, handleVirtualCellActivate,
      setSelectedRowKeys, handleViewModeChange,
  });

  const {
      tableColumns, handleAddRow, copyRowsForPaste, handlePasteCopiedRowsAsNew,
      handleDeleteSelected, handleUndoDeleteSelected, handlePreviewChanges,
  } = useDataGridRowActions({
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
  });

  const {
      handleCommit, copyToClipboard, handleCopyContextMenuFieldName,
      handleV2ColumnHeaderContextMenuAction, buildConnConfig, getTargets, handleCopyCsv,
      handleCopyDdl, handleCopyDelete, handleCopyInsert, handleCopyJson, handleCopyQueryResultCsv,
      handleCopyQueryResultJson, handleCopyQueryResultMarkdown, handleCopyRowData,
      handleCopySelectedCellsToClipboard, handleCopyUpdate, handleExportSelected,
      handleV2CellContextMenuAction, handleOpenExportDialog,
  } = useDataGridCommit({
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
  });

  const {
      handleImport, handleImportSuccess, queryResultCopyMenu, canCopyQueryResult,
      columnInfoSettingContent, cellContextMenuValue, rowSelectionConfig, totalWidth, tableScrollX,
      horizontalScrollVisible, horizontalScrollWidth, tableScrollConfig, virtualListItemHeight,
      virtualListItemHeightFixed, virtualListItemNativeScrollbarControlled,
      virtualListItemHorizontalOffsetComposited, virtualListItemColumnVirtual, tableComponents,
      resolveVirtualHorizontalElements, readVirtualHorizontalOffset,
      syncVirtualHorizontalVisualOffset, applyVirtualHorizontalOffset,
      scheduleVirtualHorizontalAlignment,
  } = useDataGridHorizontalVirtualScroll({
      connectionId, tableName, dbName, buildConnConfig, setImportFilePath, setImportPreviewVisible,
      translateDataGrid, onReload, handleCopyQueryResultCsv, handleCopyQueryResultJson,
      handleCopyQueryResultMarkdown, isQueryResultExport, mergedDisplayData,
      displayOutputColumnNames, darkMode, showColumnComment, showColumnType,
      alignNumericTemporalRight, resolvedShowRowNumberColumn, columnSearchText, setColumnSearchText,
      allOrderedColumnNames, localHiddenColumns, setLocalHiddenColumns, enableColumnOrderMemory,
      enableHiddenColumnMemory, tableColumnOrders, tableHiddenColumns, setQueryOptions,
      setAppearance, toggleAllColumnsVisibility, toggleColumnVisibility, setEnableColumnOrderMemory,
      setEnableHiddenColumnMemory, clearTableColumnOrder, clearTableHiddenColumns,
      showCellContextMenu, handleBatchFillToSelected, selectedRowKeys, setSelectedRowKeys,
      selectionColumnWidth, tableColumns, densityParams, tableViewportWidth, isMacLike,
      isWindowsLike, mergedColumns, measuredHorizontalScrollMetrics, floatingScrollbarInset,
      isTableSurfaceActive, tableHeight, effectiveUiScale, virtualEditingCellForRender,
      enableVirtual, displayColumnNames, useInlineEditableBodyCell, virtualHorizontalElementsRef,
      tableContainerRef, virtualHorizontalPreviewActiveRef, virtualHorizontalMaxScrollRef,
      virtualHorizontalPostCommitGuardRef, virtualHorizontalPostCommitFrameHandlerRef,
      externalScrollbarDraggingRef, externalScrollInteractionUntilRef,
      externalIdleCommitSchedulerRef, externalSyncRafRef, externalScrollSettleRafRef,
      pendingExternalScrollLeftRef, tableHorizontalWheelRafRef, nativeHorizontalSyncRafRef,
      pendingTableHorizontalDeltaRef, horizontalSyncSourceRef, tableRef,
      lastCommittedVirtualHorizontalOffsetRef, virtualHorizontalAlignmentRafRef,
      externalHorizontalScrollRef, lastTableScrollLeftRef, lastExternalScrollLeftRef,
  });

  const {
      scheduleVirtualHorizontalWheel, scheduleNativeVirtualHorizontalScroll,
      pickHorizontalScrollTargets, pickTableToExternalSyncTargets, pickVerticalScrollTarget,
      handleNavigatePageFind, columnQuickFindOptions, resolveColumnQuickFindTarget,
      highlightColumnQuickFindTarget, isExternalScrollbarInteractionActive,
      clearExternalScrollbarInteraction, syncExternalScrollFromTargets,
      scheduleSyncExternalScrollFromTargets,
  } = useDataGridPageFind({
      tableHorizontalWheelRafRef, pendingTableHorizontalDeltaRef, horizontalSyncSourceRef,
      readVirtualHorizontalOffset, syncVirtualHorizontalVisualOffset, lastTableScrollLeftRef,
      externalHorizontalScrollRef, lastExternalScrollLeftRef, externalScrollSequenceRef,
      externalScrollInteractionUntilRef, virtualListItemColumnVirtual,
      lastCommittedVirtualHorizontalOffsetRef, applyVirtualHorizontalOffset,
      externalIdleCommitSchedulerRef, nativeHorizontalSyncRafRef,
      virtualListItemHorizontalOffsetComposited, resolveVirtualHorizontalElements, isWindowsLike,
      enableVirtual, isTableSurfaceActive, tableContainerRef, tableScrollX, tableRef,
      cellSelectionAutoScrollControllerRef, markCellSelectionUserSelection,
      markCellSelectionDeleteEligible, cellSelectionAnchorSourceRef, setSelectedCells,
      currentSelectionRef, selectionStartRef, mergedDisplayData, rowKeyStr, dataPanelOpenRef,
      updateFocusedCell, containerRef, updateCellSelection, activePageFindMatchIndex,
      setActivePageFindMatchIndex, pageFindMatches, normalizedColumnQuickFindText,
      displayColumnNames, setHighlightedColumnName, columnQuickFindHighlightTimerRef,
      externalScrollbarDraggingRef, horizontalScrollVisible, tableScrollTargetsRef,
      pendingTableTargetSyncSourceRef, tableTargetSyncRafRef,
  });

  const {
      applyExternalScrollToTableTargets, handleExternalHorizontalScrollPointerDown,
      handleExternalHorizontalScrollPointerRelease,
      handleExternalHorizontalScrollLostPointerCapture, handleSubmitColumnQuickFind,
  } = useDataGridExternalScroll({
      externalScrollSettleRafRef, externalScrollSequenceRef, isExternalScrollbarInteractionActive,
      externalSyncRafRef, pendingExternalScrollLeftRef, externalIdleCommitSchedulerRef,
      virtualHorizontalPreviewActiveRef, horizontalSyncSourceRef, externalHorizontalScrollRef,
      tableContainerRef, lastExternalScrollLeftRef, enableVirtual, readVirtualHorizontalOffset,
      lastTableScrollLeftRef, virtualListItemColumnVirtual, lastCommittedVirtualHorizontalOffsetRef,
      virtualListItemHorizontalOffsetComposited, resolveVirtualHorizontalElements,
      virtualHorizontalMaxScrollRef, applyVirtualHorizontalOffset,
      syncVirtualHorizontalVisualOffset, virtualHorizontalPostCommitGuardRef,
      externalIdleCommitHandlerRef, externalScrollInteractionUntilRef, tableScrollTargetsRef,
      clearExternalScrollbarInteraction, externalScrollbarDraggingRef, rootRef,
      pickTableToExternalSyncTargets, syncExternalScrollFromTargets, pickHorizontalScrollTargets,
      scheduleSyncExternalScrollFromTargets, highlightColumnQuickFindTarget, columnQuickFindText,
      setColumnQuickFindText, resolveColumnQuickFindTarget, translateDataGrid,
      horizontalScrollVisible,
  });

  const {
      paginationHasKnownTotalPages, paginationTotalPages, paginationV2SummaryText,
      paginationPageText, handlePageSizeChange, handleV2PageStep, aiShortcutLabel,
  } = useDataGridLayoutEffects({
      isTableSurfaceActive, tableContainerRef, enableVirtual, horizontalSyncSourceRef,
      lastTableScrollLeftRef, externalHorizontalScrollRef, lastExternalScrollLeftRef,
      virtualListItemHorizontalOffsetComposited, isWindowsLike, scheduleVirtualHorizontalWheel,
      pickHorizontalScrollTargets, tableHorizontalWheelRafRef, pendingTableHorizontalDeltaRef,
      pagination, recalculateTableMetrics, containerRef, totalWidth, mergedDisplayData,
      horizontalScrollVisible, scheduleVirtualHorizontalAlignment, virtualHorizontalAlignmentRafRef,
      tableRenderData, tableScrollX, virtualEditingCellForRender, onScrollSnapshotChange,
      scrollSnapshot, scrollSnapshotRafRef, didRestoreScrollRef, pickVerticalScrollTarget,
      lastReportedScrollRef, data, applyVirtualHorizontalOffset, readVirtualHorizontalOffset,
      resolveVirtualHorizontalElements, syncVirtualHorizontalVisualOffset,
      scheduleNativeVirtualHorizontalScroll, scheduleSyncExternalScrollFromTargets,
      pickTableToExternalSyncTargets, tableScrollTargetsRef, syncExternalScrollFromTargets,
      tableTargetSyncRafRef, pendingTableTargetSyncSourceRef, supportsApproximateTotalPages,
      prefersManualTotalCount, supportsApproximateTableCount, translateDataGrid, onPageChange,
      queryMaxRows, shortcutOptions, activeShortcutPlatform,
  });
    return (
    <DataGridShell
      {...{
        CellContextMenuContext, CustomEvent, DataGridColumnQuickFind, DataGridPageFind,
        DataGridPaginationBar, DataGridResultViewSwitcher, DndContext, EditableContext, Form, JSON,
        Set, SortableContext, Table, activePageFindPosition, activeShortcutPlatform, addFilter,
        aiShortcutLabel, allSelectedAreDeleted, applyAllFiltersDisabled, applyAllFiltersEnabled,
        applyExternalScrollToTableTargets, handleExternalHorizontalScrollPointerDown,
        handleExternalHorizontalScrollPointerRelease,
        handleExternalHorizontalScrollLostPointerCapture, applyFilters, applyJsonEditor,
        applyQuickWhereCondition, applyRowEditor, applySortInfo, autoCommitFailedTokenRef,
        autoCommitRemainingSeconds, batchEditModalOpen, batchEditSetNull, batchEditValue,
        bgContent, bgContextMenu, bgFilter, canCopyQueryResult, canExport, canImport,
        canModifyData, canEditContextMenuCell, canOpenObjectDesigner, canUndoContextMenuCellChange,
        canViewDdl, cellContextMenu, cellContextMenuPortalRef, cellContextMenuValue, cellEditMode,
        cellEditModeRef, cellEditorIsJson, cellEditorEscapeApplied, cellEditorMeta,
        cellEditorOpen: cellEditorOpenForRender,
        cellEditorReadOnly, cellEditorViewerMode, cellEditorValue, clearAllFiltersAndSorts,
        clearAutoCommitTimer, clearQuickWhereCondition, closeBatchEditModal, closeCellEditMode,
        closeCellEditor, closeJsonEditor, closeRowEditor, closestCenter, columnInfoSettingContent,
        columnMetaCacheRef, columnMetaMap, columnMetaMapByLowerName, columnQuickFindOptions,
        columnQuickFindText, connectionId, connections, containerRef, contextHolder,
        copiedCellPatch, copiedRowsForPaste, copyRowsForPaste, copyToClipboard, currentConnConfig,
        designerReadOnly, currentTextRow, darkMode, dataEditAutoCommitDelayMs, dataEditCommitMode,
        deleteTargetRowCount, dataPanelDirtyRef, dataPanelIsJson, dataPanelOpen,
        dataPanelOriginalRef, dataPanelValue, dbName, schemaName, dbType, ddlLoading, ddlModalOpen,
        ddlSidebarResizePreviewX, ddlSidebarWidth, ddlText, ddlViewLayout, displayColumnNames,
        displayOutputColumnNames, effectiveEditLocator, enableVirtual, exportProgressModal,
        externalHorizontalScrollRef, externalScrollbarMinWidth, filterConditions,
        filterLogicOptions, filterOpOptions, filterPanelRef, filterTopPadding, focusedCellInfo,
        focusedCellWritable, foreignKeyCacheRef, form, formatTextViewValue, getTargets,
        getTemporalPickerType, gridCssText, gridFieldSelectOptions, gridId, handleAddRow,
        handleBatchFillCells, handleBatchFillToSelected, handleCellEditorSave,
        handleCellEditorValueChange, handleCellSetNull, handleSetNullForSelectedCells,
        handleClosePageFind, handleCommit, handleCopyContextMenuFieldName, handleCopyCsv,
        handleCopyDdl, handleCopyDelete, handleCopyInsert, handleCopyJson, handleCopyRowData,
        handleCopySelectedCellsToClipboard, handleCopySelectedColumnsFromRow, handleCopyUpdate,
        handleOpenContextMenuCellEditor, handleDataPanelFormatJson, handleDataPanelSave,
        handleDataGridRootPointerDownCapture, closeDdlView, handleDdlSidebarResizeStart,
        handleDeleteSelected, handleDragEnd, handleExportSelected, handleFormatJsonEditor,
        handleFormatJsonInEditor, handleCompactJsonInEditor, handleEscapeCellEditorValue,
        handleUnescapeCellEditorValue, handleImport, handleImportSuccess, handleNavigatePageFind,
        handleOpenContextMenuRowEditor, handleOpenExportDialog, handleOpenJsonEditor,
        handleOpenTableDdl, handlePageSizeChange, handlePasteCopiedColumnsToSelectedRows,
        handlePasteCopiedRowsAsNew, handlePreviewChanges, handleQuickWherePaste,
        handleSubmitColumnQuickFind, handleTableChange, handleUndoContextMenuCellChange,
        handleUndoDeleteSelected, handleV2CellContextMenuAction,
        handleV2ColumnHeaderContextMenuAction, handleV2PageStep, handleViewModeChange,
        handleVirtualTableClickCapture, handleVirtualTableContextMenuCapture,
        handleVirtualTableDoubleClickCapture, hasChanges, headerCellMinHeight,
        horizontalListSortingStrategy, horizontalScrollVisible, horizontalScrollWidth,
        importFilePath, importPreviewVisible, isBetweenOp, isListOp, isNoValueOp,
        isQueryResultExport, isTableSurfaceActive, isWritableResultColumn, jsonEditorOpen,
        jsonEditorValue, jsonViewText, loading, localizedDataEditAutoCommitDelayOptions,
        looksLikeJsonText, mergedDisplayData, metadataCacheKey, noAutoCapInputProps,
        normalizedPageFindText, onCancelTotalCount,
        onOpenErTable: openTableByName,
        onPageChange, onLastPage,
        onReload: exportScope === 'queryResult'
            ? () => {
                setFilterConditions([]);
                clearQuickWhereCondition();
                onReload?.();
            }
            : onReload,
        onRequestTotalCount, onSort, onToggleFilter, openBatchEditModal, openCurrentViewRowEditor,
        openRowEditorFieldEditor, pageFindMatches, pageFindInputRef, pageFindOpen, pageFindSummary,
        pageFindText, pagination,
        allowCustomPageSize: Boolean(pagination && queryMaxRows !== undefined),
        paginationHasKnownTotalPages, paginationPageSizeOptions, paginationPageText,
        paginationTotalPages, paginationV2SummaryText, panelFrameColor, panelOuterGap,
        panelPaddingX, panelPaddingY, panelRadius, pendingChangeCount, pinnedLeftColumnScope,
        pinnedLeftColumnSet, pkColumns, prefersManualTotalCount, previewModalOpen, previewSqlData,
        queryResultCopyMenu, quickWhereCondition, quickWhereDraft, quickWhereSuggestionOptions,
        quickWhereSuggestionsOpen, readOnly, removeFilter, renderGridFieldSelectOption,
        resetCellSelection, resolveColumnQuickFindTarget, resolveContextMenuFieldName,
        resolveWhereConditionSelectedValue, rootRef, rowClassName, rowEditorDisplayRef,
        rowEditorForm, rowEditorNullColsRef, rowEditorOpen, rowEditorRowKey, rowSelectionConfig,
        selectedCells, selectedCellCount, selectedCellRowCount, selectedRowCount,
        fillTemplateTargetRowCount, selectedRowKeys, sensors, setAddedRows, setBatchEditSetNull,
        setBatchEditValue, setCellContextMenu, setCellEditMode, setColumnQuickFindText,
        setDataEditTransactionOptions, setDataPanelValue, setDdlModalOpen, setDdlViewLayout,
        setDeletedRowKeys, setImportFilePath, setImportPreviewVisible, setJsonEditorValue,
        setMetadataReloadVersion, setModifiedColumns, setModifiedRows, setPageFindText,
        setPreviewModalOpen, setQuickWhereDraft, setQuickWhereSuggestionsOpen, setSelectedRowKeys,
        setTextRecordIndex, setTimeout, shouldApplyQuickWhereOnEnter, showColumnComment,
        showColumnType, showFilter, appliedFilterConditions, sortInfo,
        stopQuickWhereClipboardPropagation, supportsCopyInsert, tableBodyBottomPadding,
        tableColumns, tableComponents, tableContainerRef, tableName, tableRef, tableRenderData,
        tableScrollConfig, textRecordIndex, textViewRows, toggleDataPanel, toolbarBottomPadding,
        toolbarExtraActions, translateDataGrid, uniqueKeyGroupsCacheRef, updateFilter, useCallback,
        useMemo, useStore, viewMode, virtualListItemHeight, virtualListItemHeightFixed,
        virtualListItemNativeScrollbarControlled, virtualListItemHorizontalOffsetComposited,
        virtualListItemColumnVirtual, window,
      }}
    />
  );
};

// 使用 ErrorBoundary 包裹 DataGrid，防止数据渲染错误导致应用崩溃
const MemoizedDataGrid = React.memo(DataGrid);

const DataGridWithErrorBoundary: React.FC<DataGridProps> = (props) => {
    const language = useDataGridI18nLanguage();

    return (
        <DataGridErrorBoundary i18nLanguage={language}>
            <MemoizedDataGrid {...props} />
        </DataGridErrorBoundary>
    );
};

export default DataGridWithErrorBoundary;
