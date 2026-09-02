import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage, t } from '../i18n';
import DataGridToolbarFrame, { type DataGridToolbarFrameProps } from './DataGridToolbarFrame';

vi.mock('@ant-design/icons', () => {
  const icon = (name: string) => () => <span data-icon={name} />;
  return {
    ClearOutlined: icon('clear'),
    ControlOutlined: icon('control'),
    CloseOutlined: icon('close'),
    ConsoleSqlOutlined: icon('console-sql'),
    CopyOutlined: icon('copy'),
    DeleteOutlined: icon('delete'),
    DownOutlined: icon('down'),
    EditOutlined: icon('edit'),
    ExportOutlined: icon('export'),
    FilterOutlined: icon('filter'),
    FormatPainterOutlined: icon('format-painter'),
    ImportOutlined: icon('import'),
    PlusOutlined: icon('plus'),
    ReloadOutlined: icon('reload'),
    RobotOutlined: icon('robot'),
    SaveOutlined: icon('save'),
    SelectOutlined: icon('select'),
    SnippetsOutlined: icon('snippets'),
    TableOutlined: icon('table'),
    UndoOutlined: icon('undo'),
    VerticalAlignBottomOutlined: icon('vertical-align-bottom'),
  };
});

vi.mock('antd', () => {
  const Button = ({ children, icon, type, ...props }: any) => (
    <button type="button" data-button-type={type ?? 'default'} {...props}>
      {icon}
      {children}
    </button>
  );
  const Tooltip = ({ children, title }: any) => (
    <span data-tooltip={typeof title === 'string' ? title : ''}>{children}</span>
  );
  const Dropdown = ({ children }: any) => <>{children}</>;
  const Input: any = (props: any) => <input {...props} />;
  Input.TextArea = (props: any) => <textarea {...props} />;

  return {
    AutoComplete: ({ children }: any) => <>{children}</>,
    Button,
    Checkbox: (props: any) => <input type="checkbox" {...props} />,
    Dropdown,
    Input,
    Select: () => null,
    Tooltip,
  };
});

const makeProps = (overrides: Partial<DataGridToolbarFrameProps> = {}): DataGridToolbarFrameProps => ({
  isV2Ui: true,
  tableName: 'users',
  dbName: 'main',
  translate: (key, params) => t(key, params),
  loading: false,
  darkMode: false,
  bgFilter: '#fff',
  panelFrameColor: '#ddd',
  panelRadius: 8,
  panelOuterGap: 8,
  panelPaddingY: 8,
  panelPaddingX: 8,
  toolbarBottomPadding: 8,
  filterTopPadding: 8,
  selectionAccentHex: '#22c55e',
  toolbarDividerColor: '#ddd',
  showFilter: false,
  canModifyData: true,
  selectedRowKeysLength: 0,
  deleteTargetRowCount: 0,
  allSelectedAreDeleted: false,
  cellEditMode: false,
  selectedCellsSize: 0,
  selectedCellRowCount: 0,
  fillTemplateTargetRowCount: 0,
  copiedCellPatchColumnCount: 0,
  hasChanges: false,
  pendingChangeCount: 0,
  dataEditCommitMode: 'manual',
  dataEditAutoCommitDelayMs: 5000,
  dataEditAutoCommitDelayOptions: [{ value: 5000, label: '5s' }],
  autoCommitRemainingSeconds: null,
  canImport: false,
  canExport: false,
  isQueryResultExport: false,
  canCopyQueryResult: false,
  prefersManualTotalCount: false,
  aiShortcutLabel: '-',
  filterConditions: [],
  sortInfo: [],
  displayColumnNames: ['id', 'name'],
  quickWhereDraft: '',
  quickWhereSuggestionsOpen: false,
  quickWhereSuggestionOptions: [],
  gridFieldSelectOptions: [],
  filterLogicOptions: [],
  filterOpOptions: [],
  renderGridFieldSelectOption: () => null,
  noAutoCapInputProps: {},
  filterFieldSelectStyle: {},
  filterFieldPopupWidth: 240,
  onOpenExportModal: vi.fn(),
  queryResultCopyMenu: [],
  dbType: 'mysql',
  onResetPendingChanges: vi.fn(),
  onDataEditCommitModeChange: vi.fn(),
  onDataEditAutoCommitDelayChange: vi.fn(),
  onRefresh: vi.fn(),
  onToggleFilterClick: vi.fn(),
  onAddRow: vi.fn(),
  onUndoDeleteSelected: vi.fn(),
  onDeleteSelected: vi.fn(),
  onToggleCellEditMode: vi.fn(),
  onCopySelectedCellsToClipboard: vi.fn(),
  onCopySelectedColumnsFromRow: vi.fn(),
  onOpenBatchEditModal: vi.fn(),
  onPasteCopiedColumnsToSelectedRows: vi.fn(),
  onCommit: vi.fn(),
  onPreviewChanges: vi.fn(),
  onImport: vi.fn(),
  onCopyQueryResultCsv: vi.fn(),
  onRequestAiInsight: vi.fn(),
  onToggleTotalCount: vi.fn(),
  onQuickWhereDraftChange: vi.fn(),
  onQuickWhereSuggestionsOpenChange: vi.fn(),
  onQuickWhereKeyDown: vi.fn(),
  onQuickWhereSelect: vi.fn(),
  onQuickWhereCopy: vi.fn(),
  onQuickWhereCut: vi.fn(),
  onQuickWherePaste: vi.fn(),
  onApplyQuickWhere: vi.fn(),
  onClearQuickWhere: vi.fn(),
  updateFilter: vi.fn(),
  removeFilter: vi.fn(),
  addFilter: vi.fn(),
  isListOp: () => false,
  isBetweenOp: () => false,
  isNoValueOp: () => false,
  enableSortControls: true,
  onApplySortInfo: vi.fn(),
  onApplyFilters: vi.fn(),
  onEnableAllFilters: vi.fn(),
  onDisableAllFilters: vi.fn(),
  onClearFiltersAndSorts: vi.fn(),
  ...overrides,
});

