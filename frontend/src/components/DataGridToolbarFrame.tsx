import React from 'react';
import { Button, Dropdown, Select, Tooltip } from 'antd';
import type { ButtonProps, MenuProps } from 'antd';
import {
  GnAddRowIcon,
  GnCellSelectIcon,
  GnCloseIcon,
  GnClipboardIcon,
  GnCopyIcon,
  GnExportIcon,
  GnFillDownIcon,
  GnFilterIcon,
  GnImportIcon,
  GnPencilIcon,
  GnRefreshIcon,
  GnRollbackIcon,
  GnSaveIcon,
  GnSigmaIcon,
  GnSlidersIcon,
  GnSqlDocIcon,
  GnTableIcon,
  GnTrashIcon,
  GnUndoIcon,
} from './icons/gnIcons';
import AiSparkOutlined from './icons/AiSparkOutlined';
import DataGridFilterPanel from './DataGridFilterPanel';
import { hasActiveGridFilters } from './dataGridFilterActivity';
import type { FilterCondition } from '../utils/sql';

type GridFilterCondition = {
  id: number;
  enabled?: boolean;
  logic?: string;
  column: string;
  op: string;
  value: string;
  value2?: string;
};

type GridSortInfo = {
  columnKey: string;
  order: string;
  enabled?: boolean;
};

type ToolbarMenuKey = 'commit-mode' | 'query-copy';

export interface DataGridToolbarFrameProps {
  tableName?: string;
  dbName?: string;
  translate?: (key: string, params?: Record<string, string | number>) => string;
  loading: boolean;
  darkMode: boolean;
  bgFilter: string;
  panelFrameColor: string;
  panelRadius: number;
  panelOuterGap: number;
  panelPaddingY: number;
  panelPaddingX: number;
  toolbarBottomPadding: number;
  filterTopPadding: number;
  showFilter?: boolean;
  /** Applied (already committed to the host) conditions; drives the filter entry highlight. */
  appliedFilterConditions?: FilterCondition[];
  filterPanelRef?: React.RefObject<HTMLDivElement>;
  onReload?: () => void;
  onToggleFilter?: () => void;
  canModifyData: boolean;
  selectedRowKeysLength: number;
  deleteTargetRowCount: number;
  allSelectedAreDeleted: boolean;
  cellEditMode: boolean;
  selectedCellsSize: number;
  selectedCellRowCount: number;
  fillTemplateTargetRowCount: number;
  copiedCellPatchColumnCount: number;
  hasChanges: boolean;
  pendingChangeCount: number;
  dataEditCommitMode: 'manual' | 'auto';
  dataEditAutoCommitDelayMs: number;
  dataEditAutoCommitDelayOptions: Array<{ value: number; label: string }>;
  autoCommitRemainingSeconds: number | null;
  canImport: boolean;
  canExport: boolean;
  isQueryResultExport: boolean;
  canCopyQueryResult: boolean;
  prefersManualTotalCount: boolean;
  aiShortcutLabel: string;
  paginationTotalCountLoading?: boolean;
  totalCountUnavailableLabel?: string;
  totalCountUnavailableReason?: string;
  toolbarExtraActions?: React.ReactNode;
  filterConditions: GridFilterCondition[];
  sortInfo: GridSortInfo[];
  displayColumnNames: string[];
  quickWhereDraft: string;
  quickWhereCondition?: string;
  quickWhereSuggestionsOpen: boolean;
  quickWhereSuggestionOptions: Array<{ value: string; label?: React.ReactNode; insertText?: string }>;
  gridFieldSelectOptions: Array<{ value: string; label: string; title: string }>;
  filterLogicOptions: Array<{ value: string; label: string }>;
  filterOpOptions: Array<{ value: string; label: string }>;
  renderGridFieldSelectOption: (option: { label?: React.ReactNode; value?: unknown; title?: unknown }) => React.ReactNode;
  noAutoCapInputProps: Record<string, unknown>;
  filterFieldSelectStyle: React.CSSProperties;
  filterFieldPopupWidth: number;
  onOpenExportModal: () => void;
  queryResultCopyMenu: MenuProps['items'];
  dbType: string;
  onResetPendingChanges: () => void;
  onDataEditCommitModeChange: (mode: 'manual' | 'auto') => void;
  onDataEditAutoCommitDelayChange: (delayMs: number) => void;
  onRefresh: () => void;
  onToggleFilterClick: () => void;
  onAddRow: () => void;
  onUndoDeleteSelected: () => void;
  onDeleteSelected: () => void;
  onToggleCellEditMode: () => void;
  onCopySelectedCellsToClipboard: () => void;
  onCopySelectedColumnsFromRow: () => void;
  onOpenBatchEditModal: () => void;
  onPasteCopiedColumnsToSelectedRows: () => void;
  onCommit: () => void;
  onPreviewChanges: () => void;
  onImport: () => void;
  onRequestAiInsight: () => void;
  onToggleTotalCount: () => void;
  onQuickWhereDraftChange: (value: string) => void;
  onQuickWhereSuggestionsOpenChange: (open: boolean) => void;
  onQuickWhereKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onQuickWhereSelect: (value: string, option: unknown) => void;
  onQuickWhereCopy: (event: React.ClipboardEvent<HTMLInputElement>) => void;
  onQuickWhereCut: (event: React.ClipboardEvent<HTMLInputElement>) => void;
  onQuickWherePaste: (event: React.ClipboardEvent<HTMLInputElement>) => void;
  onApplyQuickWhere: () => void;
  onClearQuickWhere: () => void;
  updateFilter: (id: number, field: keyof GridFilterCondition, value: string | boolean) => void;
  removeFilter: (id: number) => void;
  addFilter: () => void;
  isListOp: (op: string) => boolean;
  isBetweenOp: (op: string) => boolean;
  isNoValueOp: (op: string) => boolean;
  enableSortControls: boolean;
  onApplySortInfo: (next: GridSortInfo[]) => void;
  onApplyFilters: () => void;
  onEnableAllFilters: () => void;
  onDisableAllFilters: () => void;
  onClearFiltersAndSorts: () => void;
}

