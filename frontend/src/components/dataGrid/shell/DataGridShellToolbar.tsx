import DataGridToolbarFrame from '../../DataGridToolbarFrame';
import { FILTER_FIELD_SELECT_STYLE, FILTER_FIELD_POPUP_WIDTH } from '../../DataGridCore';
import type { DataGridShellRenderersApi } from './useDataGridShellRenderers';
import type { DataGridShellProps } from '../../DataGridShell';

export interface DataGridShellToolbarProps {
  tableName: DataGridShellProps['tableName'];
  dbName: DataGridShellProps['dbName'];
  translateDataGrid: DataGridShellProps['translateDataGrid'];
  loading: DataGridShellProps['loading'];
  darkMode: DataGridShellProps['darkMode'];
  bgFilter: DataGridShellProps['bgFilter'];
  panelFrameColor: DataGridShellProps['panelFrameColor'];
  panelRadius: DataGridShellProps['panelRadius'];
  panelOuterGap: DataGridShellProps['panelOuterGap'];
  panelPaddingY: DataGridShellProps['panelPaddingY'];
  panelPaddingX: DataGridShellProps['panelPaddingX'];
  toolbarBottomPadding: DataGridShellProps['toolbarBottomPadding'];
  filterTopPadding: DataGridShellProps['filterTopPadding'];
  showFilter: DataGridShellProps['showFilter'];
  appliedFilterConditions: DataGridShellProps['appliedFilterConditions'];
  filterPanelRef: DataGridShellProps['filterPanelRef'];
  onReload: DataGridShellProps['onReload'];
  onToggleFilter: DataGridShellProps['onToggleFilter'];
  canModifyData: DataGridShellProps['canModifyData'];
  selectedRowKeys: DataGridShellProps['selectedRowKeys'];
  deleteTargetRowCount: DataGridShellProps['deleteTargetRowCount'];
  allSelectedAreDeleted: DataGridShellProps['allSelectedAreDeleted'];
  cellEditMode: DataGridShellProps['cellEditMode'];
  selectedCells: DataGridShellProps['selectedCells'];
  selectedCellRowCount: DataGridShellProps['selectedCellRowCount'];
  fillTemplateTargetRowCount: DataGridShellProps['fillTemplateTargetRowCount'];
  copiedCellPatch: DataGridShellProps['copiedCellPatch'];
  hasChanges: DataGridShellProps['hasChanges'];
  pendingChangeCount: DataGridShellProps['pendingChangeCount'];
  dataEditCommitMode: DataGridShellProps['dataEditCommitMode'];
  dataEditAutoCommitDelayMs: DataGridShellProps['dataEditAutoCommitDelayMs'];
  localizedDataEditAutoCommitDelayOptions: DataGridShellProps['localizedDataEditAutoCommitDelayOptions'];
  autoCommitRemainingSeconds: DataGridShellProps['autoCommitRemainingSeconds'];
  canImport: DataGridShellProps['canImport'];
  canExport: DataGridShellProps['canExport'];
  isQueryResultExport: DataGridShellProps['isQueryResultExport'];
  canCopyQueryResult: DataGridShellProps['canCopyQueryResult'];
  prefersManualTotalCount: DataGridShellProps['prefersManualTotalCount'];
  onRequestTotalCount: DataGridShellProps['onRequestTotalCount'];
  aiShortcutLabel: DataGridShellProps['aiShortcutLabel'];
  pagination: DataGridShellProps['pagination'];
  toolbarExtraActions: DataGridShellProps['toolbarExtraActions'];
  filterConditions: DataGridShellProps['filterConditions'];
  sortInfo: DataGridShellProps['sortInfo'];
  displayColumnNames: DataGridShellProps['displayColumnNames'];
  quickWhereDraft: DataGridShellProps['quickWhereDraft'];
  quickWhereCondition: DataGridShellProps['quickWhereCondition'];
  quickWhereSuggestionsOpen: DataGridShellProps['quickWhereSuggestionsOpen'];
  quickWhereSuggestionOptions: DataGridShellProps['quickWhereSuggestionOptions'];
  gridFieldSelectOptions: DataGridShellProps['gridFieldSelectOptions'];
  filterLogicOptions: DataGridShellProps['filterLogicOptions'];
  filterOpOptions: DataGridShellProps['filterOpOptions'];
  renderGridFieldSelectOption: DataGridShellProps['renderGridFieldSelectOption'];
  noAutoCapInputProps: DataGridShellProps['noAutoCapInputProps'];
  queryResultCopyMenu: DataGridShellProps['queryResultCopyMenu'];
  dbType: DataGridShellProps['dbType'];
  handleResetPendingChanges: DataGridShellRenderersApi['handleResetPendingChanges'];
  setDataEditTransactionOptions: DataGridShellProps['setDataEditTransactionOptions'];
  handleRefreshGrid: DataGridShellRenderersApi['handleRefreshGrid'];
  handleToggleFilterWithDefault: DataGridShellRenderersApi['handleToggleFilterWithDefault'];
  handleAddRow: DataGridShellProps['handleAddRow'];
  handleUndoDeleteSelected: DataGridShellProps['handleUndoDeleteSelected'];
  handleDeleteSelected: DataGridShellProps['handleDeleteSelected'];
  handleToggleCellEditMode: DataGridShellRenderersApi['handleToggleCellEditMode'];
  handleCopySelectedCellsToClipboard: DataGridShellProps['handleCopySelectedCellsToClipboard'];
  handleCopySelectedColumnsFromRow: DataGridShellProps['handleCopySelectedColumnsFromRow'];
  openBatchEditModal: DataGridShellProps['openBatchEditModal'];
  handlePasteCopiedColumnsToSelectedRows: DataGridShellProps['handlePasteCopiedColumnsToSelectedRows'];
  handleCommit: DataGridShellProps['handleCommit'];
  handlePreviewChanges: DataGridShellProps['handlePreviewChanges'];
  handleImport: DataGridShellProps['handleImport'];
  handleOpenExportDialog: DataGridShellProps['handleOpenExportDialog'];
  handleRequestAiInsight: DataGridShellRenderersApi['handleRequestAiInsight'];
  handleToggleTotalCount: DataGridShellRenderersApi['handleToggleTotalCount'];
  setQuickWhereDraft: DataGridShellProps['setQuickWhereDraft'];
  setQuickWhereSuggestionsOpen: DataGridShellProps['setQuickWhereSuggestionsOpen'];
  shouldApplyQuickWhereOnEnter: DataGridShellProps['shouldApplyQuickWhereOnEnter'];
  applyQuickWhereCondition: DataGridShellProps['applyQuickWhereCondition'];
  resolveWhereConditionSelectedValue: DataGridShellProps['resolveWhereConditionSelectedValue'];
  stopQuickWhereClipboardPropagation: DataGridShellProps['stopQuickWhereClipboardPropagation'];
  handleQuickWherePaste: DataGridShellProps['handleQuickWherePaste'];
  clearQuickWhereCondition: DataGridShellProps['clearQuickWhereCondition'];
  updateFilter: DataGridShellProps['updateFilter'];
  removeFilter: DataGridShellProps['removeFilter'];
  addFilter: DataGridShellProps['addFilter'];
  isListOp: DataGridShellProps['isListOp'];
  isBetweenOp: DataGridShellProps['isBetweenOp'];
  isNoValueOp: DataGridShellProps['isNoValueOp'];
  onSort: DataGridShellProps['onSort'];
  applySortInfo: DataGridShellProps['applySortInfo'];
  applyFilters: DataGridShellProps['applyFilters'];
  applyAllFiltersEnabled: DataGridShellProps['applyAllFiltersEnabled'];
  applyAllFiltersDisabled: DataGridShellProps['applyAllFiltersDisabled'];
  clearAllFiltersAndSorts: DataGridShellProps['clearAllFiltersAndSorts'];
}