const findAction = (renderer: ReactTestRenderer, action: string) =>
  renderer.root.find((node) => node.type === 'button' && node.props['data-grid-action'] === action);
const expectTooltip = (renderer: ReactTestRenderer, label: string) => {
  expect(renderer.root.findAll(
    (node) => node.type === 'span' && node.props['data-tooltip'] === label,
  )).not.toHaveLength(0);
};

describe('DataGridToolbarFrame cell selection actions', () => {
  beforeEach(() => {
    setCurrentLanguage('zh-CN');
  });

  it('keeps the RocketMQ TAG total action visible but disabled with an explanation', () => {
    const reason = 'Broker offset 不能表示 TAG 精确总量';
    const renderer = create(
      <DataGridToolbarFrame
        {...makeProps({
          prefersManualTotalCount: true,
          totalCountUnavailableLabel: 'TAG 总量不可用',
          totalCountUnavailableReason: reason,
        })}
      />,
    );
    const action = renderer.root.find(
      (node) => node.type === 'button' && node.props['aria-label'] === 'TAG 总量不可用',
    );

    expect(action.props.disabled).toBe(true);
    expectTooltip(renderer, reason);
  });

  it('uses a pressed selection toggle with a dynamic action label', () => {
    const onToggleCellEditMode = vi.fn();
    const renderer = create(<DataGridToolbarFrame {...makeProps({ onToggleCellEditMode })} />);

    let selectionAction = findAction(renderer, 'cell-selection');
    expect(selectionAction.props['aria-label']).toBe('单元格选择模式');
    expect(selectionAction.props['aria-pressed']).toBe(false);
    expect(selectionAction.props['data-button-type']).toBe('default');
    expect(selectionAction.findByProps({ 'data-icon': 'select' })).toBeTruthy();
    expectTooltip(renderer, '选择多个单元格');
    expect(renderer.root.findAllByProps({ 'data-grid-action': 'copy-selection' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-grid-action': 'copy-fill-template' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-grid-action': 'batch-fill' })).toHaveLength(0);

    act(() => {
      selectionAction.props.onClick();
      renderer.update(<DataGridToolbarFrame {...makeProps({ cellEditMode: true, onToggleCellEditMode })} />);
    });

    selectionAction = findAction(renderer, 'cell-selection');
    expect(onToggleCellEditMode).toHaveBeenCalledOnce();
    expect(selectionAction.props['aria-label']).toBe('单元格选择模式');
    expect(selectionAction.props['aria-pressed']).toBe(true);
    expect(selectionAction.props['data-button-type']).toBe('primary');
    expectTooltip(renderer, '退出单元格选择');
  });

  it('renders three distinct contextual actions without reusing the active-state color', () => {
    const onCopySelectedCellsToClipboard = vi.fn();
    const onCopySelectedColumnsFromRow = vi.fn();
    const onOpenBatchEditModal = vi.fn();
    const renderer = create(
      <DataGridToolbarFrame
        {...makeProps({
          cellEditMode: true,
          selectedCellsSize: 3,
          selectedCellRowCount: 1,
          onCopySelectedCellsToClipboard,
          onCopySelectedColumnsFromRow,
          onOpenBatchEditModal,
        })}
      />,
    );

    const clipboardAction = findAction(renderer, 'copy-selection');
    const templateAction = findAction(renderer, 'copy-fill-template');
    const batchFillAction = findAction(renderer, 'batch-fill');

    expect(clipboardAction.props['aria-label']).toBe('复制到剪贴板（3）');
    expect(clipboardAction.findByProps({ 'data-icon': 'copy' })).toBeTruthy();
    expectTooltip(renderer, clipboardAction.props['aria-label']);
    expect(templateAction.props['aria-label']).toBe('复制为填充模板（3）');
    expect(templateAction.findByProps({ 'data-icon': 'snippets' })).toBeTruthy();
    expect(templateAction.props.disabled).toBe(false);
    expectTooltip(renderer, templateAction.props['aria-label']);
    expect(batchFillAction.props['aria-label']).toBe('批量设值（3）');
    expect(batchFillAction.props['aria-haspopup']).toBe('dialog');
    expect(batchFillAction.props['data-button-type']).toBe('default');
    expect(batchFillAction.findByProps({ 'data-icon': 'edit' })).toBeTruthy();
    expectTooltip(renderer, batchFillAction.props['aria-label']);

    act(() => {
      clipboardAction.props.onClick();
      templateAction.props.onClick();
      batchFillAction.props.onClick();
    });
    expect(onCopySelectedCellsToClipboard).toHaveBeenCalledOnce();
    expect(onCopySelectedColumnsFromRow).toHaveBeenCalledOnce();
    expect(onOpenBatchEditModal).toHaveBeenCalledOnce();
  });

  it('disables fill-template copy when selected cells span multiple rows', () => {
    const renderer = create(
      <DataGridToolbarFrame
        {...makeProps({
          cellEditMode: true,
          selectedCellsSize: 3,
          selectedCellRowCount: 2,
        })}
      />,
    );

    const templateAction = findAction(renderer, 'copy-fill-template');
    expect(templateAction.props.disabled).toBe(true);
    expectTooltip(renderer, '创建填充模板时只能选择同一行的单元格');
    const accessibleDisabledAction = renderer.root.findByProps({
      'data-grid-disabled-action': 'copy-fill-template',
    });
    expect(accessibleDisabledAction.props.role).toBe('button');
    expect(accessibleDisabledAction.props.tabIndex).toBe(0);
    expect(accessibleDisabledAction.props['aria-disabled']).toBe('true');
    expect(accessibleDisabledAction.props['aria-label']).toContain('创建填充模板时只能选择同一行的单元格');
    expect(templateAction.props['aria-hidden']).toBe(true);
    expect(templateAction.props.tabIndex).toBe(-1);

    act(() => {
      renderer.update(
        <DataGridToolbarFrame
          {...makeProps({
            isV2Ui: false,
            cellEditMode: true,
            selectedCellsSize: 3,
            selectedCellRowCount: 2,
          })}
        />,
      );
    });
    expectTooltip(renderer, '创建填充模板时只能选择同一行的单元格');
  });

  it('enables template application for rows represented by the cell selection', () => {
    const renderer = create(
      <DataGridToolbarFrame
        {...makeProps({
          cellEditMode: true,
          selectedCellsSize: 4,
          selectedCellRowCount: 4,
          fillTemplateTargetRowCount: 4,
          selectedRowKeysLength: 0,
          copiedCellPatchColumnCount: 1,
        })}
      />,
    );

    const applyTemplateAction = renderer.root.find(
      (node) => node.type === 'button'
        && node.props['data-grid-action'] === 'apply-fill-template',
    );
    expect(applyTemplateAction.props['aria-label']).toBe('将模板应用到目标行（4）');
    expect(applyTemplateAction.props.disabled).toBe(false);
  });

  it('explains how to select targets when only the template source row is selected', () => {
    const renderer = create(
      <DataGridToolbarFrame
        {...makeProps({
          cellEditMode: true,
          selectedCellsSize: 1,
          selectedCellRowCount: 1,
          fillTemplateTargetRowCount: 0,
          copiedCellPatchColumnCount: 1,
        })}
      />,
    );

    const applyTemplateAction = findAction(renderer, 'apply-fill-template');
    expect(applyTemplateAction.props['aria-label']).toBe('将模板应用到目标行（0）');
    expect(applyTemplateAction.props.disabled).toBe(true);
    expectTooltip(renderer, '请框选目标单元格，或勾选目标行 · 模板包含 1 个字段');
    const accessibleDisabledAction = renderer.root.findByProps({
      'data-grid-disabled-action': 'apply-fill-template',
    });
    expect(accessibleDisabledAction.props['aria-disabled']).toBe('true');
    expect(accessibleDisabledAction.props['aria-label']).toContain('请框选目标单元格，或勾选目标行');
  });
});