const DataGridToolbarFrame: React.FC<DataGridToolbarFrameProps> = ({
  tableName,
  dbName,
  translate: translateProp,
  loading,
  darkMode,
  bgFilter,
  panelFrameColor,
  panelRadius,
  panelOuterGap,
  panelPaddingY,
  panelPaddingX,
  toolbarBottomPadding,
  filterTopPadding,
  showFilter,
  appliedFilterConditions,
  filterPanelRef,
  onReload,
  onToggleFilter,
  canModifyData,
  deleteTargetRowCount,
  allSelectedAreDeleted,
  cellEditMode,
  selectedCellsSize,
  selectedCellRowCount,
  fillTemplateTargetRowCount,
  copiedCellPatchColumnCount,
  hasChanges,
  pendingChangeCount,
  dataEditCommitMode,
  dataEditAutoCommitDelayMs,
  dataEditAutoCommitDelayOptions,
  autoCommitRemainingSeconds,
  canImport,
  canExport,
  isQueryResultExport,
  canCopyQueryResult,
  prefersManualTotalCount,
  aiShortcutLabel,
  paginationTotalCountLoading,
  totalCountUnavailableLabel,
  totalCountUnavailableReason,
  toolbarExtraActions,
  filterConditions,
  sortInfo,
  displayColumnNames,
  quickWhereDraft,
  quickWhereCondition,
  quickWhereSuggestionsOpen,
  quickWhereSuggestionOptions,
  gridFieldSelectOptions,
  filterLogicOptions,
  filterOpOptions,
  renderGridFieldSelectOption,
  noAutoCapInputProps,
  filterFieldSelectStyle,
  filterFieldPopupWidth,
  onOpenExportModal,
  queryResultCopyMenu,
  dbType,
  onResetPendingChanges,
  onDataEditCommitModeChange,
  onDataEditAutoCommitDelayChange,
  onRefresh,
  onToggleFilterClick,
  onAddRow,
  onUndoDeleteSelected,
  onDeleteSelected,
  onToggleCellEditMode,
  onCopySelectedCellsToClipboard,
  onCopySelectedColumnsFromRow,
  onOpenBatchEditModal,
  onPasteCopiedColumnsToSelectedRows,
  onCommit,
  onPreviewChanges,
  onImport,
  onRequestAiInsight,
  onToggleTotalCount,
  onQuickWhereDraftChange,
  onQuickWhereSuggestionsOpenChange,
  onQuickWhereKeyDown,
  onQuickWhereSelect,
  onQuickWhereCopy,
  onQuickWhereCut,
  onQuickWherePaste,
  onApplyQuickWhere,
  onClearQuickWhere,
  updateFilter,
  removeFilter,
  addFilter,
  isListOp,
  isBetweenOp,
  isNoValueOp,
  enableSortControls,
  onApplySortInfo,
  onApplyFilters,
  onEnableAllFilters,
  onDisableAllFilters,
  onClearFiltersAndSorts,
}) => {
  const translate = React.useCallback(
    (key: string, params?: Record<string, string | number>) => translateProp?.(key, params) ?? key,
    [translateProp],
  );
  const [openToolbarMenu, setOpenToolbarMenu] = React.useState<ToolbarMenuKey | null>(null);
  const updateToolbarMenuOpen = (menuKey: ToolbarMenuKey, open: boolean) => {
    setOpenToolbarMenu((current) => (open ? menuKey : current === menuKey ? null : current));
  };
  const renderToolbarDivider = () => (
    <div
      className="gn-v2-toolbar-divider"
      aria-hidden="true"
    />
  );

  // Highlight means "the data really is filtered", not "the panel is open", so the
  // entry stays lit after horizontal scrolling hides the filtered columns (issue #1302).
  const filterEntryActive = hasActiveGridFilters(appliedFilterConditions, quickWhereCondition, dbType);
  const quickWherePlaceholder = dbType === 'mongodb'
    ? translate('data_grid.filter.mongodb_query_placeholder')
    : translate('data_grid.filter.quick_where_placeholder');
  const toolbarTitle = tableName || translate('data_grid.table_fallback.query_result');
  const aiInsightTooltip = aiShortcutLabel !== '-'
    ? `${translate('data_grid.toolbar.ai_insight_tooltip')} · ${aiShortcutLabel}`
    : translate('data_grid.toolbar.ai_insight_tooltip');
  const commitModeLabel = translate(`data_grid.toolbar.commit_mode.${dataEditCommitMode}`);
  const cellSelectionModeLabel = translate('data_grid.toolbar.cell_selection_mode');
  const cellSelectionActionLabel = translate(cellEditMode
    ? 'data_grid.toolbar.cell_selection_exit'
    : 'data_grid.toolbar.cell_selection_enter');
  const canCopyFillTemplate = selectedCellRowCount === 1;
  const copyFillTemplateTooltip = canCopyFillTemplate
    ? translate('data_grid.toolbar.copy_selection_columns', { count: selectedCellsSize })
    : translate('data_grid.toolbar.copy_selection_columns_same_row');
  const hasCellContextActions = cellEditMode
    && (selectedCellsSize > 0 || copiedCellPatchColumnCount > 0);
  const applyFillTemplateLabel = translate('data_grid.toolbar.paste_to_selected_rows', {
    count: fillTemplateTargetRowCount,
  });
  const selectFillTemplateTargetsHint = translate('data_grid.toolbar.select_fill_template_targets');
  const applyFillTemplateTooltip = fillTemplateTargetRowCount > 0
    ? `${applyFillTemplateLabel} · ${translate('data_grid.toolbar.copied_columns_count', { count: copiedCellPatchColumnCount })}`
    : `${selectFillTemplateTargetsHint} · ${translate('data_grid.toolbar.copied_columns_count', { count: copiedCellPatchColumnCount })}`;
  const renderToolbarAction = ({
    label,
    tooltip = label,
    disabledReason,
    dataGridAction,
    className,
    ...buttonProps
  }: Omit<ButtonProps, 'aria-label' | 'children'> & {
    label: string;
    tooltip?: React.ReactNode;
    disabledReason?: string;
    dataGridAction?: string;
  }) => {
    const resolvedClassName = [
      'gn-v2-data-grid-toolbar-action',
      className,
    ].filter(Boolean).join(' ') || undefined;

    const actionButton = (
      <Button {...buttonProps} className={resolvedClassName} data-grid-action={dataGridAction} aria-label={label} />
    );
    return (
      <Tooltip title={tooltip}>
        {buttonProps.disabled && disabledReason ? (
          <span
            role="button"
            tabIndex={0}
            aria-disabled="true"
            aria-label={`${label} — ${disabledReason}`}
            data-grid-disabled-action={dataGridAction}
            style={{ display: 'inline-flex' }}
          >
            {React.cloneElement(actionButton, { 'aria-hidden': true, tabIndex: -1 })}
          </span>
        ) : actionButton}
      </Tooltip>
    );
  };

  return (
    <div
      className="gn-v2-data-grid-toolbar-frame"
      style={{
        margin: `${panelOuterGap}px 0 ${panelOuterGap}px 0`,
        border: `1px solid ${panelFrameColor}`,
        borderRadius: `${panelRadius}px`,
        background: bgFilter,
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <div
        className="data-grid-toolbar-scroll"
        data-grid-primary-actions="true"
        style={{
          padding: showFilter ? `${panelPaddingY}px ${panelPaddingX}px ${toolbarBottomPadding}px ${panelPaddingX}px` : `${panelPaddingY}px ${panelPaddingX}px`,
          border: 'none',
          borderRadius: 0,
          background: 'transparent',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'nowrap',
          minWidth: 0,
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarGutter: 'stable',
          WebkitOverflowScrolling: 'touch',
          boxSizing: 'border-box',
        }}
      >
        <>
            <div className="gn-v2-data-grid-toolbar-title">
              <GnTableIcon className="gn-v2-data-grid-icon" />
              <strong title={toolbarTitle}>{toolbarTitle}</strong>
              {dbName && <small title={dbName}>· {dbName}</small>}
            </div>
            {renderToolbarDivider()}
        </>
        {onReload && (
          renderToolbarAction({
            label: translate('data_grid.toolbar.refresh'),
            icon: <GnRefreshIcon />,
            disabled: loading,
            onClick: onRefresh,
          })
        )}

        {onToggleFilter && (
          <>
            {renderToolbarDivider()}
            {renderToolbarAction({
              label: translate('data_grid.toolbar.filter'),
              icon: <GnFilterIcon />,
              type: filterEntryActive ? 'primary' : 'default',
              'aria-pressed': filterEntryActive,
              dataGridAction: 'filter',
              onClick: onToggleFilterClick,
            })}
          </>
        )}

        {canModifyData && (
          <>
            {renderToolbarDivider()}
            {renderToolbarAction({
              label: translate('data_grid.toolbar.add_row'),
              icon: <GnAddRowIcon />,
              onClick: onAddRow,
            })}
            {allSelectedAreDeleted ? (
              renderToolbarAction({
                label: translate('data_grid.toolbar.undo_delete'),
                tooltip: deleteTargetRowCount > 0
                  ? `${translate('data_grid.toolbar.undo_delete')} · ${translate('data_grid.toolbar.selected_count', { count: deleteTargetRowCount })}`
                  : translate('data_grid.toolbar.undo_delete'),
                icon: <GnUndoIcon />,
                disabled: deleteTargetRowCount === 0,
                onClick: onUndoDeleteSelected,
              })
            ) : (
              renderToolbarAction({
                label: translate('data_grid.toolbar.delete_selected'),
                tooltip: deleteTargetRowCount > 0
                  ? `${translate('data_grid.toolbar.delete_selected')} · ${translate('data_grid.toolbar.selected_count', { count: deleteTargetRowCount })}`
                  : translate('data_grid.toolbar.delete_selected'),
                icon: <GnTrashIcon />,
                danger: true,
                disabled: deleteTargetRowCount === 0,
                onClick: onDeleteSelected,
              })
            )}
            {renderToolbarDivider()}
            <Tooltip title={cellSelectionActionLabel}>
              <Button
                data-grid-cell-editor-action="true"
                data-grid-cell-selection-action="true"
                data-grid-action="cell-selection"
                className="gn-v2-data-grid-toolbar-action"
                aria-label={cellSelectionModeLabel}
                aria-pressed={cellEditMode}
                icon={<GnCellSelectIcon />}
                type={cellEditMode ? 'primary' : 'default'}
                onClick={onToggleCellEditMode}
              />
            </Tooltip>
            {hasCellContextActions && renderToolbarDivider()}
            {cellEditMode && selectedCellsSize > 0 && (
              <>
                {renderToolbarAction({
                  label: translate('data_grid.toolbar.copy_selection', { count: selectedCellsSize }),
                  dataGridAction: 'copy-selection',
                  icon: <GnCopyIcon />,
                  onClick: onCopySelectedCellsToClipboard,
                })}
                {renderToolbarAction({
                  label: translate('data_grid.toolbar.copy_selection_columns', { count: selectedCellsSize }),
                  tooltip: copyFillTemplateTooltip,
                  disabledReason: canCopyFillTemplate ? undefined : copyFillTemplateTooltip,
                  dataGridAction: 'copy-fill-template',
                  icon: <GnClipboardIcon />,
                  disabled: !canCopyFillTemplate,
                  onClick: onCopySelectedColumnsFromRow,
                })}
                {renderToolbarAction({
                  label: translate('data_grid.toolbar.batch_fill', { count: selectedCellsSize }),
                  dataGridAction: 'batch-fill',
                  icon: <GnPencilIcon />,
                  'aria-haspopup': 'dialog',
                  onClick: onOpenBatchEditModal,
                })}
              </>
            )}
            {cellEditMode && copiedCellPatchColumnCount > 0 && (
              <>
                {renderToolbarAction({
                  label: applyFillTemplateLabel,
                  tooltip: applyFillTemplateTooltip,
                  disabledReason: fillTemplateTargetRowCount === 0 ? selectFillTemplateTargetsHint : undefined,
                  dataGridAction: 'apply-fill-template',
                  icon: <GnFillDownIcon />,
                  disabled: fillTemplateTargetRowCount === 0,
                  onClick: onPasteCopiedColumnsToSelectedRows,
                })}
              </>
            )}
            {renderToolbarDivider()}
            {renderToolbarAction({
              label: translate('data_grid.toolbar.commit_label'),
              tooltip: translate('data_grid.toolbar.commit', { count: pendingChangeCount }),
              className: 'gn-v2-commit-button',
              icon: <GnSaveIcon />,
              type: 'primary',
              disabled: !hasChanges,
              onClick: onCommit,
            })}
            {hasChanges && renderToolbarAction({
                label: translate('data_grid.toolbar.preview_sql'),
                icon: <GnSqlDocIcon />,
                onClick: onPreviewChanges,
            })}
            {hasChanges && renderToolbarAction({
              label: translate('data_grid.toolbar.rollback'),
              icon: <GnRollbackIcon />,
              onClick: onResetPendingChanges,
            })}
            <Tooltip
                title={`${commitModeLabel} · ${translate('data_grid.toolbar.commit_mode.tooltip')}`}
                open={openToolbarMenu === 'commit-mode' ? false : undefined}
              >
                <span className="gn-v2-data-grid-toolbar-menu-trigger">
                  <Dropdown
                    autoFocus
                    trigger={['click']}
                    open={openToolbarMenu === 'commit-mode'}
                    onOpenChange={(open) => updateToolbarMenuOpen('commit-mode', open)}
                    menu={{
                      selectable: true,
                      selectedKeys: [dataEditCommitMode],
                      items: [
                        { key: 'manual', label: translate('data_grid.toolbar.commit_mode.manual') },
                        { key: 'auto', label: translate('data_grid.toolbar.commit_mode.auto') },
                      ],
                      onClick: ({ key }) => {
                        setOpenToolbarMenu(null);
                        onDataEditCommitModeChange(key as 'manual' | 'auto');
                      },
                    }}
                  >
                    <Button
                      className="gn-v2-data-grid-toolbar-action"
                      aria-label={commitModeLabel}
                      aria-haspopup="menu"
                      aria-expanded={openToolbarMenu === 'commit-mode'}
                      icon={<GnSlidersIcon />}
                    />
                  </Dropdown>
                </span>
            </Tooltip>
            {dataEditCommitMode === 'auto' && (
              <Select
                size="small"
                value={dataEditAutoCommitDelayMs}
                onChange={onDataEditAutoCommitDelayChange}
                style={{ width: 82, flex: '0 0 auto' }}
                options={dataEditAutoCommitDelayOptions}
              />
            )}
            {dataEditCommitMode === 'auto' && hasChanges && autoCommitRemainingSeconds !== null && (
              <span style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>
                {translate('data_grid.toolbar.commit_mode.auto_countdown', { seconds: autoCommitRemainingSeconds })}
              </span>
            )}
          </>
        )}

        {(canImport || canExport) && (
          <>
            {renderToolbarDivider()}
            {canImport && renderToolbarAction({
              label: translate('data_grid.toolbar.import'),
              icon: <GnImportIcon />,
              onClick: onImport,
            })}
            {canExport && renderToolbarAction({
              label: translate('data_grid.toolbar.export'),
              icon: <GnExportIcon />,
              onClick: onOpenExportModal,
            })}
          </>
        )}

        {isQueryResultExport && (
          <>
            {renderToolbarDivider()}
            <Tooltip
                title={translate('data_grid.toolbar.copy')}
                open={openToolbarMenu === 'query-copy' ? false : undefined}
              >
                <span className="gn-v2-data-grid-toolbar-menu-trigger">
                  <Dropdown
                    autoFocus
                    trigger={['click']}
                    open={openToolbarMenu === 'query-copy'}
                    onOpenChange={(open) => updateToolbarMenuOpen('query-copy', open)}
                    menu={{ items: queryResultCopyMenu }}
                    disabled={!canCopyQueryResult}
                  >
                    <Button
                      data-grid-query-copy-action="true"
                      className="gn-v2-data-grid-toolbar-action"
                      aria-label={translate('data_grid.toolbar.copy')}
                      aria-haspopup="menu"
                      aria-expanded={openToolbarMenu === 'query-copy'}
                      icon={<GnCopyIcon />}
                      disabled={!canCopyQueryResult}
                    />
                  </Dropdown>
                </span>
            </Tooltip>
          </>
        )}

        {!canModifyData && selectedCellsSize > 0 && (
          <>
            {renderToolbarDivider()}
            <Tooltip title={translate('data_grid.toolbar.copy_selection', { count: selectedCellsSize })}>
              <Button
                data-grid-copy-selection-action="true"
                className="gn-v2-data-grid-toolbar-action"
                aria-label={translate('data_grid.toolbar.copy_selection', { count: selectedCellsSize })}
                icon={<GnCopyIcon />}
                onClick={onCopySelectedCellsToClipboard}
              />
            </Tooltip>
          </>
        )}

        <>
          {renderToolbarDivider()}
          <Tooltip title={aiInsightTooltip}>
            <Button
              className="gn-v2-data-grid-toolbar-action gn-v2-ai-insight-button"
              aria-label={translate('data_grid.toolbar.ai_insight_short')}
              icon={<AiSparkOutlined />}
              onClick={onRequestAiInsight}
            />
          </Tooltip>
        </>

        {toolbarExtraActions && (
          <>
            {renderToolbarDivider()}
            {toolbarExtraActions}
          </>
        )}

        {prefersManualTotalCount && (
          <>
            {renderToolbarDivider()}
            <Tooltip title={totalCountUnavailableReason && !paginationTotalCountLoading
              ? totalCountUnavailableReason
              : (paginationTotalCountLoading ? translate('data_grid.toolbar.cancel_count_tooltip') : translate('data_grid.toolbar.count_total_tooltip'))}>
              <span style={{ display: 'inline-flex' }}>
                <Button
                  className="gn-v2-data-grid-toolbar-action"
                  aria-label={totalCountUnavailableReason && !paginationTotalCountLoading
                    ? (totalCountUnavailableLabel || translate('data_grid.toolbar.count_total'))
                    : (paginationTotalCountLoading ? translate('data_grid.toolbar.cancel_count') : translate('data_grid.toolbar.count_total'))}
                  disabled={Boolean(totalCountUnavailableReason) && !paginationTotalCountLoading}
                  icon={paginationTotalCountLoading ? <GnCloseIcon /> : <GnSigmaIcon />}
                  onClick={onToggleTotalCount}
                />
              </span>
            </Tooltip>
          </>
        )}

        <div style={{ marginLeft: 'auto' }} />
      </div>

      {showFilter && (
        <DataGridFilterPanel
          translate={translate}
          darkMode={darkMode}
          dbType={dbType}
          panelFrameColor={panelFrameColor}
          panelRadius={panelRadius}
          panelPaddingX={panelPaddingX}
          panelPaddingY={panelPaddingY}
          filterTopPadding={filterTopPadding}
          filterPanelRef={filterPanelRef}
          filterConditions={filterConditions}
          sortInfo={sortInfo}
          displayColumnNames={displayColumnNames}
          quickWhereDraft={quickWhereDraft}
          quickWhereCondition={quickWhereCondition}
          quickWhereSuggestionOptions={quickWhereSuggestionOptions}
          gridFieldSelectOptions={gridFieldSelectOptions}
          filterLogicOptions={filterLogicOptions}
          filterOpOptions={filterOpOptions}
          renderGridFieldSelectOption={renderGridFieldSelectOption}
          noAutoCapInputProps={noAutoCapInputProps}
          filterFieldPopupWidth={filterFieldPopupWidth}
          onQuickWhereDraftChange={onQuickWhereDraftChange}
          onQuickWhereSuggestionsOpenChange={onQuickWhereSuggestionsOpenChange}
          onQuickWhereKeyDown={onQuickWhereKeyDown}
          onQuickWhereSelect={onQuickWhereSelect}
          onQuickWhereCopy={onQuickWhereCopy}
          onQuickWhereCut={onQuickWhereCut}
          onQuickWherePaste={onQuickWherePaste}
          onApplyQuickWhere={onApplyQuickWhere}
          onClearQuickWhere={onClearQuickWhere}
          updateFilter={updateFilter}
          removeFilter={removeFilter}
          addFilter={addFilter}
          isListOp={isListOp}
          isBetweenOp={isBetweenOp}
          isNoValueOp={isNoValueOp}
          enableSortControls={enableSortControls}
          onApplySortInfo={onApplySortInfo}
          onApplyFilters={onApplyFilters}
          onEnableAllFilters={onEnableAllFilters}
          onDisableAllFilters={onDisableAllFilters}
          onClearFiltersAndSorts={onClearFiltersAndSorts}
        />
      )}
    </div>
  );
};

export default DataGridToolbarFrame;