export const DataGridShellToolbar = ({
  tableName, dbName, translateDataGrid, loading, darkMode, bgFilter, panelFrameColor, panelRadius,
  panelOuterGap, panelPaddingY, panelPaddingX, toolbarBottomPadding, filterTopPadding, showFilter,
  appliedFilterConditions, filterPanelRef, onReload, onToggleFilter, canModifyData, selectedRowKeys,
  deleteTargetRowCount, allSelectedAreDeleted, cellEditMode, selectedCells, selectedCellRowCount,
  fillTemplateTargetRowCount, copiedCellPatch, hasChanges, pendingChangeCount, dataEditCommitMode,
  dataEditAutoCommitDelayMs, localizedDataEditAutoCommitDelayOptions, autoCommitRemainingSeconds,
  canImport, canExport, isQueryResultExport, canCopyQueryResult, prefersManualTotalCount,
  onRequestTotalCount, aiShortcutLabel, pagination, toolbarExtraActions, filterConditions, sortInfo,
  displayColumnNames, quickWhereDraft, quickWhereCondition, quickWhereSuggestionsOpen,
  quickWhereSuggestionOptions, gridFieldSelectOptions, filterLogicOptions, filterOpOptions,
  renderGridFieldSelectOption, noAutoCapInputProps, queryResultCopyMenu, dbType,
  handleResetPendingChanges, setDataEditTransactionOptions, handleRefreshGrid,
  handleToggleFilterWithDefault, handleAddRow, handleUndoDeleteSelected, handleDeleteSelected,
  handleToggleCellEditMode, handleCopySelectedCellsToClipboard, handleCopySelectedColumnsFromRow,
  openBatchEditModal, handlePasteCopiedColumnsToSelectedRows, handleCommit, handlePreviewChanges,
  handleImport, handleOpenExportDialog, handleRequestAiInsight, handleToggleTotalCount,
  setQuickWhereDraft, setQuickWhereSuggestionsOpen, shouldApplyQuickWhereOnEnter,
  applyQuickWhereCondition, resolveWhereConditionSelectedValue, stopQuickWhereClipboardPropagation,
  handleQuickWherePaste, clearQuickWhereCondition, updateFilter, removeFilter, addFilter, isListOp,
  isBetweenOp, isNoValueOp, onSort, applySortInfo, applyFilters, applyAllFiltersEnabled,
  applyAllFiltersDisabled, clearAllFiltersAndSorts,
}: DataGridShellToolbarProps) => (
  <DataGridToolbarFrame
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
      showFilter={showFilter}
      appliedFilterConditions={appliedFilterConditions}
      filterPanelRef={filterPanelRef}
      onReload={onReload}
      onToggleFilter={onToggleFilter}
      canModifyData={canModifyData}
      selectedRowKeysLength={selectedRowKeys.length}
      deleteTargetRowCount={deleteTargetRowCount}
      allSelectedAreDeleted={allSelectedAreDeleted}
      cellEditMode={cellEditMode}
      selectedCellsSize={selectedCells.size}
      selectedCellRowCount={selectedCellRowCount}
      fillTemplateTargetRowCount={fillTemplateTargetRowCount}
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
      paginationTotalCountLoading={pagination?.totalCountLoading}
      totalCountUnavailableLabel={pagination?.totalCountUnavailableLabel}
      totalCountUnavailableReason={pagination?.totalCountUnavailableReason}
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
);
