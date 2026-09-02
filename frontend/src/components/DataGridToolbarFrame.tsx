import React from 'react';
import { AutoComplete, Button, Checkbox, Dropdown, Input, Select, Tooltip } from 'antd';
import type { ButtonProps, MenuProps } from 'antd';
import {
  ClearOutlined,
  ControlOutlined,
  CloseOutlined,
  ConsoleSqlOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  ExportOutlined,
  FilterOutlined,
  ImportOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SaveOutlined,
  SelectOutlined,
  SnippetsOutlined,
  TableOutlined,
  UndoOutlined,
  VerticalAlignBottomOutlined,
} from '@ant-design/icons';

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
  isV2Ui: boolean;
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
  selectionAccentHex: string;
  toolbarDividerColor: string;
  showFilter?: boolean;
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
  legacyAiButtonStyle?: React.CSSProperties;
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
  onCopyQueryResultCsv: () => void;
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
  isV2Ui,
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
  selectionAccentHex,
  toolbarDividerColor,
  showFilter,
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
  legacyAiButtonStyle,
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
  onCopyQueryResultCsv,
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
      className={isV2Ui ? 'gn-v2-toolbar-divider' : undefined}
      style={isV2Ui ? undefined : { width: 1, height: 18, background: toolbarDividerColor, margin: '0 2px', flexShrink: 0 }}
      aria-hidden="true"
    />
  );

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
    legacyContent = label,
    disabledReason,
    dataGridAction,
    className,
    ...buttonProps
  }: Omit<ButtonProps, 'aria-label' | 'children'> & {
    label: string;
    tooltip?: React.ReactNode;
    legacyContent?: React.ReactNode;
    disabledReason?: string;
    dataGridAction?: string;
  }) => {
    const resolvedClassName = [
      isV2Ui ? 'gn-v2-data-grid-toolbar-action' : undefined,
      className,
    ].filter(Boolean).join(' ') || undefined;

    const actionButton = (
      <Button {...buttonProps} className={resolvedClassName} data-grid-action={dataGridAction} aria-label={label}>
        {isV2Ui ? null : legacyContent}
      </Button>
    );
    const tooltipTitle = isV2Ui || disabledReason ? tooltip : undefined;

    return (
      <Tooltip title={tooltipTitle}>
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
      className={isV2Ui ? 'gn-v2-data-grid-toolbar-frame' : undefined}
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
        {isV2Ui && (
          <>
            <div className="gn-v2-data-grid-toolbar-title">
              <TableOutlined className="gn-v2-data-grid-icon" />
              <strong title={toolbarTitle}>{toolbarTitle}</strong>
              {dbName && <small title={dbName}>· {dbName}</small>}
            </div>
            {renderToolbarDivider()}
          </>
        )}
        {onReload && (
          renderToolbarAction({
            label: translate('data_grid.toolbar.refresh'),
            icon: <ReloadOutlined />,
            disabled: loading,
            onClick: onRefresh,
          })
        )}

        {onToggleFilter && (
          <>
            {renderToolbarDivider()}
            {renderToolbarAction({
              label: translate('data_grid.toolbar.filter'),
              icon: <FilterOutlined />,
              type: showFilter ? 'primary' : 'default',
              onClick: onToggleFilterClick,
            })}
          </>
        )}

        {canModifyData && (
          <>
            {renderToolbarDivider()}
            {renderToolbarAction({
              label: translate('data_grid.toolbar.add_row'),
              icon: <PlusOutlined />,
              onClick: onAddRow,
            })}
            {allSelectedAreDeleted ? (
              renderToolbarAction({
                label: translate('data_grid.toolbar.undo_delete'),
                tooltip: deleteTargetRowCount > 0
                  ? `${translate('data_grid.toolbar.undo_delete')} · ${translate('data_grid.toolbar.selected_count', { count: deleteTargetRowCount })}`
                  : translate('data_grid.toolbar.undo_delete'),
                icon: <UndoOutlined />,
                disabled: deleteTargetRowCount === 0,
                onClick: onUndoDeleteSelected,
              })
            ) : (
              renderToolbarAction({
                label: translate('data_grid.toolbar.delete_selected'),
                tooltip: deleteTargetRowCount > 0
                  ? `${translate('data_grid.toolbar.delete_selected')} · ${translate('data_grid.toolbar.selected_count', { count: deleteTargetRowCount })}`
                  : translate('data_grid.toolbar.delete_selected'),
                icon: <DeleteOutlined />,
                danger: true,
                disabled: deleteTargetRowCount === 0,
                onClick: onDeleteSelected,
              })
            )}
            {!isV2Ui && deleteTargetRowCount > 0 && <span style={{ fontSize: '12px', color: '#888' }}>{translate('data_grid.toolbar.selected_count', { count: deleteTargetRowCount })}</span>}
            {renderToolbarDivider()}
            <Tooltip title={cellSelectionActionLabel}>
              <Button
                data-grid-cell-editor-action="true"
                data-grid-cell-selection-action="true"
                data-grid-action="cell-selection"
                className={isV2Ui ? 'gn-v2-data-grid-toolbar-action' : undefined}
                aria-label={cellSelectionModeLabel}
                aria-pressed={cellEditMode}
                icon={<SelectOutlined />}
                type={cellEditMode ? 'primary' : 'default'}
                onClick={onToggleCellEditMode}
              >
                {isV2Ui ? null : cellSelectionActionLabel}
              </Button>
            </Tooltip>
            {hasCellContextActions && renderToolbarDivider()}
            {cellEditMode && selectedCellsSize > 0 && (
              <>
                {renderToolbarAction({
                  label: translate('data_grid.toolbar.copy_selection', { count: selectedCellsSize }),
                  dataGridAction: 'copy-selection',
                  icon: <CopyOutlined />,
                  onClick: onCopySelectedCellsToClipboard,
                })}
                {renderToolbarAction({
                  label: translate('data_grid.toolbar.copy_selection_columns', { count: selectedCellsSize }),
                  tooltip: copyFillTemplateTooltip,
                  disabledReason: canCopyFillTemplate ? undefined : copyFillTemplateTooltip,
                  dataGridAction: 'copy-fill-template',
                  icon: <SnippetsOutlined />,
                  disabled: !canCopyFillTemplate,
                  onClick: onCopySelectedColumnsFromRow,
                })}
                {renderToolbarAction({
                  label: translate('data_grid.toolbar.batch_fill', { count: selectedCellsSize }),
                  dataGridAction: 'batch-fill',
                  icon: <EditOutlined />,
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
                  icon: <VerticalAlignBottomOutlined />,
                  disabled: fillTemplateTargetRowCount === 0,
                  onClick: onPasteCopiedColumnsToSelectedRows,
                })}
                {!isV2Ui && <span style={{ fontSize: '12px', color: '#888' }}>
                  {translate('data_grid.toolbar.copied_columns_count', { count: copiedCellPatchColumnCount })}
                </span>}
              </>
            )}
            {renderToolbarDivider()}
            {renderToolbarAction({
              label: translate('data_grid.toolbar.commit_label'),
              tooltip: translate('data_grid.toolbar.commit', { count: pendingChangeCount }),
              legacyContent: translate('data_grid.toolbar.commit', { count: pendingChangeCount }),
              className: isV2Ui ? 'gn-v2-commit-button' : undefined,
              icon: <SaveOutlined />,
              type: 'primary',
              disabled: !hasChanges,
              onClick: onCommit,
            })}
            {hasChanges && (isV2Ui ? (
              renderToolbarAction({
                label: translate('data_grid.toolbar.preview_sql'),
                icon: <ConsoleSqlOutlined />,
                onClick: onPreviewChanges,
              })
            ) : (
              <Dropdown menu={{ items: [{ key: 'preview-sql', label: translate('data_grid.toolbar.preview_sql_generate'), icon: <ConsoleSqlOutlined />, onClick: onPreviewChanges }] }}>
                <Button
                  aria-label={translate('data_grid.toolbar.preview_sql')}
                  icon={<ConsoleSqlOutlined />}
                >
                  {translate('data_grid.toolbar.preview_sql')} <DownOutlined />
                </Button>
              </Dropdown>
            ))}
            {hasChanges && renderToolbarAction({
              label: translate('data_grid.toolbar.rollback'),
              icon: <UndoOutlined />,
              onClick: onResetPendingChanges,
            })}
            {isV2Ui ? (
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
                      icon={<ControlOutlined />}
                    />
                  </Dropdown>
                </span>
              </Tooltip>
            ) : (
              <Tooltip title={translate('data_grid.toolbar.commit_mode.tooltip')}>
                <Select
                  size="small"
                  value={dataEditCommitMode}
                  onChange={onDataEditCommitModeChange}
                  style={{ width: 118, flex: '0 0 auto' }}
                  options={[
                    { value: 'manual', label: translate('data_grid.toolbar.commit_mode.manual') },
                    { value: 'auto', label: translate('data_grid.toolbar.commit_mode.auto') },
                  ]}
                />
              </Tooltip>
            )}
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
              icon: <ImportOutlined />,
              onClick: onImport,
            })}
            {canExport && renderToolbarAction({
              label: translate('data_grid.toolbar.export'),
              icon: <ExportOutlined />,
              onClick: onOpenExportModal,
            })}
          </>
        )}

        {isQueryResultExport && (
          <>
            {renderToolbarDivider()}
            {isV2Ui ? (
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
                      icon={<CopyOutlined />}
                      disabled={!canCopyQueryResult}
                    />
                  </Dropdown>
                </span>
              </Tooltip>
            ) : (
              <Dropdown menu={{ items: queryResultCopyMenu }} disabled={!canCopyQueryResult}>
                <Button
                  data-grid-query-copy-action="true"
                  aria-label={translate('data_grid.toolbar.copy')}
                  icon={<CopyOutlined />}
                  disabled={!canCopyQueryResult}
                  onClick={onCopyQueryResultCsv}
                >
                  {translate('data_grid.toolbar.copy')} <DownOutlined />
                </Button>
              </Dropdown>
            )}
          </>
        )}

        {!canModifyData && selectedCellsSize > 0 && (
          <>
            {renderToolbarDivider()}
            <Tooltip title={isV2Ui ? translate('data_grid.toolbar.copy_selection', { count: selectedCellsSize }) : undefined}>
              <Button
                data-grid-copy-selection-action="true"
                className={isV2Ui ? 'gn-v2-data-grid-toolbar-action' : undefined}
                aria-label={translate('data_grid.toolbar.copy_selection', { count: selectedCellsSize })}
                icon={<CopyOutlined />}
                onClick={onCopySelectedCellsToClipboard}
              >
                {isV2Ui ? null : translate('data_grid.toolbar.copy_selection', { count: selectedCellsSize })}
              </Button>
            </Tooltip>
          </>
        )}

        <>
          {renderToolbarDivider()}
          <Tooltip title={aiInsightTooltip}>
            <Button
              className={isV2Ui ? 'gn-v2-data-grid-toolbar-action gn-v2-ai-insight-button' : undefined}
              aria-label={isV2Ui ? translate('data_grid.toolbar.ai_insight_short') : translate('data_grid.toolbar.ai_insight')}
              icon={<RobotOutlined />}
              style={legacyAiButtonStyle}
              onMouseEnter={(event) => {
                if (isV2Ui) return;
                event.currentTarget.style.background = darkMode ? 'linear-gradient(135deg, rgba(16,185,129,0.25), rgba(16,185,129,0.1))' : 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(16,185,129,0.05))';
                event.currentTarget.style.borderColor = '#10b981';
              }}
              onMouseLeave={(event) => {
                if (isV2Ui) return;
                event.currentTarget.style.background = darkMode ? 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(16,185,129,0.05))' : 'linear-gradient(135deg, rgba(16,185,129,0.1), rgba(16,185,129,0.02))';
                event.currentTarget.style.borderColor = darkMode ? 'rgba(16,185,129,0.3)' : 'rgba(16,185,129,0.4)';
              }}
              onClick={onRequestAiInsight}
            >
              {isV2Ui ? null : <span>{translate('data_grid.toolbar.ai_insight')}</span>}
            </Button>
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
                  className={isV2Ui ? 'gn-v2-data-grid-toolbar-action' : undefined}
                  aria-label={totalCountUnavailableReason && !paginationTotalCountLoading
                    ? (totalCountUnavailableLabel || translate('data_grid.toolbar.count_total'))
                    : (paginationTotalCountLoading ? translate('data_grid.toolbar.cancel_count') : translate('data_grid.toolbar.count_total'))}
                  disabled={Boolean(totalCountUnavailableReason) && !paginationTotalCountLoading}
                  icon={paginationTotalCountLoading ? <CloseOutlined /> : <VerticalAlignBottomOutlined />}
                  onClick={onToggleTotalCount}
                >
                  {isV2Ui ? null : (totalCountUnavailableReason && !paginationTotalCountLoading
                    ? (totalCountUnavailableLabel || translate('data_grid.toolbar.count_total'))
                    : (paginationTotalCountLoading ? translate('data_grid.toolbar.cancel_count') : translate('data_grid.toolbar.count_total')))}
                </Button>
              </span>
            </Tooltip>
          </>
        )}

        <div style={{ marginLeft: 'auto' }} />
      </div>

      {showFilter && (
        <div
          ref={filterPanelRef}
          className={isV2Ui ? 'gn-v2-smart-filter-panel' : undefined}
          style={{
            padding: `${filterTopPadding}px ${panelPaddingX}px ${panelPaddingY}px ${panelPaddingX}px`,
            background: 'transparent',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            data-grid-quick-where="true"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              marginBottom: 10,
              borderRadius: Math.max(10, panelRadius - 2),
              border: `1px solid ${panelFrameColor}`,
              background: darkMode ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.72)',
              boxSizing: 'border-box',
              minWidth: 0,
            }}
          >
            <span
              data-grid-quick-where-label="true"
              style={{
                flex: '0 0 auto',
                minWidth: 0,
                color: isV2Ui ? 'var(--gn-fg-3)' : selectionAccentHex,
                fontSize: 12,
                fontWeight: 600,
                lineHeight: '28px',
                whiteSpace: 'nowrap',
              }}
            >
              {translate('data_grid.filter.manual_query_condition')}
            </span>
            <AutoComplete
              className={isV2Ui ? 'gn-v2-smart-filter-manual-input' : undefined}
              value={quickWhereDraft}
              options={quickWhereSuggestionOptions}
              onChange={onQuickWhereDraftChange}
              onOpenChange={onQuickWhereSuggestionsOpenChange}
              onInputKeyDown={onQuickWhereKeyDown}
              onSelect={onQuickWhereSelect}
              style={{ flex: '1 1 320px', minWidth: 220 }}
              popupMatchSelectWidth={420}
            >
              <Input
                {...noAutoCapInputProps}
                allowClear
                data-grid-quick-where-input="true"
                onCopy={onQuickWhereCopy}
                onCut={onQuickWhereCut}
                onPaste={onQuickWherePaste}
                placeholder={quickWherePlaceholder}
              />
            </AutoComplete>
            <Button size="small" type="primary" onClick={onApplyQuickWhere}>
              {translate('data_grid.filter.apply_where')}
            </Button>
            <Button size="small" onClick={onClearQuickWhere} disabled={!quickWhereDraft && !quickWhereCondition}>
              {translate('data_grid.filter.clear')}
            </Button>
          </div>

          <div style={{ maxHeight: 200, overflowY: 'auto', overflowX: 'hidden', flex: '0 1 auto' }}>
            {filterConditions.map((cond, condIndex) => (
              <div key={cond.id} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start', opacity: cond.enabled === false ? 0.58 : 1 }}>
                <Checkbox
                  checked={cond.enabled !== false}
                  onChange={(event) => updateFilter(cond.id, 'enabled', event.target.checked)}
                  style={{ marginTop: 6, flex: '0 0 auto', whiteSpace: 'nowrap' }}
                >
                  {translate('data_grid.filter.enabled')}
                </Checkbox>
                <Select
                  style={{ width: 96, minWidth: 96, maxWidth: 96, flex: '0 0 96px' }}
                  value={condIndex === 0 ? '__FIRST__' : (cond.logic === 'OR' ? 'OR' : 'AND')}
                  onChange={(value) => updateFilter(cond.id, 'logic', value)}
                  options={condIndex === 0 ? [{ value: '__FIRST__', label: translate('data_grid.filter.first_condition') }] : filterLogicOptions}
                  disabled={condIndex === 0}
                />
                <Select
                  style={filterFieldSelectStyle}
                  value={cond.column}
                  onChange={(value) => updateFilter(cond.id, 'column', value)}
                  options={gridFieldSelectOptions}
                  showSearch
                  optionFilterProp="label"
                  optionRender={renderGridFieldSelectOption}
                  popupMatchSelectWidth={filterFieldPopupWidth}
                  filterOption={(input, option) =>
                    String(option?.label ?? '')
                      .toLowerCase()
                      .includes(String(input || '').trim().toLowerCase())
                  }
                  placeholder={translate('data_grid.filter.search_field_placeholder')}
                  disabled={cond.op === 'CUSTOM'}
                />
                <Select
                  style={{ width: 140 }}
                  value={cond.op}
                  onChange={(value) => updateFilter(cond.id, 'op', value)}
                  options={filterOpOptions}
                />

                {cond.op === 'CUSTOM' ? (
                  <Input.TextArea
                    {...noAutoCapInputProps}
                    style={{ flex: 1 }}
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    value={cond.value}
                    onChange={(event) => updateFilter(cond.id, 'value', event.target.value)}
                    placeholder={translate('data_grid.filter.custom_where_placeholder')}
                  />
                ) : isListOp(cond.op) ? (
                  <Input.TextArea
                    {...noAutoCapInputProps}
                    style={{ flex: 1 }}
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    value={cond.value}
                    onChange={(event) => updateFilter(cond.id, 'value', event.target.value)}
                    placeholder={translate('data_grid.filter.list_values_placeholder')}
                  />
                ) : isBetweenOp(cond.op) ? (
                  <>
                    <Input
                      {...noAutoCapInputProps}
                      style={{ width: 220 }}
                      value={cond.value}
                      onChange={(event) => updateFilter(cond.id, 'value', event.target.value)}
                      placeholder={translate('data_grid.filter.start_value_placeholder')}
                    />
                    <Input
                      {...noAutoCapInputProps}
                      style={{ width: 220 }}
                      value={cond.value2 || ''}
                      onChange={(event) => updateFilter(cond.id, 'value2', event.target.value)}
                      placeholder={translate('data_grid.filter.end_value_placeholder')}
                    />
                  </>
                ) : isNoValueOp(cond.op) ? (
                  <Input {...noAutoCapInputProps} style={{ width: 220 }} value="" disabled placeholder={translate('data_grid.filter.no_value_placeholder')} />
                ) : (
                  <Input
                    {...noAutoCapInputProps}
                    style={{ width: 280 }}
                    value={cond.value}
                    onChange={(event) => updateFilter(cond.id, 'value', event.target.value)}
                  />
                )}

                <Button icon={<CloseOutlined />} onClick={() => removeFilter(cond.id)} type="text" danger />
              </div>
            ))}
            {enableSortControls && (
              <div style={{ paddingTop: filterConditions.length > 0 ? 4 : 0, borderTop: filterConditions.length > 0 && sortInfo.length > 0 ? `1px dashed ${panelFrameColor}` : 'none' }}>
                {sortInfo.map((item, index) => (
                <div key={`${item.columnKey || 'sort'}-${index}`} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', opacity: item.enabled === false ? 0.58 : 1 }}>
                  <Checkbox
                    checked={item.enabled !== false}
                    onChange={(event) => {
                      const next = [...sortInfo];
                      next[index] = { ...next[index], enabled: event.target.checked };
                      onApplySortInfo(next);
                    }}
                    style={{ flex: '0 0 auto' }}
                  />
                  <span style={{ fontSize: 12, color: 'inherit', opacity: 0.7, whiteSpace: 'nowrap', minWidth: 32 }}>
                    {index === 0 ? translate('data_grid.filter.sort_label') : translate('data_grid.filter.then_label')}
                  </span>
                  <Select
                    style={filterFieldSelectStyle}
                    value={item.columnKey || undefined}
                    onChange={(value) => {
                      const next = [...sortInfo];
                      if (!value) {
                        next.splice(index, 1);
                      } else {
                        next[index] = { ...next[index], columnKey: value };
                      }
                      onApplySortInfo(next.filter((entry) => entry.columnKey));
                    }}
                    options={displayColumnNames
                      .filter((columnName) => columnName === item.columnKey || !sortInfo.some((entry) => entry.columnKey === columnName))
                      .map((columnName) => ({ value: columnName, label: columnName, title: columnName }))}
                    showSearch
                    optionFilterProp="label"
                    optionRender={renderGridFieldSelectOption}
                    popupMatchSelectWidth={filterFieldPopupWidth}
                    filterOption={(input, option) =>
                      String(option?.label ?? '')
                        .toLowerCase()
                        .includes(String(input || '').trim().toLowerCase())
                    }
                    placeholder={translate('data_grid.filter.select_sort_field_placeholder')}
                    allowClear
                    onClear={() => {
                      const next = sortInfo.filter((_, itemIndex) => itemIndex !== index);
                      onApplySortInfo(next);
                    }}
                  />
                  <Select
                    style={{ width: 110 }}
                    value={item.order || 'ascend'}
                    onChange={(value) => {
                      const next = [...sortInfo];
                      next[index] = { ...next[index], order: value };
                      onApplySortInfo(next);
                    }}
                    options={[
                      { value: 'ascend', label: `${translate('data_grid.filter.sort_asc')} ↑` },
                      { value: 'descend', label: `${translate('data_grid.filter.sort_desc')} ↓` },
                    ]}
                    disabled={!item.columnKey}
                  />
                  <Button
                    icon={<CloseOutlined />}
                    type="text"
                    danger
                    size="small"
                    onClick={() => onApplySortInfo(sortInfo.filter((_, itemIndex) => itemIndex !== index))}
                  />
                </div>
                ))}
              </div>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'center',
              flex: '0 0 auto',
              marginTop: ((enableSortControls && sortInfo.length > 0) || filterConditions.length > 0) ? 4 : 0,
              paddingTop: ((enableSortControls && sortInfo.length > 0) || filterConditions.length > 0) ? 6 : 0,
              borderTop: ((enableSortControls && sortInfo.length > 0) || filterConditions.length > 0) ? `1px dashed ${panelFrameColor}` : 'none',
            }}
          >
            <Button type="primary" ghost onClick={addFilter} size="small" icon={<PlusOutlined />}>{translate('data_grid.filter.add_condition')}</Button>
            {enableSortControls && (
              <Button
                type="dashed"
                size="small"
                icon={<PlusOutlined />}
                onClick={() => {
                  const nextColumn = displayColumnNames.find((columnName) => !sortInfo.some((item) => item.columnKey === columnName)) || displayColumnNames[0] || '';
                  onApplySortInfo([...sortInfo, { columnKey: nextColumn, order: 'ascend', enabled: true }]);
                }}
                disabled={sortInfo.length >= displayColumnNames.length}
              >
                {translate('data_grid.filter.add_sort')}
              </Button>
            )}
            <div style={{ width: 1, height: 16, background: panelFrameColor, margin: '0 2px', flexShrink: 0 }} />
            <Button size="small" onClick={onEnableAllFilters}>{translate('data_grid.filter.enable_all')}</Button>
            <Button size="small" onClick={onDisableAllFilters}>{translate('data_grid.filter.disable_all')}</Button>
            <div style={{ width: 1, height: 16, background: panelFrameColor, margin: '0 2px', flexShrink: 0 }} />
            <Button type="primary" onClick={onApplyFilters} size="small">{translate('data_grid.filter.apply')}</Button>
            <Button size="small" icon={<ClearOutlined />} onClick={onClearFiltersAndSorts}>{translate('data_grid.filter.clear')}</Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DataGridToolbarFrame;
